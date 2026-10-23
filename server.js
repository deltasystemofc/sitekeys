const fs = require('fs');
const path = require('path');

// Carrega .env com dotenv ou fallback nativo sem dependências
try {
  require('dotenv').config({ path: path.join(__dirname, '.env') });
} catch (e) {}
try {
  const envPath = path.join(__dirname, '.env');
  if (fs.existsSync(envPath)) {
    const envContent = fs.readFileSync(envPath, 'utf8');
    envContent.split(/\r?\n/).forEach(line => {
      const trimmed = line.trim();
      if (trimmed && !trimmed.startsWith('#')) {
        const eqIdx = trimmed.indexOf('=');
        if (eqIdx !== -1) {
          const key = trimmed.substring(0, eqIdx).trim();
          const val = trimmed.substring(eqIdx + 1).trim().replace(/^['"]|['"]$/g, '');
          if (!process.env[key]) {
            process.env[key] = val;
          }
        }
      }
    });
  }
} catch (err) {}

const express = require('express');
const cors = require('cors');
const db = require('./services/database');
const apiService = require('./services/apiService');
const keyWatcher = require('./services/keyWatcher');
const authService = require('./services/authService');

process.on('uncaughtException', (err) => {
  console.error('[Process] Uncaught Exception:', err);
});
process.on('unhandledRejection', (reason, promise) => {
  console.error('[Process] Unhandled Rejection at:', promise, 'reason:', reason);
});

const app = express();

function cleanEnv(val) {
  if (!val) return '';
  return String(val).replace(/^['"]|['"]$/g, '').trim();
}

const rawPort = cleanEnv(process.env.PORT);
const PORT = parseInt(rawPort, 10) || 3000;

app.use(cors());
app.use(express.json());

// Endpoint de Health Check rápido para Railway
app.get('/health', (req, res) => res.status(200).send('OK'));

app.use(express.static(path.join(__dirname, 'public')));

// Rota de Login Público
app.post('/api/auth/login', (req, res) => {
  const { username, password } = req.body;
  const result = authService.login(username, password);
  if (result.success) {
    res.json(result);
  } else {
    res.status(401).json(result);
  }
});

// Checagem de Sessão / Token
app.get('/api/auth/me', authService.authMiddleware, (req, res) => {
  res.json({ success: true, user: req.user });
});

// Middleware de Proteção para todas as rotas seguintes da API
app.use('/api', authService.authMiddleware);

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

// Status da Database (Postgres vs Local)
app.get('/api/db-status', (req, res) => {
  res.json({
    success: true,
    status: db.getConnectionStatus()
  });
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
    const { durationValue, durationUnit, appId } = req.body;
    const tier = apiService.calculateApiTier(durationValue, durationUnit, appId || 1);
    res.json({ success: true, tier });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

// Forçar verificação ao vivo imediata de todas as chaves pendentes
app.post('/api/keys/sync-check', async (req, res) => {
  try {
    await keyWatcher.checkKeys(true);
    res.json({ success: true, message: 'Varredura de chaves concluída com sucesso.' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
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

// Validação prévia de chaves na API antes de importar
app.post('/api/keys/validate', async (req, res) => {
  try {
    const { keys, key } = req.body;

    let rawList = [];
    if (Array.isArray(keys) && keys.length > 0) {
      rawList = keys;
    } else if (key && typeof key === 'string') {
      rawList = key.split(/[\r\n,;\s]+/).filter(k => k && k.trim().length > 0);
    }

    if (rawList.length === 0) {
      return res.status(400).json({ success: false, error: 'Nenhuma chave informada para validação.' });
    }

    const uniqueKeys = [...new Set(rawList.map(k => k.trim().toUpperCase()))];
    const validKeys = [];
    const invalidKeys = [];

    for (const keyClean of uniqueKeys) {
      try {
        const info = await apiService.getKeyInfo(keyClean);
        if (info && info.status === 'success' && info.exists) {
          const isActivated = keyWatcher.isKeyActivated(info);
          validKeys.push({
            key: keyClean,
            valid: true,
            appId: info.app_id || 1,
            product: info.product || info.app_name || 'App Delta',
            expiresAt: info.expires_at || 'Não Ativada',
            uid: info.uid || 'Nenhum',
            ip: info.ip || 'Nenhum',
            deviceInfo: info.device_info || 'Aguardando login',
            isActivated
          });
        } else {
          invalidKeys.push({
            key: keyClean,
            valid: false,
            reason: info?.message || 'Chave não existe ou é inválida na API Delta'
          });
        }
      } catch (err) {
        invalidKeys.push({
          key: keyClean,
          valid: false,
          reason: err.message
        });
      }
    }

    res.json({
      success: true,
      total: uniqueKeys.length,
      validCount: validKeys.length,
      invalidCount: invalidKeys.length,
      validKeys,
      invalidKeys
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Importar chave(s) para monitoramento (suporta chave única ou lista em lote)
app.post('/api/keys/import', async (req, res) => {
  try {
    const { key, keys, appId, customValue, customUnit } = req.body;

    let rawList = [];
    if (Array.isArray(keys) && keys.length > 0) {
      rawList = keys;
    } else if (key && typeof key === 'string') {
      // Divide por quebras de linha, vírgulas ou espaços
      rawList = key.split(/[\r\n,;\s]+/).filter(k => k && k.trim().length > 0);
    }

    if (rawList.length === 0) {
      return res.status(400).json({ success: false, error: 'Nenhuma chave informada para importação.' });
    }

    // Normaliza e remove duplicatas
    const uniqueKeys = [...new Set(rawList.map(k => k.trim().toUpperCase()))];
    const val = parseInt(customValue, 10) || 1;
    const unit = customUnit || 'hour';
    const targetAppId = parseInt(appId, 10) || 1;

    const tier = apiService.calculateApiTier(val, unit, targetAppId);
    const now = Date.now();

    const importedKeys = [];
    const failedKeys = [];

    // Processa as chaves
    for (const keyClean of uniqueKeys) {
      try {
        const info = await apiService.getKeyInfo(keyClean);
        if (!info || info.status === 'error' || !info.exists) {
          failedKeys.push({ key: keyClean, reason: info?.message || 'Chave não existe ou inválida na API Delta' });
          continue;
        }

        const isActivated = keyWatcher.isKeyActivated(info);
        let status = 'pending';
        let firstUsedAt = null;
        let customExpiresAt = null;

        if (isActivated) {
          status = 'active';
          firstUsedAt = new Date().toISOString();
          customExpiresAt = new Date(now + tier.totalMinutes * 60 * 1000).toISOString();
        }

        const detectedAppId = parseInt(targetAppId || info.app_id || 1, 10);

        const realUid = (info.uid && !String(info.uid).includes('Nenhum') && String(info.uid).trim() !== '-')
          ? info.uid
          : (Array.isArray(info.uids_list) && info.uids_list[0] ? info.uids_list[0] : null);

        const realIp = (info.ip && !String(info.ip).includes('Nenhum') && String(info.ip).trim() !== '-')
          ? info.ip
          : (Array.isArray(info.ips_list) && info.ips_list[0] ? info.ips_list[0] : null);

        const realDevice = (info.device_info && !String(info.device_info).includes('Aguardando') && String(info.device_info).trim() !== '-')
          ? info.device_info
          : (Array.isArray(info.device_infos_list) && info.device_infos_list[0] ? info.device_infos_list[0] : null);

        const keyRecord = {
          key: keyClean,
          appId: detectedAppId,
          appName: apiService.APP_INFO[detectedAppId]?.name || info.product || `App ${detectedAppId}`,
          customDuration: {
            value: val,
            unit,
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
            uid: realUid,
            ip: realIp,
            device: realDevice,
            connectedDevices: info.connected_devices || (info.devices ? info.devices.length : (realUid ? 1 : 0)),
            maxDevices: info.max_devices || (detectedAppId === 5 ? 4 : 1),
            devices: info.devices || null
          },
          resetsUsed: 0,
          lastPolledAt: new Date().toISOString(),
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          imported: true
        };

        db.addKey(keyRecord);
        importedKeys.push(keyRecord);

        db.addLog('KEY_IMPORTED', {
          key: keyClean,
          app: keyRecord.appName,
          status: keyRecord.status,
          customDuration: `${val} ${unit}(s)`
        });
      } catch (err) {
        failedKeys.push({ key: keyClean, reason: err.message });
      }
    }

    if (importedKeys.length > 0) {
      keyWatcher.broadcast('keys_imported', { count: importedKeys.length });
    }

    res.json({
      success: true,
      total: uniqueKeys.length,
      importedCount: importedKeys.length,
      failedCount: failedKeys.length,
      importedKeys,
      failedKeys
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Consulta detalhes ao vivo de uma chave
app.get('/api/keys/:key/info', async (req, res) => {
  try {
    const keyParam = req.params.key;
    let local = db.getKey(keyParam);
    const apiData = await apiService.getKeyInfo(keyParam);

    // Se a chave estava pendente mas a API Delta mostra que já está sendo usada, ativa na hora
    if (local && local.status === 'pending' && apiData && apiData.status === 'success' && apiData.exists) {
      if (keyWatcher.isKeyActivated(apiData)) {
        const totalMinutes = local.customDuration?.totalMinutes || 60;
        const now = Date.now();
        const customExpiresAt = new Date(now + totalMinutes * 60 * 1000).toISOString();

        const realUid = (apiData.uid && !String(apiData.uid).includes('Nenhum') && String(apiData.uid).trim() !== '-')
          ? apiData.uid
          : (Array.isArray(apiData.uids_list) && apiData.uids_list[0] ? apiData.uids_list[0] : null);

        const realIp = (apiData.ip && !String(apiData.ip).includes('Nenhum') && String(apiData.ip).trim() !== '-')
          ? apiData.ip
          : (Array.isArray(apiData.ips_list) && apiData.ips_list[0] ? apiData.ips_list[0] : null);

        const realDevice = (apiData.device_info && !String(apiData.device_info).includes('Aguardando') && String(apiData.device_info).trim() !== '-')
          ? apiData.device_info
          : (Array.isArray(apiData.device_infos_list) && apiData.device_infos_list[0] ? apiData.device_infos_list[0] : null);

        const updates = {
          status: 'active',
          firstUsedAt: new Date().toISOString(),
          customExpiresAt,
          apiExpiresAt: apiData.expires_at,
          deviceInfo: {
            uid: realUid,
            ip: realIp,
            device: realDevice,
            connectedDevices: apiData.connected_devices || (apiData.devices ? apiData.devices.length : (realUid ? 1 : 0)),
            maxDevices: apiData.max_devices || (local.appId === 5 ? 4 : 1),
            devices: apiData.devices || null
          },
          lastPolledAt: new Date().toISOString()
        };

        local = db.updateKey(keyParam, updates);

        db.addLog('KEY_FIRST_LOGIN_DETECTED', {
          key: keyParam,
          appName: local.appName,
          uid: updates.deviceInfo.uid,
          ip: updates.deviceInfo.ip,
          device: updates.deviceInfo.device,
          connectedDevices: updates.deviceInfo.connectedDevices,
          customExpiresAt
        });

        keyWatcher.broadcast('key_activated', {
          key: local,
          message: `Chave ${keyParam} iniciou uso! Cronômetro iniciado.`
        });
      }
    }

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

    const updated = (await keyWatcher.handleKeyExpiration(local)) || db.getKey(keyParam);
    res.json({
      success: true,
      key: updated,
      apiDeleted: !!updated.apiDeleted,
      apiDeleteError: updated.apiDeleteError || null
    });
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

// Inicia o servidor HTTP imediatamente para passar no Health Check do Railway
const HOST = '0.0.0.0';

const server = app.listen(PORT, HOST, () => {
  console.log(`====================================================`);
  console.log(`🚀 Delta Key Manager rodando em http://${HOST}:${PORT}`);
  console.log(`====================================================`);

  // Inicializa o banco de dados e o watcher de forma assíncrona sem travar o boot
  db.init().then(() => {
    console.log(`💾 Banco: ${db.isPostgres() ? 'PostgreSQL (Nuvem)' : 'Arquivo JSON Local'}`);
    keyWatcher.start();
  }).catch(err => {
    console.error('[DB] Erro ao conectar ao banco de dados:', err.message);
    console.log('[DB] Operando com fallback em arquivo JSON local.');
    keyWatcher.start();
  });
});

server.on('error', (err) => {
  console.error('[Server] Erro no servidor HTTP:', err);
});
