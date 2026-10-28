export const PROFILE_REVISION=3;
export const SHORT_DESCRIPTION='Вывоз мебели, мусора и демонтаж. Оставьте заявку в приложении – рассчитаем стоимость.';
export const DESCRIPTION=[
 'ВАШ ГРУЗ – вывоз старой мебели и мусора, демонтаж.',
 'Опишите задачу в приложении – получите стоимость и согласуйте детали с менеджером.',
 'Для начала нажмите "Получить оценку" внизу чата.'
].join('\n\n');
export const BOT_COMMANDS=[{command:'start',description:'Открыть приложение и узнать, как всё работает'},{command:'help',description:'Услуги, стоимость и статус заявки'}];
export function welcomeText(){return [
 '<b>ВАШ ГРУЗ</b>\nВывезем старую мебель и мусор, поможем с демонтажом.',
 'Опишите задачу в приложении – там появятся стоимость и ответ менеджера.',
 'Нажмите <b>"Получить оценку"</b> внизу, чтобы начать.'
].join('\n\n')}
export function miniAppUrl(env){
 const url=new URL(env.MINI_APP_URL);
 if(url.protocol!=='https:'||url.origin!==env.ALLOWED_ORIGIN)throw Error('Invalid Mini App configuration');
 return url.href;
}
// The persistent blue menu button is the single entry point. This empty markup
// also removes the old duplicate inline button when an existing welcome is edited.
export const welcomeKeyboard=()=>({inline_keyboard:[]});
export function welcomePhotoUrl(env){
 if(!env.WELCOME_PHOTO_URL)return null;
 const url=new URL(env.WELCOME_PHOTO_URL);
 if(url.protocol!=='https:'||url.origin!==new URL(miniAppUrl(env)).origin)throw Error('Invalid welcome photo configuration');
 return url.href;
}
const form=data=>{const f=new FormData();for(const [k,v] of Object.entries(data))f.set(k,typeof v==='object'?JSON.stringify(v):String(v));return f};
export async function configureBotProfile(env,telegram,fail){
 const bot=await telegram(env,'getMe',new FormData());
 if(String(bot.username||'').toLowerCase()!==String(env.BOT_USERNAME||'').toLowerCase())fail(409,'BOT_MISMATCH','Настроен другой бот. Описание не изменялось.');
 const url=miniAppUrl(env),menu={type:'web_app',text:'Получить оценку',web_app:{url}};
 for(const language_code of ['', 'ru']){
  await telegram(env,'setMyDescription',form({description:DESCRIPTION,language_code}));
  await telegram(env,'setMyShortDescription',form({short_description:SHORT_DESCRIPTION,language_code}));
  await telegram(env,'setMyCommands',form({commands:BOT_COMMANDS,language_code}));
 }
 await telegram(env,'setChatMenuButton',form({menu_button:menu}));
 let verified=true;
 for(const language_code of ['', 'ru']){
  const description=await telegram(env,'getMyDescription',form({language_code}));
  const short=await telegram(env,'getMyShortDescription',form({language_code}));
  const commands=await telegram(env,'getMyCommands',form({language_code}));
  verified=verified&&description.description===DESCRIPTION&&short.short_description===SHORT_DESCRIPTION&&Array.isArray(commands)&&commands.length===BOT_COMMANDS.length&&BOT_COMMANDS.every((item,i)=>commands[i]?.command===item.command&&commands[i]?.description===item.description);
 }
 const actualMenu=await telegram(env,'getChatMenuButton',new FormData());
 verified=verified&&actualMenu.type==='web_app'&&actualMenu.web_app?.url===url;
 if(!verified)fail(502,'PROFILE_VERIFY','Telegram не подтвердил все настройки описания. Повторите проверку.');
 return {ok:true,bot:bot.username,verified:true,description:DESCRIPTION,shortDescription:SHORT_DESCRIPTION,menuUrl:url,cleanup:env.CLEAN_PRIVATE_MESSAGES==='true'};
}
