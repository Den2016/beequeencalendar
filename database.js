const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const config = require('./config');
const fs = require('fs');
const { dataDir } = require('./paths');

const dbPath = path.join(dataDir, 'bee_calendar.db');
const db = new sqlite3.Database(dbPath);

// Оборачиваем все методы в промисы для удобства
const dbAsync = {
    get: (sql, params = []) => {
        return new Promise((resolve, reject) => {
            db.get(sql, params, (err, result) => {
                if (err) reject(err);
                else resolve(result);
            });
        });
    },
    run: (sql, params = []) => {
        return new Promise((resolve, reject) => {
            db.run(sql, params, function(err) {
                if (err) reject(err);
                else resolve({ lastID: this.lastID, changes: this.changes });
            });
        });
    },
    all: (sql, params = []) => {
        return new Promise((resolve, reject) => {
            db.all(sql, params, (err, rows) => {
                if (err) reject(err);
                else resolve(rows);
            });
        });
    },
    exec: (sql) => {
        return new Promise((resolve, reject) => {
            db.exec(sql, (err) => {
                if (err) reject(err);
                else resolve();
            });
        });
    }
};

// Создание таблиц
dbAsync.exec(`
    CREATE TABLE IF NOT EXISTS beeuser (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        tg_id INTEGER UNIQUE NOT NULL,
        is_bot INTEGER DEFAULT 0,
        first_name VARCHAR(50),
        last_name VARCHAR(50),
        username VARCHAR(50),
        language_code VARCHAR(10),
        first_message DATETIME DEFAULT CURRENT_TIMESTAMP,
        last_message DATETIME DEFAULT CURRENT_TIMESTAMP,
        phone VARCHAR(20),
        email VARCHAR(100)
    );

    CREATE TABLE IF NOT EXISTS beeparams (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        tg_id INTEGER NOT NULL,
        chat_id INTEGER NOT NULL,
        msg_id INTEGER NOT NULL,
        typ INTEGER DEFAULT 0,
        egg INTEGER,
        subscribe INTEGER DEFAULT 2,
        subscribetime VARCHAR(8) DEFAULT '08:00',
        dt DATE,
        comment TEXT,
        waitfor VARCHAR(10)
    );

    CREATE TABLE IF NOT EXISTS beesubscribes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        tg_id INTEGER,
        chat_id INTEGER,
        msg_id INTEGER,
        dt DATETIME,
        tp INTEGER DEFAULT 0,
        eventid INTEGER,
        event TEXT,
        sent INTEGER DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS beemessages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        tg_id INTEGER,
        chat_id INTEGER,
        msg_id INTEGER,
        message TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_beeparams_tg_chat_msg ON beeparams(tg_id, chat_id, msg_id);
    CREATE INDEX IF NOT EXISTS idx_beesubscribes_dt ON beesubscribes(dt);
    CREATE INDEX IF NOT EXISTS idx_beesubscribes_tg_chat ON beesubscribes(tg_id, chat_id);
    CREATE INDEX IF NOT EXISTS idx_beesubscribes_sent ON beesubscribes(sent);
    CREATE INDEX IF NOT EXISTS idx_beesubscribes_tp ON beesubscribes(tp);
`).then(() => {
    console.log('✅ Database initialized at:', dbPath);
}).catch(err => {
    console.error('❌ Database init error:', err);
});

// Модели
const models = {
    BeeUser: {
        findOne: async (where) => {
            const key = Object.keys(where)[0];
            const value = where[key];
            return await dbAsync.get(`SELECT * FROM beeuser WHERE ${key} = ?`, [value]);
        },
        create: async (data) => {
            return await dbAsync.run(
                `INSERT OR IGNORE INTO beeuser (tg_id, is_bot, first_name, last_name, username, language_code) 
                 VALUES (?, ?, ?, ?, ?, ?)`,
                [data.tg_id, data.is_bot, data.first_name, data.last_name, data.username, data.language_code]
            );
        },
        update: async (tg_id, data) => {
            return await dbAsync.run(`UPDATE beeuser SET last_message = CURRENT_TIMESTAMP WHERE tg_id = ?`, [tg_id]);
        },
        findAll: async () => {
            return await dbAsync.all(`SELECT * FROM beeuser ORDER BY id DESC`);
        }
    },
    BeeParams: {
        findOne: async (where) => {
            const conditions = Object.keys(where).map(k => `${k} = ?`).join(' AND ');
            const values = Object.values(where);
            return await dbAsync.get(`SELECT * FROM beeparams WHERE ${conditions}`, values);
        },
        create: async (data) => {
            return await dbAsync.run(
                `INSERT INTO beeparams (tg_id, chat_id, msg_id, typ, egg, subscribe, subscribetime, dt, comment, waitfor) 
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [data.tg_id, data.chat_id, data.msg_id, data.typ || 0, data.egg || null, 
                 data.subscribe !== undefined ? data.subscribe : 2, 
                 data.subscribetime || '08:00', data.dt || null, data.comment || null, data.waitfor || null]
            );
        },
        update: async (id, data) => {
            const fields = Object.keys(data).filter(k => data[k] !== undefined).map(k => `${k} = ?`).join(', ');
            const values = Object.keys(data).filter(k => data[k] !== undefined).map(k => data[k]);
            return await dbAsync.run(`UPDATE beeparams SET ${fields} WHERE id = ?`, [...values, id]);
        },
        delete: async (where) => {
            const conditions = Object.keys(where).map(k => `${k} = ?`).join(' AND ');
            const values = Object.values(where);
            return await dbAsync.run(`DELETE FROM beeparams WHERE ${conditions}`, values);
        },
        deleteAll: async (where) => {
            const conditions = Object.keys(where).map(k => `${k} = ?`).join(' AND ');
            const values = Object.values(where);
            return await dbAsync.run(`DELETE FROM beeparams WHERE ${conditions}`, values);
        }
    },
    BeeMessages: {
        findOne: async (where) => {
            const conditions = Object.keys(where).map(k => `${k} = ?`).join(' AND ');
            const values = Object.values(where);
            return await dbAsync.get(`SELECT * FROM beemessages WHERE ${conditions}`, values);
        },
        create: async (data) => {
            return await dbAsync.run(
                `INSERT INTO beemessages (tg_id, chat_id, msg_id, message) VALUES (?, ?, ?, ?)`,
                [data.tg_id, data.chat_id, data.msg_id, data.message]
            );
        },
        deleteAll: async (where) => {
            const conditions = Object.keys(where).map(k => `${k} = ?`).join(' AND ');
            const values = Object.values(where);
            return await dbAsync.run(`DELETE FROM beemessages WHERE ${conditions}`, values);
        }
    },
    BeeSubscribes: {
        deleteAll: async (where) => {
            const conditions = Object.keys(where).map(k => `${k} = ?`).join(' AND ');
            const values = Object.values(where);
            return await dbAsync.run(`DELETE FROM beesubscribes WHERE ${conditions}`, values);
        },
        create: async (data) => {
            return await dbAsync.run(
                `INSERT INTO beesubscribes (tg_id, chat_id, msg_id, dt, eventid, event, tp, sent) 
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
                [data.tg_id, data.chat_id, data.msg_id, data.dt, data.eventid, data.event, data.tp || 0, data.sent || 0]
            );
        },
        findForSummary: async (chat_id, tg_id, dt1, dt2) => {
            return await dbAsync.all(`
                SELECT s.dt, s.eventid, p.comment 
                FROM beeparams p
                LEFT JOIN beesubscribes s ON s.msg_id = p.msg_id AND s.tg_id = p.tg_id AND s.chat_id = p.chat_id
                WHERE s.chat_id = ? AND s.tg_id = ? AND s.eventid IS NOT NULL AND DATE(s.dt) BETWEEN ? AND ?
                ORDER BY s.dt ASC
            `, [chat_id, tg_id, dt1, dt2]);
        },
        findPending: async () => {
            return await dbAsync.all(`
                SELECT s.*, p.subscribetime, p.comment 
                FROM beesubscribes s
                LEFT JOIN beeparams p ON s.msg_id = p.msg_id AND s.tg_id = p.tg_id AND s.chat_id = p.chat_id
                WHERE s.sent = 0 
                ORDER BY s.dt ASC
            `);
        }
    }
};

module.exports = { db, dbAsync, models };