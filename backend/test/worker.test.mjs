import {parseQuote,compactCaption} from '../src/statuses.mjs';
import {test,afterEach} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import worker,{validateInitData,validateOrder,validatePhotos} from '../src/worker.mjs';

const TOKEN='123456789:test-token-for-local-tests-only';
const ORIGIN='https://websitepreview26.github.io';
const originalFetch=globalThis.fetch;
afterEach(()=>{globalThis.fetch=originalFetch});
const enc=new TextEncoder();
async function sign(key,text){
  const k=await crypto.subtle.importKey('raw',key,{name:'HMAC',hash:'SHA-256'},false,['sign']);
  return crypto.subtle.sign('HMAC',k,enc.encode(text));
}
async function auth(overrides={}){
  const p=new URLSearchParams({auth_date:String(Math.floor(Date.now()/1000)),user:JSON.stringify({id:42,first_name:'Тест',username:'local_test'}),...overrides});
  const text=[...p.entries()].sort(([a],[b])=>a<b?-1:a>b?1:0).map(([k,v])=>`${k}=${v}`).join('\n');
  const secret=await sign(enc.encode('WebAppData'),TOKEN);
  p.set('hash',Buffer.from(await sign(secret,text)).toString('hex'));return p.toString();
}
const order=()=>({sv:'trash',desc:'Диван',addr:'Минск, Ленина 1',to:'',floor:1,toFloor:1,lift:true,toLift:true,dis:false,date:'',slot:0,name:'',phone:'+375291234567'});
const photo=()=>new File([new Uint8Array([255,216,255,224,0,0,255,217])],'test.jpg',{type:'image/jpeg'});
function env(){
  const sqlite=new DatabaseSync(':memory:');
  sqlite.exec(readFileSync(new URL('../migrations/0001_orders.sql',import.meta.url),'utf8'));
  sqlite.exec(readFileSync(new URL('../migrations/0002_statuses.sql',import.meta.url),'utf8'));
  sqlite.exec(readFileSync(new URL('../migrations/0003_contacts.sql',import.meta.url),'utf8'));
  sqlite.exec(readFileSync(new URL('../migrations/0004_quotes.sql',import.meta.url),'utf8'));
  sqlite.exec(readFileSync(new URL('../migrations/0005_order_organization.sql',import.meta.url),'utf8'));
  sqlite.exec(readFileSync(new URL('../migrations/0006_media_cards.sql',import.meta.url),'utf8'));
  sqlite.exec(readFileSync(new URL('../migrations/0007_contact_diagnostics.sql',import.meta.url),'utf8'));
  return {MINI_APP_URL:'https://websitepreview26.github.io/vashgruz/',BOT_USERNAME:'vash_gruz_test_bot',BOT_TOKEN:TOKEN,TELEGRAM_CHAT_ID:'-100123456789',ALLOWED_ORIGIN:ORIGIN,DB:{
    prepare(sql){return {bind(...args){return {
      sql,args,
      async first(){return sqlite.prepare(sql).get(...args)||null},
      async all(){return {results:sqlite.prepare(sql).all(...args)}},
      async run(){return {meta:{changes:Number(sqlite.prepare(sql).run(...args).changes)}}}
    }}}},
    async batch(statements){sqlite.exec('BEGIN');try{const results=statements.map(s=>({meta:{changes:Number(sqlite.prepare(s.sql).run(...s.args).changes)}}));sqlite.exec('COMMIT');return results}catch(e){sqlite.exec('ROLLBACK');throw e}}
  },sqlite};
}
async function request({id=crypto.randomUUID(),data=order(),files=[],init,origin=ORIGIN}={}){
  const form=new FormData();form.set('initData',init??await auth());form.set('requestId',id);form.set('order',JSON.stringify(data));
  files.forEach(f=>form.append('photos',f));
  return new Request('https://api.example/api/orders',{method:'POST',headers:{origin},body:form});
}
function telegramMock(handler){
  const calls=[];
  globalThis.fetch=async(url,opts)=>{
    const method=url.split('/').at(-1);calls.push({method,form:opts.body});
    if(handler){const r=await handler(method,calls);if(r)return r}
    const result=method==='sendMessage'?{message_id:99+calls.filter(c=>c.method==='sendMessage').length}:method==='sendPhoto'?{message_id:101,photo:[{file_id:'stored-photo'}]}:[{message_id:101,photo:[{file_id:'stored-1'}]},{message_id:102,photo:[{file_id:'stored-2'}]}];
    return Response.json({ok:true,result});
  };return calls;
}

test('Telegram signature, expiry, tampering and duplicate parameters',async()=>{
  assert.equal((await validateInitData(await auth(),TOKEN)).id,42);
  await assert.rejects(validateInitData((await auth())+'&user=bad',TOKEN),{code:'AUTH'});
  await assert.rejects(validateInitData(await auth({auth_date:'1'}),TOKEN),{code:'AUTH'});
  await assert.rejects(validateInitData(await auth(),TOKEN+'bad'),{code:'AUTH'});
});
test('order validation keeps optional description, rejects invalid dates and missing destination',()=>{
  assert.equal(validateOrder({...order(),desc:''}).desc,'');
  assert.throws(()=>validateOrder({...order(),sv:'flat'}),{code:'ORDER'});
  assert.throws(()=>validateOrder({...order(),phone:'1234'}),{code:'ORDER'});
  assert.throws(()=>validateOrder({...order(),date:'2099-02-30'}),{code:'ORDER'});
  assert.throws(()=>validateOrder({...order(),floor:1.5}),{code:'ORDER'});
  assert.throws(()=>validateOrder({...order(),sv:'__proto__'}),{code:'ORDER'});
});
test('photos enforce count, MIME and byte signature',async()=>{
  await validatePhotos([photo()]);
  await assert.rejects(validatePhotos(Array.from({length:6},photo)),{code:'PHOTOS'});
  await assert.rejects(validatePhotos([new File(['<html>'],'fake.jpg',{type:'image/jpeg'})]),{code:'PHOTOS'});
  await assert.rejects(validatePhotos([new File([new Uint8Array(2*1024*1024+1)],'big.jpg',{type:'image/jpeg'})]),{code:'PHOTOS'});
});
test('CORS and missing configuration reject before any Telegram call',async()=>{
  const e=env(),calls=telegramMock();
  assert.equal((await worker.fetch(await request({origin:'https://evil.example'}),e)).status,403);
  assert.equal((await worker.fetch(await request({origin:'null'}),e)).status,403);
  assert.equal((await worker.fetch(await request(),{...e,BOT_TOKEN:''})).status,503);
  const response=await worker.fetch(new Request('https://api.example/api/orders',{method:'OPTIONS',headers:{origin:ORIGIN}}),e);
  assert.equal(response.status,204);assert.equal(response.headers.get('access-control-allow-origin'),ORIGIN);assert.equal(calls.length,0);
});
test('sends text once; same request returns same receipt; changed contents rejected',async()=>{
  const e=env(),calls=telegramMock(),id=crypto.randomUUID();
  const a=await worker.fetch(await request({id}),e),first=await a.json();assert.equal(a.status,200);assert.equal(first.ok,true);
  const b=await worker.fetch(await request({id}),e);assert.equal((await b.json()).id,first.id);assert.equal(calls.length,1);
  assert.equal((await worker.fetch(await request({id,data:{...order(),desc:'Другие вещи'}}),e)).status,409);
  assert.equal(calls.length,1);assert.equal(e.sqlite.prepare('SELECT state FROM orders').get().state,'sent');
  assert.match(calls[0].form.get('text'),/Минск, Ленина 1/);
});
test('single photo is the order card with caption and controls, without separate text',async()=>{
  const e=env(),calls=telegramMock();
  const r=await worker.fetch(await request({files:[photo()]}),e);assert.equal((await r.json()).ok,true);
  assert.deepEqual(calls.map(c=>c.method),['sendPhoto']);
  assert.match(calls[0].form.get('caption'),/Минск, Ленина 1/);
  assert.equal(calls[0].form.get('reply_parameters'),null);
  assert.match(calls[0].form.get('reply_markup'),/Взять на оценку/);
  const row=e.sqlite.prepare('SELECT * FROM orders').get();
  assert.equal(row.photo_file_ids,'["stored-photo"]');assert.equal(row.message_kind,'photo');assert.equal(row.message_id,101);
});
test('album carries the order caption and receives controls on its first photo',async()=>{
  const e=env(),calls=telegramMock(),id=crypto.randomUUID();
  const r=await worker.fetch(await request({id,files:[photo(),photo()]}),e);assert.equal((await r.json()).photoCount,2);
  assert.deepEqual(calls.map(c=>c.method),['sendMediaGroup','editMessageReplyMarkup']);
  const media=JSON.parse(calls[0].form.get('media'));assert.equal(media.length,2);
  assert.match(media[0].caption,/Заявка на оценку/);assert.equal(media[1].caption,undefined);
  assert.equal(calls[1].form.get('message_id'),'101');assert.match(calls[1].form.get('reply_markup'),/Полная заявка/);
  assert.equal((await worker.fetch(await request({id,files:[photo(),photo()]}),e)).status,200);assert.equal(calls.length,2);
});
test('definitive media rejection retries the combined card without creating text',async()=>{
  let reject=true;const e=env(),id=crypto.randomUUID(),calls=telegramMock(method=>{
    if(method==='sendPhoto'&&reject){reject=false;return Response.json({ok:false,error_code:400},{status:400})}
  });
  const a=await worker.fetch(await request({id,files:[photo()]}),e);assert.equal(a.status,502);
  assert.equal(e.sqlite.prepare('SELECT state FROM orders').get().state,'received');
  const b=await worker.fetch(await request({id,files:[photo()]}),e);assert.equal((await b.json()).ok,true);
  assert.deepEqual(calls.map(c=>c.method),['sendPhoto','sendPhoto']);
});
test('album keyboard failure retries only editing, never uploads the album twice',async()=>{
  let reject=true;const e=env(),id=crypto.randomUUID(),calls=telegramMock(method=>{
    if(method==='editMessageReplyMarkup'&&reject){reject=false;throw Error('Connection lost')}
  });
  assert.equal((await worker.fetch(await request({id,files:[photo(),photo()]}),e)).status,409);
  assert.equal(e.sqlite.prepare('SELECT state FROM orders').get().state,'sent');
  assert.equal((await worker.fetch(await request({id,files:[photo(),photo()]}),e)).status,200);
  assert.deepEqual(calls.map(c=>c.method),['sendMediaGroup','editMessageReplyMarkup','editMessageReplyMarkup']);
});
test('long captions fit Telegram limit and retain contact, addresses and latest status',()=>{
 const text=['Заявка на оценку VG-123456789012','Описание: '+ '📦'.repeat(500),'Адрес: '+ 'А'.repeat(220),'Куда: '+'Б'.repeat(220),'Телефон: +375291234567','Статус: Предложение готово','Предложение: 150 BYN','Условия: '+'В'.repeat(600),'Вопрос клиента: '+'Г'.repeat(400)].join('\n');
 const caption=compactCaption(text);assert(caption.length<=1024);assert.match(caption,/Телефон: \+375291234567/);assert.match(caption,/Статус: Предложение готово/);assert.match(caption,/Предложение: 150 BYN/);assert.match(caption,/Адрес:/);assert.match(caption,/Куда:/);assert.match(caption,/…/);
 assert.equal(compactCaption('Короткая заявка'),'Короткая заявка');
});
test('lost Telegram response blocks automatic duplicates',async()=>{
  const e=env(),id=crypto.randomUUID(),calls=telegramMock(()=>{throw new Error('Network lost')});
  assert.equal((await worker.fetch(await request({id}),e)).status,409);
  assert.equal(e.sqlite.prepare('SELECT state FROM orders').get().state,'uncertain');
  assert.equal((await worker.fetch(await request({id}),e)).status,409);assert.equal(calls.length,1);
});
test('concurrent requests dispatch one copy',async()=>{
  const e=env(),id=crypto.randomUUID(),calls=telegramMock();
  const requests=await Promise.all([request({id}),request({id})]);
  const responses=await Promise.all(requests.map(r=>worker.fetch(r,e)));
  assert(responses.some(r=>r.status===200));assert.equal(calls.length,1);
});
test('per-user hourly limit and bounded body size',async()=>{
  const e=env(),calls=telegramMock();
  for(let i=0;i<10;i++)assert.equal((await worker.fetch(await request(),e)).status,200);
  assert.equal((await worker.fetch(await request(),e)).status,429);assert.equal(calls.length,10);
  const r=await request();r.headers.set('content-length',String(13*1024*1024));
  assert.equal((await worker.fetch(r,e)).status,413);
});

const WEBHOOK_SECRET='test-webhook-secret-with-more-than-32-characters';
async function listRequest(init){return new Request('https://api.example/api/orders/list',{method:'POST',headers:{origin:ORIGIN,'content-type':'application/json'},body:JSON.stringify({initData:init||await auth()})})}
function callbackRequest(id,version,action,{secret=WEBHOOK_SECRET,actor=77,chat=-100123456789,message=100,callbackId=crypto.randomUUID()}={}){
 return new Request('https://api.example/telegram/webhook',{method:'POST',headers:{'content-type':'application/json','X-Telegram-Bot-Api-Secret-Token':secret},body:JSON.stringify({callback_query:{id:callbackId,from:{id:actor},data:`vg:${id}:${version}:${action}`,message:{message_id:message,chat:{id:chat},text:'Новая заявка\\n\\nСтатус: Получена'}}})});
}
function managerMock(role='administrator'){
 return telegramMock(method=>{
  if(method==='getChatMember')return Response.json({ok:true,result:{status:role}});
  if(method==='answerCallbackQuery'||method.startsWith('editMessage'))return Response.json({ok:true,result:true});
 });
}

test('new orders have manager buttons and received event',async()=>{
 const e=env(),calls=managerMock();const result=await (await worker.fetch(await request(),e)).json();
 const buttons=JSON.parse(calls[0].form.get('reply_markup')).inline_keyboard;
 assert.match(buttons[0][0].callback_data,/vg:VG-[A-F0-9]{12}:0:processing/);
 assert.equal(result.businessStatus,'received');assert(result.statusUpdatedAt>0);
 assert.equal(e.sqlite.prepare('SELECT COUNT(*) n FROM order_status_events').get().n,1);
});
test('list returns only the authenticated customer orders',async()=>{
 const e=env();managerMock();await worker.fetch(await request(),e);
 const own=await (await worker.fetch(await listRequest(),e)).json();assert.equal(own.orders.length,1);assert.equal(own.orders[0].history[0].status,'received');
 const other=await auth({user:JSON.stringify({id:99,first_name:'Other'})});
 assert.equal((await (await worker.fetch(await listRequest(other),e)).json()).orders.length,0);
 assert.equal((await worker.fetch(await listRequest('invalid'),e)).status,401);
});
test('manager can assess but cannot accept for customer or mark work completed',async()=>{
 const e={...env(),TELEGRAM_WEBHOOK_SECRET:WEBHOOK_SECRET};managerMock();const {id}=await (await worker.fetch(await request(),e)).json();
 await worker.fetch(callbackRequest(id,0,'processing'),e);
 await worker.fetch(callbackRequest(id,1,'confirmed'),e);await worker.fetch(callbackRequest(id,1,'completed'),e);
 assert.equal(e.sqlite.prepare('SELECT business_status FROM orders').get().business_status,'processing');
});
test('forged webhook, foreign chat, ordinary members and wrong message cannot change status',async()=>{
 const e={...env(),TELEGRAM_WEBHOOK_SECRET:WEBHOOK_SECRET};managerMock('member');const {id}=await (await worker.fetch(await request(),e)).json();
 assert.equal((await worker.fetch(callbackRequest(id,0,'processing',{secret:'invalid'}),e)).status,403);
 await worker.fetch(callbackRequest(id,0,'processing'),e);
 managerMock();await worker.fetch(callbackRequest(id,0,'processing',{chat:-555}),e);
 await worker.fetch(callbackRequest(id,0,'processing',{message:999}),e);
 assert.equal(e.sqlite.prepare('SELECT business_status FROM orders').get().business_status,'received');
});
test('stale and duplicate callbacks do not reverse or repeat transitions',async()=>{
 const e={...env(),TELEGRAM_WEBHOOK_SECRET:WEBHOOK_SECRET};managerMock();const {id}=await (await worker.fetch(await request(),e)).json();
 const opts={callbackId:'same-callback'};
 await worker.fetch(callbackRequest(id,0,'processing',opts),e);await worker.fetch(callbackRequest(id,0,'processing',opts),e);
 await worker.fetch(callbackRequest(id,0,'cancelled'),e);await worker.fetch(callbackRequest(id,1,'completed'),e);
 const row=e.sqlite.prepare('SELECT business_status,business_version FROM orders').get();assert.equal(row.business_status,'processing');assert.equal(row.business_version,1);
 assert.equal(e.sqlite.prepare('SELECT COUNT(*) n FROM order_status_events').get().n,2);
});
test('cancellation asks for confirmation and terminal state cannot be reopened',async()=>{
 const e={...env(),TELEGRAM_WEBHOOK_SECRET:WEBHOOK_SECRET},calls=managerMock();const {id}=await (await worker.fetch(await request(),e)).json();
 await worker.fetch(callbackRequest(id,0,'ask_cancel'),e);assert.equal(e.sqlite.prepare('SELECT business_status FROM orders').get().business_status,'received');
 const cancelButtons=calls.filter(c=>c.method==='editMessageReplyMarkup').at(-1).form.get('reply_markup');assert.match(cancelButtons,/Да, закрыть заявку/);
 await worker.fetch(callbackRequest(id,0,'cancelled'),e);await worker.fetch(callbackRequest(id,1,'processing'),e);
 assert.equal(e.sqlite.prepare('SELECT business_status FROM orders').get().business_status,'cancelled');
});
test('simultaneous manager clicks commit a single transition',async()=>{
 const e={...env(),TELEGRAM_WEBHOOK_SECRET:WEBHOOK_SECRET};managerMock();const {id}=await (await worker.fetch(await request(),e)).json();
 await Promise.all([worker.fetch(callbackRequest(id,0,'processing'),e),worker.fetch(callbackRequest(id,0,'cancelled'),e)]);
 assert.equal(e.sqlite.prepare('SELECT business_version FROM orders').get().business_version,1);
 assert.equal(e.sqlite.prepare('SELECT COUNT(*) n FROM order_status_events').get().n,2);
});
test('bootstrap is protected and never overwrites an unrelated webhook',async()=>{
 const e={...env(),TELEGRAM_WEBHOOK_SECRET:WEBHOOK_SECRET,ADMIN_SETUP_SECRET:WEBHOOK_SECRET};
 const req=secret=>new Request('https://api.example/internal/telegram/setup',{method:'POST',headers:{authorization:'Bearer '+secret},body:'{}'});
 assert.equal((await worker.fetch(req('bad'),e)).status,403);
 const calls=telegramMock(method=>method==='getWebhookInfo'?Response.json({ok:true,result:{url:'https://other.example/webhook'}}):undefined);
 assert.equal((await worker.fetch(req(WEBHOOK_SECRET),e)).status,409);assert(!calls.some(c=>c.method==='setWebhook'));
});

test('Telegram contact is accepted only from its owner in private chat',async()=>{
 const e={...env(),TELEGRAM_WEBHOOK_SECRET:WEBHOOK_SECRET};
 const update=(sender,contactUser,chat=sender)=>new Request('https://api.example/telegram/webhook',{method:'POST',headers:{'X-Telegram-Bot-Api-Secret-Token':WEBHOOK_SECRET},body:JSON.stringify({message:{from:{id:sender,first_name:'Customer'},chat:{id:chat,type:chat>0?'private':'group'},contact:{user_id:contactUser,phone_number:'375291234567'}}})});
 await worker.fetch(update(42,99),e);await worker.fetch(update(42,42,-100),e);assert.equal(e.sqlite.prepare('SELECT COUNT(*) n FROM customer_contacts').get().n,0);
 await worker.fetch(update(42,42),e);assert.equal(e.sqlite.prepare('SELECT phone FROM customer_contacts').get().phone,'+375291234567');
 const own=new Request('https://api.example/api/contact',{method:'POST',headers:{origin:ORIGIN},body:JSON.stringify({initData:await auth()})});
 assert.equal((await (await worker.fetch(own,e)).json()).phone,'+375291234567');
 const other=new Request('https://api.example/api/contact',{method:'POST',headers:{origin:ORIGIN},body:JSON.stringify({initData:await auth({user:JSON.stringify({id:99})})})});
 assert.equal((await (await worker.fetch(other,e)).json()).phone,'');
});

function priceMessage(promptId,text,messageId=500,actor=77){return new Request('https://api.example/telegram/webhook',{method:'POST',headers:{'X-Telegram-Bot-Api-Secret-Token':WEBHOOK_SECRET},body:JSON.stringify({message:{message_id:messageId,chat:{id:-100123456789,type:'supergroup'},from:{id:actor},text,reply_to_message:{message_id:promptId}}})})}
async function quoteFixture(){
 const e={...env(),TELEGRAM_WEBHOOK_SECRET:WEBHOOK_SECRET},calls=managerMock();const {id}=await (await worker.fetch(await request(),e)).json();
 await worker.fetch(callbackRequest(id,0,'processing'),e);await worker.fetch(callbackRequest(id,1,'price'),e);
 const prompt=e.sqlite.prepare('SELECT message_id FROM quote_prompts').get();assert(prompt);
 await worker.fetch(priceMessage(prompt.message_id,'150,50\nВынос и машина включены'),e);
 return {e,calls,id,promptId:prompt.message_id};
}
async function decisionRequest(id,version,action,{init,actionId=crypto.randomUUID(),note=''}={}){return new Request('https://api.example/api/orders/decision',{method:'POST',headers:{origin:ORIGIN,'content-type':'application/json'},body:JSON.stringify({initData:init||await auth(),id,version,action,actionId,note})})}

test('quote parser uses integer kopecks and requires clear nonzero price',()=>{
 assert.deepEqual(parseQuote('150,50 BYN\nВсё включено'),{amount:15050,note:'Всё включено'});
 assert.deepEqual(parseQuote('100.5'),{amount:10050,note:''});
 for(const text of ['0','-150','150-200','100.555','150\n'+'x'.repeat(601)])assert.equal(parseQuote(text),null);
});
test('manager publishes a real quote with conditions and notifies the customer',async()=>{
 const {e,calls,promptId}=await quoteFixture();const row=e.sqlite.prepare('SELECT * FROM orders').get();
 assert.equal(row.business_status,'quoted');assert.equal(row.quote_amount_minor,15050);assert.equal(row.quote_revision,1);
 const result=await (await worker.fetch(await listRequest(),e)).json();assert.equal(result.orders[0].quote.amountMinor,15050);assert.equal(result.orders[0].quote.note,'Вынос и машина включены');
 assert(calls.some(c=>c.method==='sendMessage'&&c.form.get('chat_id')==='42'&&c.form.get('reply_markup').includes('web_app')&&c.form.get('reply_markup').includes('?order=')));
 const count=e.sqlite.prepare('SELECT COUNT(*) n FROM order_status_events').get().n;
 await worker.fetch(priceMessage(promptId,'150,50\nВынос и машина включены'),e);assert.equal(e.sqlite.prepare('SELECT COUNT(*) n FROM order_status_events').get().n,count);
});
test('only customer can accept a quote; repeated decision does not duplicate notification',async()=>{
 const {e,calls,id}=await quoteFixture();const actionId=crypto.randomUUID();
 const other=await auth({user:JSON.stringify({id:99})});assert.equal((await worker.fetch(await decisionRequest(id,2,'accept',{init:other}),e)).status,404);
 const accepted=await worker.fetch(await decisionRequest(id,2,'accept',{actionId}),e);assert.equal(accepted.status,200);assert.equal((await accepted.json()).order.businessStatus,'accepted');
 const n=calls.length;assert.equal((await worker.fetch(await decisionRequest(id,2,'accept',{actionId}),e)).status,200);assert.equal(calls.length,n);
 assert.equal((await worker.fetch(await decisionRequest(id,2,'discuss',{actionId}),e)).status,409);
});
test('discussion keeps the lead, and manager can publish a revised quote',async()=>{
 const {e,id}=await quoteFixture();
 const discussion=await worker.fetch(await decisionRequest(id,2,'discuss',{note:'Помогу с погрузкой, можно дешевле?'}),e);assert.equal((await discussion.json()).order.businessStatus,'discussion');
 assert.equal(e.sqlite.prepare('SELECT customer_note FROM orders').get().customer_note,'Помогу с погрузкой, можно дешевле?');
 await worker.fetch(callbackRequest(id,3,'price'),e);const prompt=e.sqlite.prepare('SELECT * FROM quote_prompts ORDER BY message_id DESC LIMIT 1').get();
 await worker.fetch(priceMessage(prompt.message_id,'120\nС вашей помощью при погрузке',501),e);
 const row=e.sqlite.prepare('SELECT * FROM orders').get();assert.equal(row.business_status,'quoted');assert.equal(row.quote_amount_minor,12000);assert.equal(row.quote_revision,2);
 assert.equal((await worker.fetch(await decisionRequest(id,2,'accept'),e)).status,409);
 assert.equal((await worker.fetch(await decisionRequest(id,4,'accept'),e)).status,200);
});
test('simultaneous new price and acceptance never accepts a price customer did not see',async()=>{
 const {e,id}=await quoteFixture();await worker.fetch(callbackRequest(id,2,'price'),e);const prompt=e.sqlite.prepare('SELECT * FROM quote_prompts ORDER BY message_id DESC LIMIT 1').get();
 await Promise.all([worker.fetch(priceMessage(prompt.message_id,'300',502),e),worker.fetch(await decisionRequest(id,2,'accept'),e)]);
 const row=e.sqlite.prepare('SELECT * FROM orders').get();
 assert(row.business_status==='quoted'||row.business_status==='accepted');if(row.business_status==='accepted')assert.equal(row.quote_amount_minor,15050);
});

test('backfill treats already identical Telegram message as success',async()=>{
 const e={...env(),TELEGRAM_WEBHOOK_SECRET:WEBHOOK_SECRET,ADMIN_SETUP_SECRET:WEBHOOK_SECRET};managerMock();await worker.fetch(await request(),e);
 e.sqlite.exec('UPDATE orders SET buttons_version=0');
 telegramMock(method=>method.startsWith('editMessage')?Response.json({ok:false,error_code:400,description:'Bad Request: message is not modified'},{status:400}):undefined);
 const r=await worker.fetch(new Request('https://api.example/internal/telegram/setup',{method:'POST',headers:{authorization:'Bearer '+WEBHOOK_SECRET},body:JSON.stringify({action:'backfill'})}),e);
 const result=await r.json();assert.equal(result.changed,1);assert.equal(result.failed,0);assert.equal(result.remaining,0);
});

async function organizeRequest(id,action,version=0,init){return new Request('https://api.example/api/orders/organize',{method:'POST',headers:{origin:ORIGIN,'content-type':'application/json'},body:JSON.stringify({initData:init||await auth(),id,action,version})})}
test('archive and restore are owner-specific and do not change assessment status',async()=>{
 const e=env(),calls=managerMock();const {id}=await (await worker.fetch(await request(),e)).json();const before=calls.length;
 const archived=await worker.fetch(await organizeRequest(id,'archive'),e);assert.equal((await archived.json()).order.customerVisibility,'archived');
 let list=await (await worker.fetch(await listRequest(),e)).json();assert.equal(list.orders[0].customerVisibility,'archived');assert.equal(list.orders[0].businessStatus,'received');assert.equal(calls.length,before);
 const other=await auth({user:JSON.stringify({id:99})});assert.equal((await worker.fetch(await organizeRequest(id,'delete',0,other),e)).status,404);
 assert.equal((await (await worker.fetch(await organizeRequest(id,'restore'),e)).json()).order.customerVisibility,'active');
});
test('deleted records stay out of customer list, remain with manager, and can be undone',async()=>{
 const e={...env(),TELEGRAM_WEBHOOK_SECRET:WEBHOOK_SECRET};managerMock();const {id}=await (await worker.fetch(await request(),e)).json();
 await worker.fetch(await organizeRequest(id,'delete'),e);assert.equal((await (await worker.fetch(await listRequest(),e)).json()).orders.length,0);assert.equal(e.sqlite.prepare('SELECT COUNT(*) n FROM orders').get().n,1);
 await worker.fetch(callbackRequest(id,0,'cancelled'),e);assert.equal(e.sqlite.prepare('SELECT customer_visibility FROM orders').get().customer_visibility,'deleted');
 assert.equal((await (await worker.fetch(await listRequest(),e)).json()).orders.length,0);
 await worker.fetch(await organizeRequest(id,'restore'),e);assert.equal((await (await worker.fetch(await listRequest(),e)).json()).orders.length,1);
});
test('customer cancellation is versioned, notifies manager once, and archives request',async()=>{
 const e={...env(),TELEGRAM_WEBHOOK_SECRET:WEBHOOK_SECRET},calls=managerMock();const {id}=await (await worker.fetch(await request(),e)).json();
 const response=await worker.fetch(await organizeRequest(id,'cancel'),e);const row=(await response.json()).order;
 assert.equal(row.businessStatus,'cancelled');assert.equal(row.customerVisibility,'archived');const n=calls.length;
 assert.equal((await worker.fetch(await organizeRequest(id,'cancel'),e)).status,200);assert.equal(calls.length,n);
});
test('stale cancellation cannot silently cancel updated offer',async()=>{
 const {e,id}=await quoteFixture();const response=await worker.fetch(await organizeRequest(id,'cancel',0),e);assert.equal(response.status,409);assert.equal(e.sqlite.prepare('SELECT business_status FROM orders').get().business_status,'quoted');
});

test('manager changes media caption in place and can request full original description',async()=>{
 const e=env();e.TELEGRAM_WEBHOOK_SECRET=WEBHOOK_SECRET;const calls=managerMock();
 const data={...order(),desc:'Длинное описание '.repeat(50).trim()};
 const created=await (await worker.fetch(await request({data,files:[photo()]}),e)).json();
 await worker.fetch(callbackRequest(created.id,0,'processing',{message:101}),e);
 const edit=calls.find(c=>c.method==='editMessageCaption');assert(edit);assert(edit.form.get('caption').length<=1024);assert.match(edit.form.get('caption'),/Статус: На оценке/);
 assert.equal(calls.some(c=>c.method==='editMessageText'),false);
 await worker.fetch(callbackRequest(created.id,1,'details',{message:101}),e);
 const details=calls.filter(c=>c.method==='sendMessage').at(-1);assert(details);assert(details.form.get('text').includes(data.desc));
 assert.equal(JSON.parse(details.form.get('reply_parameters')).message_id,101);
});
test('ambiguous media delivery is not uploaded again',async()=>{
 const e=env(),id=crypto.randomUUID(),calls=telegramMock(()=>{throw Error('Response lost')});
 assert.equal((await worker.fetch(await request({id,files:[photo()]}),e)).status,409);
 assert.equal((await worker.fetch(await request({id,files:[photo()]}),e)).status,409);assert.equal(calls.length,1);
});

test('pre-upgrade partial delivery resumes photos linked to existing text card',async()=>{
 const e=env(),id=crypto.randomUUID();telegramMock(()=>Response.json({ok:false,error_code:400},{status:400}));
 await worker.fetch(await request({id,files:[photo()]}),e);
 e.sqlite.prepare("UPDATE orders SET state='text_sent',message_id=100,message_kind='text'").run();
 const calls=telegramMock();assert.equal((await worker.fetch(await request({id,files:[photo()]}),e)).status,200);
 assert.deepEqual(calls.map(c=>c.method),['sendPhoto']);assert.equal(JSON.parse(calls[0].form.get('reply_parameters')).message_id,100);
 assert.equal(e.sqlite.prepare('SELECT message_kind FROM orders').get().message_kind,'text');
});

test('contact diagnostics require signed owner and never store phone or raw callback data',async()=>{
 const e=env();const req=new Request('https://api.example/api/contact',{method:'POST',headers:{origin:ORIGIN},body:JSON.stringify({initData:await auth(),diagnostic:{stage:'failed',platform:'ios',version:'9.2',phone_number:'+375291234567',response:'private raw payload',shared:true,eventKeys:'status,response',phonePresent:false}})});
 assert.equal((await worker.fetch(req,e)).status,200);
 const stored=e.sqlite.prepare('SELECT details FROM contact_diagnostics').get().details;
 assert(!stored.includes('375'));assert(!stored.includes('private raw'));assert.match(stored,/failed/);assert.match(stored,/9.2/);
});

test('acceptance notification includes the order phone and a direct Telegram button',async()=>{
 const {e,calls,id}=await quoteFixture();await worker.fetch(await decisionRequest(id,2,'accept'),e);
 const notice=calls.find(c=>c.method==='sendMessage'&&c.form.get('text')?.includes('Свяжитесь с ним'));
 assert(notice);assert.match(notice.form.get('text'),/Телефон: \+375291234567/);assert.match(notice.form.get('text'),/Telegram: @local_test/);
 assert.equal(JSON.parse(notice.form.get('reply_markup')).inline_keyboard[0][0].url,'https://t.me/local_test');
 assert.equal(JSON.parse(notice.form.get('reply_parameters')).message_id,100);
});
test('customer without username gets a user-ID button and phone in the discussion notice',async()=>{
 const {e,calls,id}=await quoteFixture();const init=await auth({user:JSON.stringify({id:42,first_name:'Тест'})});
 await worker.fetch(await decisionRequest(id,2,'discuss',{init,note:'В какое время?'}),e);
 const notice=calls.find(c=>c.method==='sendMessage'&&c.form.get('text')?.includes('Клиент просит'));
 assert.match(notice.form.get('text'),/Телефон: \+375291234567/);assert(!notice.form.get('text').includes('Telegram: @'));
 assert.equal(JSON.parse(notice.form.get('reply_markup')).inline_keyboard[0][0].url,'tg://user?id=42');
});
test('privacy rejection of contact button falls back to text with phone without reversing acceptance',async()=>{
 const {e,id}=await quoteFixture();let rejected=false;const calls=telegramMock((method,calls)=>{
  const form=calls.at(-1).form;
  if(method==='sendMessage'&&form.get('text')?.includes('Свяжитесь с ним')&&form.get('reply_markup')){rejected=true;return Response.json({ok:false,error_code:400},{status:400})}
 });
 assert.equal((await worker.fetch(await decisionRequest(id,2,'accept'),e)).status,200);assert(rejected);
 const notices=calls.filter(c=>c.method==='sendMessage');assert.equal(notices.length,2);assert.equal(notices[1].form.get('reply_markup'),null);assert.match(notices[1].form.get('text'),/Телефон:/);
 assert.equal(e.sqlite.prepare('SELECT business_status FROM orders').get().business_status,'accepted');
});

function ownContactUpdate({id=700,phone='375291234567',owner=42,chat=42}={}){
 return new Request('https://api.example/telegram/webhook',{method:'POST',headers:{'X-Telegram-Bot-Api-Secret-Token':WEBHOOK_SECRET},body:JSON.stringify({message:{message_id:id,from:{id:42,first_name:'Тест'},chat:{id:chat,type:chat>0?'private':'group'},contact:{user_id:owner,phone_number:phone}}})});
}
test('own contact card is deleted from private chat only after phone has been saved',async()=>{
 const e={...env(),TELEGRAM_WEBHOOK_SECRET:WEBHOOK_SECRET};const calls=telegramMock(method=>{
  if(method==='deleteMessage')assert.equal(e.sqlite.prepare('SELECT phone FROM customer_contacts').get().phone,'+375291234567');
 });
 assert.equal((await worker.fetch(ownContactUpdate(),e)).status,200);
 assert.deepEqual(calls.map(c=>c.method),['deleteMessage']);assert.equal(calls[0].form.get('chat_id'),'42');assert.equal(calls[0].form.get('message_id'),'700');
 await worker.fetch(ownContactUpdate({owner:99}),e);await worker.fetch(ownContactUpdate({chat:-100}),e);await worker.fetch(ownContactUpdate({phone:'123'}),e);assert.equal(calls.length,1);
});
test('Telegram deletion failure does not lose phone or fail the contact webhook',async()=>{
 const e={...env(),TELEGRAM_WEBHOOK_SECRET:WEBHOOK_SECRET};telegramMock(()=>Response.json({ok:false,error_code:400},{status:400}));
 assert.equal((await worker.fetch(ownContactUpdate(),e)).status,200);assert.equal(e.sqlite.prepare('SELECT phone FROM customer_contacts').get().phone,'+375291234567');
});
test('contact card remains when saving phone fails',async()=>{
 const e={...env(),TELEGRAM_WEBHOOK_SECRET:WEBHOOK_SECRET},calls=telegramMock();e.sqlite.exec('DROP TABLE customer_contacts');
 assert.equal((await worker.fetch(ownContactUpdate(),e)).status,500);assert.equal(calls.length,0);
});
