const cron = require('node-cron');
const { dbAsync } = require('./database');
const config = require('./config');

let bot = null;
let isProcessing = false;

// Хранилище для отслеживания уже обработанных за сегодня уведомлений
// Это предотвращает дублирование при нескольких запусках
const processedToday = new Set();

// Очищаем хранилище каждый день в 00:00
function resetProcessedToday() {
    const now = new Date();
    const tomorrow = new Date(now);
    tomorrow.setDate(tomorrow.getDate() + 1);
    tomorrow.setHours(0, 0, 0, 0);
    const msUntilTomorrow = tomorrow - now;
    
    setTimeout(() => {
        processedToday.clear();
        console.log('🔄 Processed notifications cache cleared for new day');
        resetProcessedToday(); // Рекурсивно устанавливаем следующий сброс
    }, msUntilTomorrow);
}

function initScheduler(telegramBot) {
    bot = telegramBot;
    
    // Запускаем сброс кэша в полночь
    resetProcessedToday();
    
    // Запускаем задачу каждую минуту
    cron.schedule('* * * * *', async () => {
        if (isProcessing) {
            console.log('⚠️ Previous notification run still in progress, skipping...');
            return;
        }
        
        isProcessing = true;
        try {
            console.log('🕐 Running notification scheduler...');
            await processNotifications();
        } catch (error) {
            console.error('❌ Error in notification scheduler:', error);
        } finally {
            isProcessing = false;
        }
    });
    
    // Дополнительно: запускаем проверку пропущенных уведомлений при старте
    setTimeout(async () => {
        console.log('🔍 Running missed notifications check on startup...');
        await checkMissedNotifications();
    }, 5000); // Задержка 5 секунд после запуска
    
    console.log('✅ Notification scheduler started (runs every minute)');
}

// Функция для получения текущего московского времени
function getMoscowTime() {
    return new Date(new Date().toLocaleString('en-US', { timeZone: config.timezone }));
}

// Функция для форматирования даты в YYYY-MM-DD
function formatDate(date) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}

// Функция для форматирования даты и времени в YYYY-MM-DD HH:MM
function formatDateTime(date) {
    const dateStr = formatDate(date);
    const hours = String(date.getHours()).padStart(2, '0');
    const minutes = String(date.getMinutes()).padStart(2, '0');
    return `${dateStr} ${hours}:${minutes}`;
}

// Функция для проверки и отправки пропущенных уведомлений
async function checkMissedNotifications() {
    const moscowNow = getMoscowTime();
    const currentMoscowDate = formatDate(moscowNow);
    const currentTime = `${String(moscowNow.getHours()).padStart(2, '0')}:${String(moscowNow.getMinutes()).padStart(2, '0')}`;
    
    console.log(`🔍 Checking for missed notifications at ${currentMoscowDate} ${currentTime}`);
    
    // Получаем все неотправленные уведомления за сегодня
    const missedNotifications = await dbAsync.all(`
        SELECT s.*, p.subscribetime, p.comment 
        FROM beesubscribes s
        LEFT JOIN beeparams p ON s.msg_id = p.msg_id 
            AND s.tg_id = p.tg_id 
            AND s.chat_id = p.chat_id
        WHERE DATE(s.dt) = ? 
            AND s.tp = 0
            AND s.sent = 0
    `, [currentMoscowDate]);
    
    console.log(`Found ${missedNotifications.length} pending notifications for today`);
    
    let sentCount = 0;
    
    for (const notification of missedNotifications) {
        const notificationTime = notification.subscribetime || '08:00';
        const [hours, minutes] = notificationTime.split(':');
        
        // Создаем объект Date для времени уведомления
        const notificationDateTime = new Date(moscowNow);
        notificationDateTime.setHours(parseInt(hours), parseInt(minutes), 0, 0);
        
        // Если текущее время больше времени уведомления ИЛИ прошло менее 2 часов с момента уведомления
        // Это позволяет отправить пропущенные уведомления в течение 2 часов после назначенного времени
        const timeDiff = moscowNow - notificationDateTime;
        const isMissed = timeDiff > 0 && timeDiff < 2 * 60 * 60 * 1000; // В течение 2 часов после времени уведомления
        
        if (isMissed) {
            const minutesMissed = Math.floor(timeDiff / 60000);
            console.log(`📨 Sending MISSED notification (${minutesMissed} min late) to chat ${notification.chat_id} (scheduled for ${notificationTime})`);
            
            let text = notification.event;
            if (notification.comment && notification.comment.trim() !== '') {
                text += `\n\n<b><i>комментарий</i></b>\n\n${notification.comment}`;
            }
            
            // Добавляем пометку о задержке
            text = `⚠️ <b>Уведомление с опозданием (${minutesMissed} мин.)</b>\n\n${text}`;
            
            try {
                const result = await bot.sendMessage(notification.chat_id, text, {
                    parse_mode: 'HTML',
                    reply_to_message_id: notification.msg_id
                });
                
                if (result && result.message_id) {
                    await dbAsync.run(`UPDATE beesubscribes SET sent = 1 WHERE id = ?`, [notification.id]);
                    console.log(`✅ Missed notification sent for chat ${notification.chat_id}`);
                    sentCount++;
                }
            } catch (error) {
                console.error(`❌ Failed to send missed notification to ${notification.chat_id}:`, error.message);
                // Если бот заблокирован, помечаем как отправленное, чтобы не спамить
                if (error.message.includes('bot was blocked') || error.message.includes('chat not found')) {
                    await dbAsync.run(`UPDATE beesubscribes SET sent = 1 WHERE id = ?`, [notification.id]);
                    console.log(`⚠️ User blocked, notification marked as sent for chat ${notification.chat_id}`);
                }
            }
        }
    }
    
    if (sentCount > 0) {
        console.log(`📬 Sent ${sentCount} missed notifications`);
    }
}

async function processNotifications() {
    try {
        const moscowNow = getMoscowTime();
        const currentMoscowDate = formatDate(moscowNow);
        const currentHour = moscowNow.getHours();
        const currentMinute = moscowNow.getMinutes();
        const currentTimeFormatted = `${String(currentHour).padStart(2, '0')}:${String(currentMinute).padStart(2, '0')}`;
        
        console.log(`[${new Date().toISOString()}] Checking notifications for Moscow time: ${currentMoscowDate} ${currentTimeFormatted}`);
        
        // Тип 1: Уведомления из календаря (tp=0)
        // Используем LEFT JOIN вместо INNER JOIN, чтобы включить записи без комментариев
        const notifications = await dbAsync.all(`
            SELECT s.*, COALESCE(p.subscribetime, ?) as subscribetime, p.comment 
            FROM beesubscribes s
            LEFT JOIN beeparams p ON s.msg_id = p.msg_id 
                AND s.tg_id = p.tg_id 
                AND s.chat_id = p.chat_id
            WHERE DATE(s.dt) = ? 
                AND s.tp = 0
                AND s.sent = 0
        `, [config.notificationTime, currentMoscowDate]);
        
        console.log(`Found ${notifications.length} calendar notifications for today`);
        
        let sentCount = 0;
        let skippedCount = 0;
        
        for (const notification of notifications) {
            // Создаем уникальный ключ для этого уведомления
            const notifKey = `${notification.id}_${notification.chat_id}`;
            
            // Проверяем, не обработали ли мы его уже в этом цикле
            if (processedToday.has(notifKey)) {
                console.log(`⏭️ Skipping duplicate notification ${notification.id} for chat ${notification.chat_id}`);
                skippedCount++;
                continue;
            }
            
            const notificationTime = notification.subscribetime || '08:00';
            const [hours, minutes] = notificationTime.split(':');
            
            // Сравниваем текущее время с временем уведомления
            const currentTotalMinutes = currentHour * 60 + currentMinute;
            const notificationTotalMinutes = parseInt(hours) * 60 + parseInt(minutes);
            
            // Отправляем, если текущее время >= времени уведомления
            // ИЛИ если время уведомления было в течение последних 5 минут (для случая с задержкой)
            const timeDiff = currentTotalMinutes - notificationTotalMinutes;
            const shouldSend = timeDiff >= 0 && timeDiff < 5; // Отправляем в течение 5 минут после времени
            
            if (shouldSend) {
                console.log(`📨 Sending calendar notification to chat ${notification.chat_id} (scheduled for ${notificationTime}, current: ${currentTimeFormatted})`);
                
                let text = notification.event;
                if (notification.comment && notification.comment.trim() !== '') {
                    text += `\n\n<b><i>комментарий</i></b>\n\n${notification.comment}`;
                } else {
                    text += `\n\n(комментарий к прививке не указан)`;
                }
                
                // Добавляем пометку о небольшой задержке
                if (timeDiff > 1) {
                    text = `⏰ <i>Уведомление с задержкой (${timeDiff} мин.)</i>\n\n${text}`;
                }
                
                try {
                    const result = await bot.sendMessage(notification.chat_id, text, {
                        parse_mode: 'HTML',
                        reply_to_message_id: notification.msg_id
                    });
                    
                    if (result && result.message_id) {
                        await dbAsync.run(`UPDATE beesubscribes SET sent = 1 WHERE id = ?`, [notification.id]);
                        processedToday.add(notifKey);
                        console.log(`✅ Calendar notification sent for chat ${notification.chat_id}`);
                        sentCount++;
                    }
                } catch (error) {
                    console.error(`❌ Failed to send notification to ${notification.chat_id}:`, error.message);
                    
                    // Если бот заблокирован или чат не найден, помечаем как отправленное
                    if (error.message.includes('bot was blocked') || 
                        error.message.includes('chat not found') ||
                        error.message.includes('Forbidden')) {
                        await dbAsync.run(`UPDATE beesubscribes SET sent = 1 WHERE id = ?`, [notification.id]);
                        console.log(`⚠️ User inaccessible, notification marked as sent for chat ${notification.chat_id}`);
                    }
                }
            } else if (timeDiff < 0) {
                // Еще не время
                console.log(`⏳ Notification for chat ${notification.chat_id} scheduled for ${notificationTime} (will send later)`);
            } else if (timeDiff >= 5) {
                // Пропустили более чем на 5 минут - обработаем отдельно
                console.log(`⚠️ Notification for chat ${notification.chat_id} is ${timeDiff} minutes late, will be handled by missed notifications check`);
            }
        }
        
        if (sentCount > 0) {
            console.log(`📬 Sent ${sentCount} notifications (skipped ${skippedCount} duplicates)`);
        }
        
        // Тип 2: Отложенные сообщения (tp=1)
        const delayedNotifications = await dbAsync.all(`
            SELECT * FROM beesubscribes 
            WHERE tp = 1 
                AND sent = 0
                AND datetime(dt) <= datetime(?)
        `, [formatDateTime(moscowNow)]);
        
        console.log(`Found ${delayedNotifications.length} delayed messages`);
        
        for (const notification of delayedNotifications) {
            console.log(`📨 Sending delayed message to chat ${notification.chat_id} (scheduled for ${notification.dt})`);
            
            try {
                const result = await bot.sendMessage(notification.chat_id, notification.event, {
                    parse_mode: 'HTML'
                });
                
                if (result && result.message_id) {
                    await dbAsync.run(`UPDATE beesubscribes SET sent = 1 WHERE id = ?`, [notification.id]);
                    console.log(`✅ Delayed message sent for chat ${notification.chat_id}`);
                }
            } catch (error) {
                console.error(`❌ Failed to send delayed message to ${notification.chat_id}:`, error.message);
                if (error.message.includes('bot was blocked') || error.message.includes('chat not found')) {
                    await dbAsync.run(`UPDATE beesubscribes SET sent = 1 WHERE id = ?`, [notification.id]);
                }
            }
        }
        
        // Очищаем отправленные уведомления старше 7 дней
        const weekAgo = new Date(moscowNow);
        weekAgo.setDate(weekAgo.getDate() - 7);
        const weekAgoStr = formatDate(weekAgo);
        
        const deleted = await dbAsync.run(`
            DELETE FROM beesubscribes 
            WHERE sent = 1 
                AND DATE(dt) <= ?
        `, [weekAgoStr]);
        
        if (deleted.changes > 0) {
            console.log(`🧹 Cleaned up ${deleted.changes} old sent notifications`);
        }
        
    } catch (error) {
        console.error('❌ Error in notification scheduler:', error);
    }
}

// Экспортируем также функцию для ручного вызова (для отладки)
module.exports = { initScheduler, checkMissedNotifications };