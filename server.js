const express = require('express');
const cors = require('cors');
const path = require('path');
const db = require('./services/database');
const apiService = require('./services/apiService');
const keyWatcher = require('./services/keyWatcher');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// SSE Endpoint para atualizações em tempo real
app.get('/api/events', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();

  keyWatcher.addSseClient(res);

  // Envia ping inicial
  res.write(`event: connected\ndata: ${JSON.stringify({ status: 'connected', time: new Date().toISOString() })}\n\n`);
});

// Resumo / Estatísticas
app.get('/api/stats', async (req, res) => {
  try {
    const keys = db.getKeys();
    const pending = keys.filter(k => k.status === 'pending').length;
    const active = keys.filter(k => k.status === 'active').length;
    const expired = keys.filter(k => k.status === 'expired').length;
    const total = keys.length;

    res.json({
      success: true,
      stats: {
        total,
        pending,
        active,
        expired
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Listagem de chaves
app.get('/api/keys', (req, res) => {
  try {
    const { status, app_id, search } = req.query;
    let keys = db.getKeys();

    if (status && status !== 'all') {
      keys = keys.filter(k => k.status === status);
    }
    if (app_id && app_id !== 'all') {
      keys = keys.filter(k => String(k.appId) === String(app_id));
    }
    if (search) {
      const q = search.toLowerCase();
      keys = keys.filter(k => 
        k.key.toLowerCase().includes(q) ||
        (k.appName && k.appName.toLowerCase().includes(q)) ||
        (k.deviceInfo?.uid && k.deviceInfo.uid.toLowerCase().includes(q)) ||
        (k.deviceInfo?.ip && k.deviceInfo.ip.toLowerCase().includes(q)) ||
        (k.deviceInfo?.device && k.deviceInfo.device.toLowerCase().includes(q))
      );
    }

    res.json({ success: true, keys });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Pré-visualização do cálculo de Tier
app.post('/api/keys/preview-tier', (req, res) => {
  try {
    const { durationValue, durationUnit } = req.body;
    const tier = apiService.calculateApiTier(durationValue, durationUnit);
    res.json({ success: true, tier });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

// Gerar nova(s) chave(s)
app.post('/api/keys/generate', async (req, res) => {
  try {
    const { appId, customValue, customUnit, quantity, prefix } = req.body;

    const result = await apiService.createKey({
      appId: parseInt(appId, 10) || 1,
      customValue: parseInt(customValue, 10) || 1,
      customUnit: customUnit || 'hour',
      quantity: parseInt(quantity, 10) || 1,
      prefix: prefix || ''
    });

    // Notifica via SSE
    keyWatcher.broadcast('key_created', {
      count: result.keys.length,
      keys: result.keys
    });

    res.json({ success: true, data: result });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Importar chave existente para monitoramento
app.post('/api/keys/import', async (req, res) => {
  try {
    const { key, appId, customValue, customUnit } = req.body;

    if (!key || !key.trim()) {
      return res.status(400).json({ success: false, error: 'Chave não informada.' });
    }

    const keyClean = key.trim().toUpperCase();
    const tier = apiService.calculateApiTier(customValue, customUnit);

    // Consulta status atual na API externa
    const info = await apiService.getKeyInfo(keyClean);
    if (!info || info.status === 'error' || !info.exists) {
      return res.status(400).json({
        success: false,
        error: info?.message || 'A chave informada não existe ou é inválida na API Delta.'
      });
    }

    const isActivated = keyWatcher.isKeyActivated(info);
    const now = Date.now();

    let status = 'pending';
    let firstUsedAt = null;
    let customExpiresAt = null;

    if (isActivated) {
      status = 'active';
      firstUsedAt = new Date().toISOString();
      customExpiresAt = new Date(now + tier.totalMinutes * 60 * 1000).toISOString();
    }

    const keyRecord = {
      key: keyClean,
      appId: parseInt(appId || info.app_id || 1, 10),
      appName: apiService.APP_INFO[appId]?.name || info.product || `App ${appId || 1}`,
      customDuration: {
        value: parseInt(customValue, 10),
        unit: customUnit,
        totalMinutes: tier.totalMinutes,
        totalHours: tier.customHours
      },
      apiDuration: {
        duration: tier.apiDuration,
        unit: tier.apiUnit
      },
      prefix: '',
      status,
      firstUsedAt,
      customExpiresAt,
      apiCreatedAt: info.created_at || new Date().toISOString(),
      apiExpiresAt: info.expires_at || null,
      deviceInfo: {
        uid: info.uid && !String(info.uid).includes('Nenhum') ? info.uid : null,
        ip: info.ip && !String(info.ip).includes('Nenhum') ? info.ip : null,
        device: info.device_info && !String(info.device_info).includes('Aguardando') ? info.device_info : null
      },
      resetsUsed: 0,
      lastPolledAt: new Date().toISOString(),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      imported: true
    };

    db.addKey(keyRecord);

    db.addLog('KEY_IMPORTED', {
      key: keyClean,
      app: keyRecord.appName,
      status: keyRecord.status,
      customDuration: `${customValue} ${customUnit}(s)`
    });

    keyWatcher.broadcast('key_imported', { key: keyRecord });

    res.json({ success: true, key: keyRecord, info });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Consulta detalhes ao vivo de uma chave
app.get('/api/keys/:key/info', async (req, res) => {
  try {
    const keyParam = req.params.key;
    const local = db.getKey(keyParam);
    const apiData = await apiService.getKeyInfo(keyParam);

    res.json({
      success: true,
      local,
      api: apiData
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Reset manual de HWID / IP
app.post('/api/keys/:key/reset', async (req, res) => {
  try {
    const keyParam = req.params.key;
    const result = await apiService.resetKey(keyParam);

    if (result.status === 'success') {
      const local = db.getKey(keyParam);
      if (local) {
        db.updateKey(keyParam, {
          resetsUsed: (local.resetsUsed || 0) + 1,
          deviceInfo: { uid: null, ip: null, device: null }
        });
      }
      res.json({ success: true, result });
    } else {
      res.status(400).json({ success: false, error: result.message });
    }
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Forçar expiração imediata de uma chave
app.post('/api/keys/:key/expire', async (req, res) => {
  try {
    const keyParam = req.params.key;
    const local = db.getKey(keyParam);
    if (!local) {
      return res.status(404).json({ success: false, error: 'Chave não encontrada no monitor.' });
    }

    await keyWatcher.handleKeyExpiration(local);
    const updated = db.getKey(keyParam);
    res.json({ success: true, key: updated });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Remover chave do sistema de monitoramento
app.delete('/api/keys/:key', (req, res) => {
  try {
    const keyParam = req.params.key;
    const removed = db.removeKey(keyParam);
    if (removed) {
      db.addLog('KEY_DELETED_FROM_MONITOR', { key: keyParam });
      keyWatcher.broadcast('key_deleted', { key: keyParam });
      res.json({ success: true, message: 'Chave removida do monitoramento com sucesso.' });
    } else {
      res.status(404).json({ success: false, error: 'Chave não encontrada.' });
    }
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Configurações
app.get('/api/settings', (req, res) => {
  try {
    const settings = db.getSettings();
    res.json({ success: true, settings });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/settings', (req, res) => {
  try {
    const updated = db.updateSettings(req.body);
    keyWatcher.restart();
    res.json({ success: true, settings: updated });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Logs de auditoria
app.get('/api/logs', (req, res) => {
  try {
    const limit = parseInt(req.query.limit, 10) || 100;
    const logs = db.getLogs(limit);
    res.json({ success: true, logs });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.delete('/api/logs', (req, res) => {
  try {
    db.clearLogs();
    res.json({ success: true, message: 'Logs limpos com sucesso.' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Inicia o servidor, banco e o watcher
const HOST = '0.0.0.0';

async function startServer() {
  try {
    // Inicializa banco (Postgres ou Local)
    await db.init();

    app.listen(PORT, HOST, () => {
      console.log(`====================================================`);
      console.log(`🚀 Delta Key Manager rodando em http://${HOST}:${PORT}`);
      console.log(`💾 Banco: ${db.isPostgres() ? 'PostgreSQL (Nuvem)' : 'Arquivo JSON Local'}`);
      console.log(`====================================================`);
      keyWatcher.start();
    });
  } catch (err) {
    console.error('Falha crítica ao iniciar o servidor:', err);
    process.exit(1);
  }
}

startServer();
