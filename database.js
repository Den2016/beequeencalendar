const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const config = require('./config');

const dbPath = path.join(__dirname, config.dbPath);
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

// Включение поддержки FOREIGN KEY в SQLite
dbAsync.exec("PRAGMA foreign_keys = ON;").catch(console.error);

// Создание таблиц с правильной структурой
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
        beeparams_id INTEGER NOT NULL,
        tg_id INTEGER,
        chat_id INTEGER,
        msg_id INTEGER,
        dt DATETIME,
        tp INTEGER DEFAULT 0,
        eventid INTEGER,
        event TEXT,
        sent INTEGER DEFAULT 0,
        FOREIGN KEY (beeparams_id) REFERENCES beeparams(id) ON DELETE CASCADE
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
    CREATE INDEX IF NOT EXISTS idx_beesubscribes_beeparams_id ON beesubscribes(beeparams_id);
`).then(() => {
    console.log('✅ Database initialized with CASCADE DELETE');
}).catch(err => {
    console.error('❌ Database init error:', err);
});

// Функция для миграции существующей БД
async function migrateDatabase() {
    try {
        // Проверяем, есть ли колонка beeparams_id в таблице beesubscribes
        const columns = await dbAsync.all("PRAGMA table_info(beesubscribes);");
        const hasBeeparamsId = columns.some(col => col.name === 'beeparams_id');
        
        if (!hasBeeparamsId) {
            console.log('🔄 Migrating database: adding beeparams_id foreign key...');
            
            await dbAsync.exec("BEGIN TRANSACTION;");
            await dbAsync.exec("PRAGMA foreign_keys = OFF;");
            
            // Получаем текущие данные
            const subscribes = await dbAsync.all("SELECT * FROM beesubscribes;");
            
            // Удаляем старую таблицу beesubscribes
            await dbAsync.exec("DROP TABLE beesubscribes;");
            
            // Создаем новую таблицу с foreign key
            await dbAsync.exec(`
                CREATE TABLE beesubscribes (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    beeparams_id INTEGER NOT NULL,
                    tg_id INTEGER,
                    chat_id INTEGER,
                    msg_id INTEGER,
                    dt DATETIME,
                    tp INTEGER DEFAULT 0,
                    eventid INTEGER,
                    event TEXT,
                    sent INTEGER DEFAULT 0,
                    FOREIGN KEY (beeparams_id) REFERENCES beeparams(id) ON DELETE CASCADE
                );
                CREATE INDEX idx_beesubscribes_dt ON beesubscribes(dt);
                CREATE INDEX idx_beesubscribes_tg_chat ON beesubscribes(tg_id, chat_id);
                CREATE INDEX idx_beesubscribes_beeparams_id ON beesubscribes(beeparams_id);
            `);
            
            // Восстанавливаем данные, связывая с beeparams.id
            for (const sub of subscribes) {
                // Находим соответствующий beeparams.id
                const beeparam = await dbAsync.get(
                    'SELECT id FROM beeparams WHERE tg_id = ? AND chat_id = ? AND msg_id = ?',
                    [sub.tg_id, sub.chat_id, sub.msg_id]
                );
                
                if (beeparam) {
                    await dbAsync.run(`
                        INSERT INTO beesubscribes (id, beeparams_id, tg_id, chat_id, msg_id, dt, tp, eventid, event, sent)
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    `, [sub.id, beeparam.id, sub.tg_id, sub.chat_id, sub.msg_id, sub.dt, sub.tp, sub.eventid, sub.event, sub.sent]);
                }
            }
            
            await dbAsync.exec("COMMIT;");
            console.log('✅ Database migration completed successfully!');
        }
    } catch (err) {
        console.error('❌ Migration error:', err);
        await dbAsync.exec("ROLLBACK;");
    } finally {
        await dbAsync.exec("PRAGMA foreign_keys = ON;");
    }
}

// Запускаем миграцию
migrateDatabase().catch(console.error);

// Модели с использованием промисов
const models = {
    BeeUser: {
        findOne: async (where) => {
            const key = Object.keys(where)[0];
            const value = where[key];
            return await dbAsync.get(`SELECT * FROM beeuser WHERE ${key} = ?`, [value]);
        },
        create: async (data) => {
            return await dbAsync.run(
                `INSERT INTO beeuser (tg_id, is_bot, first_name, last_name, username, language_code) 
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
            const result = await dbAsync.run(
                `INSERT INTO beeparams (tg_id, chat_id, msg_id, typ, egg, subscribe, subscribetime, dt, comment, waitfor) 
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [data.tg_id, data.chat_id, data.msg_id, data.typ || 0, data.egg || null, 
                 data.subscribe !== undefined ? data.subscribe : 2, 
                 data.subscribetime || '08:00', data.dt || null, data.comment || null, data.waitfor || null]
            );
            return result;
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
            // Сначала получаем beeparams_id
            const beeparam = await models.BeeParams.findOne({ 
                tg_id: data.tg_id, 
                chat_id: data.chat_id, 
                msg_id: data.msg_id 
            });
            
            if (!beeparam) {
                console.error('No beeparams found for create:', data);
                return null;
            }
            
            return await dbAsync.run(
                `INSERT INTO beesubscribes (beeparams_id, tg_id, chat_id, msg_id, dt, eventid, event, tp, sent) 
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [beeparam.id, data.tg_id, data.chat_id, data.msg_id, data.dt, data.eventid, data.event, data.tp || 0, data.sent || 0]
            );
        },
        findForSummary: async (chat_id, tg_id, dt1, dt2) => {
            return await dbAsync.all(`
                SELECT s.dt, s.eventid, p.comment 
                FROM beeparams p
                LEFT JOIN beesubscribes s ON s.beeparams_id = p.id
                WHERE s.chat_id = ? AND s.tg_id = ? AND s.eventid IS NOT NULL AND DATE(s.dt) BETWEEN ? AND ?
                ORDER BY s.dt ASC
            `, [chat_id, tg_id, dt1, dt2]);
        },
        findPending: async () => {
            return await dbAsync.all(`
                SELECT s.*, p.subscribetime, p.comment 
                FROM beesubscribes s
                LEFT JOIN beeparams p ON s.beeparams_id = p.id
                WHERE s.sent = 0 
                ORDER BY s.dt ASC
            `);
        }
    }
};

module.exports = { db, dbAsync, models };