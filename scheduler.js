// ============================================
// SCHEDULER.JS - ПОЛНАЯ ВЕРСИЯ
// ============================================
// Задачи шедулера:
// 1. Забирать из БД все неотправленные уведомления, у которых datetime <= now
// 2. Отправлять их с соблюдением лимитов Telegram
// 3. УДАЛЯТЬ отправленные уведомления (не помечать sent=1)
// 4. Обрабатывать ошибки (retry, rate limits, блокировка пользователей)
// 5. Ничего не решать про "просрочено", "спам", "ценность"
// ============================================

const cron = require('node-cron');
const { dbAsync } = require('./database');
const config = require('./config');

let bot = null;
let isProcessing = false;

const LIMITS = {
    MESSAGES_PER_SECOND: 30,
    DELAY_BETWEEN_MSGS: 35,
    MAX_SEND_TIME_MS: 40000,
    DEFAULT_RETRY_AFTER_MS: 5000,
    MAX_RETRIES: 3
};

const SendStatus = {
    SUCCESS: 'success',
    RATE_LIMIT: 'rate_limit',
    BLOCKED: 'blocked',
    ERROR: 'error'
};

// Кэш для предотвращения дублирования отправок в рамках одного запуска
// (не путать с sent=1 - его больше нет)
const processedInThisRun = new Map();

let stats = {
    calendarSent: 0,
    delayedSent: 0,
    rateLimits: 0,
    blocked: 0,
    errors: 0,
    startTime: null,
    endTime: null
};

// Очистка кэша при каждом запуске (не нужна, но оставим для порядка)
function resetProcessedCache() {
    processedInThisRun.clear();
}

function getMoscowTime() {
    return new Date(new Date().toLocaleString('en-US', { timeZone: config.timezone }));
}

function formatDate(date) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}

function formatDateTime(date) {
    const dateStr = formatDate(date);
    const hours = String(date.getHours()).padStart(2, '0');
    const minutes = String(date.getMinutes()).padStart(2, '0');
    const seconds = String(date.getSeconds()).padStart(2, '0');
    return `${dateStr} ${hours}:${minutes}:${seconds}`;
}

function formatDateTimeForDB(date) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    const hours = String(date.getHours()).padStart(2, '0');
    const minutes = String(date.getMinutes()).padStart(2, '0');
    const seconds = String(date.getSeconds()).padStart(2, '0');
    return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
}

function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function isTimeoutExceeded(startTime) {
    return (Date.now() - startTime) >= LIMITS.MAX_SEND_TIME_MS;
}

function parseRetryAfter(error) {
    const match = error.message.match(/retry after (\d+)/i);
    if (match) {
        return parseInt(match[1]) * 1000;
    }
    return LIMITS.DEFAULT_RETRY_AFTER_MS;
}

// ============================================
// ОТПРАВКА ОДНОГО СООБЩЕНИЯ С УДАЛЕНИЕМ ПОСЛЕ УСПЕХА
// ============================================
async function sendSingleMessage(notification, text, isCalendar = true, retryCount = 0) {
    try {
        const options = { parse_mode: 'HTML' };
        if (isCalendar && notification.msg_id) {
            options.reply_to_message_id = notification.msg_id;
        }
        
        const result = await bot.sendMessage(notification.chat_id, text, options);
        
        if (result && result.message_id) {
            // УСПЕХ - УДАЛЯЕМ уведомление из БД (вместо sent=1)
            await dbAsync.run(`DELETE FROM beesubscribes WHERE id = ?`, [notification.id]);
            console.log(`✅ Sent and deleted notification ${notification.id} to ${notification.chat_id}`);
            return { status: SendStatus.SUCCESS };
        }
        return { status: SendStatus.ERROR, error: 'No result from Telegram' };
        
    } catch (error) {
        const errorMsg = error.message || String(error);
        
        // Rate limit - специальная обработка
        if (errorMsg.includes('429') || errorMsg.includes('Too Many Requests')) {
            const retryAfter = parseRetryAfter(error);
            console.log(`⚠️ Rate limit (429) for chat ${notification.chat_id}, retry after ${retryAfter/1000}s`);
            return { status: SendStatus.RATE_LIMIT, retryAfter };
        }
        
        // Пользователь заблокировал бота - удаляем ВСЕ данные
        const blockedKeywords = [
            'bot was blocked', 'blocked by the user', 'user is deactivated',
            'chat not found', 'Forbidden', 'bot was kicked', 'user not found',
            'бот заблокирован', 'пользователь деактивирован', 'чат не найден'
        ];
        
        const isBlocked = blockedKeywords.some(keyword => 
            errorMsg.toLowerCase().includes(keyword.toLowerCase())
        );
        
        if (isBlocked) {
            // Удаляем уведомление (оно больше не нужно)
            await dbAsync.run(`DELETE FROM beesubscribes WHERE id = ?`, [notification.id]);
            console.log(`🚫 User blocked, notification deleted for chat ${notification.chat_id}`);
            
            // Удаляем пользователя и все его данные
            try {
                await dbAsync.run(`DELETE FROM beeuser WHERE tg_id = ?`, [notification.chat_id]);
                console.log(`🗑️ User ${notification.chat_id} removed from beeuser (blocked bot)`);
                
                await dbAsync.run(`DELETE FROM beeparams WHERE tg_id = ?`, [notification.chat_id]);
                await dbAsync.run(`DELETE FROM beesubscribes WHERE tg_id = ?`, [notification.chat_id]);
                await dbAsync.run(`DELETE FROM beemessages WHERE tg_id = ?`, [notification.chat_id]);
                
                console.log(`🧹 All data for user ${notification.chat_id} cleaned up`);
            } catch (deleteErr) {
                console.error(`Failed to delete user ${notification.chat_id}:`, deleteErr.message);
            }
            
            return { status: SendStatus.BLOCKED };
        }
        
        // Временная ошибка - повторяем
        if (retryCount < LIMITS.MAX_RETRIES) {
            console.log(`⚠️ Temporary error for chat ${notification.chat_id}: ${errorMsg}, retry ${retryCount + 1}/${LIMITS.MAX_RETRIES}`);
            await delay(1000 * (retryCount + 1));
            return await sendSingleMessage(notification, text, isCalendar, retryCount + 1);
        }
        
        // После всех попыток - удаляем уведомление, чтобы не засорять БД и не пытаться вечно
        await dbAsync.run(`DELETE FROM beesubscribes WHERE id = ?`, [notification.id]);
        console.error(`❌ Failed to send to ${notification.chat_id} after ${LIMITS.MAX_RETRIES} retries, notification deleted`);
        return { status: SendStatus.ERROR, error: errorMsg };
    }
}

// ============================================
// ОТПРАВКА ПАКЕТА УВЕДОМЛЕНИЙ
// ============================================
async function sendNotifications(notifications, type, startTime) {
    let sent = 0;
    let rateLimited = false;
    
    for (let i = 0; i < notifications.length; i++) {
        if (isTimeoutExceeded(startTime)) {
            console.log(`⏰ Timeout reached after ${Date.now() - startTime}ms, stopping ${type}`);
            break;
        }
        
        const notification = notifications[i];
        const notifKey = `${notification.id}_${notification.chat_id}`;
        
        // Предотвращаем дублирование в рамках одного запуска
        if (processedInThisRun.has(notifKey)) {
            console.log(`⏭️ Skipping duplicate ${type} notification ${notification.id} (already sent in this run)`);
            continue;
        }
        
        let text = notification.event;
        if (type === 'calendar' && notification.comment && notification.comment.trim() !== '') {
            text += `\n\n<b><i>комментарий</i></b>\n\n${notification.comment}`;
        } else if (type === 'calendar') {
            text += `\n\n(комментарий к прививке не указан)`;
        }
        
        console.log(`📨 [${sent + 1}/${notifications.length}] ${type === 'calendar' ? 'Calendar' : 'Delayed'} to ${notification.chat_id}`);
        
        const result = await sendSingleMessage(notification, text, type === 'calendar');
        
        if (result.status === SendStatus.SUCCESS) {
            processedInThisRun.set(notifKey, Date.now());
            sent++;
            if (type === 'calendar') stats.calendarSent++;
            else stats.delayedSent++;
        } else if (result.status === SendStatus.RATE_LIMIT) {
            stats.rateLimits++;
            rateLimited = true;
            break;  // При rate limit останавливаем всю отправку
        } else if (result.status === SendStatus.BLOCKED) {
            stats.blocked++;
        } else {
            stats.errors++;
        }
        
        await delay(LIMITS.DELAY_BETWEEN_MSGS);
    }
    
    return { sent, rateLimited };
}

// ============================================
// ВЫБОРКА УВЕДОМЛЕНИЙ - ГЛАВНОЕ ПРАВИЛО
// ============================================
// Никаких ограничений по времени. Если datetime <= now - отправляем.
// Никаких решений шедулера о "просроченности".
// ============================================

// Календарные уведомления (tp=0)
async function getReadyCalendarNotifications(moscowNow) {
    const currentDateTime = formatDateTimeForDB(moscowNow);
    
    // Ключевое условие: datetime(s.dt || ' ' || subscribetime) <= datetime(currentDateTime)
    // Если время отправки наступило - уведомление попадает в выборку
    return await dbAsync.all(`
        SELECT s.*, COALESCE(p.subscribetime, ?) as subscribetime, p.comment 
        FROM beesubscribes s
        LEFT JOIN beeparams p ON s.msg_id = p.msg_id 
            AND s.tg_id = p.tg_id 
            AND s.chat_id = p.chat_id
        WHERE s.tp = 0
            AND datetime(s.dt || ' ' || COALESCE(p.subscribetime, ?)) <= datetime(?)
        ORDER BY s.dt ASC
    `, [config.notificationTime, config.notificationTime, currentDateTime]);
}

// Отложенные сообщения (tp=1) - у них уже есть полная дата-время в dt
async function getPendingDelayedMessages(moscowNow) {
    const currentDateTime = formatDateTimeForDB(moscowNow);
    return await dbAsync.all(`
        SELECT * FROM beesubscribes 
        WHERE tp = 1
            AND datetime(dt) <= datetime(?)
        ORDER BY dt ASC
    `, [currentDateTime]);
}

// ============================================
// ОЧИСТКА СТАРЫХ УВЕДОМЛЕНИЙ (опционально, для tp=0)
// ============================================
// Оставляем на случай, если что-то не удалилось при отправке
async function cleanupOldNotifications(moscowNow) {
    const weekAgo = new Date(moscowNow);
    weekAgo.setDate(weekAgo.getDate() - 7);
    const weekAgoStr = formatDate(weekAgo);
    
    const deleted = await dbAsync.run(`
        DELETE FROM beesubscribes 
        WHERE DATE(dt) <= ?
    `, [weekAgoStr]);
    
    if (deleted.changes > 0) {
        console.log(`🧹 Cleaned up ${deleted.changes} old notifications (older than 7 days)`);
    }
}

function printStats() {
    const duration = stats.endTime - stats.startTime;
    console.log(`\n${'─'.repeat(50)}`);
    console.log(`📊 Run statistics (${duration}ms):`);
    console.log(`   ✅ Calendar sent:     ${stats.calendarSent}`);
    console.log(`   ✅ Delayed sent:      ${stats.delayedSent}`);
    console.log(`   🚫 Blocked users:     ${stats.blocked}`);
    console.log(`   ⏸️ Rate limits:       ${stats.rateLimits}`);
    console.log(`   ❌ Other errors:      ${stats.errors}`);
    console.log(`${'─'.repeat(50)}\n`);
}

// ============================================
// ОСНОВНАЯ ФУНКЦИЯ - ЗАПУСКАЕТСЯ КАЖДУЮ МИНУТУ
// ============================================
async function processNotifications() {
    // Сбрасываем статистику
    stats = {
        calendarSent: 0,
        delayedSent: 0,
        rateLimits: 0,
        blocked: 0,
        errors: 0,
        startTime: Date.now(),
        endTime: null
    };
    
    const startTime = stats.startTime;
    
    try {
        const moscowNow = getMoscowTime();
        
        console.log(`\n${'='.repeat(50)}`);
        console.log(`🕐 Notification run at ${formatDateTime(moscowNow)}`);
        console.log(`${'='.repeat(50)}`);
        
        // 1. Получаем ВСЕ готовые календарные уведомления (без ограничений)
        const readyCalendar = await getReadyCalendarNotifications(moscowNow);
        console.log(`📅 Calendar ready: ${readyCalendar.length} (datetime <= now)`);
        
        if (readyCalendar.length > 0) {
            const result = await sendNotifications(readyCalendar, 'calendar', startTime);
            if (result.rateLimited) {
                console.log(`⏸️ Rate limit hit, stopping run`);
                stats.endTime = Date.now();
                printStats();
                return;
            }
        }
        
        // 2. Получаем ВСЕ готовые отложенные сообщения
        if (!isTimeoutExceeded(startTime)) {
            const pendingDelayed = await getPendingDelayedMessages(moscowNow);
            console.log(`⏰ Delayed pending: ${pendingDelayed.length} (datetime <= now)`);
            
            if (pendingDelayed.length > 0) {
                await sendNotifications(pendingDelayed, 'delayed', startTime);
            }
        } else {
            console.log(`⏰ Timeout before delayed messages, skipping`);
        }
        
        // 3. Чистка старых уведомлений (на всякий случай)
        await cleanupOldNotifications(moscowNow);
        
        stats.endTime = Date.now();
        printStats();
        
    } catch (error) {
        console.error('❌ Fatal error in notification scheduler:', error);
        stats.endTime = Date.now();
        printStats();
    }
}

// ============================================
// ИНИЦИАЛИЗАЦИЯ
// ============================================
function initScheduler(telegramBot) {
    bot = telegramBot;
    
    // Запускаем каждую минуту
    cron.schedule('* * * * *', async () => {
        if (isProcessing) {
            console.log('⚠️ Previous notification run still in progress, skipping...');
            return;
        }
        
        isProcessing = true;
        try {
            await processNotifications();
        } catch (error) {
            console.error('❌ Error in notification scheduler:', error);
        } finally {
            isProcessing = false;
        }
    });
    
    console.log('✅ Notification scheduler started (runs every minute)');
    console.log(`📊 Limits: ${LIMITS.MESSAGES_PER_SECOND} msg/sec, ${LIMITS.DELAY_BETWEEN_MSGS}ms delay`);
    console.log(`⏱️ Max send time per run: ${LIMITS.MAX_SEND_TIME_MS/1000}s`);
    console.log(`🔄 Max retries per message: ${LIMITS.MAX_RETRIES}`);
    console.log(`🎯 Rule: send if datetime(s.dt || ' ' || subscribetime) <= datetime(now)`);
    console.log(`🗑️  Notification deleted from DB after successful send`);
}

module.exports = { initScheduler };