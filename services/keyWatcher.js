const db = require('./database');
const apiService = require('./apiService');

class KeyWatcher {
  constructor() {
    this.timer = null;
    this.isPolling = false;
    this.sseClients = new Set();
  }

  start() {
    if (this.timer) {
      clearInterval(this.timer);
    }
    const settings = db.getSettings();
    const intervalMs = Math.max(3000, (settings.pollingIntervalSec || 5) * 1000);

    console.log(`[Watcher] Iniciando monitoramento de keys a cada ${intervalMs / 1000}s`);
    
    // Executa a primeira checagem imediatamente
    this.checkKeys();

    this.timer = setInterval(() => {
      this.checkKeys();
    }, intervalMs);
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
      console.log('[Watcher] Monitoramento pausado.');
    }
  }

  restart() {
    this.stop();
    this.start();
  }

  addSseClient(res) {
    this.sseClients.add(res);
    res.on('close', () => {
      this.sseClients.delete(res);
    });
  }

  broadcast(eventType, data) {
    const payload = `event: ${eventType}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const client of this.sseClients) {
      try {
        client.write(payload);
      } catch (err) {
        this.sseClients.delete(client);
      }
    }
  }

  /**
   * Verifica se a resposta da API indica que a chave começou a ser usada
   */
  isKeyActivated(info) {
    if (!info || info.status !== 'success' || !info.exists) {
      return false;
    }

    const expiresAt = String(info.expires_at || '').toLowerCase();
    const uid = String(info.uid || '').toLowerCase();
    const ip = String(info.ip || '').toLowerCase();
    const deviceInfo = String(info.device_info || '').toLowerCase();

    // Condições que indicam NÃO ativado
    const isNotActivatedText = 
      expiresAt.includes('não ativada') ||
      expiresAt.includes('pendente') ||
      expiresAt === '' ||
      expiresAt === 'null';

    const hasNoDevice = 
      uid.includes('nenhum dispositivo') || 
      uid === '' || 
      uid === 'null' ||
      uid.includes('aguardando');

    const hasNoIp = 
      ip.includes('nenhum login') || 
      ip === '' || 
      ip === 'null';

    const hasNoDeviceInfo = 
      deviceInfo.includes('aguardando') || 
      deviceInfo === '' || 
      deviceInfo === 'null';

    // Se possui UID ou IP ou dispositivo real, OU a expiração tem data válida
    const hasRealDevice = !hasNoDevice && uid.length > 3;
    const hasRealIp = !hasNoIp && ip.length > 5;
    const hasRealDeviceInfo = !hasNoDeviceInfo && deviceInfo.length > 2;
    const hasActiveExpiration = !isNotActivatedText && expiresAt.length > 8;

    return hasRealDevice || hasRealIp || hasRealDeviceInfo || hasActiveExpiration;
  }

  async checkKeys() {
    if (this.isPolling) return;
    this.isPolling = true;

    try {
      const keys = db.getKeys();
      const pendingOrActiveKeys = keys.filter(k => k.status === 'pending' || k.status === 'active');
      const now = Date.now();

      for (const keyRecord of pendingOrActiveKeys) {
        // Se a chave já está ativa, checa se o tempo personalizado expirou
        if (keyRecord.status === 'active') {
          if (keyRecord.customExpiresAt) {
            const expireTime = new Date(keyRecord.customExpiresAt).getTime();
            if (now >= expireTime) {
              await this.handleKeyExpiration(keyRecord);
              continue;
            }
          }
        }

        // Se a chave está pendente, consulta a API para ver se o cliente logou
        if (keyRecord.status === 'pending') {
          try {
            const info = await apiService.getKeyInfo(keyRecord.key);
            keyRecord.lastPolledAt = new Date().toISOString();

            if (info && info.status === 'success' && info.exists) {
              const activated = this.isKeyActivated(info);

              if (activated) {
                const firstUsedAt = new Date().toISOString();
                const totalMinutes = keyRecord.customDuration?.totalMinutes || 60;
                const customExpiresAt = new Date(now + totalMinutes * 60 * 1000).toISOString();

                const updates = {
                  status: 'active',
                  firstUsedAt,
                  customExpiresAt,
                  apiExpiresAt: info.expires_at,
                  deviceInfo: {
                    uid: info.uid && !String(info.uid).includes('Nenhum') ? info.uid : null,
                    ip: info.ip && !String(info.ip).includes('Nenhum') ? info.ip : null,
                    device: info.device_info && !String(info.device_info).includes('Aguardando') ? info.device_info : null
                  },
                  lastPolledAt: new Date().toISOString()
                };

                const updated = db.updateKey(keyRecord.key, updates);

                db.addLog('KEY_FIRST_LOGIN_DETECTED', {
                  key: keyRecord.key,
                  appName: keyRecord.appName,
                  uid: updates.deviceInfo.uid,
                  ip: updates.deviceInfo.ip,
                  device: updates.deviceInfo.device,
                  customExpiresAt
                });

                console.log(`[Watcher] ⚡ Chave ATIVADA detectada: ${keyRecord.key} - Expira em: ${customExpiresAt}`);

                this.broadcast('key_activated', {
                  key: updated,
                  message: `Chave ${keyRecord.key} iniciou uso! Cronômetro iniciado.`
                });
              } else {
                // Atualiza polled time
                db.updateKey(keyRecord.key, { lastPolledAt: new Date().toISOString() });
              }
            }
          } catch (err) {
            console.error(`[Watcher] Erro ao consultar chave ${keyRecord.key}:`, err.message);
          }
        }
      }

      // Notifica os clientes periodicamente com o resumo
      this.broadcast('tick', { timestamp: new Date().toISOString() });
    } catch (err) {
      console.error('[Watcher] Erro no loop de verificação:', err);
    } finally {
      this.isPolling = false;
    }
  }

  async handleKeyExpiration(keyRecord) {
    const settings = db.getSettings();
    console.log(`[Watcher] ⌛ Chave EXPIRADA: ${keyRecord.key} - Atingiu a duração personalizada.`);

    let resetResult = null;
    if (settings.autoResetOnExpire) {
      try {
        resetResult = await apiService.resetKey(keyRecord.key);
      } catch (err) {
        console.error(`[Watcher] Erro ao resetar HWID da chave expirada ${keyRecord.key}:`, err.message);
      }
    }

    const updates = {
      status: 'expired',
      expiredAt: new Date().toISOString(),
      resetsUsed: (keyRecord.resetsUsed || 0) + (resetResult && resetResult.status === 'success' ? 1 : 0)
    };

    const updated = db.updateKey(keyRecord.key, updates);

    db.addLog('KEY_CUSTOM_TIME_EXPIRED', {
      key: keyRecord.key,
      appName: keyRecord.appName,
      duration: `${keyRecord.customDuration?.value} ${keyRecord.customDuration?.unit}(s)`,
      autoResetPerformed: !!(settings.autoResetOnExpire && resetResult?.status === 'success')
    });

    this.broadcast('key_expired', {
      key: updated,
      message: `Chave ${keyRecord.key} expirou o tempo personalizado de ${keyRecord.customDuration?.value} ${keyRecord.customDuration?.unit}(s)!`
    });
  }
}

const watcher = new KeyWatcher();
module.exports = watcher;
