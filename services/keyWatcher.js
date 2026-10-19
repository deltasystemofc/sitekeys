const db = require('./database');
const apiService = require('./apiService');

class KeyWatcher {
  constructor() {
    this.timer = null;
    this.isPolling = false;
    this.sseClients = new Set();
    this.deletingKeys = new Set();
  }

  start() {
    if (this.timer) {
      clearInterval(this.timer);
    }
    const settings = db.getSettings();
    const intervalMs = Math.max(3000, (settings.pollingIntervalSec || 5) * 1000);

    console.log(`[Watcher] Iniciando monitoramento de keys a cada ${intervalMs / 1000}s`);
    
    // Executa varredura de keys que já estavam expiradas no banco antes de ligar o loop
    this.cleanupExpiredKeysOnStartup().catch(err => {
      console.error('[Watcher] Erro na varredura inicial:', err.message);
    });

    // Executa a primeira checagem imediatamente
    this.checkKeys().catch(err => {
      console.error('[Watcher] Erro na checagem inicial:', err.message);
    });

    this.timer = setInterval(() => {
      this.checkKeys().catch(err => {
        console.error('[Watcher] Erro no loop de checagem:', err.message);
      });
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
   * Varredura única na inicialização para keys com status === 'expired' e apiDeleted !== true
   */
  async cleanupExpiredKeysOnStartup() {
    try {
      const keys = db.getKeys();
      const uncleaned = keys.filter(k => k.status === 'expired' && k.apiDeleted !== true);

      if (uncleaned.length === 0) {
        console.log('[Watcher] Varredura inicial: nenhuma chave expirada pendente de exclusão.');
        return;
      }

      console.log(`[Watcher] Varredura inicial: ${uncleaned.length} chave(s) expirada(s) pendente(s) de verificação.`);
      let processed = 0;
      let deleted = 0;
      let failed = 0;

      for (const k of uncleaned) {
        processed++;
        const keyClean = String(k.key || '').trim();
        if (!keyClean || !/^[A-Za-z0-9_-]+$/.test(keyClean)) continue;

        try {
          // Confirma se a chave ainda existe no gerador antes de excluir
          const info = await apiService.getKeyInfo(keyClean);
          const existsInApi = info && info.status === 'success' && info.exists;

          if (!existsInApi) {
            // Chave já não existe mais no gerador (já foi deletada ou nunca existiu)
            db.updateKey(keyClean, {
              apiDeleted: true,
              apiDeletedAt: new Date().toISOString(),
              apiDeleteError: null
            });
            deleted++;
          } else {
            // Existe no gerador: deleta uma a uma
            const delRes = await apiService.deleteKey(keyClean);
            const isAlreadyGone = delRes.status === 'error' && (
              (delRes.message && /não encontrada|não existe|inválida/i.test(delRes.message)) ||
              delRes.exists === false
            );
            if (delRes.status === 'success' || isAlreadyGone) {
              db.updateKey(keyClean, {
                apiDeleted: true,
                apiDeletedAt: new Date().toISOString(),
                apiDeleteError: null
              });
              deleted++;
            } else {
              db.updateKey(keyClean, {
                apiDeleted: false,
                apiDeleteError: delRes.message || 'Falha ao excluir na API'
              });
              failed++;
            }
          }
        } catch (err) {
          failed++;
          console.error(`[Watcher] Erro na varredura inicial da chave ${keyClean}:`, err.message);
        }

        // Intervalo de segurança de 500ms entre as requisições
        await new Promise(r => setTimeout(r, 500));
      }

      console.log(`[Watcher] Varredura inicial concluída: ${processed} processadas, ${deleted} excluídas/confirmadas, ${failed} falharam.`);
    } catch (err) {
      console.error('[Watcher] Erro geral na varredura inicial:', err.message);
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
          // Não consulta a mesma chave pendente mais de 1 vez a cada 15 segundos
          if (keyRecord.lastPolledAt) {
            const timeSincePoll = now - new Date(keyRecord.lastPolledAt).getTime();
            if (timeSincePoll < 15000) continue;
          }

          try {
            const info = await apiService.getKeyInfo(keyRecord.key);
            keyRecord.lastPolledAt = new Date().toISOString();
            db.updateKey(keyRecord.key, { lastPolledAt: keyRecord.lastPolledAt });

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
              }
            }
          } catch (err) {
            console.error(`[Watcher] Erro ao consultar chave ${keyRecord.key}:`, err.message);
          }

          // Intervalo de segurança de 100ms entre consultas de chaves pendentes
          await new Promise(r => setTimeout(r, 100));
        }
      }

      // Retry para chaves expiradas que falharam na exclusão da API (máx 10 tentativas)
      const expiredToRetry = keys.filter(k => 
        k.status === 'expired' && 
        k.apiDeleted !== true && 
        (k.apiDeleteAttempts || 0) < 10 &&
        !this.deletingKeys.has(k.key)
      );

      for (const expRecord of expiredToRetry) {
        await this.retryDeleteExpiredKey(expRecord);
      }

      // Notifica os clientes periodicamente com o resumo
      this.broadcast('tick', { timestamp: new Date().toISOString() });
    } catch (err) {
      console.error('[Watcher] Erro no loop de verificação:', err);
    } finally {
      this.isPolling = false;
    }
  }

  /**
   * Tenta novamente excluir da API uma chave que já está expirada
   */
  async retryDeleteExpiredKey(keyRecord) {
    const keyClean = String(keyRecord.key || '').trim();
    if (!keyClean || !/^[A-Za-z0-9_-]+$/.test(keyClean)) return;
    if (this.deletingKeys.has(keyClean)) return;
    this.deletingKeys.add(keyClean);

    try {
      const apiDeleteResult = await apiService.deleteKey(keyClean);
      const isAlreadyGone = apiDeleteResult.status === 'error' && (
        (apiDeleteResult.message && /não encontrada|não existe|inválida/i.test(apiDeleteResult.message)) ||
        apiDeleteResult.exists === false
      );
      const apiDeleteSuccess = apiDeleteResult.status === 'success' || isAlreadyGone;

      const attempts = (keyRecord.apiDeleteAttempts || 0) + 1;
      const updates = {
        apiDeleted: apiDeleteSuccess,
        apiDeletedAt: apiDeleteSuccess ? new Date().toISOString() : null,
        apiDeleteError: apiDeleteSuccess ? null : (apiDeleteResult.message || 'Falha ao excluir na API'),
        apiDeleteAttempts: attempts,
        lastDeleteAttemptAt: new Date().toISOString()
      };

      const updated = db.updateKey(keyClean, updates);
      console.log(`[Watcher] 🔄 Retry exclusão chave ${keyClean} (tentativa ${attempts}/10): ${apiDeleteSuccess ? 'SUCESSO' : 'FALHA'}`);

      if (apiDeleteSuccess) {
        this.broadcast('key_expired', {
          key: updated,
          apiDeleted: true,
          message: `Chave ${keyClean} foi excluída do gerador após nova tentativa!`
        });
      }
    } catch (err) {
      const attempts = (keyRecord.apiDeleteAttempts || 0) + 1;
      db.updateKey(keyClean, {
        apiDeleteError: err.message,
        apiDeleteAttempts: attempts,
        lastDeleteAttemptAt: new Date().toISOString()
      });
      console.error(`[Watcher] 🔄 Erro no retry de exclusão da chave ${keyClean}:`, err.message);
    } finally {
      this.deletingKeys.delete(keyClean);
    }
  }

  async handleKeyExpiration(keyRecord) {
    if (!keyRecord || !keyRecord.key) return null;
    const keyClean = String(keyRecord.key).trim();
    if (!/^[A-Za-z0-9_-]+$/.test(keyClean)) {
      console.error(`[Watcher] Chave inválida para expiração: ${keyClean}`);
      return null;
    }

    // Evita concorrência e execuções duplicadas
    if (this.deletingKeys.has(keyClean)) {
      console.log(`[Watcher] Chave ${keyClean} já está sendo processada.`);
      return db.getKey(keyClean);
    }
    this.deletingKeys.add(keyClean);

    const settings = db.getSettings();
    console.log(`[Watcher] ⌛ Chave EXPIRADA: ${keyClean} - Atingiu a duração personalizada.`);

    // 1. Reset opcional de HWID se configurado
    let resetResult = null;
    if (settings.autoResetOnExpire) {
      try {
        resetResult = await apiService.resetKey(keyClean);
      } catch (err) {
        console.error(`[Watcher] Erro ao resetar HWID da chave expirada ${keyClean}:`, err.message);
      }
    }

    // 2. Exclusão permanente da key na API do gerador
    let apiDeleteResult = null;
    let apiDeleteSuccess = false;
    let apiDeleteError = null;

    try {
      apiDeleteResult = await apiService.deleteKey(keyClean);
      const isAlreadyGone = apiDeleteResult.status === 'error' && (
        (apiDeleteResult.message && /não encontrada|não existe|inválida/i.test(apiDeleteResult.message)) ||
        apiDeleteResult.exists === false
      );
      apiDeleteSuccess = apiDeleteResult.status === 'success' || isAlreadyGone;
      if (!apiDeleteSuccess) {
        apiDeleteError = apiDeleteResult.message || 'Erro retornado pela API na exclusão';
      }
    } catch (err) {
      apiDeleteSuccess = false;
      apiDeleteError = err.message || 'Falha de comunicação com a API ao excluir';
      console.error(`[Watcher] Erro ao excluir chave ${keyClean} na API:`, err.message);
    }

    // 3. Atualização no banco local
    const updates = {
      status: 'expired',
      expiredAt: keyRecord.expiredAt || new Date().toISOString(),
      resetsUsed: (keyRecord.resetsUsed || 0) + (resetResult && resetResult.status === 'success' ? 1 : 0),
      apiDeleted: apiDeleteSuccess,
      apiDeletedAt: apiDeleteSuccess ? new Date().toISOString() : null,
      apiDeleteError: apiDeleteSuccess ? null : apiDeleteError,
      apiDeleteAttempts: (keyRecord.apiDeleteAttempts || 0) + 1,
      lastDeleteAttemptAt: new Date().toISOString()
    };

    const updated = db.updateKey(keyClean, updates);
    this.deletingKeys.delete(keyClean);

    // 4. Registro de log de auditoria
    db.addLog('KEY_CUSTOM_TIME_EXPIRED', {
      key: keyClean,
      appName: keyRecord.appName,
      duration: `${keyRecord.customDuration?.value} ${keyRecord.customDuration?.unit}(s)`,
      autoResetPerformed: !!(settings.autoResetOnExpire && resetResult?.status === 'success'),
      apiDeleted: apiDeleteSuccess
    });

    // 5. Broadcast SSE em tempo real
    this.broadcast('key_expired', {
      key: updated,
      apiDeleted: apiDeleteSuccess,
      message: apiDeleteSuccess
        ? `Chave ${keyClean} expirou e foi excluída do gerador com sucesso!`
        : `Chave ${keyClean} expirou (falha ao excluir no gerador: ${apiDeleteError})`
    });

    return updated;
  }
}

const watcher = new KeyWatcher();
module.exports = watcher;
