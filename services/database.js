require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');

// Ensure data directory exists
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

const defaultData = {
  settings: {
    token: process.env.DELTA_API_TOKEN || 'DELTA-a480f9e6b7ace86ab59c5507b9e4cc3f',
    pollingIntervalSec: parseInt(process.env.POLLING_INTERVAL_SEC, 10) || 5,
    autoResetOnExpire: true,
    soundNotifications: true,
    theme: 'dark'
  },
  keys: [],
  logs: []
};

// In-memory cache
let db = { ...defaultData };
let isPostgres = false;
let pool = null;

// Check PostgreSQL configuration (DATABASE_URL, POSTGRES_URL or individual PG* vars)
const databaseUrl = process.env.DATABASE_URL || process.env.POSTGRES_URL;
const hasPgVars = process.env.PGHOST && process.env.PGUSER && process.env.PGDATABASE;

if (databaseUrl || hasPgVars) {
  try {
    let poolConfig = {};

    if (databaseUrl) {
      const isInternal = databaseUrl.includes('.internal') || databaseUrl.includes('localhost') || databaseUrl.includes('127.0.0.1');
      poolConfig = {
        connectionString: databaseUrl,
        ssl: isInternal ? false : { rejectUnauthorized: false }
      };
    } else {
      const isInternal = process.env.PGHOST.includes('.internal') || process.env.PGHOST.includes('localhost');
      poolConfig = {
        host: process.env.PGHOST,
        port: parseInt(process.env.PGPORT, 10) || 5432,
        user: process.env.PGUSER,
        password: process.env.PGPASSWORD || process.env.POSTGRES_PASSWORD,
        database: process.env.PGDATABASE || process.env.POSTGRES_DB,
        ssl: isInternal ? false : { rejectUnauthorized: false }
      };
    }

    pool = new Pool(poolConfig);
    isPostgres = true;
    console.log('[DB] Configuração do PostgreSQL detectada. Inicializando Pool...');
  } catch (err) {
    console.error('[DB] Falha ao criar Pool do PostgreSQL:', err.message);
  }
} else {
  console.log('[DB] Nenhuma DATABASE_URL / PGHOST encontrada. Utilizando armazenamento local JSON (data/db.json).');
}

/**
 * Carrega dados do arquivo JSON local (fallback)
 */
function loadLocalJsonData() {
  try {
    if (fs.existsSync(DB_FILE)) {
      const raw = fs.readFileSync(DB_FILE, 'utf8');
      const parsed = JSON.parse(raw);
      return {
        settings: { ...defaultData.settings, ...(parsed.settings || {}) },
        keys: parsed.keys || [],
        logs: parsed.logs || []
      };
    }
  } catch (err) {
    console.error('[DB] Erro ao carregar JSON local:', err);
  }
  return defaultData;
}

/**
 * Salva dados no arquivo JSON local
 */
function saveLocalJsonData() {
  try {
    const tempFile = DB_FILE + '.tmp';
    fs.writeFileSync(tempFile, JSON.stringify(db, null, 2), 'utf8');
    fs.renameSync(tempFile, DB_FILE);
  } catch (err) {
    console.error('[DB] Erro ao salvar JSON local:', err);
  }
}

/**
 * Inicialização assíncrona do banco
 */
async function init() {
  if (isPostgres && pool) {
    try {
      // Test connection
      const client = await pool.connect();
      console.log('[DB] ✅ Conexão com PostgreSQL estabelecida com sucesso!');

      // Create tables if not exist
      await client.query(`
        CREATE TABLE IF NOT EXISTS delta_settings (
          id VARCHAR(50) PRIMARY KEY,
          data JSONB NOT NULL,
          updated_at TIMESTAMPTZ DEFAULT NOW()
        );

        CREATE TABLE IF NOT EXISTS delta_keys (
          key VARCHAR(100) PRIMARY KEY,
          app_id INT,
          app_name VARCHAR(100),
          status VARCHAR(30),
          data JSONB NOT NULL,
          created_at TIMESTAMPTZ DEFAULT NOW(),
          updated_at TIMESTAMPTZ DEFAULT NOW()
        );

        CREATE TABLE IF NOT EXISTS delta_logs (
          id VARCHAR(50) PRIMARY KEY,
          timestamp TIMESTAMPTZ DEFAULT NOW(),
          event VARCHAR(100),
          details JSONB,
          level VARCHAR(20)
        );
      `);

      // Load Settings from Postgres
      const settingsRes = await client.query('SELECT data FROM delta_settings WHERE id = $1', ['main']);
      if (settingsRes.rows.length > 0) {
        db.settings = { ...defaultData.settings, ...settingsRes.rows[0].data };
      } else {
        await client.query(
          'INSERT INTO delta_settings (id, data, updated_at) VALUES ($1, $2, NOW()) ON CONFLICT (id) DO NOTHING',
          ['main', JSON.stringify(defaultData.settings)]
        );
      }

      // Load Keys from Postgres
      const keysRes = await client.query('SELECT data FROM delta_keys ORDER BY created_at DESC');
      db.keys = keysRes.rows.map(r => r.data);

      // Load Logs from Postgres
      const logsRes = await client.query('SELECT id, timestamp, event, details, level FROM delta_logs ORDER BY timestamp DESC LIMIT 500');
      db.logs = logsRes.rows.map(r => ({
        id: r.id,
        timestamp: r.timestamp.toISOString ? r.timestamp.toISOString() : r.timestamp,
        event: r.event,
        details: r.details,
        level: r.level
      }));

      client.release();
      console.log(`[DB] Dados carregados do PostgreSQL: ${db.keys.length} chave(s), ${db.logs.length} log(s).`);
      return;
    } catch (err) {
      console.error('[DB] ❌ Erro ao conectar ao PostgreSQL, usando fallback local:', err.message);
      isPostgres = false;
    }
  }

  // Fallback Local
  db = loadLocalJsonData();
  console.log(`[DB] Dados carregados do JSON local: ${db.keys.length} chave(s).`);
}

// Database Interface
module.exports = {
  init,
  isPostgres: () => isPostgres,

  getSettings() {
    return db.settings;
  },

  async updateSettings(newSettings) {
    db.settings = { ...db.settings, ...newSettings };
    if (isPostgres && pool) {
      try {
        await pool.query(
          `INSERT INTO delta_settings (id, data, updated_at)
           VALUES ($1, $2, NOW())
           ON CONFLICT (id) DO UPDATE SET data = $2, updated_at = NOW()`,
          ['main', JSON.stringify(db.settings)]
        );
      } catch (err) {
        console.error('[DB Postgres] Erro ao salvar configurações:', err.message);
      }
    } else {
      saveLocalJsonData();
    }
    return db.settings;
  },

  getKeys() {
    return db.keys;
  },

  getKey(keyString) {
    return db.keys.find(k => k.key.toUpperCase() === keyString.toUpperCase());
  },

  async addKey(keyRecord) {
    db.keys = db.keys.filter(k => k.key.toUpperCase() !== keyRecord.key.toUpperCase());
    db.keys.unshift(keyRecord);

    if (isPostgres && pool) {
      try {
        await pool.query(
          `INSERT INTO delta_keys (key, app_id, app_name, status, data, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, NOW(), NOW())
           ON CONFLICT (key) DO UPDATE SET
             app_id = $2,
             app_name = $3,
             status = $4,
             data = $5,
             updated_at = NOW()`,
          [
            keyRecord.key.toUpperCase(),
            keyRecord.appId,
            keyRecord.appName,
            keyRecord.status,
            JSON.stringify(keyRecord)
          ]
        );
      } catch (err) {
        console.error('[DB Postgres] Erro ao adicionar chave:', err.message);
      }
    } else {
      saveLocalJsonData();
    }

    return keyRecord;
  },

  async updateKey(keyString, updates) {
    const idx = db.keys.findIndex(k => k.key.toUpperCase() === keyString.toUpperCase());
    if (idx !== -1) {
      db.keys[idx] = { ...db.keys[idx], ...updates, updatedAt: new Date().toISOString() };
      const updatedRecord = db.keys[idx];

      if (isPostgres && pool) {
        try {
          await pool.query(
            `UPDATE delta_keys 
             SET status = $2, data = $3, updated_at = NOW()
             WHERE key = $1`,
            [
              keyString.toUpperCase(),
              updatedRecord.status,
              JSON.stringify(updatedRecord)
            ]
          );
        } catch (err) {
          console.error('[DB Postgres] Erro ao atualizar chave:', err.message);
        }
      } else {
        saveLocalJsonData();
      }

      return updatedRecord;
    }
    return null;
  },

  async removeKey(keyString) {
    const initialLen = db.keys.length;
    db.keys = db.keys.filter(k => k.key.toUpperCase() !== keyString.toUpperCase());

    if (db.keys.length !== initialLen) {
      if (isPostgres && pool) {
        try {
          await pool.query('DELETE FROM delta_keys WHERE key = $1', [keyString.toUpperCase()]);
        } catch (err) {
          console.error('[DB Postgres] Erro ao remover chave:', err.message);
        }
      } else {
        saveLocalJsonData();
      }
      return true;
    }
    return false;
  },

  async addLog(event, details = {}, level = 'info') {
    const logItem = {
      id: Date.now() + '-' + Math.random().toString(36).substring(2, 7),
      timestamp: new Date().toISOString(),
      event,
      details,
      level
    };

    db.logs.unshift(logItem);
    if (db.logs.length > 500) {
      db.logs = db.logs.slice(0, 500);
    }

    if (isPostgres && pool) {
      try {
        await pool.query(
          `INSERT INTO delta_logs (id, timestamp, event, details, level)
           VALUES ($1, NOW(), $2, $3, $4)`,
          [logItem.id, logItem.event, JSON.stringify(logItem.details), logItem.level]
        );
      } catch (err) {
        console.error('[DB Postgres] Erro ao gravar log:', err.message);
      }
    } else {
      saveLocalJsonData();
    }

    return logItem;
  },

  getLogs(limit = 100) {
    return db.logs.slice(0, limit);
  },

  async clearLogs() {
    db.logs = [];
    if (isPostgres && pool) {
      try {
        await pool.query('DELETE FROM delta_logs');
      } catch (err) {
        console.error('[DB Postgres] Erro ao limpar logs:', err.message);
      }
    } else {
      saveLocalJsonData();
    }
  }
};
