import {consumeLimit} from './security.mjs';
import {PROFILE_REVISION,welcomeText,welcomeKeyboard} from './bot-profile.mjs';

const throwRate=error=>{throw error};
const form=data=>{const f=new FormData();for(const [key,value] of Object.entries(data))f.set(key,typeof value==='object'?JSON.stringify(value):String(value));return f};
const contentKeys=['text','photo','document','video','voice','audio','animation','sticker','video_note','location','venue','poll','dice'];
export function createBotChatService({telegram,stmt}){
 async function ensureWelcome(env,userId,explicit=false){
  const now=Date.now(),cleanup=env.CLEAN_PRIVATE_MESSAGES==='true',revision=PROFILE_REVISION*2+Number(cleanup);
  await stmt(env,'INSERT OR IGNORE INTO bot_private_chats(user_id,updated_at) VALUES(?,?)',userId,now).run();
  let row=await stmt(env,'SELECT * FROM bot_private_chats WHERE user_id=?',userId).first();
  if(row.lease_until>now)return false;
  if(row.welcome_state==='sending'){
   await stmt(env,"UPDATE bot_private_chats SET welcome_state='uncertain',lease_token='' WHERE user_id=? AND lease_until<=? AND welcome_state='sending'",userId,now).run();
   row={...row,welcome_state:'uncertain'};
  }
  // Only a new explicit /start or /help can recover an ambiguous welcome send.
  // Never automatically repeat a send whose result was lost.
  if(['uncertain','blocked'].includes(row.welcome_state)&&(!explicit||now-row.updated_at<60000))return false;
  if(!explicit&&row.pinned&&row.welcome_revision===revision&&row.synced_at>now-600000)return true;
  try{
   await consumeLimit(env,'private:welcome:'+userId,3,60000,throwRate);
   await consumeLimit(env,'private:welcome:global',15,60000,throwRate);
  }catch(e){if(e.code==='RATE')return false;throw e}
  const token=crypto.randomUUID();
  const lock=await stmt(env,"UPDATE bot_private_chats SET lease_token=?,lease_until=?,updated_at=?,welcome_state=CASE WHEN welcome_message_id IS NULL THEN 'sending' ELSE 'ready' END WHERE user_id=? AND lease_until<=?",token,now+120000,now,userId,now).run();
  if(!lock.meta.changes)return false;
  let messageId=row.welcome_message_id;
  try{
   if(messageId){
    try{await telegram(env,'editMessageText',form({chat_id:userId,message_id:messageId,text:welcomeText(cleanup),parse_mode:'HTML',reply_markup:welcomeKeyboard(env)}))}
    catch(e){if(e.code==='DELIVERY'&&e.messageMissing)messageId=null;else throw e}
   }
   if(!messageId){
    // Persist the send state before calling Telegram so a crash cannot cause an automatic duplicate.
    await stmt(env,"UPDATE bot_private_chats SET welcome_state='sending',welcome_message_id=NULL,pinned=0 WHERE user_id=? AND lease_token=?",userId,token).run();
    const sent=await telegram(env,'sendMessage',form({chat_id:userId,text:welcomeText(cleanup),parse_mode:'HTML',reply_markup:welcomeKeyboard(env),disable_notification:true}));
    if(!Number.isSafeInteger(sent?.message_id)||sent.message_id<=0)throw Error('Unconfirmed welcome message');
    messageId=sent.message_id;
    await stmt(env,"UPDATE bot_private_chats SET welcome_state='ready',welcome_message_id=?,welcome_revision=?,pinned=0 WHERE user_id=? AND lease_token=?",messageId,revision,userId,token).run();
   }
   if(!row.pinned||explicit||row.welcome_message_id!==messageId){
    await telegram(env,'pinChatMessage',form({chat_id:userId,message_id:messageId,disable_notification:true}));
   }
   await stmt(env,"UPDATE bot_private_chats SET welcome_state='ready',welcome_revision=?,pinned=1,synced_at=?,lease_until=0,lease_token='' WHERE user_id=? AND lease_token=?",revision,Date.now(),userId,token).run();
   return true;
  }catch(e){
   const state=messageId?'ready':e.telegramCode===403?'blocked':['RATE','DELIVERY'].includes(e.code)?'new':'uncertain';
   await stmt(env,'UPDATE bot_private_chats SET welcome_state=?,welcome_message_id=COALESCE(?,welcome_message_id),lease_until=0,lease_token=\'\' WHERE user_id=? AND lease_token=?',state,messageId,userId,token).run();
   return false;
  }
 }
 async function flushCleanup(env,userId=null){
  if(env.CLEAN_PRIVATE_MESSAGES!=='true')return;
  const now=Date.now();
  // Deletes are idempotent. An expired deletion lease is safe to retry.
  await stmt(env,"UPDATE private_message_cleanup SET state='pending',lease_token='' WHERE state='deleting' AND lease_until<?",now).run();
  const jobs=(await stmt(env,`SELECT c.* FROM private_message_cleanup c JOIN bot_private_chats b ON b.user_id=c.user_id
   WHERE c.state='pending' AND c.available_at<=? AND c.created_at>? AND b.pinned=1 AND b.welcome_state='ready' AND b.welcome_revision=?
   AND (? IS NULL OR c.user_id=?) AND c.message_id!=b.welcome_message_id ORDER BY c.created_at,c.message_id LIMIT 10`,now,now-48*3600000,PROFILE_REVISION*2+1,userId,userId).all()).results;
  for(const job of jobs){
   const token=crypto.randomUUID();
   const claim=await stmt(env,"UPDATE private_message_cleanup SET state='deleting',lease_token=?,lease_until=?,attempts=attempts+1 WHERE user_id=? AND message_id=? AND state='pending' AND available_at<=?",token,Date.now()+120000,job.user_id,job.message_id,Date.now()).run();
   if(!claim.meta.changes)continue;
   let error=null;
   try{
    await consumeLimit(env,'private:cleanup:global',60,60000,throwRate);
    await telegram(env,'deleteMessage',form({chat_id:job.user_id,message_id:job.message_id}));
   }catch(e){if(!e.messageMissing)error=e}
   if(!error)await stmt(env,"UPDATE private_message_cleanup SET state='done',lease_token='',lease_until=0 WHERE user_id=? AND message_id=? AND lease_token=?",job.user_id,job.message_id,token).run();
   else{
    const delay=Math.max(error.retryAfter||0,Math.min(3600,15*2**Math.min(job.attempts,8)))*1000;
    await stmt(env,"UPDATE private_message_cleanup SET state=?,available_at=?,lease_token='',lease_until=0 WHERE user_id=? AND message_id=? AND lease_token=?",error.telegramCode===403||job.attempts>=7?'failed':'pending',Date.now()+delay,job.user_id,job.message_id,token).run();
    if(error.code==='RATE'||error.telegramCode===429)break;
   }
  }
 }
 async function receive(env,message){
  const id=message.from?.id;
  if(message.chat?.type!=='private'||!Number.isSafeInteger(id)||id<=0||String(message.chat.id)!==String(id)||message.from.is_bot===true||!Number.isSafeInteger(message.message_id)||message.message_id<=0||!contentKeys.some(key=>message[key]!==undefined))return false;
  const userId=String(id),now=Date.now();
  try{
   await consumeLimit(env,'private:input:'+userId,60,60000,throwRate);
   await consumeLimit(env,'private:global',600,60000,throwRate);
  }catch(e){if(e.code==='RATE')return true;throw e}
  await stmt(env,'INSERT OR IGNORE INTO bot_private_chats(user_id,updated_at) VALUES(?,?)',userId,now).run();
  if(env.CLEAN_PRIVATE_MESSAGES==='true'){
   // Keep message IDs only, never the user's free-form text, photos or attachments.
   const created=Number.isSafeInteger(message.date)&&message.date>0?Math.min(now,message.date*1000):now;
   const available=message.dice?Math.max(now,created+24*3600000+1000):now;
   if(created>now-48*3600000)await stmt(env,`INSERT OR IGNORE INTO private_message_cleanup(user_id,message_id,available_at,created_at)
    SELECT ?,?,?,? WHERE (SELECT COUNT(*) FROM private_message_cleanup WHERE user_id=? AND state IN ('pending','deleting'))<100
    AND (SELECT COUNT(*) FROM private_message_cleanup WHERE state IN ('pending','deleting'))<10000`,userId,message.message_id,available,created,userId).run();
   const previous=await stmt(env,'SELECT state FROM private_message_cleanup WHERE user_id=? AND message_id=?',userId,message.message_id).first();
   if(previous&&['done','failed'].includes(previous.state))return true;
  }
  const explicit=/^\/(?:start|help)(?:@[A-Za-z0-9_]+)?(?:\s|$)/i.test(message.text||'');
  if(await ensureWelcome(env,userId,explicit))await flushCleanup(env,userId);
  return true;
 }
 async function maintenance(env){
  const chats=(await stmt(env,`SELECT b.user_id FROM bot_private_chats b WHERE b.lease_until<=? AND b.welcome_state IN ('new','ready','sending')
   AND EXISTS(SELECT 1 FROM private_message_cleanup c WHERE c.user_id=b.user_id AND c.state='pending')
   AND (b.pinned=0 OR b.welcome_state!='ready' OR b.welcome_revision!=?) ORDER BY b.updated_at LIMIT 5`,Date.now(),PROFILE_REVISION*2+Number(env.CLEAN_PRIVATE_MESSAGES==='true')).all()).results;
  for(const chat of chats)await ensureWelcome(env,chat.user_id);
  await flushCleanup(env);
  await stmt(env,'DELETE FROM private_message_cleanup WHERE created_at<?',Date.now()-48*3600000).run();
 }
 return {receive,maintenance};
}
