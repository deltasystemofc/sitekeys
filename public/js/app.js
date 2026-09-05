// Delta Key Master - Frontend Application Logic

let state = {
  keys: [],
  stats: { total: 0, pending: 0, active: 0, expired: 0 },
  settings: {
    token: '',
    pollingIntervalSec: 5,
    autoResetOnExpire: true,
    soundNotifications: true
  },
  filters: {
    status: 'all',
    appId: 'all',
    search: ''
  },
  currentView: 'cards', // 'cards' ou 'table'
  createdKeysModalData: []
};

// ================= AUDIO NOTIFICATIONS =================
class SoundEffects {
  constructor() {
    this.ctx = null;
  }

  init() {
    if (!this.ctx) {
      const AudioContext = window.AudioContext || window.webkitAudioContext;
      if (AudioContext) {
        this.ctx = new AudioContext();
      }
    }
  }

  playBeep(freq = 520, type = 'sine', duration = 0.15) {
    if (!state.settings.soundNotifications) return;
    try {
      this.init();
      if (!this.ctx) return;
      if (this.ctx.state === 'suspended') {
        this.ctx.resume();
      }

      const osc = this.ctx.createOscillator();
      const gain = this.ctx.createGain();

      osc.type = type;
      osc.frequency.setValueAtTime(freq, this.ctx.currentTime);
      gain.gain.setValueAtTime(0.15, this.ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, this.ctx.currentTime + duration);

      osc.connect(gain);
      gain.connect(this.ctx.destination);

      osc.start();
      osc.stop(this.ctx.currentTime + duration);
    } catch (e) {
      console.warn('Audio play failed:', e);
    }
  }

  playActivatedSound() {
    this.playBeep(587.33, 'sine', 0.12);
    setTimeout(() => this.playBeep(880, 'sine', 0.25), 130);
  }

  playExpiredSound() {
    this.playBeep(440, 'triangle', 0.15);
    setTimeout(() => this.playBeep(349.23, 'triangle', 0.3), 150);
  }
}

const sounds = new SoundEffects();

// ================= TOAST NOTIFICATIONS =================
function showToast(message, type = 'info', duration = 3500) {
  const container = document.getElementById('toastContainer');
  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;

  const iconMap = {
    success: 'fa-circle-check text-emerald',
    error: 'fa-circle-exclamation text-rose',
    warning: 'fa-triangle-exclamation text-amber',
    info: 'fa-circle-info text-cyan'
  };

  toast.innerHTML = `
    <i class="fa-solid ${iconMap[type] || iconMap.info}"></i>
    <span>${message}</span>
  `;

  container.appendChild(toast);

  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transform = 'translateX(100%)';
    toast.style.transition = 'all 0.3s ease';
    setTimeout(() => toast.remove(), 300);
  }, duration);
}

// ================= API CALLS =================
async function apiFetch(url, options = {}) {
  try {
    const res = await fetch(url, {
      headers: { 'Content-Type': 'application/json' },
      ...options
    });
    const text = await res.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      data = { success: false, error: text || `Erro HTTP ${res.status}` };
    }
    if (!res.ok) {
      return { success: false, error: data.error || data.message || `Erro HTTP ${res.status}` };
    }
    return data;
  } catch (err) {
    console.error('Fetch error:', err);
    return { success: false, error: err.message || 'Falha na comunicação com o servidor' };
  }
}

async function loadSettings() {
  const res = await apiFetch('/api/settings');
  if (res.success) {
    state.settings = res.settings;
    document.getElementById('settingToken').value = res.settings.token || '';
    document.getElementById('settingInterval').value = res.settings.pollingIntervalSec || 5;
    document.getElementById('settingAutoReset').checked = !!res.settings.autoResetOnExpire;
    document.getElementById('settingSounds').checked = !!res.settings.soundNotifications;
  }
}

async function loadKeys() {
  const params = new URLSearchParams();
  if (state.filters.status !== 'all') params.append('status', state.filters.status);
  if (state.filters.appId !== 'all') params.append('app_id', state.filters.appId);
  if (state.filters.search) params.append('search', state.filters.search);

  const [keysRes, statsRes] = await Promise.all([
    apiFetch(`/api/keys?${params.toString()}`),
    apiFetch('/api/stats')
  ]);

  if (keysRes.success) {
    state.keys = keysRes.keys;
    renderKeys();
  }

  if (statsRes.success) {
    state.stats = statsRes.stats;
    renderStats();
  }
}

// ================= RENDER STATS =================
function renderStats() {
  const { total, pending, active, expired } = state.stats;
  document.getElementById('statTotal').textContent = total;
  document.getElementById('statPending').textContent = pending;
  document.getElementById('statActive').textContent = active;
  document.getElementById('statExpired').textContent = expired;

  const pPending = total > 0 ? (pending / total) * 100 : 0;
  const pActive = total > 0 ? (active / total) * 100 : 0;
  const pExpired = total > 0 ? (expired / total) * 100 : 0;

  document.getElementById('barPending').style.width = `${pPending}%`;
  document.getElementById('barActive').style.width = `${pActive}%`;
  document.getElementById('barExpired').style.width = `${pExpired}%`;

  document.getElementById('keysCountBadge').textContent = `${state.keys.length} chave(s) exibida(s)`;
}

// ================= RENDER KEYS =================
function renderKeys() {
  const cardsContainer = document.getElementById('keysContainerCards');
  const tableBody = document.getElementById('keysTableBody');
  const emptyState = document.getElementById('emptyState');

  if (state.keys.length === 0) {
    cardsContainer.innerHTML = '';
    tableBody.innerHTML = '';
    emptyState.classList.remove('hidden');
    return;
  }

  emptyState.classList.add('hidden');

  // Render Cards
  cardsContainer.innerHTML = state.keys.map(k => createKeyCardHtml(k)).join('');

  // Render Table
  tableBody.innerHTML = state.keys.map(k => createKeyTableRowHtml(k)).join('');
}

function getAppBadgeHtml(appId, appName) {
  const appMap = {
    1: { cls: 'badge-app-1', icon: 'fa-brands fa-android', label: 'Proxy Android' },
    2: { cls: 'badge-app-2', icon: 'fa-solid fa-crosshairs', label: 'FFH4X' },
    3: { cls: 'badge-app-3', icon: 'fa-solid fa-shield-halved', label: 'Proxy Menu' },
    4: { cls: 'badge-app-4', icon: 'fa-brands fa-apple', label: 'HS iOS' }
  };
  const app = appMap[appId] || { cls: 'badge-app-1', icon: 'fa-solid fa-cube', label: appName || 'App' };
  return `<span class="app-badge ${app.cls}"><i class="${app.icon}"></i> ${app.label}</span>`;
}

function formatDurationText(customDuration) {
  if (!customDuration) return '1 Hora';
  const { value, unit } = customDuration;
  return unit === 'hour' ? `${value} Hora(s)` : `${value} Dia(s)`;
}

function createKeyCardHtml(k) {
  const durationText = formatDurationText(k.customDuration);
  const apiTierText = `${k.apiDuration?.duration || 1} ${k.apiDuration?.unit === 'day' ? 'Dia(s)' : k.apiDuration?.unit}`;

  let statusBadge = '';
  let timerContent = '';

  if (k.status === 'pending') {
    statusBadge = `<span class="status-badge badge-pending"><i class="fa-solid fa-hourglass-half"></i> Aguardando 1º Login</span>`;
    timerContent = `
      <div class="card-timer-wrap">
        <div class="timer-header">
          <span class="timer-title"><i class="fa-solid fa-clock"></i> Contagem Regressiva</span>
          <span class="timer-countdown text-amber">Pendente</span>
        </div>
        <div class="timer-progress-track">
          <div class="timer-progress-bar" style="width: 0%"></div>
        </div>
        <div class="timer-meta">
          <span>Iniciará assim que o cliente conectar</span>
          <span>Duração: ${durationText}</span>
        </div>
      </div>
    `;
  } else if (k.status === 'active') {
    statusBadge = `<span class="status-badge badge-active"><i class="fa-solid fa-bolt"></i> Em Uso (Ativa)</span>`;
    timerContent = `
      <div class="card-timer-wrap" data-key="${k.key}" data-expires="${k.customExpiresAt}" data-total-min="${k.customDuration?.totalMinutes || 60}">
        <div class="timer-header">
          <span class="timer-title"><i class="fa-solid fa-stopwatch text-emerald"></i> Tempo Restante</span>
          <span class="timer-countdown text-emerald live-countdown" id="countdown-${k.key}">Calculando...</span>
        </div>
        <div class="timer-progress-track">
          <div class="timer-progress-bar live-progress" id="progress-${k.key}" style="width: 100%"></div>
        </div>
        <div class="timer-meta">
          <span>Ativada: ${formatDate(k.firstUsedAt)}</span>
          <span>Duração: ${durationText}</span>
        </div>
      </div>
    `;
  } else if (k.status === 'expired') {
    statusBadge = `<span class="status-badge badge-expired"><i class="fa-solid fa-ban"></i> Expirada / Finalizada</span>`;
    timerContent = `
      <div class="card-timer-wrap">
        <div class="timer-header">
          <span class="timer-title"><i class="fa-solid fa-clock-rotate-left"></i> Status</span>
          <span class="timer-countdown text-rose">Finalizada</span>
        </div>
        <div class="timer-progress-track">
          <div class="timer-progress-bar bar-rose" style="width: 100%"></div>
        </div>
        <div class="timer-meta">
          <span>Expirou em: ${formatDate(k.expiredAt || k.updatedAt)}</span>
          <span>Duração: ${durationText}</span>
        </div>
      </div>
    `;
  }

  const uidStr = k.deviceInfo?.uid || 'Aguardando login';
  const ipStr = k.deviceInfo?.ip || 'Não registrado';
  const deviceStr = k.deviceInfo?.device || 'Nenhum';

  return `
    <div class="key-card status-${k.status}" id="card-${k.key}">
      <div class="card-top">
        ${getAppBadgeHtml(k.appId, k.appName)}
        ${statusBadge}
      </div>

      <div class="key-code-box">
        <span class="key-text" title="Clique para copiar">${k.key}</span>
        <button class="btn-copy" onclick="copyToClipboard('${k.key}', this)" title="Copiar Chave">
          <i class="fa-solid fa-copy"></i>
        </button>
      </div>

      ${timerContent}

      <div class="device-info-grid">
        <div class="device-row">
          <span><i class="fa-solid fa-fingerprint"></i> UID:</span>
          <span class="device-value" title="${uidStr}">${uidStr}</span>
        </div>
        <div class="device-row">
          <span><i class="fa-solid fa-network-wired"></i> IP:</span>
          <span class="device-value" title="${ipStr}">${ipStr}</span>
        </div>
        <div class="device-row">
          <span><i class="fa-solid fa-mobile-screen"></i> Aparelho:</span>
          <span class="device-value" title="${deviceStr}">${deviceStr}</span>
        </div>
      </div>

      <div class="card-actions">
        <button class="btn btn-secondary btn-sm" onclick="openKeyDetails('${k.key}')" title="Ver Informações da API">
          <i class="fa-solid fa-circle-info"></i> Detalhes
        </button>
        <button class="btn btn-secondary btn-sm" onclick="resetKeyHwid('${k.key}')" title="Resetar Hardware ID e IP">
          <i class="fa-solid fa-arrows-rotate"></i> Reset HWID
        </button>
        ${k.status === 'active' ? `
          <button class="btn btn-danger btn-sm" onclick="forceExpireKey('${k.key}')" title="Encerrar agora">
            <i class="fa-solid fa-stop"></i> Expirar
          </button>
        ` : ''}
        <button class="btn btn-secondary btn-sm text-rose" onclick="deleteKey('${k.key}')" title="Remover do Monitor">
          <i class="fa-solid fa-trash"></i>
        </button>
      </div>
    </div>
  `;
}

function createKeyTableRowHtml(k) {
  const durationText = formatDurationText(k.customDuration);
  const apiTierText = `${k.apiDuration?.duration || 1} ${k.apiDuration?.unit === 'day' ? 'Dia(s)' : k.apiDuration?.unit}`;

  let statusHtml = '';
  if (k.status === 'pending') {
    statusHtml = `<span class="status-badge badge-pending">⏳ Aguardando 1º Login</span>`;
  } else if (k.status === 'active') {
    statusHtml = `<span class="status-badge badge-active live-countdown-table" id="countdown-tbl-${k.key}">🟢 Em Uso</span>`;
  } else {
    statusHtml = `<span class="status-badge badge-expired">🔴 Expirada</span>`;
  }

  const devInfo = k.deviceInfo?.device || k.deviceInfo?.uid || 'Aguardando';

  return `
    <tr>
      <td>
        <div style="display: flex; align-items: center; gap: 0.5rem;">
          <span class="text-mono" style="font-weight: 700; color: #fff;">${k.key}</span>
          <button class="btn-copy" style="width: 26px; height: 26px;" onclick="copyToClipboard('${k.key}', this)"><i class="fa-solid fa-copy"></i></button>
        </div>
      </td>
      <td>${getAppBadgeHtml(k.appId, k.appName)}</td>
      <td><strong>${durationText}</strong></td>
      <td><span class="badge-count">${apiTierText}</span></td>
      <td>${statusHtml}</td>
      <td><span class="text-mono" style="font-size: 0.8rem;">${devInfo}</span></td>
      <td>
        <div style="display: flex; gap: 0.35rem;">
          <button class="btn btn-secondary btn-sm" onclick="openKeyDetails('${k.key}')"><i class="fa-solid fa-eye"></i></button>
          <button class="btn btn-secondary btn-sm" onclick="resetKeyHwid('${k.key}')"><i class="fa-solid fa-rotate"></i></button>
          <button class="btn btn-secondary btn-sm text-rose" onclick="deleteKey('${k.key}')"><i class="fa-solid fa-trash"></i></button>
        </div>
      </td>
    </tr>
  `;
}

// ================= REAL-TIME TIMER TICKER =================
function updateCountdowns() {
  const now = Date.now();
  const activeElements = document.querySelectorAll('.card-timer-wrap[data-expires]');

  activeElements.forEach(el => {
    const expiresStr = el.getAttribute('data-expires');
    const totalMinutes = parseFloat(el.getAttribute('data-total-min')) || 60;
    const key = el.getAttribute('data-key');
    if (!expiresStr) return;

    const expireTime = new Date(expiresStr).getTime();
    const remainingMs = expireTime - now;

    const countdownEl = document.getElementById(`countdown-${key}`);
    const progressEl = document.getElementById(`progress-${key}`);
    const tableCountdownEl = document.getElementById(`countdown-tbl-${key}`);

    if (remainingMs <= 0) {
      if (countdownEl) countdownEl.textContent = 'Expirada';
      if (progressEl) progressEl.style.width = '0%';
      if (tableCountdownEl) tableCountdownEl.textContent = '🔴 Expirada';
    } else {
      const formatted = formatRemainingTime(remainingMs);
      if (countdownEl) countdownEl.textContent = formatted;
      if (tableCountdownEl) tableCountdownEl.textContent = `🟢 ${formatted}`;

      const totalMs = totalMinutes * 60 * 1000;
      const pct = Math.max(0, Math.min(100, (remainingMs / totalMs) * 100));
      if (progressEl) progressEl.style.width = `${pct}%`;
    }
  });
}

function formatRemainingTime(ms) {
  const totalSec = Math.floor(ms / 1000);
  const days = Math.floor(totalSec / 86400);
  const hours = Math.floor((totalSec % 86400) / 3600);
  const minutes = Math.floor((totalSec % 3600) / 60);
  const seconds = totalSec % 60;

  const pad = n => String(n).padStart(2, '0');

  if (days > 0) {
    return `${days}d ${pad(hours)}h ${pad(minutes)}m ${pad(seconds)}s`;
  }
  return `${pad(hours)}:${pad(minutes)}:${pad(seconds)}`;
}

function formatDate(isoStr) {
  if (!isoStr) return '--';
  try {
    const d = new Date(isoStr);
    return d.toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' });
  } catch {
    return isoStr;
  }
}

// ================= ACTIONS =================
async function copyToClipboard(text, btnElement) {
  try {
    await navigator.clipboard.writeText(text);
    showToast(`Chave ${text} copiada!`, 'success');
    if (btnElement) {
      btnElement.classList.add('copied');
      btnElement.innerHTML = '<i class="fa-solid fa-check"></i>';
      setTimeout(() => {
        btnElement.classList.remove('copied');
        btnElement.innerHTML = '<i class="fa-solid fa-copy"></i>';
      }, 1500);
    }
  } catch {
    showToast('Erro ao copiar para a área de transferência', 'error');
  }
}

async function resetKeyHwid(keyString) {
  if (!confirm(`Deseja resetar o Hardware ID e IP da chave ${keyString}?`)) return;

  showToast(`Resetando HWID da chave ${keyString}...`, 'info');
  const res = await apiFetch(`/api/keys/${encodeURIComponent(keyString)}/reset`, { method: 'POST' });

  if (res.success) {
    showToast(`HWID da chave ${keyString} resetado com sucesso!`, 'success');
    loadKeys();
  } else {
    showToast(`Erro ao resetar: ${res.error || 'Falha na requisição'}`, 'error');
  }
}

async function forceExpireKey(keyString) {
  if (!confirm(`Tem certeza que deseja forçar a expiração da chave ${keyString}? Isso resetará seu HWID e encerrará o tempo.`)) return;

  const res = await apiFetch(`/api/keys/${encodeURIComponent(keyString)}/expire`, { method: 'POST' });
  if (res.success) {
    showToast(`Chave ${keyString} expirada com sucesso!`, 'success');
    loadKeys();
  } else {
    showToast(`Erro ao expirar chave: ${res.error}`, 'error');
  }
}

async function deleteKey(keyString) {
  if (!confirm(`Remover a chave ${keyString} do monitoramento?`)) return;

  const res = await apiFetch(`/api/keys/${encodeURIComponent(keyString)}`, { method: 'DELETE' });
  if (res.success) {
    showToast(`Chave removida do monitoramento`, 'info');
    loadKeys();
  } else {
    showToast(`Erro ao remover: ${res.error}`, 'error');
  }
}

async function openKeyDetails(keyString) {
  const modal = document.getElementById('modalKeyDetails');
  const body = document.getElementById('keyDetailsBody');
  body.innerHTML = '<div style="text-align: center; padding: 2rem;"><i class="fa-solid fa-spinner fa-spin text-primary" style="font-size: 2rem;"></i><p style="margin-top: 1rem; color: #94a3b8;">Consultando dados ao vivo na API...</p></div>';
  modal.classList.remove('hidden');

  const res = await apiFetch(`/api/keys/${encodeURIComponent(keyString)}/info`);
  if (!res.success) {
    body.innerHTML = `<div class="toast toast-error">Erro ao carregar detalhes: ${res.error}</div>`;
    return;
  }

  const local = res.local || {};
  const api = res.api || {};

  body.innerHTML = `
    <div style="display: flex; flex-direction: column; gap: 1.25rem;">
      <div class="key-code-box">
        <span class="key-text">${local.key || keyString}</span>
        <button class="btn-copy" onclick="copyToClipboard('${local.key || keyString}', this)"><i class="fa-solid fa-copy"></i></button>
      </div>

      <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 1rem;">
        <div style="background: var(--bg-input); padding: 1rem; border-radius: var(--radius-md); border: 1px solid var(--border-color);">
          <h4 style="font-size: 0.85rem; color: var(--cyan); margin-bottom: 0.75rem; text-transform: uppercase;"><i class="fa-solid fa-stopwatch"></i> Monitor Local</h4>
          <p><strong>Status:</strong> ${local.status}</p>
          <p><strong>Duração Personalizada:</strong> ${formatDurationText(local.customDuration)}</p>
          <p><strong>1º Login Detectado:</strong> ${formatDate(local.firstUsedAt)}</p>
          <p><strong>Expira em:</strong> ${formatDate(local.customExpiresAt)}</p>
          <p><strong>Resets Utilizados:</strong> ${local.resetsUsed || 0}</p>
        </div>

        <div style="background: var(--bg-input); padding: 1rem; border-radius: var(--radius-md); border: 1px solid var(--border-color);">
          <h4 style="font-size: 0.85rem; color: var(--emerald); margin-bottom: 0.75rem; text-transform: uppercase;"><i class="fa-solid fa-cloud"></i> Resposta Oficial da API</h4>
          <p><strong>Produto:</strong> ${api.product || api.app_name || '--'}</p>
          <p><strong>Duração API:</strong> ${api.duration || '--'}</p>
          <p><strong>Expiração na API:</strong> ${api.expires_at || '--'}</p>
          <p><strong>UID:</strong> ${api.uid || '--'}</p>
          <p><strong>IP:</strong> ${api.ip || '--'}</p>
          <p><strong>Aparelho:</strong> ${api.device_info || '--'}</p>
        </div>
      </div>

      <div style="text-align: right; margin-top: 0.5rem;">
        <button class="btn btn-secondary" onclick="document.getElementById('modalKeyDetails').classList.add('hidden')">Fechar</button>
      </div>
    </div>
  `;
}

// ================= TIER PREVIEW CALCULATION =================
function calculateClientTier(customValue, customUnit) {
  const val = parseInt(customValue, 10) || 1;
  const totalHours = customUnit === 'hour' ? val : val * 24;
  if (totalHours <= 24) {
    return {
      tierDescription: '1 Dia (Mínimo da API para durações de horas)',
      explanation: `Duração personalizada de ${customUnit === 'hour' ? `${val} hora(s)` : `${val} dia(s)`}. Será gerada uma chave de 1 Dia na API e o cronômetro iniciará no 1º login.`
    };
  } else if (totalHours <= 24 * 7) {
    return {
      tierDescription: '7 Dias (Mínimo da API para até 1 semana)',
      explanation: `Duração personalizada de ${val} dias (${totalHours}h). Será gerada uma chave de 7 Dias na API e expirará em ${val} dias após o 1º login.`
    };
  } else if (totalHours <= 24 * 30) {
    return {
      tierDescription: '30 Dias (Mínimo da API para até 1 mês)',
      explanation: `Duração personalizada de ${val} dias (${totalHours}h). Será gerada uma chave de 30 Dias na API e expirará em ${val} dias após o 1º login.`
    };
  }
  return {
    tierDescription: 'Limite Excedido',
    explanation: 'A duração máxima permitida é de 30 dias.'
  };
}

function updateTierPreview() {
  const tabHour = document.getElementById('tabUnitHour');
  const isHour = tabHour ? tabHour.classList.contains('active') : true;
  const unit = isHour ? 'hour' : 'day';
  const valInput = document.getElementById('genCustomValue');
  let val = parseInt(valInput?.value, 10) || 1;

  if (isHour && val > 720) val = 720;
  if (!isHour && val > 30) val = 30;

  const previewBox = document.getElementById('tierPreviewText');
  if (!previewBox) return;

  const clientTier = calculateClientTier(val, unit);
  previewBox.innerHTML = `
    <div><strong>🎯 Plano Gerado na API:</strong> <span class="text-cyan font-bold">${clientTier.tierDescription}</span></div>
    <div style="margin-top: 0.35rem; color: #cbd5e1;">${clientTier.explanation}</div>
  `;
}

// ================= SSE REAL-TIME LISTENER =================
function initSSE() {
  const evtSource = new EventSource('/api/events');

  evtSource.onmessage = (e) => {
    // Ping regular
  };

  evtSource.addEventListener('tick', () => {
    // Sincronização periódica
  });

  evtSource.addEventListener('key_activated', (e) => {
    try {
      const data = JSON.parse(e.data);
      sounds.playActivatedSound();
      showToast(`⚡ Chave ${data.key?.key} iniciou uso agora! Cronômetro ativado.`, 'success', 6000);
      loadKeys();
    } catch (err) {
      console.error(err);
    }
  });

  evtSource.addEventListener('key_expired', (e) => {
    try {
      const data = JSON.parse(e.data);
      sounds.playExpiredSound();
      showToast(`⌛ Chave ${data.key?.key} atingiu a duração personalizada e foi encerrada!`, 'warning', 7000);
      loadKeys();
    } catch (err) {
      console.error(err);
    }
  });

  evtSource.addEventListener('key_created', () => {
    loadKeys();
  });

  evtSource.addEventListener('key_imported', () => {
    loadKeys();
  });

  evtSource.addEventListener('key_deleted', () => {
    loadKeys();
  });

  evtSource.onerror = () => {
    console.warn('SSE reconectando...');
  };
}

// ================= MODAL LOGS =================
async function openLogsModal() {
  const modal = document.getElementById('modalLogs');
  const container = document.getElementById('logsContainer');
  container.innerHTML = '<div style="text-align: center; padding: 2rem;"><i class="fa-solid fa-spinner fa-spin text-primary" style="font-size: 2rem;"></i></div>';
  modal.classList.remove('hidden');

  const res = await apiFetch('/api/logs?limit=80');
  if (!res.success) {
    container.innerHTML = `<div class="toast toast-error">${res.error}</div>`;
    return;
  }

  if (res.logs.length === 0) {
    container.innerHTML = '<div style="text-align: center; padding: 2rem; color: #94a3b8;">Nenhum registro de log no momento.</div>';
    return;
  }

  const badgeMap = {
    KEY_CREATED: { bg: 'rgba(59, 130, 246, 0.2)', text: '#60a5fa', label: 'Chave Gerada' },
    KEY_FIRST_LOGIN_DETECTED: { bg: 'rgba(16, 185, 129, 0.2)', text: '#10b981', label: '1º Login Detectado' },
    KEY_CUSTOM_TIME_EXPIRED: { bg: 'rgba(244, 63, 94, 0.2)', text: '#f43f5e', label: 'Tempo Expirado' },
    KEY_RESET_SUCCESS: { bg: 'rgba(6, 182, 212, 0.2)', text: '#06b6d4', label: 'HWID Resetado' },
    KEY_IMPORTED: { bg: 'rgba(168, 85, 247, 0.2)', text: '#c084fc', label: 'Chave Importada' },
    KEY_DELETED_FROM_MONITOR: { bg: 'rgba(100, 116, 139, 0.2)', text: '#94a3b8', label: 'Removida' }
  };

  container.innerHTML = res.logs.map(log => {
    const badge = badgeMap[log.event] || { bg: 'rgba(255,255,255,0.1)', text: '#fff', label: log.event };
    const detailStr = Object.entries(log.details || {})
      .map(([k, v]) => `<strong>${k}:</strong> ${v}`)
      .join(' | ');

    return `
      <div class="log-entry">
        <div class="log-main">
          <span class="log-event-badge" style="background: ${badge.bg}; color: ${badge.text};">${badge.label}</span>
          <div style="color: #cbd5e1; font-size: 0.82rem; margin-top: 0.25rem;">${detailStr}</div>
        </div>
        <span class="log-time">${formatDate(log.timestamp)}</span>
      </div>
    `;
  }).join('');
}

// ================= DOM EVENT LISTENERS =================
document.addEventListener('DOMContentLoaded', () => {
  // Inicializa dados e SSE
  loadSettings();
  loadKeys();
  initSSE();

  // Timer loop para contagem regressiva suave a cada 1s
  setInterval(updateCountdowns, 1000);

  // Recarrega estatísticas e chaves periodicamente (backup caso SSE reconecte)
  setInterval(loadKeys, 8000);

  // Tabs de Unidade (Horas vs Dias)
  const tabHour = document.getElementById('tabUnitHour');
  const tabDay = document.getElementById('tabUnitDay');
  const presetsHours = document.getElementById('presetsHours');
  const presetsDays = document.getElementById('presetsDays');
  const genValue = document.getElementById('genCustomValue');
  const unitSuffix = document.getElementById('genUnitSuffix');
  const helpText = document.getElementById('genHelpText');

  tabHour.addEventListener('click', () => {
    tabHour.classList.add('active');
    tabDay.classList.remove('active');
    presetsHours.classList.remove('hidden');
    presetsDays.classList.add('hidden');
    unitSuffix.textContent = 'Horas';
    genValue.value = 2;
    genValue.max = 23;
    helpText.textContent = 'Duração personalizada em horas (gerará plano de 1 dia na API).';
    updateTierPreview();
  });

  tabDay.addEventListener('click', () => {
    tabDay.classList.add('active');
    tabHour.classList.remove('active');
    presetsDays.classList.remove('hidden');
    presetsHours.classList.add('hidden');
    unitSuffix.textContent = 'Dias';
    genValue.value = 3;
    genValue.max = 30;
    helpText.textContent = 'Duração personalizada em dias (máximo permitido: 30 dias).';
    updateTierPreview();
  });

  // Presets click handlers
  document.querySelectorAll('#presetsHours .btn-preset').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('#presetsHours .btn-preset').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      genValue.value = btn.getAttribute('data-val');
      updateTierPreview();
    });
  });

  document.querySelectorAll('#presetsDays .btn-preset').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('#presetsDays .btn-preset').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      genValue.value = btn.getAttribute('data-val');
      updateTierPreview();
    });
  });

  genValue.addEventListener('input', () => {
    updateTierPreview();
  });

  // Presets de Prefixo
  document.querySelectorAll('#presetsPrefixes .btn-preset').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('#presetsPrefixes .btn-preset').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      const pfx = btn.getAttribute('data-pfx') || '';
      document.getElementById('genPrefix').value = pfx;
    });
  });

  document.getElementById('genPrefix')?.addEventListener('input', (e) => {
    const val = e.target.value.trim().toUpperCase();
    document.querySelectorAll('#presetsPrefixes .btn-preset').forEach(b => {
      b.classList.toggle('active', b.getAttribute('data-pfx') === val);
    });
  });

  // Modais Toggle
  const modalGen = document.getElementById('modalGenerate');
  const modalImport = document.getElementById('modalImport');
  const modalSettings = document.getElementById('modalSettings');
  const modalLogs = document.getElementById('modalLogs');
  const modalSuccess = document.getElementById('modalCreatedSuccess');

  document.getElementById('btnOpenGenerate').addEventListener('click', () => {
    updateTierPreview();
    modalGen.classList.remove('hidden');
  });
  document.getElementById('btnEmptyGenerate').addEventListener('click', () => {
    updateTierPreview();
    modalGen.classList.remove('hidden');
  });
  document.getElementById('btnCloseGenerate').addEventListener('click', () => modalGen.classList.add('hidden'));
  document.getElementById('btnCancelGenerate').addEventListener('click', () => modalGen.classList.add('hidden'));

  document.getElementById('btnOpenImport').addEventListener('click', () => modalImport.classList.remove('hidden'));
  document.getElementById('btnEmptyImport').addEventListener('click', () => modalImport.classList.remove('hidden'));
  document.getElementById('btnCloseImport').addEventListener('click', () => modalImport.classList.add('hidden'));
  document.getElementById('btnCancelImport').addEventListener('click', () => modalImport.classList.add('hidden'));

  document.getElementById('btnOpenSettings').addEventListener('click', () => modalSettings.classList.remove('hidden'));
  document.getElementById('btnCloseSettings').addEventListener('click', () => modalSettings.classList.add('hidden'));
  document.getElementById('btnCancelSettings').addEventListener('click', () => modalSettings.classList.add('hidden'));

  document.getElementById('btnOpenLogs').addEventListener('click', openLogsModal);
  document.getElementById('btnCloseLogs').addEventListener('click', () => modalLogs.classList.add('hidden'));

  document.getElementById('btnCloseDetails').addEventListener('click', () => document.getElementById('modalKeyDetails').classList.add('hidden'));
  document.getElementById('btnCloseSuccess').addEventListener('click', () => modalSuccess.classList.add('hidden'));
  document.getElementById('btnOkCreated').addEventListener('click', () => modalSuccess.classList.add('hidden'));

  // Form Gerar Chave
  document.getElementById('formGenerate').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btnSubmit = document.getElementById('btnSubmitGenerate');
    const originalText = btnSubmit.innerHTML;
    btnSubmit.disabled = true;
    btnSubmit.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Gerando...';

    const appId = document.querySelector('input[name="appId"]:checked')?.value || 1;
    const isHour = document.getElementById('tabUnitHour').classList.contains('active');
    const customUnit = isHour ? 'hour' : 'day';
    const customValue = parseInt(document.getElementById('genCustomValue').value, 10) || 1;
    const quantity = parseInt(document.getElementById('genQuantity').value, 10) || 1;
    const prefix = document.getElementById('genPrefix').value.trim();

    try {
      const res = await apiFetch('/api/keys/generate', {
        method: 'POST',
        body: JSON.stringify({ appId, customValue, customUnit, quantity, prefix })
      });

      if (res.success) {
        modalGen.classList.add('hidden');
        showToast(`${res.data.keys.length} chave(s) gerada(s) com sucesso!`, 'success');
        
        // Exibe modal de sucesso com as chaves geradas
        state.createdKeysModalData = res.data.keys;
        const listContainer = document.getElementById('createdKeysList');
        listContainer.innerHTML = res.data.keys.map(k => `
          <div class="created-key-item">
            <span class="created-key-string">${k.key}</span>
            <button class="btn btn-secondary btn-sm" onclick="copyToClipboard('${k.key}', this)"><i class="fa-solid fa-copy"></i> Copiar</button>
          </div>
        `).join('');

        modalSuccess.classList.remove('hidden');
        loadKeys();
      } else {
        showToast(`Erro ao gerar: ${res.error || 'Falha na API'}`, 'error');
      }
    } catch (err) {
      showToast('Erro interno ao processar requisição.', 'error');
    } finally {
      btnSubmit.disabled = false;
      btnSubmit.innerHTML = originalText;
    }
  });

  // Copiar todas as geradas
  document.getElementById('btnCopyAllCreated').addEventListener('click', () => {
    const allText = state.createdKeysModalData.map(k => k.key).join('\n');
    copyToClipboard(allText);
  });

  // Form Importar Chave
  document.getElementById('formImport').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btnSubmit = document.getElementById('btnSubmitImport');
    const originalText = btnSubmit.innerHTML;
    btnSubmit.disabled = true;
    btnSubmit.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Verificando...';

    const key = document.getElementById('importKey').value.trim();
    const appId = document.getElementById('importAppId').value;
    const customValue = parseInt(document.getElementById('importDurationValue').value, 10) || 1;
    const customUnit = document.getElementById('importDurationUnit').value;

    try {
      const res = await apiFetch('/api/keys/import', {
        method: 'POST',
        body: JSON.stringify({ key, appId, customValue, customUnit })
      });

      if (res.success) {
        modalImport.classList.add('hidden');
        showToast(`Chave ${key} importada e agora está sob monitoramento!`, 'success');
        document.getElementById('importKey').value = '';
        loadKeys();
      } else {
        showToast(`Erro ao importar: ${res.error}`, 'error');
      }
    } catch (err) {
      showToast('Erro ao importar chave.', 'error');
    } finally {
      btnSubmit.disabled = false;
      btnSubmit.innerHTML = originalText;
    }
  });

  // Form Configurações
  document.getElementById('formSettings').addEventListener('submit', async (e) => {
    e.preventDefault();
    const token = document.getElementById('settingToken').value.trim();
    const pollingIntervalSec = parseInt(document.getElementById('settingInterval').value, 10) || 5;
    const autoResetOnExpire = document.getElementById('settingAutoReset').checked;
    const soundNotifications = document.getElementById('settingSounds').checked;

    const res = await apiFetch('/api/settings', {
      method: 'POST',
      body: JSON.stringify({ token, pollingIntervalSec, autoResetOnExpire, soundNotifications })
    });

    if (res.success) {
      modalSettings.classList.add('hidden');
      state.settings = res.settings;
      showToast('Configurações salvas com sucesso!', 'success');
    } else {
      showToast(`Erro ao salvar: ${res.error}`, 'error');
    }
  });

  // Limpar Logs
  document.getElementById('btnClearLogs').addEventListener('click', async () => {
    if (!confirm('Deseja realmente limpar o histórico de logs?')) return;
    const res = await apiFetch('/api/logs', { method: 'DELETE' });
    if (res.success) {
      showToast('Logs limpos!', 'info');
      openLogsModal();
    }
  });

  // Filtros e Busca
  const searchInput = document.getElementById('searchInput');
  const btnClearSearch = document.getElementById('btnClearSearch');
  const filterStatus = document.getElementById('filterStatus');
  const filterApp = document.getElementById('filterApp');

  searchInput.addEventListener('input', (e) => {
    state.filters.search = e.target.value;
    btnClearSearch.classList.toggle('hidden', !e.target.value);
    loadKeys();
  });

  btnClearSearch.addEventListener('click', () => {
    searchInput.value = '';
    state.filters.search = '';
    btnClearSearch.classList.add('hidden');
    loadKeys();
  });

  filterStatus.addEventListener('change', (e) => {
    state.filters.status = e.target.value;
    loadKeys();
  });

  filterApp.addEventListener('change', (e) => {
    state.filters.appId = e.target.value;
    loadKeys();
  });

  document.getElementById('btnRefresh').addEventListener('click', () => {
    showToast('Atualizando dados...', 'info', 1000);
    loadKeys();
  });

  // Toggle View
  const btnCards = document.getElementById('viewCardsBtn');
  const btnTable = document.getElementById('viewTableBtn');
  const containerCards = document.getElementById('keysContainerCards');
  const containerTable = document.getElementById('keysContainerTable');

  btnCards.addEventListener('click', () => {
    btnCards.classList.add('active');
    btnTable.classList.remove('active');
    containerCards.classList.remove('hidden');
    containerTable.classList.add('hidden');
  });

  btnTable.addEventListener('click', () => {
    btnTable.classList.add('active');
    btnCards.classList.remove('active');
    containerCards.classList.add('hidden');
    containerTable.classList.remove('hidden');
  });

  // Stat Card click to filter
  document.querySelectorAll('.stat-card').forEach(card => {
    card.addEventListener('click', () => {
      const filter = card.getAttribute('data-filter');
      document.querySelectorAll('.stat-card').forEach(c => c.classList.remove('active-filter'));
      card.classList.add('active-filter');
      filterStatus.value = filter;
      state.filters.status = filter;
      loadKeys();
    });
  });
});
