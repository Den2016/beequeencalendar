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

const processedToday = new Map();
let stats = {
    calendarSent: 0,
    delayedSent: 0,
    calendarSkipped: 0,
    delayedSkipped: 0,
    rateLimits: 0,
    blocked: 0,
    errors: 0,
    startTime: null,
    endTime: null
};

function resetProcessedToday() {
    const now = new Date();
    const tomorrow = new Date(now);
    tomorrow.setDate(tomorrow.getDate() + 1);
    tomorrow.setHours(0, 0, 0, 0);
    const msUntilTomorrow = tomorrow - now;
    
    setTimeout(() => {
        processedToday.clear();
        console.log('🔄 Processed notifications cache cleared for new day');
        resetProcessedToday();
    }, msUntilTomorrow);
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

async function sendSingleMessage(notification, text, isCalendar = true, retryCount = 0) {
    try {
        const options = { parse_mode: 'HTML' };
        if (isCalendar && notification.msg_id) {
            options.reply_to_message_id = notification.msg_id;
        }
        
        const result = await bot.sendMessage(notification.chat_id, text, options);
        
        if (result && result.message_id) {
            await dbAsync.run(`UPDATE beesubscribes SET sent = 1 WHERE id = ?`, [notification.id]);
            return { status: SendStatus.SUCCESS };
        }
        return { status: SendStatus.ERROR, error: 'No result from Telegram' };
        
    } catch (error) {
        const errorMsg = error.message || String(error);
        
        if (errorMsg.includes('429') || errorMsg.includes('Too Many Requests')) {
            const retryAfter = parseRetryAfter(error);
            console.log(`⚠️ Rate limit (429) for chat ${notification.chat_id}, retry after ${retryAfter/1000}s`);
            return { status: SendStatus.RATE_LIMIT, retryAfter };
        }
        
        const blockedKeywords = [
            'bot was blocked', 'blocked by the user', 'user is deactivated',
            'chat not found', 'Forbidden', 'bot was kicked', 'user not found',
            'бот заблокирован', 'пользователь деактивирован', 'чат не найден'
        ];
        
        const isBlocked = blockedKeywords.some(keyword => 
            errorMsg.toLowerCase().includes(keyword.toLowerCase())
        );
        
        if (isBlocked) {
            await dbAsync.run(`UPDATE beesubscribes SET sent = 1 WHERE id = ?`, [notification.id]);
            console.log(`🚫 User blocked, notification marked as sent for chat ${notification.chat_id}`);
            return { status: SendStatus.BLOCKED };
        }
        
        if (retryCount < LIMITS.MAX_RETRIES) {
            console.log(`⚠️ Temporary error for chat ${notification.chat_id}: ${errorMsg}, retry ${retryCount + 1}/${LIMITS.MAX_RETRIES}`);
            await delay(1000 * (retryCount + 1));
            return await sendSingleMessage(notification, text, isCalendar, retryCount + 1);
        }
        
        console.error(`❌ Failed to send to ${notification.chat_id} after ${LIMITS.MAX_RETRIES} retries:`, errorMsg);
        return { status: SendStatus.ERROR, error: errorMsg };
    }
}

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
        
        if (processedToday.has(notifKey)) {
            console.log(`⏭️ Skipping duplicate ${type} notification ${notification.id}`);
            stats[type === 'calendar' ? 'calendarSkipped' : 'delayedSkipped']++;
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
            processedToday.set(notifKey, Date.now());
            sent++;
            if (type === 'calendar') stats.calendarSent++;
            else stats.delayedSent++;
        } else if (result.status === SendStatus.RATE_LIMIT) {
            stats.rateLimits++;
            rateLimited = true;
            break;
        } else if (result.status === SendStatus.BLOCKED) {
            stats.blocked++;
        } else {
            stats.errors++;
        }
        
        await delay(LIMITS.DELAY_BETWEEN_MSGS);
    }
    
    return { sent, rateLimited };
}

async function getReadyCalendarNotifications(currentMoscowDate, currentHour, currentMinute) {
    const calendarNotifications = await dbAsync.all(`
        SELECT s.*, COALESCE(p.subscribetime, ?) as subscribetime, p.comment 
        FROM beesubscribes s
        LEFT JOIN beeparams p ON s.msg_id = p.msg_id 
            AND s.tg_id = p.tg_id 
            AND s.chat_id = p.chat_id
        WHERE DATE(s.dt) = ? 
            AND s.tp = 0
            AND s.sent = 0
        ORDER BY 
            CASE 
                WHEN s.eventid = 1 THEN 1
                WHEN s.eventid = 4 THEN 2
                ELSE 3
            END,
            s.dt ASC
    `, [config.notificationTime, currentMoscowDate]);
    
    const readyNotifications = [];
    for (const notification of calendarNotifications) {
        const notificationTime = notification.subscribetime || '08:00';
        const [hours, minutes] = notificationTime.split(':');
        const notificationTotalMinutes = parseInt(hours) * 60 + parseInt(minutes);
        const currentTotalMinutes = currentHour * 60 + currentMinute;
        const timeDiff = currentTotalMinutes - notificationTotalMinutes;
        
        if (timeDiff >= 0 && timeDiff < 120) {
            readyNotifications.push(notification);
        }
    }
    
    return readyNotifications;
}

async function getPendingDelayedMessages(moscowNow) {
    return await dbAsync.all(`
        SELECT * FROM beesubscribes 
        WHERE tp = 1 
            AND sent = 0
            AND datetime(dt) <= datetime(?)
        ORDER BY dt ASC
    `, [formatDateTime(moscowNow)]);
}

async function cleanupOldNotifications(moscowNow) {
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
}

function printStats() {
    const duration = stats.endTime - stats.startTime;
    console.log(`\n${'─'.repeat(50)}`);
    console.log(`📊 Run statistics (${duration}ms):`);
    console.log(`   ✅ Calendar sent:     ${stats.calendarSent}`);
    console.log(`   ✅ Delayed sent:      ${stats.delayedSent}`);
    console.log(`   ⏭️ Skipped:           ${stats.calendarSkipped}`);
    console.log(`   🚫 Blocked users:     ${stats.blocked}`);
    console.log(`   ⏸️ Rate limits:       ${stats.rateLimits}`);
    console.log(`   ❌ Other errors:      ${stats.errors}`);
    console.log(`${'─'.repeat(50)}\n`);
}

async function processNotifications() {
    stats = {
        calendarSent: 0,
        delayedSent: 0,
        calendarSkipped: 0,
        delayedSkipped: 0,
        rateLimits: 0,
        blocked: 0,
        errors: 0,
        startTime: Date.now(),
        endTime: null
    };
    
    const startTime = stats.startTime;
    
    try {
        const moscowNow = getMoscowTime();
        const currentMoscowDate = formatDate(moscowNow);
        const currentHour = moscowNow.getHours();
        const currentMinute = moscowNow.getMinutes();
        
        console.log(`\n${'='.repeat(50)}`);
        console.log(`🕐 Notification run at ${formatDateTime(moscowNow)}`);
        console.log(`${'='.repeat(50)}`);
        
        const readyCalendar = await getReadyCalendarNotifications(currentMoscowDate, currentHour, currentMinute);
        console.log(`📅 Calendar ready: ${readyCalendar.length}`);
        
        if (readyCalendar.length > 0) {
            const result = await sendNotifications(readyCalendar, 'calendar', startTime);
            if (result.rateLimited) {
                console.log(`⏸️ Rate limit hit, stopping run`);
                stats.endTime = Date.now();
                printStats();
                return;
            }
        }
        
        if (!isTimeoutExceeded(startTime)) {
            const pendingDelayed = await getPendingDelayedMessages(moscowNow);
            console.log(`⏰ Delayed pending: ${pendingDelayed.length}`);
            
            if (pendingDelayed.length > 0) {
                await sendNotifications(pendingDelayed, 'delayed', startTime);
            }
        } else {
            console.log(`⏰ Timeout before delayed messages, skipping`);
        }
        
        await cleanupOldNotifications(moscowNow);
        
        stats.endTime = Date.now();
        printStats();
        
    } catch (error) {
        console.error('❌ Fatal error in notification scheduler:', error);
        stats.endTime = Date.now();
        printStats();
    }
}

async function checkMissedNotifications() {
    const moscowNow = getMoscowTime();
    const currentMoscowDate = formatDate(moscowNow);
    
    console.log(`🔍 Checking for missed notifications at ${formatDateTime(moscowNow)}`);
    
    const fiveMinutesAgo = new Date(moscowNow);
    fiveMinutesAgo.setMinutes(fiveMinutesAgo.getMinutes() - 5);
    const fiveMinutesAgoStr = formatDateTime(fiveMinutesAgo);
    
    const missedNotifications = await dbAsync.all(`
        SELECT s.*, p.subscribetime, p.comment 
        FROM beesubscribes s
        LEFT JOIN beeparams p ON s.msg_id = p.msg_id 
            AND s.tg_id = p.tg_id 
            AND s.chat_id = p.chat_id
        WHERE DATE(s.dt) = ? 
            AND s.tp = 0
            AND s.sent = 0
            AND datetime(s.dt) <= datetime(?)
        ORDER BY s.id ASC
        LIMIT 100
    `, [currentMoscowDate, fiveMinutesAgoStr]);
    
    if (missedNotifications.length > 0) {
        console.log(`⚠️ Found ${missedNotifications.length} potentially missed notifications`);
        
        const startTime = Date.now();
        for (const notification of missedNotifications) {
            if (isTimeoutExceeded(startTime)) break;
            
            let text = notification.event;
            text = `⏰ <i>Уведомление с опозданием (пропущено)</i>\n\n${text}`;
            
            if (notification.comment && notification.comment.trim() !== '') {
                text += `\n\n<b><i>комментарий</i></b>\n\n${notification.comment}`;
            }
            
            const result = await sendSingleMessage(notification, text, true);
            if (result.status === SendStatus.RATE_LIMIT) {
                console.log(`⚠️ Rate limit while catching up missed notifications, stopping`);
                break;
            }
            await delay(LIMITS.DELAY_BETWEEN_MSGS);
        }
    }
}

function initScheduler(telegramBot) {
    bot = telegramBot;
    resetProcessedToday();
    
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
    
    setTimeout(async () => {
        console.log('🔍 Running missed notifications check on startup...');
        await checkMissedNotifications();
    }, 5000);
    
    console.log('✅ Notification scheduler started (runs every minute)');
    console.log(`📊 Limits: ${LIMITS.MESSAGES_PER_SECOND} msg/sec, ${LIMITS.DELAY_BETWEEN_MSGS}ms delay`);
    console.log(`⏱️ Max send time per run: ${LIMITS.MAX_SEND_TIME_MS/1000}s`);
    console.log(`🔄 Max retries per message: ${LIMITS.MAX_RETRIES}`);
}

module.exports = { initScheduler, checkMissedNotifications };