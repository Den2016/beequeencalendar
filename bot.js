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

// Клавиатуры
const queenParamsKb = {
    inline_keyboard: [
        [{ text: '1дн. яйцо', callback_data: '1de' }, { text: '2дн. яйцо', callback_data: '2de' }, { text: '3дн. яйцо', callback_data: '3de' }],
        [{ text: '1дн. личинка', callback_data: '1db' }, { text: '2дн. личинка', callback_data: '2db' }],
        [{ text: 'запечатанный маточник', callback_data: '9de' }]
    ]
};

const dronParamsKb = {
    inline_keyboard: [
        [{ text: '1дн. яйцо', callback_data: 'd1de' }, { text: '2дн. яйцо', callback_data: 'd2de' }, { text: '3дн. яйцо', callback_data: 'd3de' }],
        [{ text: 'запечатка трутня', callback_data: 'd10de' }]
    ]
};

const setupKb = {
    inline_keyboard: [[{ text: 'Настройка', callback_data: 'setupmessage' }]]
};

// Вспомогательные функции
function formatDate(date, withDow = true) {
    const days = ['вск', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб'];
    let formatted = `${date.getDate().toString().padStart(2, '0')}.${(date.getMonth() + 1).toString().padStart(2, '0')}.${date.getFullYear().toString().slice(-2)}`;
    if (withDow) {
        formatted += ` (${days[date.getDay()]})`;
    }
    return `<b>${formatted}</b>`;
}

function updateUser(message) {
    const from = message.from;
    let user = models.BeeUser.findOne({ tg_id: from.id });
    if (!user) {
        models.BeeUser.create({
            tg_id: from.id,
            is_bot: from.is_bot ? 1 : 0,
            first_name: from.first_name || '',
            last_name: from.last_name || '',
            username: from.username || '',
            language_code: from.language_code || ''
        });
    } else {
        models.BeeUser.update(from.id, {});
    }
    return models.BeeUser.findOne({ tg_id: from.id });
}

function addEvent(tg_id, chat_id, msg_id, date, eventId, typ) {
    const bp = models.BeeParams.findOne({ tg_id, msg_id, chat_id });
    if (!bp) return;

    const subscribe = bp.subscribe;
    const subscribetime = bp.subscribetime || '08:00';

    if (subscribe === 1 || subscribe === 2) {
        const evDate = date.toISOString().split('T')[0];
        const eventText = typ === 1 
            ? `Здравствуйте.\nСегодня, ${formatDate(date)} такое событие:\n\n <b>${events[eventId]}</b>`
            : `Здравствуйте.\nСегодня, ${formatDate(date)} по прививке необходимо сделать/проконтролировать:\n\n <b>${events[eventId]}</b>`;
        
        models.BeeSubscribes.create({
            tg_id, chat_id, msg_id,
            dt: evDate,
            eventid: eventId,
            event: eventText
        });
    }

    if (subscribe === 2) {
        const prevDate = new Date(date);
        prevDate.setDate(prevDate.getDate() - 1);
        const eventText = typ === 1
            ? `Здравствуйте.\nСегодня, ${formatDate(date)}\nНапоминаю, что завтра возникнет такое событие:\n\n <b>${events[eventId]}</b>`
            : `Здравствуйте.\nСегодня ${formatDate(prevDate)}\nНапоминаю, что завтра, ${formatDate(date)} возникнет следующее событие:\n\n <b>${events[eventId]}</b>`;
        
        models.BeeSubscribes.create({
            tg_id, chat_id, msg_id,
            dt: prevDate.toISOString().split('T')[0],
            eventid: null,
            event: eventText
        });
    }
}

function calcCalendar(msg_id, chat_id, tg_id) {
    models.BeeSubscribes.deleteAll({ tg_id, msg_id, chat_id });
    
    const bp = models.BeeParams.findOne({ tg_id, msg_id, chat_id });
    if (!bp) return;
    
    const egg = bp.egg;
    const date = new Date(bp.dt);
    
    // Вычисляем дату однодневного яйца
    let eggDate = new Date(date);
    if (egg !== 1) {
        eggDate.setDate(eggDate.getDate() - (egg - 1));
    }
    
    let atext = '';
    
    if (bp.typ === 0) {
        // Вывод маток
        // Контроль приема (5 дней от яйца)
        let dt = new Date(eggDate);
        dt.setDate(dt.getDate() + 5);
        const controlDate = formatDate(dt);
        addEvent(tg_id, chat_id, msg_id, dt, 1, bp.typ);
        
        // Запечатка (+3 дня)
        dt.setDate(dt.getDate() + 3);
        const closeDate = formatDate(dt);
        addEvent(tg_id, chat_id, msg_id, dt, 2, bp.typ);
        
        // Отбор/бигуди (+13 дней от яйца)
        dt = new Date(eggDate);
        dt.setDate(dt.getDate() + 13);
        const takeDate = formatDate(dt);
        addEvent(tg_id, chat_id, msg_id, dt, 3, bp.typ);
        
        // Выход маток (+1 день)
        dt.setDate(dt.getDate() + 1);
        const outDateStart = formatDate(dt);
        addEvent(tg_id, chat_id, msg_id, dt, 4, bp.typ);
        
        dt.setDate(dt.getDate() + 1);
        const outDateEnd = formatDate(dt);
        
        // Облет (+21 день от яйца)
        dt = new Date(eggDate);
        dt.setDate(dt.getDate() + 21);
        const flyDateStart = formatDate(dt);
        addEvent(tg_id, chat_id, msg_id, dt, 5, bp.typ);
        
        // Контроль засева (+27 дней)
        dt = new Date(eggDate);
        dt.setDate(dt.getDate() + 27);
        const eggControlDate = formatDate(dt);
        addEvent(tg_id, chat_id, msg_id, dt, 6, bp.typ);
        
        // Формирование текста
        if (egg === 9) {
            atext += `${formatDate(eggDate)} яйцо\n\n`;
        } else {
            if (egg === 4 || egg === 5) {
                // Для личинок
            }
            atext += `${controlDate} - контроль приема, открытый маточник\n`;
            atext += `${closeDate} - запечатка маточника\n`;
        }
        atext += `${takeDate} - отбор (бигуди)\n`;
        atext += `${outDateStart} - ${outDateEnd} - выход маток\n`;
        atext += `${flyDateStart} - облет\n`;
        atext += `c ${eggControlDate} - контроль засева\n\n`;
        
    } else if (bp.typ === 1) {
        // Вывод трутней
        let dt = new Date(eggDate);
        dt.setDate(dt.getDate() + 10);
        const closeDronDate = formatDate(dt);
        if (egg !== 10) addEvent(tg_id, chat_id, msg_id, dt, 7, bp.typ);
        
        dt.setDate(dt.getDate() + 3);
        const queenReadyDate = formatDate(dt);
        addEvent(tg_id, chat_id, msg_id, dt, 8, bp.typ);
        
        dt.setDate(dt.getDate() + 11);
        const dronOutDate = formatDate(dt);
        addEvent(tg_id, chat_id, msg_id, dt, 9, bp.typ);
        
        dt.setDate(dt.getDate() + 11);
        const dronReadyDate = formatDate(dt);
        addEvent(tg_id, chat_id, msg_id, dt, 10, bp.typ);
        
        dt = new Date(eggDate);
        dt.setDate(dt.getDate() + 48);
        const endUsefulDronDate = formatDate(dt);
        addEvent(tg_id, chat_id, msg_id, dt, 11, bp.typ);
        
        if (egg !== 10) atext += `${closeDronDate} - запечатка расплода\n`;
        atext += `${queenReadyDate} - можно начинать вывод маток\n`;
        atext += `${dronOutDate} - выход трутня\n`;
        atext += `${dronReadyDate} - созревание трутня\n`;
        atext += `${endUsefulDronDate} - трутень далее непригоден для ИО\n\n`;
    }
    
    // Формируем итоговый текст
    let text = `Расчет ${bp.typ === 1 ? 'вывода трутня ' : ''}для заданных параметров\n<b>---------------\n`;
    text += `${eggs[egg]}\n`;
    text += `${formatDate(date)}\n`;
    if (bp.subscribe === 0) text += "Уведомления отключены\n";
    if (bp.subscribe === 1) text += `Уведомления включены в день события. Время отправки уведомления ${bp.subscribetime}\n`;
    if (bp.subscribe === 2) text += `Уведомления включены в день и за день до события. Время отправки уведомления ${bp.subscribetime} (мск)\n`;
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

function buildCalendarKeyboard(currentDate) {
    const year = currentDate.getFullYear();
    const month = currentDate.getMonth() + 1;
    const selectedDay = currentDate.getDate();
    
    const months = ['', 'январь', 'февраль', 'март', 'апрель', 'май', 'июнь', 'июль', 'август', 'сентябрь', 'октябрь', 'ноябрь', 'декабрь'];
    
    const firstDay = new Date(year, month - 1, 1);
    const lastDay = new Date(year, month, 0);
    const daysInMonth = lastDay.getDate();
    const startOffset = firstDay.getDay() === 0 ? 6 : firstDay.getDay() - 1;
    
    const keyboard = [[
        { text: months[month - 1] || '', callback_data: `setmonth_${month}` }
    ]];
    
    // Дни недели
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
        while (week.length < 7) week.push({ text: ' ', callback_data: 'ignore' });
        keyboard.push(week);
    }
    
    keyboard.push([{ text: 'подтвердить дату', callback_data: 'setdate' }]);
    // Убеждаемся, что keyboard - массив, а не объект
    console.log('Keyboard built, rows:', keyboard.length);    
    
    return { inline_keyboard: keyboard };
}

// Обработчики команд
bot.onText(/\/start/, async (msg) => {
    const chatId = msg.chat.id;
    updateUser(msg);
    await bot.sendMessage(chatId, 'Привет. Этот бот поможет спланировать вывод маток. Для обсуждения есть чат @beequeencalendar_bot_chat');
});

bot.onText(/\/newqueen/, async (msg) => {
    const chatId = msg.chat.id;
    const messageId = msg.message_id;
    await bot.deleteMessage(chatId, messageId);
    await bot.sendMessage(chatId, 'Выберите начальные данные', queenParamsKb);
});

bot.onText(/\/fastnewqueen/, async (msg) => {
    const chatId = msg.chat.id;
    const tgId = msg.from.id;
    const messageId = msg.message_id;
    
    await bot.deleteMessage(chatId, messageId);
    const sent = await bot.sendMessage(chatId, 'подготовка');
    
    let bp = models.BeeParams.findOne({ tg_id: tgId, msg_id: sent.message_id, chat_id: chatId });
    if (!bp) {
        models.BeeParams.create({
            tg_id: tgId, chat_id: chatId, msg_id: sent.message_id,
            typ: 0, egg: 4, subscribe: 0, subscribetime: '08:00', dt: new Date().toISOString().split('T')[0]
        });
    } else {
        models.BeeParams.update(bp.id, { egg: 4 });
    }
    
    const text = calcCalendar(sent.message_id, chatId, tgId);
    await bot.editMessageText(text, { chat_id: chatId, message_id: sent.message_id, parse_mode: 'HTML' });
    await bot.editMessageReplyMarkup({ inline_keyboard: setupKb.inline_keyboard }, { chat_id: chatId, message_id: sent.message_id });
});

bot.onText(/\/newdron/, async (msg) => {
    const chatId = msg.chat.id;
    const messageId = msg.message_id;
    await bot.deleteMessage(chatId, messageId);
    await bot.sendMessage(chatId, 'Выберите начальные данные', dronParamsKb);
});

bot.onText(/\/summary/, async (msg) => {
    const chatId = msg.chat.id;
    const tgId = msg.from.id;
    
    const today = new Date();
    const nextWeek = new Date();
    nextWeek.setDate(today.getDate() + 7);
    
    const todayStr = today.toISOString().split('T')[0];
    const nextWeekStr = nextWeek.toISOString().split('T')[0];
    
    const list = models.BeeSubscribes.findForSummary(chatId, tgId, todayStr, nextWeekStr);
    
    if (list.length === 0) {
        await bot.sendMessage(chatId, 'В ближайшие 7 дней событий нет');
        return;
    }
    
    const daysOfWeekRu = ['Понедельник', 'Вторник', 'Среда', 'Четверг', 'Пятница', 'Суббота', 'Воскресенье'];
    let outputText = '';
    let currentGroupTitle = null;
    console.log("list from bot.js", list);
    for (const record of list) {
        const date = new Date(record.dt);
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

// Callback query handler
bot.on('callback_query', async (callbackQuery) => {

    if (!callbackQuery || !callbackQuery.data || !callbackQuery.message) {
        console.log('Invalid callback_query received');
        return;
    }

    const chatId = callbackQuery.message.chat.id;
    const messageId = callbackQuery.message.message_id;
    const tgId = callbackQuery.from.id;
    const data = callbackQuery.data;
    
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
        
        let bp = models.BeeParams.findOne({ tg_id: tgId, msg_id: messageId, chat_id: chatId });
        if (!bp) {
            models.BeeParams.create({
                tg_id: tgId, chat_id: chatId, msg_id: messageId,
                typ: typ, egg: egg, subscribe: 0, subscribetime: '08:00'
            });
            bp = models.BeeParams.findOne({ tg_id: tgId, msg_id: messageId, chat_id: chatId });
        } else {
            models.BeeParams.update(bp.id, { egg: egg, typ: typ });
            bp = models.BeeParams.findOne({ tg_id: tgId, msg_id: messageId, chat_id: chatId });
        }
        
        const currentDate = bp.dt ? new Date(bp.dt) : new Date();
        await bot.editMessageText(`Выбрано ${eggs[egg]}\nВыберите дату`, { chat_id: chatId, message_id: messageId });
        await bot.editMessageReplyMarkup(buildCalendarKeyboard(currentDate), { chat_id: chatId, message_id: messageId });
        return;
    }
    
    // Установка дня
    if (data.startsWith('setday_')) {
        const day = parseInt(data.split('_')[1]);
        if (day && !isNaN(day)) {
            const bp = models.BeeParams.findOne({ tg_id: tgId, msg_id: messageId, chat_id: chatId });
            if (bp && bp.dt) {
                const currentDate = new Date(bp.dt);
                currentDate.setDate(day);
                models.BeeParams.update(bp.id, { dt: currentDate.toISOString().split('T')[0] });
                await bot.editMessageReplyMarkup(buildCalendarKeyboard(currentDate), { chat_id: chatId, message_id: messageId });
            }
        }
        return;
    }
    
    // Установка месяца
    if (data.startsWith('setmonth_')) {
        const month = parseInt(data.split('_')[1]);
        if (month && !isNaN(month)) {
            const bp = models.BeeParams.findOne({ tg_id: tgId, msg_id: messageId, chat_id: chatId });
            if (bp && bp.dt) {
                const currentDate = new Date(bp.dt);
                currentDate.setMonth(month - 1);
                // Если день некорректный для нового месяца, установим на 1 число
                if (currentDate.getMonth() !== month - 1) {
                    currentDate.setDate(1);
                }
                models.BeeParams.update(bp.id, { dt: currentDate.toISOString().split('T')[0] });
                await bot.editMessageReplyMarkup(buildCalendarKeyboard(currentDate), { chat_id: chatId, message_id: messageId });
            }
        }
        return;
    }
    
    // Подтверждение даты
    if (data === 'setdate') {
        const text = calcCalendar(messageId, chatId, tgId);
        await bot.editMessageText(text, { chat_id: chatId, message_id: messageId, parse_mode: 'HTML' });
        await bot.editMessageReplyMarkup(setupKb, { chat_id: chatId, message_id: messageId });
        return;
    }
    
    // Закрыть меню настройки
    if (data === 'closesetupmenu') {
        await bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: chatId, message_id: messageId });
        return;
    }
    
    // Открыть меню настройки
    if (data === 'setupmessage') {
        const setupMenu = {
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
        };
        await bot.editMessageReplyMarkup(setupMenu, { chat_id: chatId, message_id: messageId });
        return;
    }
    
    // Изменить исходные данные
    if (data === 'updatequeen') {
        const bp = models.BeeParams.findOne({ tg_id: tgId, msg_id: messageId, chat_id: chatId });
        const kb = bp && bp.typ === 1 ? dronParamsKb : queenParamsKb;
        await bot.editMessageText('Выберите начальные данные', { chat_id: chatId, message_id: messageId });
        await bot.editMessageReplyMarkup(kb, { chat_id: chatId, message_id: messageId });
        return;
    }
    
    // Настройка подписок
    if (data === 'setsubscribe0' || data === 'setsubscribe1' || data === 'setsubscribe2') {
        const subscribe = parseInt(data.slice(-1));
        const bp = models.BeeParams.findOne({ tg_id: tgId, msg_id: messageId, chat_id: chatId });
        if (bp) {
            models.BeeParams.update(bp.id, { subscribe });
            const text = calcCalendar(messageId, chatId, tgId);
            await bot.editMessageText(text, { chat_id: chatId, message_id: messageId, parse_mode: 'HTML' });
            await bot.editMessageReplyMarkup(setupKb, { chat_id: chatId, message_id: messageId });
        }
        return;
    }
    
    // Установка времени уведомлений
    if (data === 'setsubscribetime') {
        const bp = models.BeeParams.findOne({ tg_id: tgId, msg_id: messageId, chat_id: chatId });
        if (bp) {
            models.BeeParams.update(bp.id, { waitfor: 'time' });
            const text = calcCalendar(messageId, chatId, tgId);
            await bot.editMessageText(text, { chat_id: chatId, message_id: messageId, parse_mode: 'HTML' });
        }
        return;
    }
    
    // Установка комментария
    if (data === 'setcomment') {
        const bp = models.BeeParams.findOne({ tg_id: tgId, msg_id: messageId, chat_id: chatId });
        if (bp) {
            models.BeeParams.update(bp.id, { waitfor: 'comment' });
            const text = calcCalendar(messageId, chatId, tgId);
            await bot.editMessageText(text, { chat_id: chatId, message_id: messageId, parse_mode: 'HTML' });
        }
        return;
    }
    
    // Удаление записи
    if (data === 'delrec') {
        const confirmKb = {
            inline_keyboard: [
                [{ text: '✅ Удалить', callback_data: 'yes_delrec' }, { text: '❎ Оставить', callback_data: 'closesetupmenu' }]
            ]
        };
        await bot.editMessageReplyMarkup(confirmKb, { chat_id: chatId, message_id: messageId });
        return;
    }
    
    if (data === 'yes_delrec') {
        models.BeeParams.delete({ tg_id: tgId, msg_id: messageId, chat_id: chatId });
        models.BeeMessages.deleteAll({ tg_id: tgId, msg_id: messageId, chat_id: chatId });
        await bot.editMessageText('Удалено', { chat_id: chatId, message_id: messageId, parse_mode: 'HTML' });
        return;
    }
});

// Обработка текстовых сообщений (для комментариев и времени)
bot.on('message', async (msg) => {
    if (msg.text && msg.text.startsWith('/')) return; // Skip commands
    
    const chatId = msg.chat.id;
    const tgId = msg.from.id;
    const messageId = msg.message_id;
    const text = msg.text;
    
    // Обработка комментария
    let bp = models.BeeParams.findOne({ chat_id: chatId, waitfor: 'comment' });
    if (bp) {
        models.BeeParams.update(bp.id, { comment: text, waitfor: null });
        await bot.deleteMessage(chatId, messageId);
        const newText = calcCalendar(bp.msg_id, chatId, bp.tg_id);
        await bot.editMessageText(newText, { chat_id: chatId, message_id: bp.msg_id, parse_mode: 'HTML' });
        await bot.editMessageReplyMarkup(setupKb, { chat_id: chatId, message_id: bp.msg_id });
        return;
    }
    
    // Обработка времени
    bp = models.BeeParams.findOne({ chat_id: chatId, waitfor: 'time' });
    if (bp) {
        const timeMatch = text.match(/(\d{1,2})(?:\s|:)?(\d{0,2})/);
        if (timeMatch) {
            let hours = parseInt(timeMatch[1]);
            let minutes = timeMatch[2] ? parseInt(timeMatch[2]) : 0;
            if (hours < 0 || hours > 23) hours = 8;
            if (minutes < 0 || minutes > 59) minutes = 0;
            const timeStr = `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}`;
            models.BeeParams.update(bp.id, { subscribetime: timeStr, waitfor: null });
            await bot.deleteMessage(chatId, messageId);
            const newText = calcCalendar(bp.msg_id, chatId, bp.tg_id);
            await bot.editMessageText(newText, { chat_id: chatId, message_id: bp.msg_id, parse_mode: 'HTML' });
            await bot.editMessageReplyMarkup(setupKb, { chat_id: chatId, message_id: bp.msg_id });
        }
        return;
    }
    
    // Сохраняем сообщение в beemessages
    const existing = models.BeeMessages.findOne({ tg_id: tgId, chat_id: chatId, msg_id: messageId });
    if (!existing && text) {
        models.BeeMessages.create({ tg_id: tgId, chat_id: chatId, msg_id: messageId, message: text });
    }
});

console.log('🤖 Bot started with long polling...');

module.exports = bot;