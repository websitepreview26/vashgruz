import {createStatusService,statusKeyboard,compactCaption} from './statuses.mjs';
// HTTP/FormData + Telegram API. Only persistence and env bindings are Cloudflare-specific.
const MAX_BODY = 12 * 1024 * 1024;
const MAX_PHOTO = 2 * 1024 * 1024;
const names = {trash:'Вывоз мусора',flat:'Квартирный переезд',office:'Офисный переезд',load:'Услуги грузчиков',rig:'Такелаж',dem:'Демонтаж'};
const slots = ['По согласованию','Утро: 8:00–12:00','День: 12:00–17:00','Вечер: 17:00–21:00'];
const enc = new TextEncoder();
class HttpError extends Error {
  constructor(status, code, message) { super(message); this.status=status; this.code=code; }
}
const fail = (status,code,message) => {throw new HttpError(status,code,message)};
const hex = bytes => Array.from(new Uint8Array(bytes),x=>x.toString(16).padStart(2,'0')).join('');
async function hmac(key,text){
  const k=await crypto.subtle.importKey('raw',key,{name:'HMAC',hash:'SHA-256'},false,['sign']);
  return crypto.subtle.sign('HMAC',k,enc.encode(text));
}
export async function validateInitData(raw,token,now=Math.floor(Date.now()/1000)){
  if(typeof raw!=='string'||raw.length>16000)fail(401,'AUTH','Откройте приложение заново через Telegram.');
  const params=new URLSearchParams(raw),hash=params.get('hash');
  if(!/^[a-f0-9]{64}$/i.test(hash||''))fail(401,'AUTH','Откройте приложение заново через Telegram.');
  const entries=[...params.entries()];
  if(new Set(entries.map(([k])=>k)).size!==entries.length)fail(401,'AUTH','Неверная подпись Telegram.');
  const text=entries.filter(([k])=>k!=='hash').sort(([a],[b])=>a<b?-1:a>b?1:0).map(([k,v])=>`${k}=${v}`).join('\n');
  const secret=await hmac(enc.encode('WebAppData'),token);
  const expected=hex(await hmac(secret,text));
  let diff=0;for(let i=0;i<64;i++)diff|=expected.charCodeAt(i)^hash.toLowerCase().charCodeAt(i);
  const date=Number(params.get('auth_date'));
  if(diff||!Number.isSafeInteger(date)||date>now+60||now-date>86400)fail(401,'AUTH','Сессия истекла. Откройте приложение заново через Telegram.');
  let user;try{user=JSON.parse(params.get('user'))}catch{}
  if(!user||!Number.isSafeInteger(user.id)||user.id<=0)fail(401,'AUTH','Не удалось подтвердить пользователя Telegram.');
  return user;
}
export function validateOrder(raw){
  if(!raw||typeof raw!=='object'||Array.isArray(raw))fail(400,'ORDER','Проверьте данные заявки.');
  const text=(key,max,required=false)=>{
    const v=raw[key];
    if(typeof v!=='string'||v.length>max||(required&&v.trim().length<5))fail(400,'ORDER','Проверьте адрес и данные заявки.');
    return v.trim().replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g,'');
  };
  if(!Object.hasOwn(names,raw.sv))fail(400,'ORDER','Выберите услугу.');
  const w={sv:raw.sv,desc:text('desc',1000),addr:text('addr',220,true),to:text('to',220,raw.sv==='flat'||raw.sv==='office'),name:raw.name===undefined?'':text('name',60),phone:text('phone',25)};
  if(!/^\+?[1-9]\d{8,14}$/.test(w.phone.replace(/[\s()-]/g,'')))fail(400,'ORDER','Проверьте номер телефона.');
  for(const k of ['floor','toFloor']){
    if(!Number.isInteger(raw[k])||raw[k]<1||raw[k]>50)fail(400,'ORDER','Проверьте этаж.');
    w[k]=raw[k];
  }
  for(const k of ['lift','toLift','dis']){
    if(typeof raw[k]!=='boolean')fail(400,'ORDER','Проверьте условия заказа.');w[k]=raw[k];
  }
  if(!Number.isInteger(raw.slot)||raw.slot<0||raw.slot>3)fail(400,'ORDER','Проверьте время.');w.slot=raw.slot;
  const date=text('date',10),today=new Date().toLocaleDateString('en-CA',{timeZone:'Europe/Minsk'});
  if(date&&(!/^\d{4}-\d{2}-\d{2}$/.test(date)||Number.isNaN(Date.parse(date+'T12:00:00Z'))||new Date(date+'T12:00:00Z').toISOString().slice(0,10)!==date||date<today))fail(400,'ORDER','Выберите сегодняшнюю или будущую дату.');
  w.date=date;return w;
}
export async function validatePhotos(files){
  if(files.length>5)fail(400,'PHOTOS','Можно прикрепить до 5 фотографий.');
  for(const f of files){
    if(!(f instanceof File)||!f.size||f.size>MAX_PHOTO)fail(400,'PHOTOS','Фото должно быть не больше 2 МБ после подготовки.');
    const b=new Uint8Array(await f.slice(0,12).arrayBuffer());
    const jpeg=f.type==='image/jpeg'&&b[0]===255&&b[1]===216&&b[2]===255;
    const png=f.type==='image/png'&&[137,80,78,71,13,10,26,10].every((v,i)=>b[i]===v);
    const webp=f.type==='image/webp'&&String.fromCharCode(...b.slice(0,4))==='RIFF'&&String.fromCharCode(...b.slice(8,12))==='WEBP';
    if(!jpeg&&!png&&!webp)fail(400,'PHOTOS','Не удалось прочитать фотографию. Выберите другой снимок.');
  }
}
async function boundedForm(request){
  if(!(request.headers.get('content-type')||'').startsWith('multipart/form-data'))fail(415,'FORMAT','Неверный формат заявки.');
  if(Number(request.headers.get('content-length'))>MAX_BODY)fail(413,'SIZE','Слишком большой размер фотографий.');
  if(!request.body)fail(400,'FORMAT','Пустая заявка.');
  const reader=request.body.getReader(),chunks=[];let size=0;
  while(true){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>MAX_BODY){await reader.cancel();fail(413,'SIZE','Слишком большой размер фотографий.')}chunks.push(value)}
  try{return await new Response(new Blob(chunks),{headers:{'content-type':request.headers.get('content-type')}}).formData()}
  catch{fail(400,'FORMAT','Не удалось прочитать заявку.')}
}
export function orderMessage(w,id,user,photoCount){
  const floor=(f,l)=>`${f} этаж, ${l?'есть лифт':'без лифта'}`;
  return [
    `Заявка на оценку ${id}`,names[w.sv],w.desc.replace(/\s+/g,' ')||'Без описания',
    `Адрес: ${w.addr}`,floor(w.floor,w.lift),
    ...((w.sv==='flat'||w.sv==='office')?[`Куда: ${w.to}`,floor(w.toFloor,w.toLift)]:[]),
    ...(w.dis?['Нужна разборка']:[]),`Когда: ${w.date||'По согласованию'}${w.date?', '+slots[w.slot]:''}`,
    `Имя: ${w.name||user.first_name||'Не указано'}`,`Телефон: ${w.phone}`,
    `Клиент: ${user.username?'@'+user.username+' · ':''}ID ${user.id}`,`Фото: ${photoCount}`
  ].join('\n');
}
// A definitive Telegram error is safe to retry; a lost network response is ambiguous.
async function telegram(env,method,body){
  let response,data;
  const actualBody=[...body.values()].some(v=>v instanceof Blob)?body:new URLSearchParams([...body.entries()]);
  try{response=await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`,{method:'POST',body:actualBody,signal:AbortSignal.timeout(25000)})}
  catch(e){const error=new HttpError(409,'UNCERTAIN','Связь прервалась. Проверяем доставку; повторная отправка заблокирована, чтобы не создать дубликат.');error.safeDiagnostic=e.name;throw error}
  try{data=await response.json()}
  catch{const error=new HttpError(409,'UNCERTAIN','Не удалось подтвердить ответ Telegram.');error.safeDiagnostic='HTTP '+response.status+', '+(response.headers.get('content-type')||'no content type');throw error}
  if(data.ok!==true){
    if(method.startsWith('editMessage')&&Number(data.error_code)===400&&/message is not modified/i.test(String(data.description||'')))return true;
    if(response.status>=500||Number(data.error_code)>=500)throw new HttpError(409,'UNCERTAIN','Не удалось подтвердить доставку. Заявка требует проверки.');
    throw new HttpError(502,'DELIVERY','Не удалось отправить заявку. Попробуйте ещё раз позже.');
  }
  return data.result;
}
const bodyFor=env=>{const form=new FormData();form.set('chat_id',env.TELEGRAM_CHAT_ID);return form};
const stmt=(env,sql,...args)=>env.DB.prepare(sql).bind(...args);
const statusService=createStatusService({telegram,stmt,fail});
const receipt=row=>({ok:true,id:row.id,photoCount:row.photo_count,businessStatus:row.business_status||'received',statusUpdatedAt:row.status_updated_at||row.updated_at});
async function dispatch(env,row,w,user,photos){
  if(row.state==='sent'){await statusService.ensureMediaButtons(env,row);await statusService.received(env,row.id);return receipt(row)}
  if(['sending_text','sending_photos','uncertain'].includes(row.state))fail(409,'UNCERTAIN','Эта заявка уже отправляется или требует проверки доставки. Не создавайте её повторно.');
  let state=row.state,messageId=row.message_id;
  if(state==='received'){
    const lock=await stmt(env,"UPDATE orders SET state='sending_text', updated_at=? WHERE id=? AND state='received'",Date.now(),row.id).run();
    if(!lock.meta.changes)fail(409,'BUSY','Заявка уже отправляется. Подождите немного.');
    const base=orderMessage(w,row.id,user,photos.length),kind=photos.length>1?'album':photos.length?'photo':'text';
    const form=bodyFor(env);form.set('protect_content','true');
    const caption=compactCaption(base+'\n\nСтатус: Получена');
    if(kind==='text')form.set('text',base+'\n\nСтатус: Получена');
    else if(kind==='photo'){form.set('photo',photos[0],'photo.jpg');form.set('caption',caption)}
    else{
      form.set('media',JSON.stringify(photos.map((file,i)=>{
        form.set('photo'+i,file,`photo-${i+1}.jpg`);
        return {type:'photo',media:'attach://photo'+i,...(i===0?{caption}:{})};
      })));
    }
    if(kind!=='album')form.set('reply_markup',JSON.stringify(statusKeyboard({...row,message_kind:kind})));
    let result;
    try{result=await telegram(env,kind==='text'?'sendMessage':kind==='photo'?'sendPhoto':'sendMediaGroup',form)}
    catch(e){await stmt(env,'UPDATE orders SET state=?,updated_at=? WHERE id=?',e.code==='DELIVERY'?'received':'uncertain',Date.now(),row.id).run();throw e}
    const messages=Array.isArray(result)?result:[result];
    messageId=messages[0].message_id;state='sent';
    const ids=messages.map(m=>m.photo?.at(-1)?.file_id).filter(Boolean);
    await stmt(env,'UPDATE orders SET state=?,message_id=?,updated_at=?,buttons_version=?,manager_text=?,message_kind=?,photo_file_ids=? WHERE id=?',state,messageId,Date.now(),kind==='album'?0:1,base,kind,JSON.stringify(ids),row.id).run();
    row=await stmt(env,'SELECT * FROM orders WHERE id=?',row.id).first();
    await statusService.ensureMediaButtons(env,row);
  }
  // Resume pre-upgrade deliveries whose separate text message already exists.
  if(state==='text_sent'){
    const lock=await stmt(env,"UPDATE orders SET state='sending_photos',updated_at=? WHERE id=? AND state='text_sent'",Date.now(),row.id).run();
    if(!lock.meta.changes)fail(409,'BUSY','Фотографии уже отправляются.');
    const form=bodyFor(env);form.set('protect_content','true');form.set('reply_parameters',JSON.stringify({message_id:messageId}));
    if(photos.length===1){form.set('photo',photos[0],'photo.jpg');form.set('caption',`Фото к заявке ${row.id}`)}
    else{
      const media=photos.map((file,i)=>{form.set('photo'+i,file,`photo-${i+1}.jpg`);return {type:'photo',media:'attach://photo'+i,...(i===0?{caption:`Фото к заявке ${row.id}`}:{})}});
      form.set('media',JSON.stringify(media));
    }
    let result;
    try{result=await telegram(env,photos.length===1?'sendPhoto':'sendMediaGroup',form)}
    catch(e){await stmt(env,'UPDATE orders SET state=?,updated_at=? WHERE id=?',e.code==='DELIVERY'?'text_sent':'uncertain',Date.now(),row.id).run();if(e.code==='DELIVERY')e.message='Заявка доставлена, фотографии — нет. Нажмите повторно: отправим только фото.';throw e}
    const messages=Array.isArray(result)?result:[result];
    const ids=messages.map(m=>m.photo?.at(-1)?.file_id).filter(Boolean);
    await stmt(env,"UPDATE orders SET state='sent',photo_file_ids=?,updated_at=? WHERE id=?",JSON.stringify(ids),Date.now(),row.id).run();
  }
  await statusService.received(env,row.id);
  return receipt(await stmt(env,'SELECT * FROM orders WHERE id=?',row.id).first());
}
export default {
  async fetch(request,env){
    const origin=request.headers.get('origin'),allowed=env.ALLOWED_ORIGIN;
    const headers={'content-type':'application/json; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff','vary':'Origin'};
    if(origin&&origin===allowed){headers['access-control-allow-origin']=origin;headers['access-control-allow-methods']='POST, GET, OPTIONS';headers['access-control-allow-headers']='Content-Type'}
    const json=(data,status=200)=>new Response(JSON.stringify(data),{status,headers});
    try{
      const path=new URL(request.url).pathname;
      if(path==='/health'&&request.method==='GET')return json({ok:true,configured:!!(env.DB&&env.BOT_TOKEN&&env.TELEGRAM_CHAT_ID),statuses:!!env.TELEGRAM_WEBHOOK_SECRET});
      if(path==='/telegram/webhook'||path==='/internal/telegram/setup'){
        if(request.method!=='POST')fail(405,'METHOD','Метод не поддерживается.');
        if(!env.DB||!env.BOT_TOKEN||!env.TELEGRAM_CHAT_ID)fail(503,'SETUP','Не настроено.');
        return json(await (path==='/telegram/webhook'?statusService.webhook(request,env):statusService.setup(request,env)));
      }
      if(!allowed||origin!==allowed)fail(403,'ORIGIN','Откройте мини-приложение через Telegram.');
      if(request.method==='OPTIONS')return new Response(null,{status:204,headers});
      if(!['/api/orders','/api/orders/list','/api/contact','/api/orders/decision','/api/orders/organize'].includes(path))fail(404,'NOT_FOUND','Не найдено.');
      if(request.method!=='POST')fail(405,'METHOD','Метод не поддерживается.');
      if(!env.DB||!env.BOT_TOKEN||!env.TELEGRAM_CHAT_ID)fail(503,'SETUP','Приём заявок ещё настраивается. Попробуйте позже.');
      if(path==='/api/orders/list')return json(await statusService.list(request,env,validateInitData));
      if(path==='/api/orders/decision')return json(await statusService.decision(request,env,validateInitData));
      if(path==='/api/orders/organize')return json(await statusService.organize(request,env,validateInitData));
      if(path==='/api/contact')return json(await statusService.contact(request,env,validateInitData));
      const form=await boundedForm(request),user=await validateInitData(form.get('initData'),env.BOT_TOKEN);
      const requestId=form.get('requestId');
      if(typeof requestId!=='string'||!/^[a-zA-Z0-9_-]{16,80}$/.test(requestId))fail(400,'ID','Неверный номер запроса.');
      let raw;try{raw=JSON.parse(form.get('order'))}catch{fail(400,'ORDER','Не удалось прочитать заявку.')}
      const w=validateOrder(raw),photos=form.getAll('photos');await validatePhotos(photos);
      w.name=String(user.first_name||'').slice(0,60);
      const hashes=await Promise.all(photos.map(async p=>hex(await crypto.subtle.digest('SHA-256',await p.arrayBuffer()))));
      const fingerprint=hex(await crypto.subtle.digest('SHA-256',enc.encode(JSON.stringify([w,hashes]))));
      let row=await stmt(env,'SELECT * FROM orders WHERE user_id=? AND request_id=?',String(user.id),requestId).first();
      if(!row){
        const count=await stmt(env,'SELECT COUNT(*) AS n FROM orders WHERE user_id=? AND created_at>?',String(user.id),Date.now()-3600000).first();
        if(count.n>=10)fail(429,'RATE','Слишком много заявок. Попробуйте позже.');
        const id='VG-'+crypto.randomUUID().replaceAll('-','').slice(0,12).toUpperCase(),now=Date.now();
        await stmt(env,'INSERT OR IGNORE INTO orders (request_id,user_id,id,fingerprint,payload,photo_count,created_at,updated_at) SELECT ?,?,?,?,?,?,?,? WHERE (SELECT COUNT(*) FROM orders WHERE user_id=? AND created_at>?) < 10',requestId,String(user.id),id,fingerprint,JSON.stringify(w),photos.length,now,now,String(user.id),now-3600000).run();
        row=await stmt(env,'SELECT * FROM orders WHERE user_id=? AND request_id=?',String(user.id),requestId).first();
        if(!row)fail(429,'RATE','Слишком много заявок. Попробуйте позже.');
      }
      if(row.fingerprint!==fingerprint)fail(409,'CHANGED','Заявка уже передана с другими данными. Создайте новую заявку.');
      const result=await dispatch(env,row,w,user,photos);
      await statusService.saveContact(env,user,w.phone);
      return json(result);
    }catch(e){
      // Never log request bodies, Telegram URLs (bot token), or user contact details.
      return json({ok:false,code:e instanceof HttpError?e.code:'INTERNAL',message:e instanceof HttpError?e.message:'Не удалось подтвердить отправку. Данные сохранены; попробуйте позже.'},e instanceof HttpError?e.status:500);
    }
  }
};
