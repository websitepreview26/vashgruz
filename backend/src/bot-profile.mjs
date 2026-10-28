export const PROFILE_REVISION=1;
export const SHORT_DESCRIPTION='Вывоз мебели и мусора, демонтаж. Заявка с фото, расчёт стоимости и статусы — в приложении.';
export const DESCRIPTION=[
 'ВАШ ГРУЗ — вывоз мебели и мусора, демонтаж.',
 'Опишите задачу, укажите адрес и при желании добавьте фото. Мы оценим работу и предложим стоимость.',
 'Цена, условия и статусы — в приложении. После вашего согласия менеджер свяжется с вами, чтобы уточнить детали.',
 'Нажмите «Получить оценку», чтобы начать.'
].join('\n\n');
export const BOT_COMMANDS=[{command:'start',description:'Открыть приложение и узнать, как всё работает'},{command:'help',description:'Услуги, стоимость и статус заявки'}];
export function welcomeText(cleanup){return [
 '🚚 <b>ВАШ ГРУЗ</b>',
 'Вывоз мебели и мусора · Демонтаж',
 '<b>От задачи — к понятной стоимости</b>\n1. Выберите услугу и опишите задачу.\n2. Укажите адрес и добавьте фото, если они помогут оценить работу.\n3. Получите предложение и согласуйте условия.',
 '<b>Всё по заявке — в одном месте</b>\nСтоимость, ответ менеджера и статусы появятся в разделе «Заявки». После принятия цены менеджер свяжется с вами для уточнения деталей.',
 'Нажмите кнопку ниже, чтобы получить оценку.',
 ...(cleanup?['ℹ️ Сообщения в этом чате очищаются автоматически. Чтобы передать задачу или задать вопрос по предложению, откройте приложение.']:[])
].join('\n\n')}
export function miniAppUrl(env){
 const url=new URL(env.MINI_APP_URL);
 if(url.protocol!=='https:'||url.origin!==env.ALLOWED_ORIGIN)throw Error('Invalid Mini App configuration');
 return url.href;
}
export const welcomeKeyboard=env=>({inline_keyboard:[[{text:'Получить оценку',web_app:{url:miniAppUrl(env)}}]]});
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
