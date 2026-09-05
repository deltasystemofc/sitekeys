const fs = require('fs');
const path = require('path');

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

function loadData() {
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
    console.error('[DB] Erro ao carregar banco de dados, usando defaults:', err);
  }
  return defaultData;
}

let db = loadData();

function saveData() {
  try {
    const tempFile = DB_FILE + '.tmp';
    fs.writeFileSync(tempFile, JSON.stringify(db, null, 2), 'utf8');
    fs.renameSync(tempFile, DB_FILE);
  } catch (err) {
    console.error('[DB] Erro ao salvar banco de dados:', err);
  }
}

module.exports = {
  getSettings() {
    return db.settings;
  },
  updateSettings(newSettings) {
    db.settings = { ...db.settings, ...newSettings };
    saveData();
    return db.settings;
  },
  getKeys() {
    return db.keys;
  },
  getKey(keyString) {
    return db.keys.find(k => k.key.toUpperCase() === keyString.toUpperCase());
  },
  addKey(keyRecord) {
    // Remove if exists to avoid duplicates
    db.keys = db.keys.filter(k => k.key.toUpperCase() !== keyRecord.key.toUpperCase());
    db.keys.unshift(keyRecord);
    saveData();
    return keyRecord;
  },
  updateKey(keyString, updates) {
    const idx = db.keys.findIndex(k => k.key.toUpperCase() === keyString.toUpperCase());
    if (idx !== -1) {
      db.keys[idx] = { ...db.keys[idx], ...updates, updatedAt: new Date().toISOString() };
      saveData();
      return db.keys[idx];
    }
    return null;
  },
  removeKey(keyString) {
    const initialLen = db.keys.length;
    db.keys = db.keys.filter(k => k.key.toUpperCase() !== keyString.toUpperCase());
    if (db.keys.length !== initialLen) {
      saveData();
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
    // Keep max 500 logs
    if (db.logs.length > 500) {
      db.logs = db.logs.slice(0, 500);
    }
    saveData();
    return logItem;
  },
  getLogs(limit = 100) {
    return db.logs.slice(0, limit);
  },
  clearLogs() {
    db.logs = [];
    saveData();
  }
};
