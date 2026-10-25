export const STATUS_LABELS={received:'Получена',processing:'На оценке',confirmed:'Заказ подтверждён',completed:'Выполнен',cancelled:'Отменён'};
const next={received:'processing',processing:'confirmed',confirmed:'completed'};
const actions={processing:'Взять на оценку',confirmed:'Подтвердить заказ',completed:'Завершить'};
export function statusKeyboard(row,confirmCancel=false){
  const data=action=>`vg:${row.id}:${row.business_version||0}:${action}`;
  if(['completed','cancelled'].includes(row.business_status))return {inline_keyboard:[]};
  if(confirmCancel)return {inline_keyboard:[[{text:'Да, отменить заказ',callback_data:data('cancelled')}],[{text:'Назад',callback_data:data('back')}]]};
  const action=next[row.business_status||'received'];
  return {inline_keyboard:[...(action?[[{text:actions[action],callback_data:data(action)}]]:[]),[{text:'Отменить',callback_data:data('ask_cancel')}]]};
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
  async function list(request,env,validateInitData){
    const data=await smallJson(request),user=await validateInitData(data.initData,env.BOT_TOKEN);
    const rows=(await stmt(env,"SELECT * FROM orders WHERE user_id=? AND state='sent' ORDER BY created_at DESC LIMIT 50",String(user.id)).all()).results;
    const events=(await stmt(env,'SELECT e.* FROM order_status_events e JOIN orders o ON o.id=e.order_id WHERE o.user_id=? ORDER BY e.changed_at DESC LIMIT 300',String(user.id)).all()).results;
    return {ok:true,orders:rows.map(row=>({
      ...JSON.parse(row.payload),serverId:row.id,requestId:row.request_id,status:'sent',businessStatus:row.business_status,
      statusVersion:row.business_version,statusUpdatedAt:row.status_updated_at,createdAt:row.created_at,photoCount:row.photo_count,
      history:events.filter(e=>e.order_id===row.id).map(e=>({status:e.status,at:e.changed_at})).reverse()
    }))};
  }
  async function edit(env,row,message,confirmCancel=false){
    const form=new FormData();form.set('chat_id',env.TELEGRAM_CHAT_ID);form.set('message_id',String(row.message_id));
    form.set('reply_markup',JSON.stringify(statusKeyboard(row,confirmCancel)));
    // On cancellation confirmation, leave the message text unchanged.
    if(confirmCancel||!message?.text)return telegram(env,'editMessageReplyMarkup',form);
    const base=message.text.replace(/\n\nСтатус: [^\n]*$/,'');
    form.set('text',base+'\n\nСтатус: '+STATUS_LABELS[row.business_status]);
    return telegram(env,'editMessageText',form);
  }
  async function webhook(request,env){
    if(!secretMatches(request.headers.get('X-Telegram-Bot-Api-Secret-Token'),env.TELEGRAM_WEBHOOK_SECRET))fail(403,'WEBHOOK','Доступ запрещён.');
    const update=await smallJson(request),q=update.callback_query;
    if(!q)return {ok:true};
    if(typeof q.id!=='string'||q.id.length>128)return {ok:true};
    const answer=async text=>{const f=new FormData();f.set('callback_query_id',q.id);f.set('text',text);try{await telegram(env,'answerCallbackQuery',f)}catch{}};
    if(String(q.message?.chat?.id)!==String(env.TELEGRAM_CHAT_ID)){await answer('Управление доступно только в группе заказов.');return {ok:true}}
    const match=/^vg:(VG-[A-F0-9]{12}):(\d{1,8}):(processing|confirmed|completed|ask_cancel|cancelled|back)$/.exec(q.data||'');
    if(!match){await answer('Кнопка недоступна.');return {ok:true}}
    if(!Number.isSafeInteger(q.from?.id)){await answer('Не удалось проверить пользователя.');return {ok:true}}
    const memberForm=new FormData();memberForm.set('chat_id',env.TELEGRAM_CHAT_ID);memberForm.set('user_id',String(q.from.id));
    let member;try{member=await telegram(env,'getChatMember',memberForm)}catch{await answer('Не удалось проверить права администратора группы.');return {ok:true}}
    if(!['creator','administrator'].includes(member.status)){await answer('Изменять статус могут только администраторы группы.');return {ok:true}}
    const [,id,versionString,action]=match,version=Number(versionString);
    let row=await stmt(env,'SELECT * FROM orders WHERE id=?',id).first();
    if(!row||row.message_id!==q.message.message_id){await answer('Заявка не найдена.');return {ok:true}}
    if(row.state!=='sent'){await answer('Заявка ещё доставляется. Попробуйте чуть позже.');return {ok:true}}
    if(row.business_version!==version){
      try{await edit(env,row,q.message)}catch{}
      await answer('Статус уже обновлён: '+STATUS_LABELS[row.business_status]);return {ok:true};
    }
    if(['ask_cancel','back'].includes(action)){
      try{await edit(env,row,q.message,action==='ask_cancel');await answer(action==='ask_cancel'?'Подтвердите отмену заказа.':'')}catch{await answer('Не удалось обновить кнопки. Повторите попытку.')}
      return {ok:true};
    }
    if(!next[row.business_status]||(action!==next[row.business_status]&&action!=='cancelled')){await answer('Этот переход недоступен.');return {ok:true}}
    const now=Date.now();
    await env.DB.batch([
      stmt(env,'INSERT OR IGNORE INTO order_status_events(event_id,order_id,status,actor_id,changed_at) SELECT ?,id,?,?,? FROM orders WHERE id=? AND business_version=? AND business_status=? AND state=\'sent\'',q.id,action,String(q.from.id),now,id,version,row.business_status),
      stmt(env,'UPDATE orders SET business_status=?,business_version=business_version+1,status_updated_at=? WHERE id=? AND business_version=? AND business_status=? AND EXISTS(SELECT 1 FROM order_status_events WHERE event_id=? AND order_id=orders.id AND status=?)',action,now,id,version,row.business_status,q.id,action)
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
    const form=new FormData();form.set('url',url);form.set('secret_token',env.TELEGRAM_WEBHOOK_SECRET);form.set('allowed_updates',JSON.stringify(['callback_query']));form.set('drop_pending_updates','false');
    await setupTelegram('setWebhook',form);
    const info=await setupTelegram('getWebhookInfo',new FormData());
    return {ok:true,webhook:info.url===url,pending:info.pending_update_count||0};
  }
  return {received,list,webhook,setup};
}
