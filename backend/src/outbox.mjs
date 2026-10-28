// Enqueue inside the same D1 batch as the business event. Sending is a separate step.
export function createOutbox({stmt,telegram,edit}){
 function enqueue(env,eventId,orderId,kind,payload,now){
  return stmt(env,`INSERT OR IGNORE INTO delivery_outbox(id,order_id,kind,payload,available_at,created_at)
   SELECT ?,order_id,?,?,?,? FROM order_status_events WHERE event_id=? AND order_id=?`,eventId+':'+kind,kind,JSON.stringify(payload),now,now,eventId,orderId);
 }
 async function flush(env,orderId=null){
  const now=Date.now();
  // A crashed send may already have reached Telegram. Never automatically resend it.
  await stmt(env,"UPDATE delivery_outbox SET state=CASE WHEN kind='edit' THEN 'pending' ELSE 'uncertain' END,last_error='LEASE_EXPIRED',lease_token='' WHERE state='sending' AND lease_until<?",now).run();
  const tasks=(await stmt(env,"SELECT * FROM delivery_outbox WHERE state='pending' AND available_at<=? AND (? IS NULL OR order_id=?) ORDER BY created_at,id LIMIT 10",now,orderId,orderId).all()).results;
  for(const task of tasks){
   const token=crypto.randomUUID();
   const lock=await stmt(env,`UPDATE delivery_outbox SET state='sending',lease_token=?,lease_until=?,attempts=attempts+1
    WHERE id=? AND state='pending' AND available_at<=? AND NOT EXISTS
    (SELECT 1 FROM delivery_outbox other WHERE other.order_id=delivery_outbox.order_id AND other.state='sending')`,token,Date.now()+120000,task.id,Date.now()).run();
   if(!lock.meta.changes)continue;
   try{
    if(task.kind==='edit'){
     const row=await stmt(env,'SELECT * FROM orders WHERE id=?',task.order_id).first();
     if(row?.state==='sent')await edit(env,row);
    }else{
     const params=JSON.parse(task.payload),form=new FormData();
     for(const [k,v] of Object.entries(params))form.set(k,typeof v==='object'?JSON.stringify(v):String(v));
     try{await telegram(env,'sendMessage',form)}catch(e){
      if(e.code==='DELIVERY'&&e.telegramCode===400&&form.has('reply_markup')){form.delete('reply_markup');await telegram(env,'sendMessage',form)}else throw e;
     }
    }
    await stmt(env,"UPDATE delivery_outbox SET state='sent',last_error='',lease_token='' WHERE id=? AND lease_token=?",task.id,token).run();
   }catch(e){
    const ambiguous=task.kind!=='edit'&&(!['RATE','DELIVERY'].includes(e.code));
    const delay=Math.max(e.retryAfter||0,Math.min(3600,15*2**Math.min(task.attempts,8)))*1000;
    await stmt(env,"UPDATE delivery_outbox SET state=?,available_at=?,last_error=?,lease_token='' WHERE id=? AND lease_token=?",ambiguous?'uncertain':(e.telegramCode===403||task.attempts>=9)?'failed':'pending',Date.now()+delay,['RATE','DELIVERY','UNCERTAIN'].includes(e.code)?e.code:'INTERNAL',task.id,token).run();
   }
  }
 }
 return {enqueue,flush};
}
