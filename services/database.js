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

// In-memory cache for instant reads
let db = { ...defaultData };
let isPostgresConnected = false;
let pool = null;
let connectionError = null;

/**
 * Cria a conexão com o PostgreSQL com suporte a Railway e SSL flexível
 */
function createPgPool() {
  const databaseUrl = process.env.DATABASE_URL || process.env.POSTGRES_URL;
  const hasPgVars = process.env.PGHOST && process.env.PGUSER && process.env.PGDATABASE;

  if (!databaseUrl && !hasPgVars) {
    return null;
  }

  try {
    let poolConfig = {};

    if (databaseUrl) {
      // Se for URL completa (padrão Railway)
      const isLocal = databaseUrl.includes('localhost') || databaseUrl.includes('127.0.0.1');
      poolConfig = {
        connectionString: databaseUrl,
        ssl: isLocal ? false : { rejectUnauthorized: false },
        connectionTimeoutMillis: 10000,
        idleTimeoutMillis: 30000,
        max: 10
      };
    } else {
      // Se forem variáveis separadas PG*
      const isLocal = process.env.PGHOST.includes('localhost') || process.env.PGHOST.includes('127.0.0.1');
      poolConfig = {
        host: process.env.PGHOST,
        port: parseInt(process.env.PGPORT, 10) || 5432,
        user: process.env.PGUSER,
        password: process.env.PGPASSWORD || process.env.POSTGRES_PASSWORD,
        database: process.env.PGDATABASE || process.env.POSTGRES_DB,
        ssl: isLocal ? false : { rejectUnauthorized: false },
        connectionTimeoutMillis: 10000,
        idleTimeoutMillis: 30000,
        max: 10
      };
    }

    return new Pool(poolConfig);
  } catch (err) {
    console.error('[DB] Erro ao instanciar Pool do PostgreSQL:', err.message);
    connectionError = err.message;
    return null;
  }
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
  // Carrega inicialmente do JSON para ter dados em memória imediatamente
  db = loadLocalJsonData();

  pool = createPgPool();

  if (pool) {
    try {
      console.log('[DB] Tentando conectar ao PostgreSQL...');
      const client = await pool.connect();
      console.log('[DB] ✅ Conexão com PostgreSQL estabelecida com sucesso!');
      isPostgresConnected = true;
      connectionError = null;

      // Cria tabelas se não existirem
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

      // Carrega Settings do PostgreSQL
      const settingsRes = await client.query('SELECT data FROM delta_settings WHERE id = $1', ['main']);
      if (settingsRes.rows.length > 0) {
        db.settings = { ...defaultData.settings, ...settingsRes.rows[0].data };
      } else {
        await client.query(
          'INSERT INTO delta_settings (id, data, updated_at) VALUES ($1, $2, NOW()) ON CONFLICT (id) DO NOTHING',
          ['main', JSON.stringify(db.settings)]
        );
      }

      // Carrega Keys do PostgreSQL
      const keysRes = await client.query('SELECT data FROM delta_keys ORDER BY created_at DESC');
      if (keysRes.rows.length > 0) {
        db.keys = keysRes.rows.map(r => r.data);
      } else if (db.keys.length > 0) {
        // Se o Postgres estiver vazio mas o JSON tiver chaves, migra para o Postgres
        console.log(`[DB] Migrando ${db.keys.length} chave(s) do JSON local para o PostgreSQL...`);
        for (const k of db.keys) {
          await client.query(
            `INSERT INTO delta_keys (key, app_id, app_name, status, data, created_at, updated_at)
             VALUES ($1, $2, $3, $4, $5, NOW(), NOW())
             ON CONFLICT (key) DO UPDATE SET data = $5, updated_at = NOW()`,
            [k.key.toUpperCase(), k.appId, k.appName, k.status, JSON.stringify(k)]
          );
        }
      }

      // Carrega Logs do PostgreSQL
      const logsRes = await client.query('SELECT id, timestamp, event, details, level FROM delta_logs ORDER BY timestamp DESC LIMIT 500');
      if (logsRes.rows.length > 0) {
        db.logs = logsRes.rows.map(r => ({
          id: r.id,
          timestamp: r.timestamp.toISOString ? r.timestamp.toISOString() : r.timestamp,
          event: r.event,
          details: r.details,
          level: r.level
        }));
      }

      client.release();
      console.log(`[DB] PostgreSQL sincronizado: ${db.keys.length} chave(s) ativas no banco.`);
      return;
    } catch (err) {
      console.error('[DB] ❌ Erro ao conectar ao PostgreSQL:', err.message);
      isPostgresConnected = false;
      connectionError = err.message;

      // Se falhou com SSL, tenta sem SSL como fallback
      if (err.message.includes('SSL') || err.message.includes('tls') || err.message.includes('certificate')) {
        try {
          console.log('[DB] Tentando reconectar sem SSL...');
          const rawUrl = process.env.DATABASE_URL || '';
          const noSslPool = new Pool({
            connectionString: rawUrl,
            ssl: false,
            connectionTimeoutMillis: 6000
          });
          const client2 = await noSslPool.connect();
          console.log('[DB] ✅ Conexão sem SSL estabelecida com sucesso!');
          pool = noSslPool;
          isPostgresConnected = true;
          connectionError = null;
          client2.release();
          return;
        } catch (err2) {
          console.error('[DB] Falha na tentativa sem SSL:', err2.message);
        }
      }
    }
  }

  console.log(`[DB] Utilizando armazenamento local JSON (data/db.json). Chaves em memória: ${db.keys.length}`);
}

// Database Interface
module.exports = {
  init,
  isPostgres: () => isPostgresConnected,
  getConnectionStatus: () => ({
    connected: isPostgresConnected,
    type: isPostgresConnected ? 'PostgreSQL' : 'Local JSON',
    error: connectionError,
    keysCount: db.keys.length,
    hasDatabaseUrl: !!(process.env.DATABASE_URL || process.env.POSTGRES_URL)
  }),

  getSettings() {
    return db.settings;
  },

  async updateSettings(newSettings) {
    db.settings = { ...db.settings, ...newSettings };
    saveLocalJsonData();

    if (isPostgresConnected && pool) {
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
    }
    return db.settings;
  },

  getKeys() {
    return db.keys;
  },

  getKey(keyString) {
    return db.keys.find(k => k.key.toUpperCase() === keyString.toUpperCase());
  },

  addKey(keyRecord) {
    // Sincroniza em memória imediatamente
    db.keys = db.keys.filter(k => k.key.toUpperCase() !== keyRecord.key.toUpperCase());
    db.keys.unshift(keyRecord);
    saveLocalJsonData();

    // Persiste no Postgres de forma assíncrona
    if (isPostgresConnected && pool) {
      pool.query(
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
      ).catch(err => {
        console.error('[DB Postgres] Erro ao gravar chave:', err.message);
      });
    }

    return keyRecord;
  },

  updateKey(keyString, updates) {
    const idx = db.keys.findIndex(k => k.key.toUpperCase() === keyString.toUpperCase());
    if (idx !== -1) {
      db.keys[idx] = { ...db.keys[idx], ...updates, updatedAt: new Date().toISOString() };
      const updatedRecord = db.keys[idx];
      saveLocalJsonData();

      if (isPostgresConnected && pool) {
        pool.query(
          `UPDATE delta_keys 
           SET status = $2, data = $3, updated_at = NOW()
           WHERE key = $1`,
          [
            keyString.toUpperCase(),
            updatedRecord.status,
            JSON.stringify(updatedRecord)
          ]
        ).catch(err => {
          console.error('[DB Postgres] Erro ao atualizar chave:', err.message);
        });
      }

      return updatedRecord;
    }
    return null;
  },

  removeKey(keyString) {
    const initialLen = db.keys.length;
    db.keys = db.keys.filter(k => k.key.toUpperCase() !== keyString.toUpperCase());

    if (db.keys.length !== initialLen) {
      saveLocalJsonData();

      if (isPostgresConnected && pool) {
        pool.query('DELETE FROM delta_keys WHERE key = $1', [keyString.toUpperCase()])
          .catch(err => {
            console.error('[DB Postgres] Erro ao remover chave:', err.message);
          });
      }
      return true;
    }
    return false;
  },

  addLog(event, details = {}, level = 'info') {
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
    saveLocalJsonData();

    if (isPostgresConnected && pool) {
      pool.query(
        `INSERT INTO delta_logs (id, timestamp, event, details, level)
         VALUES ($1, NOW(), $2, $3, $4)`,
        [logItem.id, logItem.event, JSON.stringify(logItem.details), logItem.level]
      ).catch(err => {
        console.error('[DB Postgres] Erro ao gravar log:', err.message);
      });
    }

    return logItem;
  },

  getLogs(limit = 100) {
    return db.logs.slice(0, limit);
  },

  async clearLogs() {
    db.logs = [];
    saveLocalJsonData();

    if (isPostgresConnected && pool) {
      try {
        await pool.query('DELETE FROM delta_logs');
      } catch (err) {
        console.error('[DB Postgres] Erro ao limpar logs:', err.message);
      }
    }
  }
};
