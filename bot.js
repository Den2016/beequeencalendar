const TelegramBot = require('node-telegram-bot-api');
const { models } = require('./database');
const config = require('./config');
const path = require('path');

const bot = new TelegramBot(config.botToken, { polling: true });

// Константы из PHP
const eggs = {
    1: 'яйцо стоячее (1день)',
    2: 'яйцо наклонное (2день)',
    3: 'яйцо лежачее (3день)',
    4: 'однодневная личинка',
    5: 'двухдневная личинка',
    9: 'запечатанный маточник',
    10: 'печатка трутового расплода'
};

const events = {
    1: 'контроль приема личинок',
    2: 'отбор запечатанных маточников или контроль печатки',
    3: 'поставить бигуди на маточники',
    4: 'проверить выход матки',
    5: 'начало периода облета матки',
    6: 'контроль кладки',
    7: 'Печатка трутового расплода',
    8: 'Запечатанный трутень достиг момента, когда можно начинать прививку однодневной личинкой',
    9: 'Выход трутня',
    10: 'Достижение трутнем половой зрелости',
    11: 'Окончание срока годности трутня для ИО'
};

// ========== ЗНАЧЕНИЯ ПО УМОЛЧАНИЮ ==========
const DEFAULT_SUBSCRIBE = 1; // 2 = уведомления в день и за день до события (как в PHP)
const DEFAULT_SUBSCRIBE_TIME = '08:00';
const DEFAULT_EGG_FOR_FAST = 4; // однодневная личинка для быстрой прививки

// ========== ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ ДЛЯ РАБОТЫ С ДАТАМИ ==========
function parseDate(dateString) {
    if (!dateString) return new Date();
    const parts = dateString.split('-');
    return new Date(parseInt(parts[0]), parseInt(parts[1]) - 1, parseInt(parts[2]));
}

function formatDateForDB(date) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}

function formatDate(date, withDow = true) {
    const days = ['вск', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб'];
    let formatted = `${date.getDate().toString().padStart(2, '0')}.${(date.getMonth() + 1).toString().padStart(2, '0')}.${date.getFullYear().toString().slice(-2)}`;
    if (withDow) {
        formatted += ` (${days[date.getDay()]})`;
    }
    return `<b>${formatted}</b>`;
}

// ========== ФУНКЦИИ ДЛЯ РАБОТЫ С КЛАВИАТУРАМИ ==========
function sendWithKeyboard(chatId, text, keyboard, parseMode = null) {
    const options = {};
    
    if (keyboard) {
        if (keyboard.reply_markup) {
            options.reply_markup = keyboard.reply_markup;
        } else if (keyboard.inline_keyboard) {
            options.reply_markup = keyboard;
        } else if (Array.isArray(keyboard)) {
            options.reply_markup = { inline_keyboard: keyboard };
        }
    }
    
    if (parseMode) {
        options.parse_mode = parseMode;
    }
    
    return bot.sendMessage(chatId, text, options);
}

function editWithKeyboard(chatId, messageId, text, keyboard, parseMode = null) {
    const options = {
        chat_id: chatId,
        message_id: messageId
    };
    
    if (text) {
        options.text = text;
    }
    
    if (keyboard) {
        if (keyboard.reply_markup) {
            options.reply_markup = keyboard.reply_markup;
        } else if (keyboard.inline_keyboard) {
            options.reply_markup = keyboard;
        } else if (Array.isArray(keyboard)) {
            options.reply_markup = { inline_keyboard: keyboard };
        }
    }
    
    if (parseMode) {
        options.parse_mode = parseMode;
    }
    
    return bot.editMessageText(text, options);
}

function editKeyboardOnly(chatId, messageId, keyboard) {
    const options = {
        chat_id: chatId,
        message_id: messageId
    };
    
    if (keyboard && keyboard.reply_markup) {
        options.reply_markup = keyboard.reply_markup;
    } else if (keyboard && keyboard.inline_keyboard) {
        options.reply_markup = keyboard;
    } else if (keyboard && Array.isArray(keyboard)) {
        options.reply_markup = { inline_keyboard: keyboard };
    } else {
        options.reply_markup = { inline_keyboard: [] };
    }
    
    return bot.editMessageReplyMarkup(options.reply_markup, options);
}

// ========== КЛАВИАТУРЫ ==========
const queenParamsKb = {
    reply_markup: {
        inline_keyboard: [
            [{ text: '1дн. яйцо', callback_data: '1de' }, { text: '2дн. яйцо', callback_data: '2de' }, { text: '3дн. яйцо', callback_data: '3de' }],
            [{ text: '1дн. личинка', callback_data: '1db' }, { text: '2дн. личинка', callback_data: '2db' }],
            [{ text: 'запечатанный маточник', callback_data: '9de' }]
        ]
    }
};

const dronParamsKb = {
    reply_markup: {
        inline_keyboard: [
            [{ text: '1дн. яйцо', callback_data: 'd1de' }, { text: '2дн. яйцо', callback_data: 'd2de' }, { text: '3дн. яйцо', callback_data: 'd3de' }],
            [{ text: 'запечатка трутня', callback_data: 'd10de' }]
        ]
    }
};

const setupKb = {
    reply_markup: {
        inline_keyboard: [[{ text: 'Настройка', callback_data: 'setupmessage' }]]
    }
};

function getSetupMenuKb() {
    return {
        reply_markup: {
            inline_keyboard: [
                [{ text: '📝 Изменить исходные данные', callback_data: 'updatequeen' }],
                [{ text: '📲 Уведомления в день события', callback_data: 'setsubscribe1' }],
                [{ text: '📲 Уведомления в день и за день до события', callback_data: 'setsubscribe2' }],
                [{ text: '❌ Отключить уведомления', callback_data: 'setsubscribe0' }],
                [{ text: '⏰ Время уведомления (мск)', callback_data: 'setsubscribetime' }],
                [{ text: '✍ Создать комментарий к записи', callback_data: 'setcomment' }],
                [{ text: '❎ Убрать меню настройки', callback_data: 'closesetupmenu' }],
                [{ text: '💣 Удалить запись', callback_data: 'delrec' }]
            ]
        }
    };
}

function getConfirmDeleteKb() {
    return {
        reply_markup: {
            inline_keyboard: [
                [{ text: '✅ Удалить', callback_data: 'yes_delrec' }, { text: '❎ Оставить', callback_data: 'closesetupmenu' }]
            ]
        }
    };
}

function buildCalendarKeyboard(currentDate) {
    const year = currentDate.getFullYear();
    const month = currentDate.getMonth() + 1;
    const selectedDay = currentDate.getDate();
    
    const months = ['', 'январь', 'февраль', 'март', 'апрель', 'май', 'июнь', 'июль', 'август', 'сентябрь', 'октябрь', 'ноябрь', 'декабрь'];
    
    const firstDay = new Date(year, month - 1, 1);
    const daysInMonth = new Date(year, month, 0).getDate();
    let startOffset = firstDay.getDay() - 1;
    if (startOffset === -1) startOffset = 6;
    
    const keyboard = [[
        { text: months[month] || '', callback_data: `setmonth_${month}` }
    ]];
    
    const weekDays = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'];
    const weekRow = weekDays.map(d => ({ text: d, callback_data: 'ignore' }));
    keyboard.push(weekRow);
    
    let week = [];
    for (let i = 0; i < startOffset; i++) {
        week.push({ text: ' ', callback_data: 'ignore' });
    }
    
    for (let day = 1; day <= daysInMonth; day++) {
        const isSelected = day === selectedDay;
        const text = isSelected ? `(${day})` : ` ${day}`;
        week.push({ text, callback_data: `setday_${day}` });
        
        if (week.length === 7) {
            keyboard.push([...week]);
            week = [];
        }
    }
    
    if (week.length > 0) {
        while (week.length < 7) {
            week.push({ text: ' ', callback_data: 'ignore' });
        }
        keyboard.push(week);
    }
    
    keyboard.push([{ text: '✅ подтвердить дату', callback_data: 'setdate' }]);
    
    return { reply_markup: { inline_keyboard: keyboard } };
}

// ========== ОСНОВНЫЕ ФУНКЦИИ БОТА ==========
async function updateUser(message) {
    const from = message.from;
    let user = await models.BeeUser.findOne({ tg_id: from.id });
    if (!user) {
        await models.BeeUser.create({
            tg_id: from.id,
            is_bot: from.is_bot ? 1 : 0,
            first_name: from.first_name || '',
            last_name: from.last_name || '',
            username: from.username || '',
            language_code: from.language_code || ''
        });
    } else {
        await models.BeeUser.update(from.id, {});
    }
    return await models.BeeUser.findOne({ tg_id: from.id });
}

async function addEvent(tg_id, chat_id, msg_id, date, eventId, typ) {
    const bp = await models.BeeParams.findOne({ tg_id, msg_id, chat_id });
    if (!bp) return;

    const subscribe = bp.subscribe;
    const evDate = formatDateForDB(date);
    
    if (subscribe === 1 || subscribe === 2) {
        const eventText = typ === 1 
            ? `Здравствуйте.\nСегодня, ${formatDate(date)} такое событие:\n\n <b>${events[eventId]}</b>`
            : `Здравствуйте.\nСегодня, ${formatDate(date)} по прививке необходимо сделать/проконтролировать:\n\n <b>${events[eventId]}</b>`;
        
        await models.BeeSubscribes.create({
            tg_id, chat_id, msg_id,
            dt: evDate,
            eventid: eventId,
            event: eventText,
            tp: 0,
            sent: 0
        });
    }

    if (subscribe === 2) {
        const prevDate = new Date(date);
        prevDate.setDate(prevDate.getDate() - 1);
        const prevDateStr = formatDateForDB(prevDate);
        
        const eventText = typ === 1
            ? `Здравствуйте.\nСегодня, ${formatDate(date)}\nНапоминаю, что завтра возникнет такое событие:\n\n <b>${events[eventId]}</b>`
            : `Здравствуйте.\nСегодня ${formatDate(prevDate)}\nНапоминаю, что завтра, ${formatDate(date)} возникнет следующее событие:\n\n <b>${events[eventId]}</b>`;
        
        await models.BeeSubscribes.create({
            tg_id, chat_id, msg_id,
            dt: prevDateStr,
            eventid: null,
            event: eventText,
            tp: 0,
            sent: 0
        });
    }
}

async function calcCalendar(msg_id, chat_id, tg_id) {
    await models.BeeSubscribes.deleteAll({ tg_id, msg_id, chat_id });
    
    const bp = await models.BeeParams.findOne({ tg_id, msg_id, chat_id });
    if (!bp) return '';
    
    const egg = bp.egg;
    const date = parseDate(bp.dt);
    
    let eggDate = new Date(date);
    if (egg !== 1) {
        eggDate.setDate(eggDate.getDate() - (egg - 1));
    }
    
    let atext = '';
    
    if (bp.typ === 0) {
        let dt = new Date(eggDate);
        dt.setDate(dt.getDate() + 5);
        await addEvent(tg_id, chat_id, msg_id, dt, 1, bp.typ);
        
        dt.setDate(dt.getDate() + 3);
        await addEvent(tg_id, chat_id, msg_id, dt, 2, bp.typ);
        
        dt = new Date(eggDate);
        dt.setDate(dt.getDate() + 13);
        await addEvent(tg_id, chat_id, msg_id, dt, 3, bp.typ);
        
        dt.setDate(dt.getDate() + 1);
        await addEvent(tg_id, chat_id, msg_id, dt, 4, bp.typ);
        
        dt.setDate(dt.getDate() + 1);
        
        dt = new Date(eggDate);
        dt.setDate(dt.getDate() + 21);
        await addEvent(tg_id, chat_id, msg_id, dt, 5, bp.typ);
        
        dt = new Date(eggDate);
        dt.setDate(dt.getDate() + 27);
        await addEvent(tg_id, chat_id, msg_id, dt, 6, bp.typ);
        
        const controlDate = formatDate(new Date(eggDate.getTime() + 5*24*60*60*1000));
        const closeDate = formatDate(new Date(eggDate.getTime() + 8*24*60*60*1000));
        const takeDate = formatDate(new Date(eggDate.getTime() + 13*24*60*60*1000));
        const outDateStart = formatDate(new Date(eggDate.getTime() + 14*24*60*60*1000));
        const outDateEnd = formatDate(new Date(eggDate.getTime() + 15*24*60*60*1000));
        const flyDateStart = formatDate(new Date(eggDate.getTime() + 21*24*60*60*1000));
        const eggControlDate = formatDate(new Date(eggDate.getTime() + 27*24*60*60*1000));
        
        if (egg === 9) {
            atext += `${formatDate(eggDate)} яйцо\n\n`;
        } else {
            atext += `${controlDate} - контроль приема, открытый маточник\n`;
            atext += `${closeDate} - запечатка маточника\n`;
        }
        atext += `${takeDate} - отбор (бигуди)\n`;
        atext += `${outDateStart} - ${outDateEnd} - выход маток\n`;
        atext += `${flyDateStart} - облет\n`;
        atext += `c ${eggControlDate} - контроль засева\n\n`;
        
    } else if (bp.typ === 1) {
        let dt = new Date(eggDate);
        dt.setDate(dt.getDate() + 10);
        if (egg !== 10) await addEvent(tg_id, chat_id, msg_id, dt, 7, bp.typ);
        
        dt.setDate(dt.getDate() + 3);
        await addEvent(tg_id, chat_id, msg_id, dt, 8, bp.typ);
        
        dt.setDate(dt.getDate() + 11);
        await addEvent(tg_id, chat_id, msg_id, dt, 9, bp.typ);
        
        dt.setDate(dt.getDate() + 11);
        await addEvent(tg_id, chat_id, msg_id, dt, 10, bp.typ);
        
        dt = new Date(eggDate);
        dt.setDate(dt.getDate() + 48);
        await addEvent(tg_id, chat_id, msg_id, dt, 11, bp.typ);
        
        const closeDronDate = formatDate(new Date(eggDate.getTime() + 10*24*60*60*1000));
        const queenReadyDate = formatDate(new Date(eggDate.getTime() + 13*24*60*60*1000));
        const dronOutDate = formatDate(new Date(eggDate.getTime() + 24*24*60*60*1000));
        const dronReadyDate = formatDate(new Date(eggDate.getTime() + 35*24*60*60*1000));
        const endUsefulDronDate = formatDate(new Date(eggDate.getTime() + 48*24*60*60*1000));
        
        if (egg !== 10) atext += `${closeDronDate} - запечатка расплода\n`;
        atext += `${queenReadyDate} - можно начинать вывод маток\n`;
        atext += `${dronOutDate} - выход трутня\n`;
        atext += `${dronReadyDate} - созревание трутня\n`;
        atext += `${endUsefulDronDate} - трутень далее непригоден для ИО\n\n`;
    }
    
    let text = `Расчет ${bp.typ === 1 ? 'вывода трутня ' : ''}для заданных параметров\n<b>---------------\n`;
    text += `${eggs[egg]}\n`;
    text += `${formatDate(date)}\n`;
    if (bp.subscribe === 0) text += "❌ Уведомления отключены\n";
    if (bp.subscribe === 1) text += `📲 Уведомления включены в день события. Время отправки уведомления ${bp.subscribetime}\n`;
    if (bp.subscribe === 2) text += `📲 Уведомления включены в день и за день до события. Время отправки уведомления ${bp.subscribetime} (мск)\n`;
    text += "----------------</b>\n";
    text += atext;
    text += bp.comment || '';
    
    if (bp.waitfor === 'comment') {
        text += "\n\n<b> Ожидание ввода комментария. Отправьте сообщение, которое будет прикреплено к этому расчету в качестве комментария</b>";
    }
    if (bp.waitfor === 'time') {
        text += "\n\n<b> Ожидание ввода времени уведомления. Отправьте сообщение, в котором укажите время в виде\n08:00 или 8 15 или 8</b>";
    }
    
    return text;
}

// ========== ОБРАБОТЧИКИ КОМАНД ==========
bot.onText(/\/start/, async (msg) => {
    const chatId = msg.chat.id;
    await updateUser(msg);
    await sendWithKeyboard(chatId, 'Привет. Этот бот поможет спланировать вывод маток. Для обсуждения есть чат @beequeencalendar_bot_chat', null);
});

bot.onText(/\/newqueen/, async (msg) => {
    const chatId = msg.chat.id;
    const messageId = msg.message_id;
    await bot.deleteMessage(chatId, messageId);
    await sendWithKeyboard(chatId, 'Выберите начальные данные', queenParamsKb);
});

bot.onText(/\/fastnewqueen/, async (msg) => {
    const chatId = msg.chat.id;
    const tgId = msg.from.id;
    const messageId = msg.message_id;
    
    await bot.deleteMessage(chatId, messageId);
    const sent = await bot.sendMessage(chatId, 'подготовка');
    
    const today = new Date();
    const todayStr = formatDateForDB(today);
    
    let bp = await models.BeeParams.findOne({ tg_id: tgId, msg_id: sent.message_id, chat_id: chatId });
    if (!bp) {
        // ВНИМАНИЕ: Уведомления ВКЛЮЧЕНЫ по умолчанию (subscribe = DEFAULT_SUBSCRIBE)
        await models.BeeParams.create({
            tg_id: tgId, chat_id: chatId, msg_id: sent.message_id,
            typ: 0, 
            egg: DEFAULT_EGG_FOR_FAST, 
            subscribe: DEFAULT_SUBSCRIBE,  // ← Изменено: теперь включены по умолчанию
            subscribetime: DEFAULT_SUBSCRIBE_TIME, 
            dt: todayStr
        });
    } else {
        await models.BeeParams.update(bp.id, { egg: DEFAULT_EGG_FOR_FAST, dt: todayStr });
    }
    
    const text = await calcCalendar(sent.message_id, chatId, tgId);
    await editWithKeyboard(chatId, sent.message_id, text, setupKb, 'HTML');
});

bot.onText(/\/newdron/, async (msg) => {
    const chatId = msg.chat.id;
    const messageId = msg.message_id;
    await bot.deleteMessage(chatId, messageId);
    await sendWithKeyboard(chatId, 'Выберите начальные данные', dronParamsKb);
});

bot.onText(/\/summary/, async (msg) => {
    const chatId = msg.chat.id;
    const tgId = msg.from.id;
    
    const today = new Date();
    const nextWeek = new Date();
    nextWeek.setDate(today.getDate() + 7);
    
    const todayStr = formatDateForDB(today);
    const nextWeekStr = formatDateForDB(nextWeek);
    
    const list = await models.BeeSubscribes.findForSummary(chatId, tgId, todayStr, nextWeekStr);
    
    if (!list || list.length === 0) {
        await bot.sendMessage(chatId, 'В ближайшие 7 дней событий нет');
        return;
    }
    
    const daysOfWeekRu = ['Понедельник', 'Вторник', 'Среда', 'Четверг', 'Пятница', 'Суббота', 'Воскресенье'];
    let outputText = '';
    let currentGroupTitle = null;
    
    for (const record of list) {
        const date = parseDate(record.dt);
        const formattedDate = `${date.getDate().toString().padStart(2, '0')}-${(date.getMonth() + 1).toString().padStart(2, '0')}-${date.getFullYear()}`;
        const weekDayNumber = (date.getDay() + 6) % 7;
        const weekDay = daysOfWeekRu[weekDayNumber];
        const groupTitle = `${formattedDate} (${weekDay})`;
        
        if (groupTitle !== currentGroupTitle) {
            if (currentGroupTitle !== null) outputText += '\n';
            outputText += `<b>${groupTitle}</b>\n`;
            currentGroupTitle = groupTitle;
        }
        
        outputText += `<code>${events[record.eventid]}: <b>${record.comment || ''}</b></code>\n`;
    }
    
    await bot.sendMessage(chatId, outputText, { parse_mode: 'HTML' });
});

bot.onText(/\/subscribe/, async (msg) => {
    const chatId = msg.chat.id;
    const replyTo = msg.reply_to_message;
    const msgId = msg.message_id;
    
    if (!replyTo) {
        await bot.sendMessage(chatId, 'Команда /subscribe должна использоваться как ответ на сообщение, на которое необходимо настроить оповещения');
        await bot.deleteMessage(chatId, msgId);
    }
});

// ========== ОБРАБОТЧИК CALLBACK ЗАПРОСОВ ==========
bot.on('callback_query', async (callbackQuery) => {
    if (!callbackQuery || !callbackQuery.data || !callbackQuery.message) {
        console.log('Invalid callback_query received');
        return;
    }

    const chatId = callbackQuery.message.chat.id;
    const messageId = callbackQuery.message.message_id;
    const tgId = callbackQuery.from.id;
    const data = callbackQuery.data;
    
    console.log(`Received callback_query: tgId=${tgId}, chatId=${chatId}, messageId=${messageId}, data=${data}`);

    await bot.answerCallbackQuery(callbackQuery.id);
    
    // Обработка выбора яйца/личинки
    if (['1de', '2de', '3de', '1db', '2db', '9de', 'd1de', 'd2de', 'd3de', 'd10de'].includes(data)) {
        let egg = 0;
        let typ = 0;
        
        switch (data) {
            case '1de': egg = 1; typ = 0; break;
            case '2de': egg = 2; typ = 0; break;
            case '3de': egg = 3; typ = 0; break;
            case '1db': egg = 4; typ = 0; break;
            case '2db': egg = 5; typ = 0; break;
            case '9de': egg = 9; typ = 0; break;
            case 'd1de': egg = 1; typ = 1; break;
            case 'd2de': egg = 2; typ = 1; break;
            case 'd3de': egg = 3; typ = 1; break;
            case 'd10de': egg = 10; typ = 1; break;
        }
        
        let bp = await models.BeeParams.findOne({ tg_id: tgId, msg_id: messageId, chat_id: chatId });
        const today = new Date();
        const todayStr = formatDateForDB(today);
        
        if (!bp) {
            // ВНИМАНИЕ: Уведомления ВКЛЮЧЕНЫ по умолчанию (subscribe = DEFAULT_SUBSCRIBE)
            await models.BeeParams.create({
                tg_id: tgId, chat_id: chatId, msg_id: messageId,
                typ: typ, 
                egg: egg, 
                subscribe: DEFAULT_SUBSCRIBE,  // ← Изменено: теперь включены по умолчанию
                subscribetime: DEFAULT_SUBSCRIBE_TIME,
                dt: todayStr
            });
            bp = await models.BeeParams.findOne({ tg_id: tgId, msg_id: messageId, chat_id: chatId });
        } else {
            await models.BeeParams.update(bp.id, { egg: egg, typ: typ });
            bp = await models.BeeParams.findOne({ tg_id: tgId, msg_id: messageId, chat_id: chatId });
        }
        
        const currentDate = bp.dt ? parseDate(bp.dt) : new Date();
        const calendarKeyboard = buildCalendarKeyboard(currentDate);
        await editWithKeyboard(chatId, messageId, `Выбрано ${eggs[egg]}\nВыберите дату`, calendarKeyboard);
        return;
    }
    
    // Установка дня
    if (data.startsWith('setday_')) {
        const day = parseInt(data.split('_')[1]);
        if (day && !isNaN(day)) {
            const bp = await models.BeeParams.findOne({ tg_id: tgId, msg_id: messageId, chat_id: chatId });
            if (bp && bp.dt) {
                const currentDate = parseDate(bp.dt);
                currentDate.setDate(day);
                await models.BeeParams.update(bp.id, { dt: formatDateForDB(currentDate) });
                const newKeyboard = buildCalendarKeyboard(currentDate);
                await editKeyboardOnly(chatId, messageId, newKeyboard);
            }
        }
        return;
    }
    
    // Установка месяца
    if (data.startsWith('setmonth_')) {
        const month = parseInt(data.split('_')[1]);
        if (month && !isNaN(month)) {
            const bp = await models.BeeParams.findOne({ tg_id: tgId, msg_id: messageId, chat_id: chatId });
            if (bp && bp.dt) {
                const currentDate = parseDate(bp.dt);
                const oldDay = currentDate.getDate();
                currentDate.setMonth(month - 1);
                
                const newDay = currentDate.getDate();
                if (newDay !== oldDay) {
                    currentDate.setDate(0);
                }
                
                await models.BeeParams.update(bp.id, { dt: formatDateForDB(currentDate) });
                const newKeyboard = buildCalendarKeyboard(currentDate);
                await editKeyboardOnly(chatId, messageId, newKeyboard);
            }
        }
        return;
    }
    
    // Подтверждение даты
    if (data === 'setdate') {
        const text = await calcCalendar(messageId, chatId, tgId);
        await editWithKeyboard(chatId, messageId, text, setupKb, 'HTML');
        return;
    }
    
    // Закрыть меню настройки
    if (data === 'closesetupmenu') {
        await editKeyboardOnly(chatId, messageId, setupKb);
        return;
    }
    
    // Открыть меню настройки
    if (data === 'setupmessage') {
        await editKeyboardOnly(chatId, messageId, getSetupMenuKb());
        return;
    }
    
    // Изменить исходные данные
    if (data === 'updatequeen') {
        const bp = await models.BeeParams.findOne({ tg_id: tgId, msg_id: messageId, chat_id: chatId });
        const kb = bp && bp.typ === 1 ? dronParamsKb : queenParamsKb;
        await editWithKeyboard(chatId, messageId, 'Выберите начальные данные', kb);
        return;
    }
    
    // Настройка подписок
    if (data === 'setsubscribe0' || data === 'setsubscribe1' || data === 'setsubscribe2') {
        const subscribe = parseInt(data.slice(-1));
        const bp = await models.BeeParams.findOne({ tg_id: tgId, msg_id: messageId, chat_id: chatId });
        if (bp) {
            await models.BeeParams.update(bp.id, { subscribe });
            const text = await calcCalendar(messageId, chatId, tgId);
            await editWithKeyboard(chatId, messageId, text, setupKb, 'HTML');
        }
        return;
    }
    
    // Установка времени уведомлений
    if (data === 'setsubscribetime') {
        const bp = await models.BeeParams.findOne({ tg_id: tgId, msg_id: messageId, chat_id: chatId });
        if (bp) {
            await models.BeeParams.update(bp.id, { waitfor: 'time' });
            const text = await calcCalendar(messageId, chatId, tgId);
            await editWithKeyboard(chatId, messageId, text, setupKb, 'HTML');
        }
        return;
    }
    
    // Установка комментария
    if (data === 'setcomment') {
        const bp = await models.BeeParams.findOne({ tg_id: tgId, msg_id: messageId, chat_id: chatId });
        if (bp) {
            await models.BeeParams.update(bp.id, { waitfor: 'comment' });
            const text = await calcCalendar(messageId, chatId, tgId);
            await editWithKeyboard(chatId, messageId, text, setupKb, 'HTML');
        }
        return;
    }
    
    // Удаление записи
    if (data === 'delrec') {
        await editKeyboardOnly(chatId, messageId, getConfirmDeleteKb());
        return;
    }
    
    if (data === 'yes_delrec') {
        await models.BeeParams.delete({ tg_id: tgId, msg_id: messageId, chat_id: chatId });
        await models.BeeMessages.deleteAll({ tg_id: tgId, msg_id: messageId, chat_id: chatId });
        await editWithKeyboard(chatId, messageId, 'Удалено', null, 'HTML');
        return;
    }
});

// ========== ОБРАБОТЧИК ТЕКСТОВЫХ СООБЩЕНИЙ ==========
bot.on('message', async (msg) => {
    if (msg.text && msg.text.startsWith('/')) return;
    
    const chatId = msg.chat.id;
    const tgId = msg.from.id;
    const messageId = msg.message_id;
    const text = msg.text;
    
    // Обработка комментария
    let bp = await models.BeeParams.findOne({ chat_id: chatId, waitfor: 'comment' });
    if (bp) {
        await models.BeeParams.update(bp.id, { comment: text, waitfor: null });
        await bot.deleteMessage(chatId, messageId);
        const newText = await calcCalendar(bp.msg_id, chatId, bp.tg_id);
        await editWithKeyboard(chatId, bp.msg_id, newText, setupKb, 'HTML');
        return;
    }
    
    // Обработка времени
    bp = await models.BeeParams.findOne({ chat_id: chatId, waitfor: 'time' });
    if (bp) {
        const timeMatch = text.match(/(\d{1,2})(?:\s|:)?(\d{0,2})/);
        if (timeMatch) {
            let hours = parseInt(timeMatch[1]);
            let minutes = timeMatch[2] ? parseInt(timeMatch[2]) : 0;
            if (hours < 0 || hours > 23) hours = 8;
            if (minutes < 0 || minutes > 59) minutes = 0;
            const timeStr = `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}`;
            await models.BeeParams.update(bp.id, { subscribetime: timeStr, waitfor: null });
            await bot.deleteMessage(chatId, messageId);
            const newText = await calcCalendar(bp.msg_id, chatId, bp.tg_id);
            await editWithKeyboard(chatId, bp.msg_id, newText, setupKb, 'HTML');
        }
        return;
    }
    
    // Сохраняем сообщение в beemessages
    const existing = await models.BeeMessages.findOne({ tg_id: tgId, chat_id: chatId, msg_id: messageId });
    if (!existing && text) {
        await models.BeeMessages.create({ tg_id: tgId, chat_id: chatId, msg_id: messageId, message: text });
    }
});

console.log('🤖 Bot started with long polling...');
console.log('📋 Default settings:');
console.log(`   - Notifications: ${DEFAULT_SUBSCRIBE === 2 ? 'ON (day and day before)' : DEFAULT_SUBSCRIBE === 1 ? 'ON (day only)' : 'OFF'}`);
console.log(`   - Notification time: ${DEFAULT_SUBSCRIBE_TIME}`);
console.log(`   - Fast new queen egg: ${eggs[DEFAULT_EGG_FOR_FAST]}`);

module.exports = bot;