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
  return {BOT_TOKEN:TOKEN,TELEGRAM_CHAT_ID:'-100123456789',ALLOWED_ORIGIN:ORIGIN,DB:{
    prepare(sql){return {bind(...args){return {
      async first(){return sqlite.prepare(sql).get(...args)||null},
      async run(){return {meta:{changes:Number(sqlite.prepare(sql).run(...args).changes)}}}
    }}}}
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
    const result=method==='sendMessage'?{message_id:100}:method==='sendPhoto'?{message_id:101,photo:[{file_id:'stored-photo'}]}:[{message_id:101,photo:[{file_id:'stored-1'}]},{message_id:102,photo:[{file_id:'stored-2'}]}];
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
test('single photo uses sendPhoto and replies to the order message',async()=>{
  const e=env(),calls=telegramMock();
  const r=await worker.fetch(await request({files:[photo()]}),e);assert.equal((await r.json()).ok,true);
  assert.deepEqual(calls.map(c=>c.method),['sendMessage','sendPhoto']);
  assert.equal(JSON.parse(calls[1].form.get('reply_parameters')).message_id,100);
  assert.equal(e.sqlite.prepare('SELECT photo_file_ids FROM orders').get().photo_file_ids,'["stored-photo"]');
});
test('multiple photos use an album linked to the order',async()=>{
  const e=env(),calls=telegramMock();
  const r=await worker.fetch(await request({files:[photo(),photo()]}),e);assert.equal((await r.json()).photoCount,2);
  assert.deepEqual(calls.map(c=>c.method),['sendMessage','sendMediaGroup']);
  assert.equal(JSON.parse(calls[1].form.get('media')).length,2);
});
test('definitive photo failure retries only photos, never text',async()=>{
  let reject=true;const e=env(),id=crypto.randomUUID(),calls=telegramMock(method=>{
    if(method==='sendPhoto'&&reject){reject=false;return Response.json({ok:false,error_code:400},{status:400})}
  });
  const a=await worker.fetch(await request({id,files:[photo()]}),e);assert.equal(a.status,502);
  assert.equal(e.sqlite.prepare('SELECT state FROM orders').get().state,'text_sent');
  const b=await worker.fetch(await request({id,files:[photo()]}),e);assert.equal((await b.json()).ok,true);
  assert.deepEqual(calls.map(c=>c.method),['sendMessage','sendPhoto','sendPhoto']);
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
