// bluesky.js – Bluesky-Integration für SpotMe (global verfügbar)
'use strict';

const API_BASE = 'https://spotme-chat-obom.onrender.com/api';

// ── Hilfsfunktionen ──────────────────────────────────────────────────────────
function getCodeToken() {
  const code = localStorage.getItem('sm_code');
  const token = localStorage.getItem('sm_token');
  return { code, token };
}

async function fetchJSON(url, options = {}) {
  const res = await fetch(url, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...options.headers }
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

// ── Öffentliche API (global) ─────────────────────────────────────────────────
window.getBlueskyStatus = async function() {
  const { code, token } = getCodeToken();
  if (!code || !token) return { connected: false };
  try {
    return await fetchJSON(`${API_BASE}/bluesky/status/${code}?token=${token}`);
  } catch {
    return { connected: false, error: true };
  }
};

window.connectBluesky = async function(handle, appPassword) {
  const { code, token } = getCodeToken();
  if (!code || !token) throw new Error('Kein Profil gefunden');
  return await fetchJSON(`${API_BASE}/bluesky/connect`, {
    method: 'POST',
    body: JSON.stringify({ code, token, handle, appPassword })
  });
};

window.disconnectBluesky = async function() {
  const { code, token } = getCodeToken();
  if (!code || !token) throw new Error('Kein Profil gefunden');
  return await fetchJSON(`${API_BASE}/bluesky/disconnect`, {
    method: 'DELETE',
    body: JSON.stringify({ code, token })
  });
};

window.shareSpotOnBluesky = async function(spotId, customMessage = null) {
  const { code, token } = getCodeToken();
  if (!code || !token) throw new Error('Kein Profil gefunden');
  return await fetchJSON(`${API_BASE}/bluesky/share-spot`, {
    method: 'POST',
    body: JSON.stringify({ code, token, spotId, message: customMessage || undefined })
  });
};