import {test} from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';

const html=readFileSync(new URL('../../index.html',import.meta.url),'utf8');
const script=html.slice(html.indexOf('<script>')+8,html.indexOf('</script>',html.indexOf('<script>')));
class Element {
  constructor(){this.innerHTML='';this.textContent='';this.style={};this.listeners={};this.scrollTop=0;this.classList={add(){},remove(){}};}
  addEventListener(key,fn){this.listeners[key]=fn}
  focus(){}setAttribute(){}contains(){return false}querySelector(){return new Element()}
}
function client({live=false,fetcher,initialOrders}={}){
  const nodes=new Map(),storage=new Map(),urls=new Set();let counter=0;
  if(initialOrders)storage.set('vg-requests-v2',JSON.stringify(initialOrders));
  const node=k=>{if(!nodes.has(k))nodes.set(k,new Element());return nodes.get(k)};
  const tg={initData:'signed-test-data',platform:'ios',colorScheme:'light',initDataUnsafe:{user:{id:42,first_name:'Тест'}},ready(){},expand(){},disableVerticalSwipes(){},setHeaderColor(){},setBackgroundColor(){},setBottomBarColor(){},onEvent(){},MainButton:{hide(){}},BackButton:{onClick(){},hide(){},show(){}},HapticFeedback:{selectionChanged(){},notificationOccurred(){}}};
  const doc={querySelector:node,querySelectorAll:()=>[],addEventListener(){},documentElement:{dataset:{},style:{setProperty(){}},classList:{add(){}}},createElement(name){
    if(name==='canvas')return {width:0,height:0,getContext:()=>({fillRect(){},drawImage(){}}),toDataURL:()=> 'data:image/jpeg;base64,preview',toBlob:cb=>cb(new Blob([new Uint8Array([255,216,255,224,255,217])],{type:'image/jpeg'}))};
    return new Element();
  }};
  class FakeImage{naturalWidth=3000;naturalHeight=2000;set src(v){this.onload()}}
  const context={window:{VG_CONFIG:{apiBase:live?'https://api.example':''},...(live?{Telegram:{WebApp:tg}}:{}),addEventListener(){}},document:doc,matchMedia:()=>({matches:false}),localStorage:{getItem:k=>storage.get(k)||null,setItem:(k,v)=>storage.set(k,v)},crypto,FormData,Blob,File,FileReader:class{readAsDataURL(){this.result='data:image/jpeg;base64,original';this.onload()}},Image:FakeImage,AbortSignal,Date,setTimeout,clearTimeout,requestAnimationFrame:()=>0,cancelAnimationFrame(){},performance,fetch:(url,opts)=>url.endsWith('/api/contact')?Promise.resolve(Response.json({ok:true,phone:''})):fetcher(url,opts),URL:{createObjectURL(){const u='blob:test-'+(++counter);urls.add(u);return u},revokeObjectURL:u=>urls.delete(u)}};
  vm.createContext(context);vm.runInContext(script,context);
  return {run:s=>vm.runInContext(s,context),node,storage,context,urls,tg};
}
test('photo preparation, five-photo limit and session-only drafts',async()=>{
  const c=client();c.run("S.w=newW('trash');render()");
  c.context.files=Array.from({length:6},()=>new File(['image'],'phone.jpg',{type:'image/jpeg'}));
  await c.run('addPhotos(files)');
  assert.equal(c.run('S.w.photos.length'),5);assert.equal(c.run('S.preparing'),false);
  assert.match(c.run('S.photoError'),/до 5/);
  const draft=JSON.parse(c.storage.get('vg-requests-v2'))[0];
  assert.equal(draft.photoCount,5);assert.deepEqual(draft.photos,[]);assert(!c.storage.get('vg-requests-v2').includes('blob:'));
  assert.equal(c.urls.size,0);assert.match(c.node('#view').innerHTML,/Фото 5/);
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
  assert.match(c.node('#view').innerHTML,/<h2>Заявка на оценку получена<\/h2>/);
});
test('failure preserves photos and uses same request ID on retry',async()=>{
  const calls=[];const c=client({live:true,fetcher:async(url,opts)=>{calls.push(opts.body);return Response.json({ok:false,message:'Попробуйте позже'},{status:502})}});
  c.run("S.w=newW('trash');Object.assign(S.w,{addr:'Минск, Ленина 1',phone:'+375291234567'});S.step=2");
  c.context.files=[new File(['image'],'test.jpg',{type:'image/jpeg'})];await c.run('addPhotos(files)');
  await c.run('submitOrder()');assert.equal(c.run('S.w.photos.length'),1);assert.equal(c.run('S.last'),null);assert.match(c.run('S.submitError'),/Попробуйте/);
  await c.run('submitOrder()');assert.equal(calls[0].get('requestId'),calls[1].get('requestId'));assert.equal(calls[0].getAll('photos').length,1);
});

test('server status replaces cached status, keeps drafts, and preserves scroll',async()=>{
 const remote={...{sv:'trash',desc:'Диван',addr:'Минск, Ленина 1',to:'',floor:1,toFloor:1,lift:true,toLift:true,dis:false,date:'',slot:0,name:'',phone:'+375291234567'},serverId:'VG-TEST',requestId:'remote-request',status:'sent',businessStatus:'processing',statusUpdatedAt:Date.now(),photoCount:0,history:[{status:'received',at:Date.now()}]};
 const c=client({live:true,fetcher:async()=>Response.json({ok:true,orders:[remote]})});
 c.context.remote=remote;
 c.run("S.orders=[{...remote,id:'local-sent',businessStatus:'received'},{id:'draft-1',sv:'trash',status:'draft',desc:'Черновик',date:''}];S.tab='orders';render()");
 c.node('#view').scrollTop=120;await c.run('syncOrders()');
 assert.equal(c.run('S.orders.length'),2);assert.equal(c.run('S.orders[0].businessStatus'),'processing');assert.equal(c.run('S.orders[0].id'),'local-sent');assert.equal(c.node('#view').scrollTop,120);
 assert.match(c.node('#view').innerHTML,/На оценке/);assert(!c.node('#view').innerHTML.includes('Черновик'));assert.match(c.run('home()'),/Продолжить заполнение/);
});
test('status fetch failure keeps last known state instead of fabricating progress',async()=>{
 const c=client({live:true,fetcher:async()=>{throw Error('offline')}});
 c.run("S.orders=[{id:'local',serverId:'VG-TEST',sv:'trash',status:'sent',businessStatus:'received',date:'',desc:'Диван'}];S.tab='orders'");
 await c.run('syncOrders()');assert.equal(c.run('S.orders[0].businessStatus'),'received');assert.match(c.node('#view').innerHTML,/Не удалось обновить статусы/);
});

test('native picker event adds thumbnails and resets input so the same file can be selected again',async()=>{
 const c=client();c.run("S.w=newW('flat');render()");
 const input=c.node('#photo-input'),handler=input.listeners.change;
 input.files=[new File(['image'],'iphone.jpg',{type:'image/jpeg'})];input.value='C:\\fakepath\\iphone.jpg';
 await handler({currentTarget:input});
 assert.equal(input.value,'');assert.equal(c.run('S.w.photos.length'),1);
 assert.match(c.node('#view').innerHTML,/Добавлено: 1 из 5/);assert.match(c.node('#view').innerHTML,/<img src="data:image\/jpeg;base64,preview"/);
 c.run('render()');assert.equal(input.listeners.change,handler);
 await handler({currentTarget:input});assert.equal(c.run('S.w.photos.length'),2);
 assert.equal((html.match(/id="photo-input"/g)||[]).length,1);
 assert(html.indexOf('id="photo-input"')<html.indexOf('<script>'));
});
test('iOS image can fall back to data URL decoding and tolerate missing MIME metadata',async()=>{
 const c=client();c.context.Image=class{naturalWidth=2000;naturalHeight=1500;set src(v){v.startsWith('blob:')?this.onerror():this.onload()}};
 c.run("S.w=newW('trash');render()");c.context.files=[new File(['image'],'iphone.jpg',{type:''})];
 await c.run('addPhotos(files)');assert.equal(c.run('S.w.photos.length'),1);assert.equal(c.run('S.photoError'),'');assert.equal(c.urls.size,0);
});
test('unreadable photo produces a visible error instead of silently keeping empty picker',async()=>{
 const c=client();c.context.Image=class{set src(v){this.onerror()}};
 c.run("S.w=newW('trash');render()");c.context.files=[new File(['bad'],'image.heic',{type:'image/heic'})];
 await c.run('addPhotos(files)');assert.equal(c.run('S.w.photos.length'),0);assert.equal(c.run('S.preparing'),false);
 assert.match(c.run('S.photoError'),/JPEG или PNG/);const view=c.node('#view').innerHTML;
 assert(view.indexOf('Фото не удалось открыть')<view.indexOf('class="photo-grid"'));
});

test('both moving addresses are visible together; next is disabled until both are entered',()=>{
 const c=client();c.run("S.w=newW('flat');S.step=1;render()");
 assert(c.node('#go').disabled);assert.equal(c.node('#go').textContent,'Укажите адрес погрузки');
 c.run("S.w.addr='Минск, Ленина 1';refresh()");assert(c.node('#go').disabled);assert.equal(c.node('#go').textContent,'Укажите адрес выгрузки');
 c.run("S.w.to='Минск, Кирова 2';refresh()");assert.equal(c.node('#go').disabled,false);assert.equal(c.node('#go').textContent,'Далее: контакт');
 const view=c.node('#view').innerHTML;assert(view.indexOf('id="to"')<view.indexOf('На погрузке'));assert.equal(c.run('S.step'),1);
});
test('Telegram phone sharing fills contact without a name field and caches number for next order',async()=>{
 const c=client({live:true});c.tg.requestContact=cb=>cb(true);
 c.context.fetch=async()=>Response.json({ok:true,phone:'+375291234567',updatedAt:Date.now()});
 c.run("S.w=newW('trash');S.step=2;render()");assert.match(c.node('#view').innerHTML,/Поделиться номером/);assert(!c.node('#view').innerHTML.includes('id="name"'));
 await c.run('requestPhone()');assert.equal(c.run('S.w.phone'),'+375291234567');assert.equal(c.run('S.contactBusy'),false);assert.equal(c.node('#go').disabled,false);
 assert.match(c.node('#view').innerHTML,/Для связи с водителем/);assert.equal(c.run("newW('flat').phone"),'+375291234567');
});
test('declining Telegram contact opens manual option without inventing a number',async()=>{
 const c=client({live:true});c.tg.requestContact=cb=>cb(false);c.run("S.w=newW('trash');S.step=2;render()");
 await c.run('requestPhone()');assert.equal(c.run('S.w.phone'),'');assert.equal(c.run('S.phoneManual'),true);assert.equal(c.run('S.contactBusy'),false);assert.match(c.node('#view').innerHTML,/id="phone"/);assert(c.node('#go').disabled);
});

test('quote is shown as a proposal; agreeing sends versioned decision rather than completing work',async()=>{
 const base={sv:'trash',desc:'Диван',addr:'Минск, Ленина 1',to:'',floor:1,toFloor:1,lift:true,toLift:true,dis:false,date:'',slot:0,name:'',phone:'+375291234567',id:'local',serverId:'VG-TEST',status:'sent',businessStatus:'quoted',statusVersion:2,quote:{amountMinor:15050,note:'Машина и вынос включены',revision:1}};
 const calls=[];const c=client({live:true,fetcher:async(url,opts)=>{calls.push(JSON.parse(opts.body));return Response.json({ok:true,order:{...base,businessStatus:'accepted',statusVersion:3}})}});
 c.context.proposal=base;c.run("S.orders=[proposal];S.last=proposal;S.tab='done';render()");
 assert.equal(c.node('#go').textContent,'Подходит, согласовать');assert.match(c.node('#view').innerHTML,/Машина и вынос включены/);assert(!c.node('#view').innerHTML.includes('Выполнен'));
 await c.node('#go').onclick();assert.equal(calls[0].action,'accept');assert.equal(calls[0].version,2);assert.equal(c.run('S.last.businessStatus'),'accepted');assert.match(c.node('#view').innerHTML,/Стоимость принята/);
});
test('a changed quote is refreshed and never accepted automatically',async()=>{
 const proposal={sv:'trash',desc:'Диван',addr:'Минск, Ленина 1',date:'',id:'local',serverId:'VG-TEST',status:'sent',businessStatus:'quoted',statusVersion:2,quote:{amountMinor:15000,note:'',revision:1}};
 let decisions=0;const c=client({live:true,fetcher:async(url)=>url.endsWith('/decision')?(decisions++,Response.json({ok:false,code:'QUOTE_CHANGED',message:'Предложение изменилось.'},{status:409})):Response.json({ok:true,orders:[{...proposal,statusVersion:3,quote:{amountMinor:18000,note:'Уточнён объём',revision:2}}]})});
 c.context.proposal=proposal;c.run("S.orders=[proposal];S.last=proposal;S.tab='done';render()");await c.run("decideQuote('accept')");
 assert.equal(decisions,1);assert.equal(c.run('S.last.businessStatus'),'quoted');assert.equal(c.run('S.last.quote.amountMinor'),18000);assert.equal(c.run('S.last.statusVersion'),3);
});

test('active and archive tabs filter rows and show only first batch',()=>{
 const c=client();c.run("S.orders=Array.from({length:12},(_,i)=>({id:'sent-'+i,serverId:'VG-'+i,sv:'trash',status:'sent',date:'',desc:'Задача '+i,customerVisibility:i===11?'archived':'active'}));S.tab='orders';render()");
 assert.equal((c.node('#view').innerHTML.match(/<article class="ord">/g)||[]).length,8);assert.match(c.node('#view').innerHTML,/Показать ещё \(3\)/);
 c.run("S.listTab='archive';render()");assert.equal((c.node('#view').innerHTML.match(/<article class="ord">/g)||[]).length,1);assert.match(c.node('#view').innerHTML,/Задача 11/);
});
test('local draft deletion and undo work without server request',async()=>{
 const c=client();c.run("S.orders=[{id:'draft',sv:'trash',status:'draft',date:'',desc:'Тест'}];S.orderMenuId='draft';S.tab='orders';S.sheet='order-confirm';S.orderConfirmAction='delete'");
 await c.run("organizeOrder('delete')");assert.equal(c.run('S.orders.length'),0);assert.equal(c.run('S.organizeError'),'');assert.match(c.node('#order-notice').innerHTML,/Отменить/);
 await c.run('undoOrder()');assert.equal(c.run('S.orders.length'),1);assert.equal(c.run('S.orders[0].id'),'draft');
});
test('server deletion is retained across subsequent status refresh',async()=>{
 const remote={id:'local',serverId:'VG-TEST',status:'sent',sv:'trash',date:'',desc:'Диван',businessStatus:'received',statusVersion:0};
 const c=client({live:true,fetcher:async(url)=>url.endsWith('/organize')?Response.json({ok:true,order:{...remote,customerVisibility:'deleted'}}):Response.json({ok:true,orders:[]})});
 c.context.record=remote;c.run("S.orders=[record];S.orderMenuId='local';S.tab='orders';S.sheet='order-confirm';S.orderConfirmAction='delete'");
 await c.run("organizeOrder('delete')");assert.equal(c.run('S.orders.length'),0);await c.run('syncOrders()');assert.equal(c.run('S.orders.length'),0);
});

test('Telegram native callback fills phone immediately without waiting for webhook',async()=>{
 const c=client({live:true});let requests=0;
 c.tg.requestContact=cb=>cb(true,{responseUnsafe:{contact:{user_id:42,phone_number:'375291234567'}}});
 c.context.fetch=async()=>{requests++;throw Error('Webhook delayed')};
 c.run("S.w=newW('trash');S.step=2;render()");
 await c.run('requestPhone()');assert.equal(c.run('S.w.phone'),'+375291234567');assert.equal(requests,1);assert.equal(c.node('#go').disabled,false);
});
test('raw Telegram callback contact can fill number and confirmed saved phone is not rejected for age',async()=>{
 const c=client({live:true});c.tg.requestContact=cb=>cb(true,{response:new URLSearchParams({contact:JSON.stringify({user_id:42,phone_number:'+375291234567'})}).toString()});
 c.context.URLSearchParams=URLSearchParams;
 c.run("S.w=newW('trash');S.step=2;render()");await c.run('requestPhone()');assert.equal(c.run('S.w.phone'),'+375291234567');
 c.tg.requestContact=cb=>cb(true);c.context.fetch=async()=>Response.json({ok:true,phone:'+375331234567',updatedAt:1,serverTime:Date.now()});
 await c.run('requestPhone()');assert.equal(c.run('S.w.phone'),'+375331234567');assert.equal(c.run('S.contactError'),'');
});
test('foreign callback contact is ignored; authenticated server contact is used instead',async()=>{
 const c=client({live:true});c.tg.requestContact=cb=>cb(true,{responseUnsafe:{contact:{user_id:99,phone_number:'375291111111'}}});
 c.context.fetch=async()=>Response.json({ok:true,phone:'+375291234567',updatedAt:1});
 c.run("S.w=newW('trash');S.step=2;render()");await c.run('requestPhone()');assert.equal(c.run('S.w.phone'),'+375291234567');
});

test('empty service selection and cached phone do not create drafts; only latest meaningful form is kept',()=>{
 const c=client();c.run("S.w=newW('trash');S.w.phone='+375291234567';storeDraft()");assert.equal(c.run('S.orders.length'),0);
 c.run("S.w.desc='Диван';storeDraft();S.w=null");assert.equal(c.run('S.orders.length'),1);
 const old=c.run('S.orders[0].id');
 c.run("S.w=newW('flat');S.w.addr='Минск, Ленина 1';storeDraft()");assert.equal(c.run('S.orders.length'),1);assert.notEqual(c.run('S.orders[0].id'),old);
 assert.equal(c.run('S.orders[0].sv'),'flat');assert.equal(c.run('photoCache.size'),1);
 c.run("S.w.addr='';storeDraft()");assert.equal(c.run('S.orders.length'),0);
});
test('existing drafts consolidate at startup, keeping newest filled form and every sent order',()=>{
 const c=client({initialOrders:[
  {id:'sent',serverId:'VG-REAL',status:'sent',sv:'trash',date:'',desc:'Отправлена'},
  {id:'old',status:'draft',sv:'trash',desc:'Старый',updatedAt:'2026-10-25T10:00:00Z'},
  {id:'latest',status:'draft',sv:'flat',addr:'Минск, Ленина 1',updatedAt:'2026-10-25T12:00:00Z'},
  {id:'empty',status:'draft',sv:'rig',phone:'+375291234567',updatedAt:'2026-10-25T13:00:00Z'}
 ]});
 assert.equal(c.run('S.orders.length'),2);assert.equal(c.run("S.orders.find(o=>o.status==='draft').id"),'latest');
 c.run("S.tab='orders';render()");assert.match(c.node('#view').innerHTML,/VG-REAL/);assert(!c.node('#view').innerHTML.includes('Черновик'));
 const home=c.run('home()');assert.match(home,/Продолжить заполнение/);assert.match(home,/data-a="draft-delete"/);assert(!home.includes('№'));
 assert.equal(JSON.parse(c.storage.get('vg-requests-v2')).length,2);
});
test('drafts never enter list counts or archive, including before a status refresh',()=>{
 const c=client();c.run("S.orders=[{id:'draft',status:'draft',sv:'trash',desc:'Незакончено',customerVisibility:'archived'},{id:'sent',status:'sent',serverId:'VG-SENT',sv:'trash',date:'',desc:'На оценке'}];S.tab='orders';render()");
 assert.equal(c.run('visibleOrders().length'),1);assert.match(c.node('#view').innerHTML,/Активные <span>1/);assert.match(c.node('#view').innerHTML,/Архив <span>0/);
 c.run("S.listTab='archive';render()");assert.equal(c.run('visibleOrders().length'),0);assert.match(c.node('#view').innerHTML,/Архив пуст/);
});
