import {createOutbox} from './outbox.mjs';
import {createBotChatService} from './bot-chat.mjs';
import {configureBotProfile} from './bot-profile.mjs';
// Telegram media captions have a 1024-character limit. Keep every line represented;
// the full original remains in D1 and is available via the manager's details button.
export function compactCaption(text){
 const lines=String(text).split('\n');
 while(lines.join('\n').length>1024){
  let i=0;for(let n=1;n<lines.length;n++)if(lines[n].length>lines[i].length)i=n;
  const excess=lines.join('\n').length-1024;
  const length=Math.max(32,lines[i].length-Math.min(excess,Math.max(1,Math.floor(lines[i].length/4))));
  if(length>=lines[i].length)return lines.join('\n').slice(0,1023)+'…';
  lines[i]=Array.from(lines[i].slice(0,length-1)).join('').replace(/[\uD800-\uDBFF]$/,'')+'…';
 }
 return lines.join('\n');
}
export const STATUS_LABELS={received:'Заявка получена',processing:'На оценке',quoted:'Предложение готово',discussion:'Уточняем условия',accepted:'Стоимость принята',cancelled:'Заявка закрыта',confirmed:'Согласовано ранее',completed:'Архив'};
const terminal=new Set(['accepted','cancelled','confirmed','completed']);
export const money=minor=>(minor/100).toLocaleString('ru-RU',{maximumFractionDigits:2})+' BYN';
export function parseQuote(text){
 const [first,...rest]=String(text||'').trim().split('\n');
 const match=/^(\d{1,6})(?:[.,](\d{1,2}))?\s*(?:BYN|руб\.?)?$/i.exec(first.trim());
 if(!match)return null;
 const amount=Number(match[1])*100+Number((match[2]||'').padEnd(2,'0')),note=rest.join('\n').trim();
 return amount>0&&note.length<=600?{amount,note}:null;
}
  function managerText(row,message){
   const w=JSON.parse(row.payload),base=row.manager_text||message?.text?.replace(/\n\nСтатус: [^\n]*$/,'')||[`Заявка на оценку ${row.id}`,w.desc||'Без описания',`Адрес: ${w.addr}`,w.to?`Куда: ${w.to}`:'',`Телефон: ${w.phone}`,`Клиент ID ${row.user_id}`].filter(Boolean).join('\n');
   return base+'\n\nСтатус: '+STATUS_LABELS[row.business_status]+(row.quote_amount_minor?'\nПредложение: '+money(row.quote_amount_minor)+(row.quote_note?'\n'+row.quote_note.replace(/\s+/g,' '):''):'')+(row.customer_note?'\nВопрос клиента: '+row.customer_note.replace(/\s+/g,' '):'');
  }
export function statusKeyboard(row,confirmCancel=false,fullText=managerText(row)){
 const data=action=>`vg:${row.id}:${row.business_version||0}:${action}`;
 const details=row.message_kind&&row.message_kind!=='text'&&compactCaption(fullText)!==fullText?[[{text:'Полная заявка',callback_data:data('details')}]]:[];
 if(terminal.has(row.business_status))return {inline_keyboard:details};
 if(confirmCancel)return {inline_keyboard:[[{text:'Да, закрыть заявку',callback_data:data('cancelled')}],[{text:'Назад',callback_data:data('back')}]]};
 const buttons=row.business_status==='received'?[{text:'Взять на оценку',callback_data:data('processing')}]:[{text:row.business_status==='quoted'?'Изменить цену':'Назвать цену',callback_data:data('price')}];
 return {inline_keyboard:[buttons,[{text:'Закрыть заявку',callback_data:data('ask_cancel')}],...details]};
}
export function createStatusService({telegram,stmt,fail}){
  const outbox=createOutbox({stmt,telegram,edit,sendManagerControls});
  const botChat=createBotChatService({telegram,stmt});
  async function smallJson(request){
    const reader=request.body?.getReader();if(!reader)fail(400,'FORMAT','Пустой запрос.');
    const chunks=[];let n=0;
    while(true){const r=await reader.read();if(r.done)break;n+=r.value.length;if(n>65536){await reader.cancel();fail(413,'SIZE','Запрос слишком большой.')}chunks.push(r.value)}
    try{const value=JSON.parse(await new Blob(chunks).text());if(!value||typeof value!=='object'||Array.isArray(value))throw Error();return value}catch{fail(400,'FORMAT','Неверный формат запроса.')}
  }
  function secretMatches(a,b){
    if(typeof a!=='string'||typeof b!=='string'||a.length!==b.length||b.length<32)return false;
    let diff=0;for(let i=0;i<a.length;i++)diff|=a.charCodeAt(i)^b.charCodeAt(i);return diff===0;
  }
  async function received(env,id){
    const now=Date.now();
    await env.DB.batch([
      stmt(env,"UPDATE orders SET status_updated_at=? WHERE id=? AND status_updated_at=0",now,id),
      stmt(env,"INSERT OR IGNORE INTO order_status_events(event_id,order_id,status,changed_at) SELECT 'received:'||id,id,'received',status_updated_at FROM orders WHERE id=? AND state='sent'",id)
    ]);
  }
  function publicOrder(row,events=[]){return {
   ...JSON.parse(row.payload),serverId:row.id,requestId:row.request_id,status:'sent',deliveryState:row.state,businessStatus:row.state==='sent'?row.business_status:['received','text_sent'].includes(row.state)?'delivery_retry':'delivery_pending',
   deliveryAttempts:row.delivery_attempts,deliveryRetryAt:row.delivery_next_at,remainingPhotoCount:row.state==='text_sent'?Math.max(0,row.photo_count-JSON.parse(row.photo_file_ids||'[]').length):0,statusVersion:row.business_version,statusUpdatedAt:row.status_updated_at,createdAt:row.created_at,photoCount:row.photo_count,
   quote:row.quote_amount_minor?{amountMinor:row.quote_amount_minor,currency:'BYN',note:row.quote_note,revision:row.quote_revision}:null,
   customerNote:row.customer_note||'',customerVisibility:row.customer_visibility||'active',history:events.filter(e=>e.order_id===row.id).map(e=>({status:e.status,at:e.changed_at})).reverse()
  }}
  async function list(request,env,validateInitData){
   const data=await smallJson(request),user=await validateInitData(data.initData,env.BOT_TOKEN);
   let cursor=null;
   if(data.cursor!==undefined&&data.cursor!==null){
    if(typeof data.cursor!=='string'||data.cursor.length>160)fail(400,'CURSOR','Неверная страница.');
    try{cursor=JSON.parse(atob(data.cursor))}catch{fail(400,'CURSOR','Неверная страница.')}
    if(!Array.isArray(cursor)||cursor.length!==2||!Number.isSafeInteger(cursor[0])||typeof cursor[1]!=='string'||!/^VG-[A-F0-9]{12}$/.test(cursor[1]))fail(400,'CURSOR','Неверная страница.');
   }
   const rows=(await stmt(env,"SELECT * FROM orders WHERE user_id=? AND (state IN ('sent','uncertain','sending_text','sending_photos','text_sent') OR (state='received' AND (delivery_attempts>0 OR delivery_next_at>0))) AND customer_visibility!='deleted' AND (? IS NULL OR created_at<? OR (created_at=? AND id<?)) ORDER BY created_at DESC,id DESC LIMIT 101",String(user.id),cursor?.[0]??null,cursor?.[0]??0,cursor?.[0]??0,cursor?.[1]??'').all()).results;
   const more=rows.length>100,page=rows.slice(0,100),last=page.at(-1);
   const events=page.length?(await stmt(env,'SELECT * FROM order_status_events WHERE order_id IN ('+page.map(()=>'?').join(',')+') ORDER BY changed_at DESC',...page.map(r=>r.id)).all()).results:[];
   return {ok:true,orders:page.map(row=>publicOrder(row,events)),nextCursor:more?btoa(JSON.stringify([last.created_at,last.id])):null};
  }
  async function get(request,env,validateInitData){
   const data=await smallJson(request),user=await validateInitData(data.initData,env.BOT_TOKEN);
   if(!(typeof data.id==='string'&&/^VG-[A-F0-9]{12}$/.test(data.id))&&!(typeof data.requestId==='string'&&/^[a-zA-Z0-9_-]{16,80}$/.test(data.requestId)))fail(400,'ID','Неверный номер заявки.');
   const row=await stmt(env,'SELECT * FROM orders WHERE user_id=? AND '+(data.id?'id=?':'request_id=?')+" AND customer_visibility!='deleted'",String(user.id),data.id||data.requestId).first();
   if(!row)fail(404,'NOT_FOUND','Заявка не найдена.');
   const events=(await stmt(env,'SELECT * FROM order_status_events WHERE order_id=? ORDER BY changed_at DESC',row.id).all()).results;
   return {ok:true,order:publicOrder(row,events)};
  }
  async function contact(request,env,validateInitData){
    const data=await smallJson(request),user=await validateInitData(data.initData,env.BOT_TOKEN);
    if(data.diagnostic&&typeof data.diagnostic==='object'){
      const source=data.diagnostic,details={};
      for(const key of ['stage','platform','version','eventKeys','contactKeys','contactType','error'])if(typeof source[key]==='string')details[key]=source[key].replace(/[^a-zA-Z_.,: -]/g,'').slice(0,180);
      if(typeof source.version==='string'&&/^\d{1,2}\.\d{1,2}$/.test(source.version))details.version=source.version;
      for(const key of ['shared','responsePresent','phonePresent'])if(typeof source[key]==='boolean')details[key]=source[key];
      await stmt(env,'INSERT INTO contact_diagnostics(user_id,details,updated_at) VALUES(?,?,?) ON CONFLICT(user_id) DO UPDATE SET details=excluded.details,updated_at=excluded.updated_at',String(user.id),JSON.stringify(details),Date.now()).run();
    }
    const row=await stmt(env,'SELECT phone,updated_at FROM customer_contacts WHERE user_id=?',String(user.id)).first();
    return {ok:true,phone:row?.phone||'',updatedAt:row?.updated_at||0,serverTime:Date.now()};
  }
  async function saveContact(env,user,phone,at=Date.now(),source='telegram'){
    await stmt(env,`INSERT INTO customer_contacts(user_id,phone,first_name,updated_at,source) VALUES(?,?,?,?,?)
     ON CONFLICT(user_id) DO UPDATE SET phone=excluded.phone,first_name=excluded.first_name,updated_at=excluded.updated_at,source=excluded.source
     WHERE excluded.updated_at>customer_contacts.updated_at OR (excluded.updated_at=customer_contacts.updated_at AND excluded.source='telegram' AND customer_contacts.source!='telegram')`,String(user.id),phone,String(user.first_name||'').slice(0,60),at,source).run();
  }
  async function admin(env,id){
   const f=new FormData();f.set('chat_id',env.TELEGRAM_CHAT_ID);f.set('user_id',String(id));
   try{const member=await telegram(env,'getChatMember',f);return ['creator','administrator'].includes(member.status)}catch{return false}
  }
  async function edit(env,row,message,confirmCancel=false){
   const form=new FormData();form.set('chat_id',env.TELEGRAM_CHAT_ID);form.set('message_id',String(row.message_id));form.set('reply_markup',JSON.stringify(statusKeyboard(row,confirmCancel,managerText(row,message))));
   if(confirmCancel||(!message?.text&&!row.manager_text))return telegram(env,'editMessageReplyMarkup',form);
   if(row.message_kind&&row.message_kind!=='text'){form.set('caption',compactCaption(managerText(row,message)));return telegram(env,'editMessageCaption',form)}
   form.set('text',managerText(row,message));return telegram(env,'editMessageText',form);
  }
  async function sendManagerControls(env,row){
   const form=new FormData();form.set('chat_id',env.TELEGRAM_CHAT_ID);form.set('protect_content','true');
   form.set('text',managerText(row));form.set('reply_parameters',JSON.stringify({message_id:row.message_id}));
   form.set('reply_markup',JSON.stringify(statusKeyboard({...row,message_kind:'text'})));
   return telegram(env,'sendMessage',form);
  }
  async function ensureMediaButtons(env,row){
   if(row.message_kind!=='album'||row.state!=='sent')return;
   // Album keyboards can be accepted by Telegram but hidden by its clients.
   // Use a separate, durable control card linked to the existing album.
   await received(env,row.id);
   await outbox.enqueue(env,'received:'+row.id,row.id,'sendMessage',{managerControls:true},Date.now()).run();
   await outbox.flush(env,row.id);
  }
  async function maintainMediaButtons(env){
   const rows=(await stmt(env,"SELECT * FROM orders WHERE state='sent' AND message_kind='album' AND message_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM delivery_outbox WHERE order_id=orders.id AND id='received:'||orders.id||':sendMessage') ORDER BY created_at LIMIT 10").all()).results;
   for(const row of rows)await ensureMediaButtons(env,row);
  }
  async function reply(env,message,text,markup){
   const f=new FormData();f.set('chat_id',env.TELEGRAM_CHAT_ID);f.set('text',text);f.set('reply_parameters',JSON.stringify({message_id:message.message_id}));
   if(markup)f.set('reply_markup',JSON.stringify(markup));
   try{await telegram(env,'sendMessage',f)}catch(e){
    // A privacy restriction may reject a user-ID link. Keep the phone notification.
    if(markup&&e.code==='DELIVERY'){f.delete('reply_markup');try{await telegram(env,'sendMessage',f)}catch{}}
   }
  }
  async function priceReply(env,message){
   if(String(message.chat?.id)!==String(env.TELEGRAM_CHAT_ID)||!message.reply_to_message||!Number.isSafeInteger(message.from?.id))return;
   const prompt=await stmt(env,'SELECT * FROM quote_prompts WHERE message_id=?',message.reply_to_message.message_id).first();
   if(!prompt||!await admin(env,message.from.id))return;
   if(await stmt(env,'SELECT event_id FROM order_status_events WHERE event_id=?','quote:'+message.message_id).first())return;
   let row=await stmt(env,'SELECT * FROM orders WHERE id=?',prompt.order_id).first();
   if(!row||row.business_version!==prompt.expected_version||!['processing','discussion','quoted'].includes(row.business_status)){await reply(env,message,'Предложение уже изменилось. Нажмите «Назвать цену» под актуальной заявкой.');return}
   const quote=parseQuote(message.text);
   if(!quote){await reply(env,message,'Укажите сумму в BYN первой строкой, например 150. Следующими строками — что входит в стоимость и условия (до 600 символов). Ответьте ещё раз на сообщение с запросом цены.');return}
   const eventId='quote:'+message.message_id,now=Date.now();
   let notice=null;
   if(env.MINI_APP_URL||/^[A-Za-z0-9_]+$/.test(env.BOT_USERNAME||'')){
    const button={text:'Посмотреть предложение'};
    if(env.MINI_APP_URL){const url=new URL(env.MINI_APP_URL);url.searchParams.set('order',row.id);button.web_app={url:url.href}}
    else button.url=`https://t.me/${env.BOT_USERNAME}?startapp=order_${row.id}`;
    notice={_quoteRevision:row.quote_revision+1,chat_id:row.user_id,text:`Предложение по заявке ${row.id} обновлено. Актуальная стоимость и условия – в приложении. Можно согласиться или задать вопрос.`,reply_markup:{inline_keyboard:[[button]]}};
   }
   const changes=await env.DB.batch([
    stmt(env,"INSERT OR IGNORE INTO order_status_events(event_id,order_id,status,actor_id,changed_at) SELECT ?,id,'quoted',?,? FROM orders WHERE id=? AND business_version=?",eventId,String(message.from.id),now,row.id,row.business_version),
    stmt(env,"UPDATE orders SET business_status='quoted',business_version=business_version+1,status_updated_at=?,quote_amount_minor=?,quote_note=?,quote_revision=quote_revision+1,customer_note='' WHERE id=? AND business_version=? AND EXISTS(SELECT 1 FROM order_status_events WHERE event_id=? AND order_id=orders.id)",now,quote.amount,quote.note,row.id,row.business_version,eventId),
    outbox.enqueue(env,eventId,row.id,'edit',{},now),
    ...(notice?[outbox.enqueue(env,eventId,row.id,'sendMessage',notice,now)]:[])
   ]);
   if(!changes[1].meta.changes)return;
   row=await stmt(env,'SELECT * FROM orders WHERE id=?',row.id).first();
   await outbox.flush(env,row.id);
   const delivered=await stmt(env,"SELECT state FROM delivery_outbox WHERE id=?",eventId+':sendMessage').first();
   await reply(env,message,delivered?.state==='sent'?'Предложение сохранено, клиенту отправлено уведомление. Ждём его решения.':'Предложение сохранено в приложении. Уведомление ожидает доставки или проверки; при необходимости свяжитесь с клиентом по телефону.');
  }
  async function decision(request,env,validateInitData){
   const data=await smallJson(request),user=await validateInitData(data.initData,env.BOT_TOKEN);
   if(!['accept','discuss'].includes(data.action)||typeof data.actionId!=='string'||!/^[a-zA-Z0-9_-]{16,80}$/.test(data.actionId)||!Number.isInteger(data.version)||typeof data.id!=='string')fail(400,'DECISION','Проверьте действие.');
   const note=typeof data.note==='string'?data.note.trim():'';if(note.length>400)fail(400,'DECISION','Комментарий должен быть не длиннее 400 символов.');
   let row=await stmt(env,"SELECT * FROM orders WHERE id=? AND user_id=? AND state='sent'",data.id,String(user.id)).first();
   if(!row)fail(404,'NOT_FOUND','Заявка не найдена.');
   const target=data.action==='accept'?'accepted':'discussion',eventId='client:'+user.id+':'+data.actionId;
   const old=await stmt(env,'SELECT * FROM order_status_events WHERE event_id=?',eventId).first();
   if(old&&(old.order_id!==row.id||old.status!==target))fail(409,'DECISION','Это действие уже использовано.');
   if(!old){
    if(data.action==='discuss'&&!note)fail(400,'DECISION','Напишите, что хотите уточнить.');
    if(!(data.action==='accept'?['quoted','discussion'].includes(row.business_status):row.business_status==='quoted')||!row.quote_amount_minor||row.business_version!==data.version)fail(409,'QUOTE_CHANGED','Предложение изменилось. Обновите заявку и посмотрите актуальную цену.');
    const now=Date.now(),payload=JSON.parse(row.payload),username=/^[A-Za-z0-9_]{5,32}$/.test(user.username||'')?user.username:'';
    const contact=`\n\nТелефон: ${payload.phone}${username?'\nTelegram: @'+username:''}`;
    const text=data.action==='accept'?`Клиент принял стоимость ${money(row.quote_amount_minor)} по заявке ${row.id}.\nСвяжитесь с ним для согласования времени.`:`Клиент просит уточнить условия по заявке ${row.id}.${note?'\n'+note:''}`;
    const notice={chat_id:env.TELEGRAM_CHAT_ID,text:text+contact,reply_parameters:{message_id:row.message_id},reply_markup:{inline_keyboard:[[{text:'Написать клиенту в Telegram',url:username?'https://t.me/'+username:'tg://user?id='+row.user_id}]]}};
    const changes=await env.DB.batch([
     stmt(env,"INSERT OR IGNORE INTO order_status_events(event_id,order_id,status,actor_id,changed_at) SELECT ?,id,?,?,? FROM orders WHERE id=? AND user_id=? AND business_version=? AND business_status=?",eventId,target,String(user.id),now,row.id,String(user.id),data.version,row.business_status),
     stmt(env,"UPDATE orders SET business_status=?,business_version=business_version+1,status_updated_at=?,customer_note=? WHERE id=? AND user_id=? AND business_version=? AND business_status=? AND EXISTS(SELECT 1 FROM order_status_events WHERE event_id=? AND order_id=orders.id AND status=?)",target,now,note,row.id,String(user.id),data.version,row.business_status,eventId,target),
     outbox.enqueue(env,eventId,row.id,'edit',{},now),
     outbox.enqueue(env,eventId,row.id,'sendMessage',notice,now)
    ]);
    if(!changes[1].meta.changes)fail(409,'QUOTE_CHANGED','Предложение уже обновлено.');
    row=await stmt(env,'SELECT * FROM orders WHERE id=?',row.id).first();
   }
   await outbox.flush(env,row.id);
   const events=(await stmt(env,'SELECT * FROM order_status_events WHERE order_id=? ORDER BY changed_at DESC',row.id).all()).results;
   return {ok:true,order:publicOrder(row,events)};
  }
  async function organize(request,env,validateInitData){
   const data=await smallJson(request),user=await validateInitData(data.initData,env.BOT_TOKEN);
   if(!['archive','restore','delete','cancel'].includes(data.action)||typeof data.id!=='string')fail(400,'ACTION','Недоступное действие.');
   let row=await stmt(env,"SELECT * FROM orders WHERE id=? AND user_id=? ",data.id,String(user.id)).first();
   if(!row)fail(404,'NOT_FOUND','Заявка не найдена.');
   if(data.action==='cancel'&&row.state!=='sent')fail(409,'DELIVERY_PENDING','Сначала необходимо проверить доставку заявки.');
   if(data.action==='cancel'&&row.business_status!=='cancelled'){
    if(!['received','processing','quoted','discussion','accepted'].includes(row.business_status))fail(409,'CANNOT_CANCEL','Эту оценку уже нельзя отменить в приложении.');
    if(data.version!==row.business_version)fail(409,'STALE','Заявка обновилась. Обновите список и повторите действие.');
    const eventId='customer-cancel:'+row.id+':'+row.business_version,now=Date.now();
    const changes=await env.DB.batch([
     stmt(env,"INSERT OR IGNORE INTO order_status_events(event_id,order_id,status,actor_id,changed_at) SELECT ?,id,'cancelled',?,? FROM orders WHERE id=? AND user_id=? AND business_version=?",eventId,String(user.id),now,row.id,String(user.id),data.version),
     stmt(env,"UPDATE orders SET business_status='cancelled',business_version=business_version+1,status_updated_at=?,customer_visibility=CASE WHEN customer_visibility='deleted' THEN 'deleted' ELSE 'archived' END WHERE id=? AND user_id=? AND business_version=? AND EXISTS(SELECT 1 FROM order_status_events WHERE event_id=? AND order_id=orders.id)",now,row.id,String(user.id),data.version,eventId),
     outbox.enqueue(env,eventId,row.id,'edit',{},now),
     outbox.enqueue(env,eventId,row.id,'sendMessage',{chat_id:env.TELEGRAM_CHAT_ID,text:'Клиент отменил заявку '+row.id+'.',reply_parameters:{message_id:row.message_id}},now)
    ]);
    if(!changes[1].meta.changes)fail(409,'STALE','Заявка уже обновилась.');
    row=await stmt(env,'SELECT * FROM orders WHERE id=?',row.id).first();
    await outbox.flush(env,row.id);
   }else if(data.action==='cancel'){await outbox.flush(env,row.id)}else{
    const visibility={archive:'archived',restore:'active',delete:'deleted'}[data.action];
    await stmt(env,'UPDATE orders SET customer_visibility=? WHERE id=? AND user_id=?',visibility,row.id,String(user.id)).run();
    row={...row,customer_visibility:visibility};
   }
   const events=(await stmt(env,'SELECT * FROM order_status_events WHERE order_id=? ORDER BY changed_at DESC',row.id).all()).results;
   return {ok:true,order:publicOrder(row,events)};
  }
  async function webhook(request,env){
    if(!secretMatches(request.headers.get('X-Telegram-Bot-Api-Secret-Token'),env.TELEGRAM_WEBHOOK_SECRET))fail(403,'WEBHOOK','Доступ запрещён.');
    const update=await smallJson(request),q=update.callback_query,message=update.message;
    if(message?.contact){
      const sender=message.from,c=message.contact;
      if(message.chat?.type==='private'&&Number.isSafeInteger(sender?.id)&&sender.id>0&&String(message.chat.id)===String(sender.id)&&c.user_id===sender.id){
        const digits=String(c.phone_number||'').replace(/\D/g,'');
        if(/^[1-9]\d{8,14}$/.test(digits)){
          await saveContact(env,sender,'+'+digits);
          // Delete only the sender's own contact, and only after durable storage.
          if(Number.isSafeInteger(message.message_id)&&message.message_id>0){
            const form=new FormData();form.set('chat_id',String(message.chat.id));form.set('message_id',String(message.message_id));
            try{await telegram(env,'deleteMessage',form)}catch{}
          }
        }
      }
      return {ok:true};
    }
    if(message&&await botChat.receive(env,message))return {ok:true};
    if(message?.text){await priceReply(env,message);return {ok:true}}
    if(!q)return {ok:true};
    if(typeof q.id!=='string'||q.id.length>128)return {ok:true};
    const answer=async text=>{const f=new FormData();f.set('callback_query_id',q.id);f.set('text',text);try{await telegram(env,'answerCallbackQuery',f)}catch{}};
    if(String(q.message?.chat?.id)!==String(env.TELEGRAM_CHAT_ID)){await answer('Управление доступно только в группе заказов.');return {ok:true}}
    const match=/^vg:(VG-[A-F0-9]{12}):(\d{1,8}):(processing|confirmed|completed|price|ask_cancel|cancelled|back|details)$/.exec(q.data||'');
    if(!match){await answer('Кнопка недоступна.');return {ok:true}}
    if(!Number.isSafeInteger(q.from?.id)){await answer('Не удалось проверить пользователя.');return {ok:true}}
    if(!await admin(env,q.from.id)){await answer('Изменять статус могут только администраторы группы.');return {ok:true}}
    const [,id,versionString,action]=match,version=Number(versionString);
    let row=await stmt(env,'SELECT * FROM orders WHERE id=?',id).first();
    if(!row||row.message_id!==q.message.message_id){await answer('Заявка не найдена.');return {ok:true}}
    if(!row.manager_text&&typeof q.message.text==='string'){
      row.manager_text=q.message.text.replace(/\n\nСтатус: [^\n]*$/,'');
      await stmt(env,"UPDATE orders SET manager_text=? WHERE id=? AND manager_text=''",row.manager_text,row.id).run();
    }
    if(row.state!=='sent'){await answer('Заявка ещё доставляется. Попробуйте чуть позже.');return {ok:true}}
    if(row.business_version!==version){
      try{await edit(env,row,q.message)}catch{}
      await answer('Статус уже обновлён: '+STATUS_LABELS[row.business_status]);return {ok:true};
    }
    if(action==='details'){await reply(env,q.message,managerText(row,q.message));await answer('');return {ok:true}}
    if(action==='price'){
     if(!['processing','discussion','quoted'].includes(row.business_status)){await answer('Сначала возьмите заявку на оценку.');return {ok:true}}
     const display=q.from.first_name||'Менеджер',f=new FormData();
     f.set('chat_id',env.TELEGRAM_CHAT_ID);f.set('text',`${display}, укажите цену для заявки ${row.id}.\nПервая строка — сумма в BYN, например 150.\nСледующие строки — что включено и условия. Это предложение, а не подтверждённый заказ.`);
     f.set('entities',JSON.stringify([{type:'text_mention',offset:0,length:display.length,user:{id:q.from.id,first_name:display,is_bot:false}}]));
     f.set('reply_markup',JSON.stringify({force_reply:true,selective:true,input_field_placeholder:'150 — сумма первой строкой'}));
     try{const prompt=await telegram(env,'sendMessage',f);await stmt(env,'INSERT OR REPLACE INTO quote_prompts(message_id,order_id,expected_version,created_at) VALUES(?,?,?,?)',prompt.message_id,row.id,row.business_version,Date.now()).run();await answer('Ответьте на сообщение бота с запросом цены.')}catch{await answer('Не удалось открыть ввод цены. Попробуйте ещё раз.')}
     return {ok:true};
    }
    if(['ask_cancel','back'].includes(action)){
      try{await edit(env,row,q.message,action==='ask_cancel');await answer(action==='ask_cancel'?'Подтвердите отмену заявки.':'')}catch{await answer('Не удалось обновить кнопки. Повторите попытку.')}
      return {ok:true};
    }
    const permitted=(action==='processing'&&row.business_status==='received')||(action==='cancelled'&&!terminal.has(row.business_status));
    if(!permitted){await answer('Этот переход недоступен: сначала назовите цену, затем дождитесь решения клиента.');return {ok:true}}
    const now=Date.now();
    await env.DB.batch([
      stmt(env,'INSERT OR IGNORE INTO order_status_events(event_id,order_id,status,actor_id,changed_at) SELECT ?,id,?,?,? FROM orders WHERE id=? AND business_version=? AND business_status=? AND state=\'sent\'',q.id,action,String(q.from.id),now,id,version,row.business_status),
      stmt(env,"UPDATE orders SET business_status=?,business_version=business_version+1,status_updated_at=?,customer_visibility=CASE WHEN customer_visibility='deleted' THEN 'deleted' WHEN ?='cancelled' THEN 'archived' ELSE customer_visibility END WHERE id=? AND business_version=? AND business_status=? AND EXISTS(SELECT 1 FROM order_status_events WHERE event_id=? AND order_id=orders.id AND status=?)",action,now,action,id,version,row.business_status,q.id,action),
      outbox.enqueue(env,q.id,id,'edit',{},now)
    ]);
    row=await stmt(env,'SELECT * FROM orders WHERE id=?',id).first();
    await outbox.flush(env,row.id);
    await answer('Статус: '+STATUS_LABELS[row.business_status]);return {ok:true};
  }
  async function setup(request,env){
    const key=request.headers.get('authorization')?.replace(/^Bearer /,'');
    if(!secretMatches(key,env.ADMIN_SETUP_SECRET))fail(403,'SETUP_AUTH','Доступ запрещён.');
    const body=await smallJson(request);
    if(body.action==='bot_profile')return {...await configureBotProfile(env,telegram,fail),welcomeRefresh:await botChat.refreshExisting(env)};
    if(body.action==='deliveries'){
      const now=Date.now();
      return {ok:true,orders:(await stmt(env,"SELECT id,state,updated_at,delivery_attempts,message_kind FROM orders WHERE state='uncertain' OR (state IN ('sending_text','sending_photos') AND updated_at<?) OR (state='received' AND delivery_attempts>=5) ORDER BY updated_at LIMIT 100",now-120000).all()).results,
       notifications:(await stmt(env,"SELECT id,order_id,kind,state,attempts,last_error,available_at FROM delivery_outbox WHERE state IN ('pending','uncertain','failed') OR (state='sending' AND lease_until<?) ORDER BY created_at LIMIT 100",now).all()).results};
    }
    if(['resolve_order','resolve_notification'].includes(body.action)){
      if(typeof body.id!=='string'||body.id.length>200||body.confirmation!==body.id||typeof body.note!=='string'||body.note.trim().length<5||body.note.length>300)fail(400,'RESOLUTION','Укажите номер, его подтверждение и результат ручной проверки.');
      const now=Date.now(),auditId=crypto.randomUUID();
      if(body.action==='resolve_order'){
        if(!['delivered','not_delivered'].includes(body.outcome)||!Number.isSafeInteger(body.expectedUpdatedAt))fail(400,'RESOLUTION','Укажите результат проверки и версию записи.');
        if(body.outcome==='delivered'&&(!Number.isSafeInteger(body.messageId)||body.messageId<=0))fail(400,'RESOLUTION','Нужен ID существующего сообщения в группе.');
        const changes=await env.DB.batch([
          stmt(env,`INSERT INTO delivery_resolutions(id,order_id,outcome,note,created_at) SELECT ?,id,?,?,? FROM orders WHERE id=? AND updated_at=? AND (state='uncertain' OR (state IN ('sending_text','sending_photos') AND updated_at<?) OR (state='received' AND delivery_attempts>=5))`,auditId,body.outcome,body.note.trim(),now,body.id,body.expectedUpdatedAt,now-120000),
          stmt(env,`UPDATE orders SET state=CASE WHEN ?='delivered' THEN 'sent' WHEN message_id IS NOT NULL THEN 'text_sent' ELSE 'received' END,message_id=CASE WHEN ?='delivered' AND message_id IS NULL THEN ? ELSE message_id END,updated_at=?,delivery_attempts=0,delivery_next_at=?,buttons_version=0 WHERE id=? AND updated_at=? AND EXISTS(SELECT 1 FROM delivery_resolutions WHERE id=? AND order_id=orders.id)`,body.outcome,body.outcome,body.messageId||null,now,now,body.id,body.expectedUpdatedAt,auditId)
        ]);
        if(!changes[1].meta.changes)fail(409,'STALE','Запись уже изменилась или ещё отправляется.');
        if(body.outcome==='delivered'){
          await received(env,body.id);
          await env.DB.batch([outbox.enqueue(env,'received:'+body.id,body.id,'edit',{},now)]);
          await outbox.flush(env,body.id);
        }
      }else{
        if(!['delivered','not_delivered'].includes(body.outcome))fail(400,'RESOLUTION','Укажите результат сверки уведомления.');
        const task=await stmt(env,'SELECT * FROM delivery_outbox WHERE id=?',body.id).first();
        const managerCard=task?.kind==='sendMessage'&&JSON.parse(task.payload).managerControls===true;
        if(managerCard&&body.outcome==='delivered'&&(!Number.isSafeInteger(body.messageId)||body.messageId<=0))fail(400,'RESOLUTION','Нужен ID карточки управления в группе.');
        const changes=await env.DB.batch([
          stmt(env,"INSERT INTO delivery_resolutions(id,order_id,task_id,outcome,note,created_at) SELECT ?,order_id,id,?,?,? FROM delivery_outbox WHERE id=? AND (state IN ('uncertain','failed') OR (state='sending' AND lease_until<?))",auditId,body.outcome,body.note.trim(),now,body.id,now),
          stmt(env,"UPDATE delivery_outbox SET state=?,available_at=?,lease_token='',lease_until=0,last_error='',attempts=0 WHERE id=? AND EXISTS(SELECT 1 FROM delivery_resolutions WHERE id=? AND task_id=delivery_outbox.id)",body.outcome==='delivered'?'sent':'pending',now,body.id,auditId),
          ...(managerCard&&body.outcome==='delivered'?[stmt(env,"UPDATE orders SET message_id=?,message_kind='text',buttons_version=1 WHERE id=? AND EXISTS(SELECT 1 FROM delivery_resolutions WHERE id=? AND task_id=?)",body.messageId,task.order_id,auditId,body.id)]:[])
        ]);
        if(!changes[1].meta.changes)fail(409,'STALE','Уведомление уже изменилось или ещё отправляется.');
      }
      return {ok:true};
    }
    if(body.action==='diagnostics'){
      const info=await telegram(env,'getWebhookInfo',new FormData()),bot=await telegram(env,'getMe',new FormData());
      return {ok:true,bot:bot.username,webhookMatches:info.url===new URL('/telegram/webhook',request.url).href,pending:info.pending_update_count||0,lastError:info.last_error_message||'',lastErrorAt:info.last_error_date||0,allowedUpdates:info.allowed_updates||[],contacts:(await stmt(env,'SELECT details,updated_at FROM contact_diagnostics ORDER BY updated_at DESC LIMIT 3').all()).results};
    }
    if(body.action==='backfill'){
      const rows=(await stmt(env,"SELECT * FROM orders WHERE state='sent' AND message_id IS NOT NULL AND buttons_version=0 ORDER BY created_at DESC LIMIT 10").all()).results;
      let changed=0,failed=0;
      for(const row of rows){
        try{await edit(env,row,null);await stmt(env,'UPDATE orders SET buttons_version=1 WHERE id=?',row.id).run();changed++}catch{failed++}
      }
      const count=await stmt(env,"SELECT COUNT(*) AS n FROM orders WHERE state='sent' AND message_id IS NOT NULL AND buttons_version=0").first();
      return {ok:true,changed,failed,remaining:count.n};
    }
    if(body.action!=='setup')fail(400,'ACTION','Неизвестное действие.');
    if(!env.TELEGRAM_WEBHOOK_SECRET)fail(503,'SETUP','Не задан секрет webhook.');
    const url=new URL('/telegram/webhook',request.url).href;
    const setupTelegram=async(method,form)=>{try{return await telegram(env,method,form)}catch(e){fail(502,'TELEGRAM_SETUP','Не удалось настроить '+method+': '+(e.safeDiagnostic||e.code||'ошибка Telegram'))}};
    const old=await setupTelegram('getWebhookInfo',new FormData());
    if(old.url&&old.url!==url)fail(409,'EXISTING_WEBHOOK','У бота уже другой webhook. Он не изменён.');
    const form=new FormData();form.set('url',url);form.set('secret_token',env.TELEGRAM_WEBHOOK_SECRET);form.set('allowed_updates',JSON.stringify(['callback_query','message']));form.set('drop_pending_updates','false');
    await setupTelegram('setWebhook',form);
    const info=await setupTelegram('getWebhookInfo',new FormData());
    return {ok:true,webhook:info.url===url,pending:info.pending_update_count||0};
  }
  return {ensureMediaButtons,maintainMediaButtons,received,list,get,contact,saveContact,decision,organize,webhook,setup,flushOutbox:outbox.flush,maintainBotChat:botChat.maintenance};
}
