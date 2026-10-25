import {test} from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';

const html=readFileSync(new URL('../../index.html',import.meta.url),'utf8');
const script=html.slice(html.indexOf('<script>')+8,html.indexOf('</script>',html.indexOf('<script>')));
class Element {
  constructor(){this.innerHTML='';this.textContent='';this.style={};this.listeners={};this.scrollTop=0;this.classList={add(){},remove(){}};}
  addEventListener(key,fn){this.listeners[key]=fn}
  focus(){}setAttribute(){}contains(){return false}
}
function client({live=false,fetcher}={}){
  const nodes=new Map(),storage=new Map(),urls=new Set();let counter=0;
  const node=k=>{if(!nodes.has(k))nodes.set(k,new Element());return nodes.get(k)};
  const tg={initData:'signed-test-data',platform:'ios',colorScheme:'light',initDataUnsafe:{user:{id:42,first_name:'Тест'}},ready(){},expand(){},disableVerticalSwipes(){},setHeaderColor(){},setBackgroundColor(){},setBottomBarColor(){},onEvent(){},MainButton:{hide(){}},BackButton:{onClick(){},hide(){},show(){}},HapticFeedback:{selectionChanged(){},notificationOccurred(){}}};
  const doc={querySelector:node,querySelectorAll:()=>[],addEventListener(){},documentElement:{dataset:{},style:{setProperty(){}},classList:{add(){}}},createElement(name){
    if(name==='canvas')return {width:0,height:0,getContext:()=>({fillRect(){},drawImage(){}}),toBlob:cb=>cb(new Blob([new Uint8Array([255,216,255,224,255,217])],{type:'image/jpeg'}))};
    return new Element();
  }};
  class FakeImage{naturalWidth=3000;naturalHeight=2000;set src(v){this.onload()}}
  const context={window:{VG_CONFIG:{apiBase:live?'https://api.example':''},...(live?{Telegram:{WebApp:tg}}:{}),addEventListener(){}},document:doc,matchMedia:()=>({matches:false}),localStorage:{getItem:k=>storage.get(k)||null,setItem:(k,v)=>storage.set(k,v)},crypto,FormData,Blob,File,Image:FakeImage,AbortSignal,Date,setTimeout,clearTimeout,performance,fetch:fetcher,URL:{createObjectURL(){const u='blob:test-'+(++counter);urls.add(u);return u},revokeObjectURL:u=>urls.delete(u)}};
  vm.createContext(context);vm.runInContext(script,context);
  return {run:s=>vm.runInContext(s,context),node,storage,context,urls};
}
test('photo preparation, five-photo limit and session-only drafts',async()=>{
  const c=client();c.run("S.w=newW('trash');render()");
  c.context.files=Array.from({length:6},()=>new File(['image'],'phone.jpg',{type:'image/jpeg'}));
  await c.run('addPhotos(files)');
  assert.equal(c.run('S.w.photos.length'),5);assert.equal(c.run('S.preparing'),false);
  assert.match(c.run('S.photoError'),/до 5/);
  const draft=JSON.parse(c.storage.get('vg-requests-v2'))[0];
  assert.equal(draft.photoCount,5);assert.deepEqual(draft.photos,[]);assert(!c.storage.get('vg-requests-v2').includes('blob:'));
  assert.equal(c.urls.size,5);assert.match(c.node('#view').innerHTML,/Фото 5/);
});
test('empty description can advance without selecting a field',()=>{
  const c=client();c.run("S.w=newW('trash');S.step=0;render()");
  c.node('#go').onclick();assert.equal(c.run('S.step'),1);
  assert.equal(Object.keys(c.run('S.errors')).length,0);
});
test('configured API sends form and files; only confirmed result produces success',async()=>{
  const calls=[];let finish;
  const c=client({live:true,fetcher:(url,opts)=>{calls.push({url,...opts});return new Promise(resolve=>{finish=resolve})}});
  c.run("S.w=newW('trash');Object.assign(S.w,{addr:'Минск, Ленина 1',phone:'+375291234567'});S.step=2");
  const pending=c.run('submitOrder()');assert.equal(c.run('S.sending'),true);assert.equal(c.run('S.tab'),'home');
  await c.run('submitOrder()');assert.equal(calls.length,1);
  assert.equal(calls[0].body.get('initData'),'signed-test-data');assert.match(calls[0].body.get('requestId'),/^[a-f\d-]{36}$/);
  finish(Response.json({ok:true,id:'VG-TEST',photoCount:0}));await pending;
  assert.equal(c.run('S.sending'),false);assert.equal(c.run('S.last.status'),'sent');assert.equal(c.run('S.last.serverId'),'VG-TEST');
  assert.match(c.node('#view').innerHTML,/Заявка отправлена/);
});
test('failure preserves photos and uses same request ID on retry',async()=>{
  const calls=[];const c=client({live:true,fetcher:async(url,opts)=>{calls.push(opts.body);return Response.json({ok:false,message:'Попробуйте позже'},{status:502})}});
  c.run("S.w=newW('trash');Object.assign(S.w,{addr:'Минск, Ленина 1',phone:'+375291234567'});S.step=2");
  c.context.files=[new File(['image'],'test.jpg',{type:'image/jpeg'})];await c.run('addPhotos(files)');
  await c.run('submitOrder()');assert.equal(c.run('S.w.photos.length'),1);assert.equal(c.run('S.last'),null);assert.match(c.run('S.submitError'),/Попробуйте/);
  await c.run('submitOrder()');assert.equal(calls[0].get('requestId'),calls[1].get('requestId'));assert.equal(calls[0].getAll('photos').length,1);
});
