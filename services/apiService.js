const db = require('./database');

const BASE_URL = 'https://geradorproxy.online';

const APP_INFO = {
  1: { id: 1, name: 'Proxy Android', icon: 'android', badgeColor: '#3ddc84' },
  2: { id: 2, name: 'FFH4X Android', icon: 'gamepad', badgeColor: '#ff9800' },
  3: { id: 3, name: 'Proxy Menu / MDK API', icon: 'shield', badgeColor: '#00e5ff' },
  4: { id: 4, name: 'HS iOS External / Ruanwq API', icon: 'apple', badgeColor: '#a855f7' }
};

/**
 * Calcula o menor tier oficial necessário na API para cobrir o tempo personalizado solicitado
 * @param {number} customValue - Valor numérico (ex: 2, 5, 15)
 * @param {string} customUnit - 'hour' ou 'day'
 * @returns {{ apiDuration: number, apiUnit: string, totalMinutes: number, explanation: string }}
 */
function calculateApiTier(customValue, customUnit) {
  const value = parseInt(customValue, 10);
  if (isNaN(value) || value <= 0) {
    throw new Error('Duração inválida informada.');
  }

  let totalHours = 0;
  if (customUnit === 'hour') {
    if (value > 720) { // 30 dias = 720 horas
      throw new Error('A duração máxima permitida é de 30 dias (720 horas).');
    }
    totalHours = value;
  } else if (customUnit === 'day') {
    if (value > 30) {
      throw new Error('A duração máxima permitida é de 30 dias.');
    }
    totalHours = value * 24;
  } else {
    throw new Error('Unidade de tempo inválida. Use "hour" ou "day".');
  }

  // Lógica de mapeamento para o menor tier da API
  if (totalHours <= 24) {
    // Horas personalizadas (ex: 1h, 2h, 12h, 24h) -> Gera 1 Dia na API
    return {
      apiDuration: 1,
      apiUnit: 'day',
      totalMinutes: totalHours * 60,
      customHours: totalHours,
      tierDescription: '1 Dia (Mínimo da API para durações de horas)',
      explanation: `Duração personalizada de ${customUnit === 'hour' ? `${value} hora(s)` : `${value} dia(s)`}. Será gerada uma chave de 1 Dia na API e o cronômetro de ${customUnit === 'hour' ? `${value}h` : `${value}d`} iniciará no 1º login.`
    };
  } else if (totalHours <= 24 * 7) {
    // Dias personalizados de 2 a 7 dias -> Gera 7 Dias na API
    return {
      apiDuration: 7,
      apiUnit: 'day',
      totalMinutes: totalHours * 60,
      customHours: totalHours,
      tierDescription: '7 Dias (Mínimo da API para até 1 semana)',
      explanation: `Duração personalizada de ${value} dias (${totalHours}h). Será gerada uma chave de 7 Dias na API e expirará em ${value} dias após o 1º login.`
    };
  } else if (totalHours <= 24 * 30) {
    // Dias personalizados de 8 a 30 dias -> Gera 30 Dias na API
    return {
      apiDuration: 30,
      apiUnit: 'day',
      totalMinutes: totalHours * 60,
      customHours: totalHours,
      tierDescription: '30 Dias (Mínimo da API para até 1 mês)',
      explanation: `Duração personalizada de ${value} dias (${totalHours}h). Será gerada uma chave de 30 Dias na API e expirará em ${value} dias após o 1º login.`
    };
  } else {
    throw new Error('Duração acima do limite máximo de 30 dias.');
  }
}

/**
 * Realiza requisições HTTP seguras com timeout e tratamento de resposta
 */
async function requestApi(endpoint, params = {}) {
  const query = new URLSearchParams(params).toString();
  const url = `${BASE_URL}/${endpoint}?${query}`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12000);

  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) DeltaKeyManager/1.0',
        'Accept': 'application/json, text/plain, */*'
      },
      signal: controller.signal
    });

    clearTimeout(timeout);
    const text = await response.text();

    try {
      return JSON.parse(text);
    } catch {
      return { status: 'error', message: 'Resposta não-JSON da API', raw: text, httpStatus: response.status };
    }
  } catch (err) {
    clearTimeout(timeout);
    if (err.name === 'AbortError') {
      throw new Error(`Timeout ao conectar com a API (${endpoint}).`);
    }
    throw err;
  }
}

/**
 * Cria nova(s) chave(s) na API Delta
 */
async function createKey({ appId = 1, customValue = 1, customUnit = 'hour', quantity = 1, prefix = '' }) {
  const settings = db.getSettings();
  const token = settings.token;

  if (!token) {
    throw new Error('Token da API não configurado.');
  }

  const tier = calculateApiTier(customValue, customUnit);
  const qty = Math.max(1, Math.min(parseInt(quantity, 10) || 1, 20));

  const params = {
    token,
    app_id: appId,
    duration: tier.apiDuration,
    unit: tier.apiUnit,
    quantity: qty
  };

  // Sanitiza o prefixo (remove hífens no final para evitar duplicidade ex: VIP--XXXX)
  if (prefix && prefix.trim().length > 0) {
    const cleanPrefix = prefix.trim().replace(/-+$/, '');
    if (cleanPrefix.length > 0) {
      params.prefix = cleanPrefix;
    }
  }

  const result = await requestApi('CreateKeyAPI.php', params);

  if (result.status === 'error') {
    throw new Error(result.message || 'Erro retornado pela API externa.');
  }

  // Obtém lista de chaves geradas
  let generatedKeys = [];
  if (Array.isArray(result.keys) && result.keys.length > 0) {
    generatedKeys = result.keys;
  } else if (result.key) {
    generatedKeys = [result.key];
  }

  if (generatedKeys.length === 0) {
    throw new Error('Nenhuma chave retornada pela API.');
  }

  const registeredRecords = [];

  for (const keyStr of generatedKeys) {
    const keyRecord = {
      key: keyStr,
      appId: parseInt(appId, 10),
      appName: APP_INFO[appId]?.name || result.app_name || `App ${appId}`,
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
      prefix: params.prefix || '',
      status: 'pending', // 'pending' (aguardando 1º login), 'active' (contando tempo), 'expired' (tempo esgotado), 'error'
      firstUsedAt: null,
      customExpiresAt: null,
      apiCreatedAt: new Date().toISOString(),
      apiExpiresAt: null,
      deviceInfo: {
        uid: null,
        ip: null,
        device: null
      },
      resetsUsed: 0,
      lastPolledAt: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };

    await db.addKey(keyRecord);
    registeredRecords.push(keyRecord);

    await db.addLog('KEY_CREATED', {
      key: keyStr,
      app: keyRecord.appName,
      customDuration: `${customValue} ${customUnit}(s)`,
      apiTier: `${tier.apiDuration} ${tier.apiUnit}`,
      prefix: params.prefix || 'Nenhum'
    });
  }

  return {
    success: true,
    result,
    keys: registeredRecords,
    remainingCredits: result.remaining_credits,
    tier
  };
}

/**
 * Consulta informações de uma chave na API Delta
 */
async function getKeyInfo(keyString) {
  const settings = db.getSettings();
  const token = settings.token;

  if (!keyString) {
    throw new Error('Chave não informada.');
  }

  const result = await requestApi('GetKeyInfo.php', {
    key: keyString.trim(),
    token: token || ''
  });

  return result;
}

/**
 * Reseta Hardware ID / IP de uma chave na API Delta
 */
async function resetKey(keyString) {
  const settings = db.getSettings();
  const token = settings.token;

  if (!token) {
    throw new Error('Token da API não configurado.');
  }
  if (!keyString) {
    throw new Error('Chave não informada.');
  }

  const result = await requestApi('ResetKeyAPI.php', {
    key: keyString.trim(),
    token
  });

  if (result.status === 'success') {
    db.addLog('KEY_RESET_SUCCESS', {
      key: keyString,
      resetsUsed: result.resets_used
    });
  } else {
    db.addLog('KEY_RESET_FAILED', {
      key: keyString,
      message: result.message
    }, 'warning');
  }

  return result;
}

module.exports = {
  APP_INFO,
  calculateApiTier,
  createKey,
  getKeyInfo,
  resetKey
};
