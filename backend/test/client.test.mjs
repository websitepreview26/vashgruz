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
  if(initialOrders)storage.set('vg-requests-v2',JSON.stringify(initialOrders.map(o=>({ownerId:live?'42':'local',...o}))));
  const node=k=>{if(!nodes.has(k))nodes.set(k,new Element());return nodes.get(k)};
  const tg={initData:'signed-test-data',platform:'ios',colorScheme:'light',initDataUnsafe:{user:{id:42,first_name:'Тест'}},ready(){},expand(){},disableVerticalSwipes(){},setHeaderColor(){},setBackgroundColor(){},setBottomBarColor(){},onEvent(){},MainButton:{hide(){}},BackButton:{onClick(){},hide(){},show(){}},HapticFeedback:{selectionChanged(){},notificationOccurred(){}}};
  const doc={querySelector:node,querySelectorAll:()=>[],addEventListener(){},documentElement:{dataset:{},style:{setProperty(){}},classList:{add(){}}},createElement(name){
    if(name==='canvas')return {width:0,height:0,getContext:()=>({fillRect(){},drawImage(){}}),toDataURL:()=> 'data:image/jpeg;base64,preview',toBlob:cb=>cb(new Blob([new Uint8Array([255,216,255,224,255,217])],{type:'image/jpeg'}))};
    return new Element();
  }};
  class FakeImage{naturalWidth=3000;naturalHeight=2000;set src(v){this.onload()}}
  const context={window:{VG_CONFIG:{apiBase:live?'https://api.example':''},...(live?{Telegram:{WebApp:tg}}:{}),addEventListener(){}},document:doc,matchMedia:()=>({matches:false}),localStorage:{getItem:k=>storage.get(k)||null,setItem:(k,v)=>storage.set(k,v)},crypto,FormData,Blob,File,FileReader:class{readAsDataURL(){this.result='data:image/jpeg;base64,original';this.onload()}},Image:FakeImage,AbortController,AbortSignal,Date,setTimeout,clearTimeout,requestAnimationFrame:()=>0,cancelAnimationFrame(){},performance,fetch:(url,opts)=>url.endsWith('/api/contact')?Promise.resolve(Response.json({ok:true,phone:''})):fetcher(url,opts),URL:{createObjectURL(){const u='blob:test-'+(++counter);urls.add(u);return u},revokeObjectURL:u=>urls.delete(u)}};
  vm.createContext(context);vm.runInContext(script,context);
  return {run:s=>vm.runInContext(s,context),node,storage,context,urls,tg};
}
test('photo preparation, five-photo limit and session-only drafts',async()=>{
  const c=client();c.run("S.w=newW('trash');render()");
  c.context.files=Array.from({length:6},()=>new File(['image'],'phone.jpg',{type:'image/jpeg'}));
  await c.run('addPhotos(files)');
  assert.equal(c.run('S.w.photos.length'),5);assert.equal(c.run('S.preparing'),false);
  assert.match(c.run('S.photoError'),/до 5/);
  const draft=JSON.parse(c.storage.get(c.run('ORDER_STORAGE_KEY')))[0];
  assert.equal(draft.photoCount,5);assert.deepEqual(draft.photos,[]);assert(!c.storage.get(c.run('ORDER_STORAGE_KEY')).includes('blob:'));
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
 c.run("S.orders=[{...remote,id:'local-sent',businessStatus:'received'},{id:'draft-1',sv:'trash',ownerId:String(user?.id||'local'),status:'draft',desc:'Черновик',date:''}];S.tab='orders';render()");
 c.node('#view').scrollTop=120;await c.run('syncOrders()');
 assert.equal(c.run('S.orders.length'),2);assert.equal(c.run('S.orders[0].businessStatus'),'processing');assert.equal(c.run('S.orders[0].id'),'local-sent');assert.equal(c.node('#view').scrollTop,120);
 assert.match(c.node('#view').innerHTML,/На оценке/);assert(!c.node('#view').innerHTML.includes('Черновик'));assert.match(c.run('home()'),/Продолжить заполнение/);
});
test('status fetch failure keeps last known state instead of fabricating progress',async()=>{
 const c=client({live:true,fetcher:async()=>{throw Error('offline')}});
 c.run("S.orders=[{id:'local',serverId:'VG-TEST',sv:'trash',ownerId:String(user?.id||'local'),status:'sent',businessStatus:'received',date:'',desc:'Диван'}];S.tab='orders'");
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
 assert(c.node('#go').disabled);assert.equal(c.node('#go').textContent,'Укажите адрес точки А');
 c.run("S.w.addr='Минск, Ленина 1';refresh()");assert(c.node('#go').disabled);assert.equal(c.node('#go').textContent,'Укажите адрес точки Б');
 c.run("S.w.to='Минск, Кирова 2';refresh()");assert.equal(c.node('#go').disabled,false);assert.equal(c.node('#go').textContent,'Далее: контакт');
 const view=c.node('#view').innerHTML;assert(view.indexOf('id="addr"')<view.indexOf('data-k="floor"'));assert(view.indexOf('data-k="floor"')<view.indexOf('id="to"'));assert(view.indexOf('id="to"')<view.indexOf('data-k="toFloor"'));assert.equal(c.run('S.step'),1);
});
test('Telegram phone sharing fills contact without a name field and caches number for next order',async()=>{
 const c=client({live:true});c.tg.requestContact=cb=>cb(true);
 c.context.fetch=async()=>Response.json({ok:true,phone:'+375291234567',updatedAt:Date.now()});
 c.run("S.w=newW('trash');S.step=2;render()");assert.match(c.node('#view').innerHTML,/Подставить номер/);assert(!c.node('#view').innerHTML.includes('id="name"'));
 await c.run('requestPhone()');assert.equal(c.run('S.w.phone'),'+375291234567');assert.equal(c.run('S.contactBusy'),false);assert.equal(c.node('#go').disabled,false);
 assert.match(c.node('#view').innerHTML,/Для уточнения деталей/);assert.equal(c.run("newW('flat').phone"),'+375291234567');
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
 const c=client();c.run("S.orders=Array.from({length:12},(_,i)=>({id:'sent-'+i,serverId:'VG-'+i,sv:'trash',ownerId:String(user?.id||'local'),status:'sent',date:'',desc:'Задача '+i,businessStatus:i===11?'cancelled':'received',customerVisibility:i===11?'archived':'active'}));S.tab='orders';render()");
 assert.equal((c.node('#view').innerHTML.match(/<article class="ord">/g)||[]).length,8);assert.match(c.node('#view').innerHTML,/Показать ещё \(3\)/);
 c.run("S.listTab='archive';render()");assert.equal((c.node('#view').innerHTML.match(/<article class="ord">/g)||[]).length,1);assert.match(c.node('#view').innerHTML,/Задача 11/);
});
test('local draft deletion uses calm confirmation and has no undo action',async()=>{
 const c=client();c.run("S.orders=[{id:'draft',sv:'trash',ownerId:String(user?.id||'local'),status:'draft',date:'',desc:'Тест'}];S.orderMenuId='draft';S.tab='orders';S.sheet='order-confirm';S.orderConfirmAction='delete'");
 const confirmation=c.run('orderActionsSheet()+sheetCloseButton()');assert.match(confirmation,/Удалить черновик\?/);assert.match(confirmation,/Можно будет заполнить новую заявку/);assert.match(confirmation,/>Оставить</);assert(!confirmation.includes('Удалить из списка'));
 await c.run("organizeOrder('delete')");assert.equal(c.run('S.orders.length'),0);assert.equal(c.run('S.organizeError'),'');assert.match(c.node('#order-notice').innerHTML,/Черновик удалён/);assert(!c.node('#order-notice').innerHTML.includes('undo-order'));assert.equal(c.run('orderUndo'),null);
});
test('server deletion is retained across subsequent status refresh',async()=>{
 const remote={id:'local',serverId:'VG-TEST',status:'sent',sv:'trash',date:'',desc:'Диван',businessStatus:'received',statusVersion:0};
 const c=client({live:true,fetcher:async(url)=>url.endsWith('/organize')?Response.json({ok:true,order:{...remote,customerVisibility:'deleted'}}):Response.json({ok:true,orders:[]})});
 c.context.record=remote;c.run("S.orders=[record];S.orderMenuId='local';S.tab='orders';S.sheet='order-confirm';S.orderConfirmAction='delete'");
 const dialog=c.run('orderActionsSheet()+sheetCloseButton()');assert.match(dialog,/Убрать заявку из списка\?/);assert.match(dialog,/Это не отменит оценку/);assert.match(dialog,/>Оставить</);assert.match(dialog,/>Убрать</);assert(!dialog.includes('>Закрыть<'));
 await c.run("organizeOrder('delete')");assert.equal(c.run('orderUndo'),null);assert.equal(c.run('S.orders.length'),0);await c.run('syncOrders()');assert.equal(c.run('S.orders.length'),0);
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
 assert.equal(JSON.parse(c.storage.get(c.run('ORDER_STORAGE_KEY'))).length,2);
});
test('drafts cannot trigger history or list tabs; an empty history selection returns to current',()=>{
 const c=client();c.run("S.orders=[{id:'draft',ownerId:String(user?.id||'local'),status:'draft',sv:'trash',desc:'Незакончено',customerVisibility:'archived'},{id:'sent',ownerId:String(user?.id||'local'),status:'sent',serverId:'VG-SENT',sv:'trash',date:'',desc:'На оценке'}];S.tab='orders';render()");
 assert.equal(c.run('visibleOrders().length'),1);assert(!c.node('#view').innerHTML.includes('order-folders'));
 c.run("S.listTab='archive';render()");assert.equal(c.run('S.listTab'),'active');assert.equal(c.run('visibleOrders().length'),1);
});
test('only closed statuses create history; accepted offers and old manually archived leads stay current',()=>{
 const c=client();c.run("S.orders=[{id:'accepted',serverId:'VG-A',ownerId:String(user?.id||'local'),status:'sent',sv:'trash',date:'',businessStatus:'accepted',customerVisibility:'archived'},{id:'processing',serverId:'VG-P',ownerId:String(user?.id||'local'),status:'sent',sv:'trash',date:'',businessStatus:'processing',customerVisibility:'archived'}];S.tab='orders';render()");
 assert.equal(c.run('visibleOrders().length'),2);assert(!c.node('#view').innerHTML.includes('order-folders'));
 c.run("S.orders.push({id:'closed',serverId:'VG-C',ownerId:String(user?.id||'local'),status:'sent',sv:'trash',date:'',businessStatus:'cancelled',customerVisibility:'active'});render()");
 assert.match(c.node('#view').innerHTML,/Текущие <span>2/);assert.match(c.node('#view').innerHTML,/История <span>1/);
 c.run("S.listTab='archive';render()");assert.equal(c.run('visibleOrders()[0].id'),'closed');
 c.run("S.orders=S.orders.filter(o=>o.id!=='closed');render()");assert.equal(c.run('S.listTab'),'active');assert(!c.node('#view').innerHTML.includes('order-folders'));
});
test('order menu contains deletion and current assessment cancellation without repeat or archive actions',()=>{
 const c=client();c.run("S.orders=[{id:'lead',serverId:'VG-LEAD',ownerId:String(user?.id||'local'),status:'sent',sv:'trash',businessStatus:'processing'}];S.orderMenuId='lead';S.sheet='order-actions'");
 let menu=c.run('orderActionsSheet()');assert.match(menu,/Убрать из списка/);assert.match(menu,/Отменить оценку/);assert(!menu.includes('data-a="again"'));assert(!menu.includes('data-v="archive"'));assert(!menu.includes('data-v="restore"'));
 c.run("S.orders[0].businessStatus='cancelled'");menu=c.run('orderActionsSheet()');assert.match(menu,/Убрать из списка/);assert(!menu.includes('Отменить оценку'));
});

test('pickup location controls conditions without assuming floor or lift and copy describes assessment',()=>{
 const c=client();c.run("S.w=newW('furniture');S.step=1;render()");
 assert.equal(c.run('S.w.floor'),null);assert.equal(c.run('S.w.lift'),null);assert.equal(c.run('S.w.location'),null);
 let html=c.node('#view').innerHTML;assert.match(html,/Из помещения/);assert.match(html,/Уже на улице/);assert(!html.includes('data-k="floor"'));
 c.run("S.w.location='indoor';render()");html=c.node('#view').innerHTML;assert.match(html,/data-k="floor"/);assert.match(html,/<option value="" selected>Не указан<\/option>/);assert(!html.includes('data-a="lift-choice" data-k="lift" data-v="true" aria-pressed="true"'));assert(!html.includes('data-a="lift-choice" data-k="lift" data-v="false" aria-pressed="true"'));assert(!html.includes('Не знаю'));
 c.run("S.w.location='outside';S.w.floor=4;S.w.lift=true;render()");assert(!c.node('#view').innerHTML.includes('data-k="floor"'));assert.match(c.run('ticket(S.w)'),/Уже на улице/);assert(!c.run('ticket(S.w)').includes('4 этаж'));
 c.run("S.step=0;render()");html=c.node('#view').innerHTML;assert.match(html,/Описание/);assert.match(html,/Помогут точнее оценить стоимость/);assert(!html.includes('Коротко:'));
 c.run("S.step=2;render()");assert.match(c.node('#view').innerHTML,/Куда сообщить стоимость/);assert.match(c.node('#view').innerHTML,/Предложение появится здесь/);
});
test('quote question is a secondary action without the price-objection prompt',()=>{
 const c=client();c.context.proposal={quote:{amountMinor:15000},businessStatus:'quoted'};
 const html=c.run('quoteCard(proposal)');assert.match(html,/class="quote-question"/);assert.match(html,/Задать вопрос/);assert(!html.includes('Если цена или условия не подходят'));
});

test('paused services are hidden in both choosers while historical labels remain available',()=>{
 const c=client();const home=c.run('home()');
 for(const id of ['flat','office','load','rig'])assert(!home.includes('data-v="'+id+'"'));
 c.run("S.w=newW('furniture');S.sheet='svc'");const picker=c.run('sheetHTML()');
 for(const id of ['flat','office','load','rig'])assert(!picker.includes('data-v="'+id+'"'));
 assert.equal(c.run("sv('flat').n"),'Квартирный переезд');
});
test('lift type is shown only when a lift is confirmed and appears in the summary',()=>{
 const c=client();c.run("S.w=newW('furniture');S.w.location='indoor';S.step=1;render()");
 assert(!c.node('#view').innerHTML.includes('Тип лифта'));
 c.run("S.w.lift=true;render()");assert.match(c.node('#view').innerHTML,/Обычный/);assert.match(c.node('#view').innerHTML,/Грузовой/);
 c.run("S.w.liftType='cargo'");assert.match(c.run('ticket(S.w)'),/грузовой лифт/);
 c.run("S.w.lift=false;render()");assert(!c.node('#view').innerHTML.includes('Тип лифта'));assert(!c.run('ticket(S.w)').includes('грузовой лифт'));
});

test('lift landing question has no default and the answer appears in the request summary',()=>{
 const c=client();c.run("S.w=newW('furniture');S.w.location='indoor';S.w.lift=true;S.step=1;render()");
 assert.equal(c.run('S.w.liftFirstFloor'),null);assert.match(c.node('#view').innerHTML,/Лифт спускается на 1-й этаж/);
 assert.match(c.node('#view').innerHTML,/Нет, только до 2-го/);
 assert(!/data-a="lift-landing"[^>]+aria-pressed="true"/.test(c.node('#view').innerHTML));
 c.run("S.w.liftType='cargo';S.w.liftFirstFloor=false");assert.match(c.run('ticket(S.w)'),/грузовой лифт, только до 2-го этажа/);
 c.run('S.w.lift=false;render()');assert(!c.node('#view').innerHTML.includes('Лифт спускается'));assert(!c.run('ticket(S.w)').includes('до 2-го'));
});

test('security: foreign and unowned cached sent orders are never rendered on failed sync',async()=>{
 const c=client({live:true,initialOrders:[{ownerId:'99',id:'foreign',serverId:'VG-000000000001',status:'sent',sv:'trash',date:'',desc:'PRIVATE OTHER ACCOUNT'},{ownerId:null,id:'unowned',status:'sent',sv:'trash',desc:'UNOWNED PRIVATE DATA'}],fetcher:async()=>{throw Error('offline')}});
 c.run("S.tab='orders';render()");assert.equal(c.run('S.orders.length'),0);assert(!c.node('#view').innerHTML.includes('PRIVATE'));
 await c.run('syncOrders()');assert.equal(c.run('S.orders.length'),0);assert(!c.node('#view').innerHTML.includes('PRIVATE'));
 assert.match(c.run('ORDER_STORAGE_KEY'),/^vg-requests-v3:42:https:\/\/api\.example$/);
});
test('security: signed upload header is sent before multipart body',async()=>{
 let sent;const c=client({live:true,fetcher:async(url,opts)=>{sent=opts;return Response.json({ok:true,id:'VG-000000000001',photoCount:0})}});
 c.run("S.w=newW('trash');Object.assign(S.w,{addr:'Минск, Ленина 1',phone:'+375291234567'});S.step=2");await c.run('submitOrder()');
 assert.equal(sent.headers['X-Telegram-Init-Data'],'signed-test-data');
});
test('security: ambiguous upload opens the saved delivery status instead of inviting a new order',async()=>{
 const c=client({live:true,fetcher:async(url)=>url.endsWith('/get')?Response.json({ok:true,order:{serverId:'VG-000000000001',requestId:'request-1234567890',sv:'trash',date:'',status:'sent',businessStatus:'delivery_pending',deliveryState:'uncertain',addr:'Минск, Ленина 1'}}):Response.json({ok:false,code:'UNCERTAIN',message:'Проверяем доставку'},{status:409})});
 c.run("S.w=newW('trash');Object.assign(S.w,{addr:'Минск, Ленина 1',phone:'+375291234567'});S.step=2");await c.run('submitOrder()');
 assert.equal(c.run('S.w'),null);assert.equal(c.run('S.tab'),'done');assert.equal(c.run('S.last.businessStatus'),'delivery_pending');assert.match(c.node('#view').innerHTML,/Проверяем доставку/);assert(!c.node('#view').innerHTML.includes('data-a="retry-delivery"'));
});
test('security: retrying known undelivered card preserves original request ID and asks for lost photos',()=>{
 const c=client({live:true});
 c.run("S.orders=[{id:'saved',ownerId:'42',status:'sent',deliveryState:'received',serverId:'VG-000000000001',requestId:'original-request-123',sv:'trash',date:'',addr:'Минск, Ленина 1',photoCount:2}];retryDelivery('saved')");
 assert.equal(c.run('S.w.submitId'),'original-request-123');assert.equal(c.run('S.w.photos.length'),0);assert.match(c.run('S.photoError'),/заново/);
});
test('security: pagination loads older remote orders and deep link looks up owner-specific record',async()=>{
 const row=n=>({serverId:'VG-'+String(n).padStart(12,'0'),requestId:'request-for-order-'+n,status:'sent',sv:'trash',date:'',desc:'Order '+n,businessStatus:'received'});
 const calls=[];const c=client({live:true,fetcher:async(url,opts)=>{
  const body=JSON.parse(opts.body);calls.push({url,body});
  if(url.endsWith('/get'))return Response.json({ok:true,order:row(500)});
  return Response.json({ok:true,orders:body.cursor?[row(101)]:Array.from({length:100},(_,i)=>row(i+1)),nextCursor:body.cursor?null:'next-page'});
 }});
 c.run('statusPageCount=2');await c.run('syncOrders()');assert.equal(c.run('S.orders.length'),101);assert.equal(c.run('statusNextCursor'),null);assert.equal(calls[1].body.cursor,'next-page');
 c.run("statusPageCount=1;pendingOrderId='VG-000000000500'");await c.run('syncOrders()');assert.equal(c.run('S.last.serverId'),'VG-000000000500');assert.equal(c.run('S.tab'),'done');assert(calls.some(c=>c.url.endsWith('/get')));
});

test('production: phone cache is scoped to authenticated user and API without importing legacy test number',()=>{
 const c=client({live:true});c.storage.set('vg-phone:42','+375291234567');
 assert.equal(c.run('cachedPhone()'),'');assert.equal(c.run('PHONE_STORAGE_KEY'),'vg-phone-v2:42:https://api.example');
 c.run("cachePhone('+375299999999')");assert.equal(c.run('cachedPhone()'),'+375299999999');assert.equal(c.storage.get('vg-phone-v2:42:https://api.example'),'+375299999999');
});

async function waitForPhotoState(condition){
 for(let i=0;i<200;i++){if(condition())return;await new Promise(resolve=>setTimeout(resolve,0))}
 assert.fail('Photo preparation did not reach the expected state');
}
function heldPhotoPreparation(c){
 const jobs=[];
 c.context.compressPhoto=(file,options)=>{options.onStage('Подготавливаем фото');return new Promise((resolve,reject)=>jobs.push({file,...options,resolve,reject}))};
 return jobs;
}
const preparedPhoto=()=>({blob:new Blob(['ready'],{type:'image/jpeg'}),url:'data:image/jpeg;base64,ready'});

test('photo progress: selected photos show live processed count and are not uploaded before order submission',async()=>{
 const uploads=[],c=client({live:true,fetcher:async(...args)=>{uploads.push(args);return Response.json({ok:true})}}),jobs=heldPhotoPreparation(c);
 c.run("S.w=newW('trash');render()");c.context.files=[new File(['a'],'a.jpg',{type:'image/jpeg'}),new File(['b'],'b.jpg',{type:'image/jpeg'})];
 const pending=c.run('addPhotos(files)');assert.equal(c.run('S.preparing'),true);assert.match(c.node('#view').innerHTML,/photo-progress/);assert.match(c.node('#view').innerHTML,/Отменить/);assert(c.node('#go').disabled);
 await waitForPhotoState(()=>jobs.length===1);assert.equal(c.node('#photo-progress-title').textContent,'Фото 1 из 2');assert.equal(c.node('#photo-progress-bar').value,0);
 jobs[0].resolve(preparedPhoto());await waitForPhotoState(()=>jobs.length===2);
 assert.equal(c.node('#photo-progress-title').textContent,'Фото 2 из 2');assert.equal(c.node('#photo-progress-bar').value,1);assert.equal(c.run('S.w.photos.length'),1);assert.match(c.node('#photo-grid').innerHTML,/base64,ready/);
 jobs[1].resolve(preparedPhoto());await pending;assert.equal(c.run('S.preparing'),false);assert.equal(c.run('S.photoProgress'),null);assert.equal(c.run('S.w.photos.length'),2);assert.equal(uploads.length,0);assert.equal(c.node('#go').disabled,false);
});
test('photo progress: cancelling keeps ready photos and ignores late work from the cancelled batch',async()=>{
 const c=client(),jobs=heldPhotoPreparation(c);c.run("S.w=newW('trash');render()");c.context.files=[new File(['a'],'a.jpg'),new File(['b'],'b.jpg')];
 const pending=c.run('addPhotos(files)');await waitForPhotoState(()=>jobs.length===1);jobs[0].resolve(preparedPhoto());await waitForPhotoState(()=>jobs.length===2);
 c.run('cancelPhotoPreparation()');assert.equal(c.run('S.preparing'),false);assert.equal(jobs[1].signal.aborted,true);assert.equal(c.run('S.w.photos.length'),1);assert.equal(c.node('#go').disabled,false);
 jobs[1].resolve(preparedPhoto());await pending;assert.equal(c.run('S.w.photos.length'),1);assert.equal(c.run('S.photoError'),'');assert.equal(JSON.parse(c.storage.get(c.run('ORDER_STORAGE_KEY')))[0].photoCount,1);
});
test('photo progress: late completion cannot cancel or corrupt a newer selection',async()=>{
 const c=client(),jobs=heldPhotoPreparation(c);c.run("S.w=newW('trash');render()");c.context.files=[new File(['a'],'a.jpg')];
 const old=c.run('addPhotos(files)');await waitForPhotoState(()=>jobs.length===1);c.run('cancelPhotoPreparation()');
 const current=c.run('addPhotos(files)');await waitForPhotoState(()=>jobs.length===2);jobs[0].resolve(preparedPhoto());await old;
 assert.equal(c.run('S.preparing'),true);assert.equal(c.run('S.w.photos.length'),0);assert.equal(c.run('S.photoProgress.total'),1);
 jobs[1].resolve(preparedPhoto());await current;assert.equal(c.run('S.w.photos.length'),1);assert.equal(c.run('S.preparing'),false);
});
test('photo progress: cancel interrupts image decoding and releases its object URL',async()=>{
 const c=client();c.context.Image=class{naturalWidth=1000;naturalHeight=1000;set src(value){this.source=value}};
 c.run("S.w=newW('trash');render()");c.context.files=[new File(['a'],'a.jpg',{type:'image/jpeg'})];
 const pending=c.run('addPhotos(files)');await waitForPhotoState(()=>c.urls.size===1);c.run('cancelPhotoPreparation()');await pending;
 assert.equal(c.urls.size,0);assert.equal(c.run('S.preparing'),false);assert.equal(c.run('S.w.photos.length'),0);assert.equal(c.run('S.photoError'),'');
});
test('photo progress: back cancels preparation immediately and keeps the draft',async()=>{
 const c=client(),jobs=heldPhotoPreparation(c);c.run("S.w=newW('trash');S.w.desc='Диван';render()");c.context.files=[new File(['a'],'a.jpg')];
 const pending=c.run('addPhotos(files)');await waitForPhotoState(()=>jobs.length===1);c.run('back()');
 assert.equal(c.run('S.w'),null);assert.equal(c.run('S.preparing'),false);assert.equal(c.run('S.tab'),'home');assert.equal(c.run('S.orders[0].desc'),'Диван');
 jobs[0].resolve(preparedPhoto());await pending;assert.equal(c.run('S.w'),null);assert.equal(c.run('S.tab'),'home');
});
test('photo progress: a failed photo advances the batch and does not leave the interface locked',async()=>{
 const c=client(),jobs=heldPhotoPreparation(c);c.run("S.w=newW('trash');render()");c.context.files=[new File(['a'],'a.jpg'),new File(['b'],'b.jpg')];
 const pending=c.run('addPhotos(files)');await waitForPhotoState(()=>jobs.length===1);jobs[0].reject(Error('Не удалось прочитать фото'));
 await waitForPhotoState(()=>jobs.length===2);assert.equal(c.node('#photo-progress-bar').value,1);assert.equal(c.run('S.w.photos.length'),0);jobs[1].resolve(preparedPhoto());await pending;
 assert.equal(c.run('S.preparing'),false);assert.equal(c.run('S.w.photos.length'),1);assert.match(c.run('S.photoError'),/Не удалось прочитать/);assert.equal(c.node('#go').disabled,false);
});

test('floor picker selects high floors directly, keeps addresses independent and allows clearing',()=>{
 const c=client();c.run("S.w=newW('flat');S.step=1;render()");
 assert.match(c.node('#view').innerHTML,/data-floor="floor"/);assert.match(c.node('#view').innerHTML,/data-floor="toFloor"/);
 c.run("selectFloor({dataset:{floor:'floor'},value:'24'});selectFloor({dataset:{floor:'toFloor'},value:'40'})");
 assert.equal(c.run('S.w.floor'),24);assert.equal(c.run('S.w.toFloor'),40);
 assert.match(c.run("conditions('','В точке А')"),/<option value="24" selected>24 этаж/);
 const draft=JSON.parse(c.storage.get(c.run('ORDER_STORAGE_KEY')))[0];assert.equal(draft.floor,24);assert.equal(draft.toFloor,40);
 c.run("selectFloor({dataset:{floor:'floor'},value:''})");assert.equal(c.run('S.w.floor'),null);assert.equal(c.run('S.w.toFloor'),40);
 for(const value of ['0','41','50','1.5','bad']){c.context.badFloor=value;c.run("selectFloor({dataset:{floor:'floor'},value:badFloor})");assert.equal(c.run('S.w.floor'),null)}
});

test('time options show ranges and custom time is validated, saved and displayed',()=>{
 const c=client();c.run("S.w=newW('trash');S.w.addr='Минск, Ленина 1';S.w.date=today();S.step=1;render()");
 for(const range of ['8:00–12:00','12:00–17:00','17:00–21:00'])assert(c.node('#view').innerHTML.includes(range));
 c.run("S.w.slot=4;render()");assert.match(c.node('#view').innerHTML,/type="time"/);assert.match(c.node('#view').innerHTML,/Своё время/);assert(!c.node('#view').innerHTML.includes('data-a="slot" data-v="4"'));
 assert.equal(c.run('!!validate().customTimeFrom'),true);
 c.run("S.w.customTimeFrom='14:30';S.w.customTimeTo='16:00';storeDraft()");assert.equal(Object.keys(c.run('validate()')).length,0);
 assert.match(c.run('ticket(S.w)'),/14:30–16:00/);
 const draft=JSON.parse(c.storage.get(c.run('ORDER_STORAGE_KEY')))[0];assert.equal(draft.customTimeFrom,'14:30');assert.equal(draft.customTimeTo,'16:00');
 c.run("S.w.customTimeTo='14:00'");assert.equal(c.run('!!validate().customTimeTo'),true);
 c.run("S.w.customTimeTo=''");assert.equal(Object.keys(c.run('validate()')).length,0);assert.match(c.run('ticket(S.w)'),/14:30/);
 c.run("S.w.slot=2");assert.match(c.run('ticket(S.w)'),/12:00–17:00/);
});

test('direct time input selects custom time and clearing it returns to any time',()=>{
 const c=client();c.run("S.w=newW('trash');S.w.date=today();S.w.slot=2;render()");
 c.run("updateCustomTime({dataset:{f:'customTimeFrom'},value:'15:30'})");assert.equal(c.run('S.w.slot'),4);assert.equal(c.run('S.w.customTimeFrom'),'15:30');
 c.run("updateCustomTime({dataset:{f:'customTimeTo'},value:'17:00'})");assert.match(c.run('ticket(S.w)'),/15:30–17:00/);
 c.run("updateCustomTime({dataset:{f:'customTimeFrom'},value:''})");assert.equal(c.run('S.w.slot'),0);assert.equal(c.run('S.w.customTimeTo'),'');
});
