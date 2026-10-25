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
export function statusKeyboard(row,confirmCancel=false){
 const data=action=>`vg:${row.id}:${row.business_version||0}:${action}`;
 const details=row.message_kind&&row.message_kind!=='text'?[[{text:'Полная заявка',callback_data:data('details')}]]:[];
 if(terminal.has(row.business_status))return {inline_keyboard:details};
 if(confirmCancel)return {inline_keyboard:[[{text:'Да, закрыть заявку',callback_data:data('cancelled')}],[{text:'Назад',callback_data:data('back')}]]};
 const buttons=row.business_status==='received'?[{text:'Взять на оценку',callback_data:data('processing')}]:[{text:row.business_status==='quoted'?'Изменить цену':'Назвать цену',callback_data:data('price')}];
 return {inline_keyboard:[buttons,[{text:'Закрыть заявку',callback_data:data('ask_cancel')}],...details]};
}
export function createStatusService({telegram,stmt,fail}){
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
   ...JSON.parse(row.payload),serverId:row.id,requestId:row.request_id,status:'sent',businessStatus:row.business_status,
   statusVersion:row.business_version,statusUpdatedAt:row.status_updated_at,createdAt:row.created_at,photoCount:row.photo_count,
   quote:row.quote_amount_minor?{amountMinor:row.quote_amount_minor,currency:'BYN',note:row.quote_note,revision:row.quote_revision}:null,
   customerNote:row.customer_note||'',customerVisibility:row.customer_visibility||'active',history:events.filter(e=>e.order_id===row.id).map(e=>({status:e.status,at:e.changed_at})).reverse()
  }}
  async function list(request,env,validateInitData){
   const data=await smallJson(request),user=await validateInitData(data.initData,env.BOT_TOKEN);
   const rows=(await stmt(env,"SELECT * FROM orders WHERE user_id=? AND state='sent' AND customer_visibility!='deleted' ORDER BY CASE customer_visibility WHEN 'active' THEN 0 ELSE 1 END,created_at DESC LIMIT 100",String(user.id)).all()).results;
   const events=(await stmt(env,'SELECT e.* FROM order_status_events e JOIN orders o ON o.id=e.order_id WHERE o.user_id=? ORDER BY e.changed_at DESC LIMIT 300',String(user.id)).all()).results;
   return {ok:true,orders:rows.map(row=>publicOrder(row,events))};
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
  async function saveContact(env,user,phone){
    await stmt(env,'INSERT INTO customer_contacts(user_id,phone,first_name,updated_at) VALUES(?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET phone=excluded.phone,first_name=excluded.first_name,updated_at=excluded.updated_at',String(user.id),phone,String(user.first_name||'').slice(0,60),Date.now()).run();
  }
  async function admin(env,id){
   const f=new FormData();f.set('chat_id',env.TELEGRAM_CHAT_ID);f.set('user_id',String(id));
   try{const member=await telegram(env,'getChatMember',f);return ['creator','administrator'].includes(member.status)}catch{return false}
  }
  function managerText(row,message){
   const w=JSON.parse(row.payload),base=row.manager_text||message?.text?.replace(/\n\nСтатус: [^\n]*$/,'')||[`Заявка на оценку ${row.id}`,w.desc||'Без описания',`Адрес: ${w.addr}`,w.to?`Куда: ${w.to}`:'',`Телефон: ${w.phone}`,`Клиент ID ${row.user_id}`].filter(Boolean).join('\n');
   return base+'\n\nСтатус: '+STATUS_LABELS[row.business_status]+(row.quote_amount_minor?'\nПредложение: '+money(row.quote_amount_minor)+(row.quote_note?'\n'+row.quote_note.replace(/\s+/g,' '):''):'')+(row.customer_note?'\nВопрос клиента: '+row.customer_note.replace(/\s+/g,' '):'');
  }
  async function edit(env,row,message,confirmCancel=false){
   const form=new FormData();form.set('chat_id',env.TELEGRAM_CHAT_ID);form.set('message_id',String(row.message_id));form.set('reply_markup',JSON.stringify(statusKeyboard(row,confirmCancel)));
   if(confirmCancel||(!message?.text&&!row.manager_text))return telegram(env,'editMessageReplyMarkup',form);
   if(row.message_kind&&row.message_kind!=='text'){form.set('caption',compactCaption(managerText(row,message)));return telegram(env,'editMessageCaption',form)}
   form.set('text',managerText(row,message));return telegram(env,'editMessageText',form);
  }
  async function ensureMediaButtons(env,row){
   if(row.message_kind!=='album'||row.buttons_version)return;
   const form=new FormData();form.set('chat_id',env.TELEGRAM_CHAT_ID);form.set('message_id',String(row.message_id));form.set('reply_markup',JSON.stringify(statusKeyboard(row)));
   await telegram(env,'editMessageReplyMarkup',form);
   await stmt(env,'UPDATE orders SET buttons_version=1 WHERE id=?',row.id).run();
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
   const changes=await env.DB.batch([
    stmt(env,"INSERT OR IGNORE INTO order_status_events(event_id,order_id,status,actor_id,changed_at) SELECT ?,id,'quoted',?,? FROM orders WHERE id=? AND business_version=?",eventId,String(message.from.id),now,row.id,row.business_version),
    stmt(env,"UPDATE orders SET business_status='quoted',business_version=business_version+1,status_updated_at=?,quote_amount_minor=?,quote_note=?,quote_revision=quote_revision+1,customer_note='' WHERE id=? AND business_version=? AND EXISTS(SELECT 1 FROM order_status_events WHERE event_id=? AND order_id=orders.id)",now,quote.amount,quote.note,row.id,row.business_version,eventId)
   ]);
   if(!changes[1].meta.changes)return;
   row=await stmt(env,'SELECT * FROM orders WHERE id=?',row.id).first();
   try{await edit(env,row)}catch{}
   let notified=false;
   if(env.MINI_APP_URL||/^[A-Za-z0-9_]+$/.test(env.BOT_USERNAME||'')){
    const f=new FormData();f.set('chat_id',row.user_id);f.set('text',`Расчёт готов: ${money(quote.amount)}${quote.note?'\n'+quote.note:''}\nПосмотрите предложение в приложении — можно согласиться или уточнить условия.`);const button={text:'Посмотреть предложение'};if(env.MINI_APP_URL){const url=new URL(env.MINI_APP_URL);url.searchParams.set('order',row.id);button.web_app={url:url.href}}else button.url=`https://t.me/${env.BOT_USERNAME}?startapp=order_${row.id}`;f.set('reply_markup',JSON.stringify({inline_keyboard:[[button]]}));
    try{await telegram(env,'sendMessage',f);notified=true}catch{}
   }
   await reply(env,message,notified?'Предложение сохранено, клиенту отправлено уведомление. Ждём его решения.':'Предложение сохранено в приложении. Личное уведомление не доставлено — при необходимости свяжитесь с клиентом по телефону.');
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
    if(row.business_status!=='quoted'||!row.quote_amount_minor||row.business_version!==data.version)fail(409,'QUOTE_CHANGED','Предложение изменилось. Обновите заявку и посмотрите актуальную цену.');
    const now=Date.now();const changes=await env.DB.batch([
     stmt(env,"INSERT OR IGNORE INTO order_status_events(event_id,order_id,status,actor_id,changed_at) SELECT ?,id,?,?,? FROM orders WHERE id=? AND user_id=? AND business_version=? AND business_status='quoted'",eventId,target,String(user.id),now,row.id,String(user.id),data.version),
     stmt(env,"UPDATE orders SET business_status=?,business_version=business_version+1,status_updated_at=?,customer_note=? WHERE id=? AND user_id=? AND business_version=? AND business_status='quoted' AND EXISTS(SELECT 1 FROM order_status_events WHERE event_id=? AND order_id=orders.id AND status=?)",target,now,note,row.id,String(user.id),data.version,eventId,target)
    ]);
    if(!changes[1].meta.changes)fail(409,'QUOTE_CHANGED','Предложение уже обновлено.');
    row=await stmt(env,'SELECT * FROM orders WHERE id=?',row.id).first();
    try{await edit(env,row)}catch{}
    const payload=JSON.parse(row.payload),username=/^[A-Za-z0-9_]{5,32}$/.test(user.username||'')?user.username:'';
    const contact=`\n\nТелефон: ${payload.phone}${username?'\nTelegram: @'+username:''}`;
    const text=data.action==='accept'?`Клиент принял стоимость ${money(row.quote_amount_minor)} по заявке ${row.id}.\nСвяжитесь с ним для согласования времени.`:`Клиент просит уточнить условия по заявке ${row.id}.${note?'\n'+note:''}`;
    const markup={inline_keyboard:[[{text:'Написать клиенту в Telegram',url:username?'https://t.me/'+username:'tg://user?id='+row.user_id}]]};
    await reply(env,{message_id:row.message_id},text+contact,markup);
   }
   const events=(await stmt(env,'SELECT * FROM order_status_events WHERE order_id=? ORDER BY changed_at DESC',row.id).all()).results;
   return {ok:true,order:publicOrder(row,events)};
  }
  async function organize(request,env,validateInitData){
   const data=await smallJson(request),user=await validateInitData(data.initData,env.BOT_TOKEN);
   if(!['archive','restore','delete','cancel'].includes(data.action)||typeof data.id!=='string')fail(400,'ACTION','Недоступное действие.');
   let row=await stmt(env,"SELECT * FROM orders WHERE id=? AND user_id=? AND state='sent'",data.id,String(user.id)).first();
   if(!row)fail(404,'NOT_FOUND','Заявка не найдена.');
   if(data.action==='cancel'&&row.business_status!=='cancelled'){
    if(!['received','processing','quoted','discussion','accepted'].includes(row.business_status))fail(409,'CANNOT_CANCEL','Эту оценку уже нельзя отменить в приложении.');
    if(data.version!==row.business_version)fail(409,'STALE','Заявка обновилась. Обновите список и повторите действие.');
    const eventId='customer-cancel:'+row.id+':'+row.business_version,now=Date.now();
    const changes=await env.DB.batch([
     stmt(env,"INSERT OR IGNORE INTO order_status_events(event_id,order_id,status,actor_id,changed_at) SELECT ?,id,'cancelled',?,? FROM orders WHERE id=? AND user_id=? AND business_version=?",eventId,String(user.id),now,row.id,String(user.id),data.version),
     stmt(env,"UPDATE orders SET business_status='cancelled',business_version=business_version+1,status_updated_at=?,customer_visibility='archived' WHERE id=? AND user_id=? AND business_version=? AND EXISTS(SELECT 1 FROM order_status_events WHERE event_id=? AND order_id=orders.id)",now,row.id,String(user.id),data.version,eventId)
    ]);
    if(!changes[1].meta.changes)fail(409,'STALE','Заявка уже обновилась.');
    row=await stmt(env,'SELECT * FROM orders WHERE id=?',row.id).first();
    try{await edit(env,row)}catch{}
    await reply(env,{message_id:row.message_id},'Клиент отменил запрос на оценку '+row.id+'.');
   }else if(data.action!=='cancel'){
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
      try{await edit(env,row,q.message,action==='ask_cancel');await answer(action==='ask_cancel'?'Подтвердите отмену заказа.':'')}catch{await answer('Не удалось обновить кнопки. Повторите попытку.')}
      return {ok:true};
    }
    const permitted=(action==='processing'&&row.business_status==='received')||(action==='cancelled'&&!terminal.has(row.business_status));
    if(!permitted){await answer('Этот переход недоступен: сначала назовите цену, затем дождитесь решения клиента.');return {ok:true}}
    const now=Date.now();
    await env.DB.batch([
      stmt(env,'INSERT OR IGNORE INTO order_status_events(event_id,order_id,status,actor_id,changed_at) SELECT ?,id,?,?,? FROM orders WHERE id=? AND business_version=? AND business_status=? AND state=\'sent\'',q.id,action,String(q.from.id),now,id,version,row.business_status),
      stmt(env,"UPDATE orders SET business_status=?,business_version=business_version+1,status_updated_at=?,customer_visibility=CASE WHEN customer_visibility='deleted' THEN 'deleted' WHEN ?='cancelled' THEN 'archived' ELSE customer_visibility END WHERE id=? AND business_version=? AND business_status=? AND EXISTS(SELECT 1 FROM order_status_events WHERE event_id=? AND order_id=orders.id AND status=?)",action,now,action,id,version,row.business_status,q.id,action)
    ]);
    row=await stmt(env,'SELECT * FROM orders WHERE id=?',id).first();
    // Persist first: even if Telegram cannot edit the message, the app sees the actual status.
    try{await edit(env,row,q.message)}catch{}
    await answer('Статус: '+STATUS_LABELS[row.business_status]);return {ok:true};
  }
  async function setup(request,env){
    const key=request.headers.get('authorization')?.replace(/^Bearer /,'');
    if(!secretMatches(key,env.ADMIN_SETUP_SECRET))fail(403,'SETUP_AUTH','Доступ запрещён.');
    const body=await smallJson(request);
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
  return {ensureMediaButtons,received,list,contact,saveContact,decision,organize,webhook,setup};
}
