/*
 * Platine — version web (iPhone, Android, ordinateur)
 * ─────────────────────────────────────────────────────────────────────────────
 * Connexion Spotify directement dans le navigateur (PKCE : pas de client secret),
 * lecture de l'état toutes les 2 s, commandes, Titres likés, et génération du
 * widget iPhone pour l'app Scriptable. Branche le tout sur platine-api.js.
 */
(() => {
  'use strict';

  const CFG = window.PLATINE_CONFIG || {};
  const ACCOUNTS = 'https://accounts.spotify.com';
  const API = 'https://api.spotify.com/v1';
  const SCOPES = [
    'user-read-playback-state', 'user-modify-playback-state', 'user-read-currently-playing',
    'user-library-read', 'user-library-modify',
  ];
  // Adresse de retour = le dossier de l'appli, ex. https://pseudo.github.io/platine/
  const REDIRECT = location.origin + location.pathname.replace(/[^/]*$/, '');
  const K = {
    client: 'platine.clientId', refresh: 'platine.refreshToken', access: 'platine.accessToken',
    exp: 'platine.expiresAt', pending: 'platine.pending', wake: 'platine.ecranAllume', mode: 'platine.libraryMode',
  };
  const store = {
    get: (k) => { try { return localStorage.getItem(k); } catch (_) { return null; } },
    set: (k, v) => { try { if (v == null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch (_) {} },
  };

  class ApiError extends Error {
    constructor(code, detail, status) { super(detail || code); this.code = code; this.status = status || 0; }
  }

  const clientId = () => String(CFG.clientId || store.get(K.client) || '').trim();
  const connected = () => !!store.get(K.refresh);

  /* ------------------------------------------------------------------ */
  /* Connexion Spotify (PKCE)                                            */
  /* ------------------------------------------------------------------ */
  const b64url = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const random = (n) => b64url(crypto.getRandomValues(new Uint8Array(n)));

  async function login(purpose) {
    const id = clientId();
    if (!id) { ui.message('Renseigne d’abord le Client ID de ton app Spotify.', true); return; }
    const verifier = random(48);
    const state = random(16);
    const challenge = b64url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
    store.set(K.pending, JSON.stringify({ verifier, state, purpose: purpose || 'app' }));
    const p = new URLSearchParams({
      response_type: 'code', client_id: id, scope: SCOPES.join(' '), redirect_uri: REDIRECT,
      state, code_challenge_method: 'S256', code_challenge: challenge,
    });
    location.href = `${ACCOUNTS}/authorize?${p}`;
  }

  async function postToken(params) {
    let r;
    try {
      r = await fetch(`${ACCOUNTS}/api/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ ...params, client_id: clientId() }),
      });
    } catch (_) {
      throw new ApiError('network');
    }
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.access_token) throw new ApiError('auth', j.error_description || j.error || `HTTP ${r.status}`, r.status);
    return j;
  }

  function storeTokens(j) {
    store.set(K.access, j.access_token);
    store.set(K.exp, String(Date.now() + Math.max(60, (j.expires_in || 3600) - 120) * 1000));
    if (j.refresh_token) store.set(K.refresh, j.refresh_token);
  }

  // Retour depuis la page de connexion Spotify (?code=… ou ?error=…)
  async function handleCallback() {
    const q = new URLSearchParams(location.search);
    if (!q.has('code') && !q.has('error')) return null;
    history.replaceState(null, '', REDIRECT);
    let pending = null;
    try { pending = JSON.parse(store.get(K.pending) || 'null'); } catch (_) { pending = null; }
    store.set(K.pending, null);
    if (q.get('error')) return { error: q.get('error') };
    if (!pending || pending.state !== q.get('state')) return { error: 'state' };
    try {
      const j = await postToken({ grant_type: 'authorization_code', code: q.get('code'), redirect_uri: REDIRECT, code_verifier: pending.verifier });
      if (pending.purpose === 'widget') return { widgetToken: j.refresh_token };
      storeTokens(j);
      return { ok: true };
    } catch (e) {
      return { error: e.message };
    }
  }

  let refreshing = null;
  async function accessToken(force) {
    const at = store.get(K.access);
    if (!force && at && (+store.get(K.exp) || 0) > Date.now()) return at;
    if (!refreshing) refreshing = doRefresh().finally(() => { refreshing = null; });
    return refreshing;
  }
  async function doRefresh() {
    const rt = store.get(K.refresh);
    if (!rt || !clientId()) throw new ApiError('not_configured');
    try {
      const j = await postToken({ grant_type: 'refresh_token', refresh_token: rt });
      storeTokens(j);
      return j.access_token;
    } catch (e) {
      if (e.code === 'auth' && /invalid_grant|revoked|invalid refresh/i.test(e.message)) logout();
      throw e;
    }
  }

  function logout() {
    [K.refresh, K.access, K.exp, K.mode].forEach((k) => store.set(k, null));
  }

  /* ------------------------------------------------------------------ */
  /* API Spotify                                                         */
  /* ------------------------------------------------------------------ */
  let backoffUntil = 0;
  async function api(method, path, query, retry = true) {
    if (Date.now() < backoffUntil) throw new ApiError('rate_limited');
    const token = await accessToken();
    const url = new URL(API + path);
    if (query) Object.entries(query).forEach(([k, v]) => { if (v !== undefined && v !== null) url.searchParams.set(k, String(v)); });
    let r;
    try {
      r = await fetch(url, { method, headers: { Authorization: `Bearer ${token}` } });
    } catch (_) {
      throw new ApiError('network');
    }
    if (r.status === 401 && retry) { await accessToken(true); return api(method, path, query, false); }
    if (r.status === 429) {
      const wait = parseInt(r.headers.get('Retry-After') || '5', 10) || 5;
      backoffUntil = Date.now() + Math.min(wait, 300) * 1000;
      throw new ApiError('rate_limited');
    }
    const text = await r.text();
    let data = null;
    if (text) { try { data = JSON.parse(text); } catch (_) { data = null; } }
    if (!r.ok) {
      const msg = String((data && data.error && (data.error.message || data.error)) || `HTTP ${r.status}`);
      if (r.status === 403) throw new ApiError(/scope/i.test(msg) ? 'scope' : 'forbidden', msg, 403);
      if (r.status === 404 && /device/i.test(msg)) throw new ApiError('no_device', msg, 404);
      throw new ApiError('http', msg, r.status);
    }
    return data;
  }

  // Titres likés : /me/library (depuis février 2026), sinon /me/tracks
  const savedCache = new Map();
  const idOf = (uri) => String(uri).split(':').pop();
  const canFallback = (e) => (e.code === 'http' && [400, 404, 405, 410].includes(e.status)) || e.code === 'forbidden';
  async function isSaved(uri) {
    const c = savedCache.get(uri);
    if (c && Date.now() - c.at < 120000) return c.v;
    let v;
    if (store.get(K.mode) !== 'legacy') {
      try {
        const arr = await api('GET', '/me/library/contains', { uris: uri });
        v = !!(Array.isArray(arr) && arr[0]);
        store.set(K.mode, 'library');
      } catch (e) {
        if (store.get(K.mode) === 'library' || !canFallback(e)) throw e;
        store.set(K.mode, 'legacy');
      }
    }
    if (v === undefined) {
      const arr = await api('GET', '/me/tracks/contains', { ids: idOf(uri) });
      v = !!(Array.isArray(arr) && arr[0]);
    }
    savedCache.set(uri, { v, at: Date.now() });
    return v;
  }
  async function setSaved(uri, v) {
    if (!/^spotify:(track|episode):[A-Za-z0-9]+$/.test(String(uri))) throw new ApiError('http', 'URI invalide');
    const method = v ? 'PUT' : 'DELETE';
    let done = false;
    if (store.get(K.mode) !== 'legacy') {
      try { await api(method, '/me/library', { uris: uri }); store.set(K.mode, 'library'); done = true; } catch (e) {
        if (store.get(K.mode) === 'library' || !canFallback(e)) throw e;
        store.set(K.mode, 'legacy');
      }
    }
    if (!done) await api(method, '/me/tracks', { ids: idOf(uri) });
    savedCache.set(uri, { v, at: Date.now() });
  }

  const biggest = (images) => (Array.isArray(images) && images.length
    ? images.slice().sort((a, b) => (b.width || 0) - (a.width || 0))[0].url || '' : '');

  async function getState() {
    const p = await api('GET', '/me/player', { additional_types: 'episode' });
    if (!p || !p.device) return { ok: true, active: false };
    const item = p.item || null;
    let track = null;
    if (item) {
      const ep = item.type === 'episode';
      track = ep ? {
        title: item.name || '',
        artist: (item.show && (item.show.publisher || item.show.name)) || '',
        album: (item.show && item.show.name) || '',
        cover: biggest(item.images) || biggest(item.show && item.show.images),
      } : {
        title: item.name || '',
        artist: (item.artists || []).map((a) => a.name).filter(Boolean).join(', '),
        album: (item.album && item.album.name) || '',
        cover: biggest(item.album && item.album.images),
      };
    }
    let liked = null;
    if (item && item.uri && !item.is_local) { try { liked = await isSaved(item.uri); } catch (_) { liked = null; } }
    return {
      ok: true, active: true, isPlaying: !!p.is_playing, progressMs: p.progress_ms || 0,
      durationMs: (item && item.duration_ms) || 0, uri: (item && item.uri) || null, track,
      shuffle: !!p.shuffle_state, repeat: p.repeat_state || 'off', device: (p.device && p.device.name) || '', liked,
    };
  }

  async function control({ action, positionMs }) {
    const map = {
      play: ['PUT', '/me/player/play'], pause: ['PUT', '/me/player/pause'],
      next: ['POST', '/me/player/next'], previous: ['POST', '/me/player/previous'],
    };
    if (action === 'seek') return api('PUT', '/me/player/seek', { position_ms: Math.max(0, Math.round(positionMs || 0)) });
    if (!map[action]) throw new ApiError('http', 'Action inconnue');
    return api(map[action][0], map[action][1]);
  }

  /* ------------------------------------------------------------------ */
  /* Lecture régulière de l'état                                         */
  /* ------------------------------------------------------------------ */
  const listeners = [];
  let last = { ok: true, active: false };
  let timer = 0;
  let busy = false;

  function push() {
    const s = { ...last, configured: connected(), fetchedAt: last.fetchedAt || Date.now() };
    listeners.forEach((cb) => { try { cb(s); } catch (e) { console.error(e); } });
  }
  function schedule(ms) {
    clearTimeout(timer);
    timer = setTimeout(poll, Math.max(0, ms));
  }
  async function poll() {
    if (document.hidden) return;              // reprend quand l'appli revient au premier plan
    if (!connected()) { last = { ok: true, active: false }; push(); ui.show(); return; }
    if (busy) { schedule(500); return; }
    busy = true;
    let next = 2000;
    try {
      last = { ...(await getState()), fetchedAt: Date.now() };
    } catch (e) {
      last = { ok: false, active: false, error: e.code, fetchedAt: Date.now() };
      next = e.code === 'rate_limited' ? 20000 : 6000;
      if (!connected()) ui.show('Ta session Spotify a expiré : reconnecte-toi.');
    }
    busy = false;
    push();
    ecranAllume();
    schedule(next);
  }
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) schedule(0);
    ecranAllume();
  });

  // Option : garder l'écran allumé pendant la lecture (pratique en « platine » posée sur le bureau)
  let verrou = null;
  async function ecranAllume() {
    const veut = store.get(K.wake) === '1' && last.active && last.isPlaying && !document.hidden;
    if (veut && !verrou && navigator.wakeLock) {
      try {
        verrou = await navigator.wakeLock.request('screen');
        verrou.addEventListener('release', () => { verrou = null; });
      } catch (_) { verrou = null; }
    } else if (!veut && verrou) {
      verrou.release().catch(() => {});
      verrou = null;
    }
  }

  /* ------------------------------------------------------------------ */
  /* Pont avec platine-api.js                                            */
  /* ------------------------------------------------------------------ */
  window.platineApp = {
    web: true,
    onState: (cb) => { listeners.push(cb); },
    async call(type, payload = {}) {
      try {
        if (type === 'control') await control(payload);
        else if (type === 'setLiked') await setSaved(payload.uri, !!payload.liked);
        else if (type === 'shuffle') await api('PUT', '/me/player/shuffle', { state: !!payload.state });
        else if (type === 'repeat') await api('PUT', '/me/player/repeat', { state: payload.state });
        else return { ok: false, error: 'http' };
        schedule(350);
        return { ok: true };
      } catch (e) {
        schedule(1000);
        return { ok: false, error: e.code || 'http', detail: e.message };
      }
    },
    async coverData(src) {
      try {
        const blob = await (await fetch(src)).blob();
        return await new Promise((res) => { const fr = new FileReader(); fr.onload = () => res(fr.result); fr.onerror = () => res(null); fr.readAsDataURL(blob); });
      } catch (_) { return null; }
    },
    refresh: (delay) => schedule(Number(delay) || 0),
    setSolid() {}, dragStart() {}, dragMove() {}, dragEnd() {},
    windowAction: (action) => { if (action === 'settings') ui.show(); },
    ready: () => push(),
  };

  /* ------------------------------------------------------------------ */
  /* Écran de connexion / réglages                                       */
  /* ------------------------------------------------------------------ */
  const ui = {
    el: null,
    $: (id) => document.getElementById(id),
    init() {
      this.el = this.$('connexion');
      if (!this.el) return;
      this.$('cx-redirect').textContent = REDIRECT;
      if (CFG.clientId) this.$('cx-client-zone').hidden = true;
      this.$('cx-client').value = store.get(K.client) || '';
      this.$('cx-client').addEventListener('change', (e) => store.set(K.client, e.target.value.trim() || null));
      this.$('cx-login').addEventListener('click', () => { store.set(K.client, this.$('cx-client').value.trim() || store.get(K.client)); login('app'); });
      this.$('cx-widget').addEventListener('click', () => login('widget'));
      this.$('cx-logout').addEventListener('click', () => { logout(); this.refresh(); this.message('Déconnectée de Spotify sur cet appareil.'); push(); });
      this.$('cx-close').addEventListener('click', () => this.hide());
      this.$('cx-wake').checked = store.get(K.wake) === '1';
      this.$('cx-wake').addEventListener('change', (e) => { store.set(K.wake, e.target.checked ? '1' : null); ecranAllume(); });
      this.$('cx-copy').addEventListener('click', () => copier(REDIRECT, this.$('cx-copy')));
      this.$('cx-script-copy').addEventListener('click', () => copier(this.$('cx-script').value, this.$('cx-script-copy')));
      if (!navigator.wakeLock) this.$('cx-wake-zone').hidden = true;
      this.refresh();
    },
    refresh() {
      if (!this.el) return;
      const ok = connected();
      this.$('cx-login').hidden = ok;
      this.$('cx-connecte').hidden = !ok;
      if (!CFG.clientId) this.$('cx-client-zone').hidden = ok;
    },
    show(msg) {
      if (!this.el) return;
      this.refresh();
      if (msg) this.message(msg, true);
      this.el.hidden = false;
    },
    hide() { if (this.el && connected()) this.el.hidden = true; },
    message(text, erreur) {
      const m = this.$('cx-message');
      if (!m) return;
      m.textContent = text || '';
      m.classList.toggle('erreur', !!erreur);
    },
  };

  async function copier(text, btn) {
    try { await navigator.clipboard.writeText(text); } catch (_) {
      const t = document.createElement('textarea');
      t.value = text; document.body.appendChild(t); t.select();
      try { document.execCommand('copy'); } catch (__) {}
      t.remove();
    }
    const label = btn.textContent;
    btn.textContent = 'Copié ✓';
    setTimeout(() => { btn.textContent = label; }, 1500);
  }

  const ERREURS = {
    access_denied: 'Connexion annulée.',
    state: 'La connexion a été interrompue : relance « Se connecter avec Spotify » depuis cet écran.',
    server_error: 'Spotify a refusé la connexion (erreur de son côté). Vérifie que ton compte est bien ajouté dans « User Management » de l’app, puis réessaie.',
  };

  async function scriptWidget(token) {
    const modele = await (await fetch('scriptable-widget.js', { cache: 'no-store' })).text();
    return modele
      .replace('__CLIENT_ID__', clientId())
      .replace('__REFRESH_TOKEN__', token)
      .replace('__ADRESSE_APPLI__', REDIRECT);
  }

  async function demarrer() {
    ui.init();
    const retour = await handleCallback();
    if (retour && retour.error) {
      const e = String(retour.error);
      const cle = Object.keys(ERREURS).find((k) => e.includes(k));
      ui.show(cle ? ERREURS[cle] : `Spotify a refusé la connexion (${e}). Vérifie que l’adresse de l’appli est bien dans « Redirect URIs ».`);
    } else if (retour && retour.widgetToken) {
      ui.show();
      ui.$('cx-script').value = await scriptWidget(retour.widgetToken);
      ui.$('cx-script-zone').hidden = false;
      ui.message('Ton widget est prêt : copie le script ci-dessous dans Scriptable.');
    } else if (!connected()) {
      ui.show();
    }
    schedule(0);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', demarrer, { once: true });
  else demarrer();
})();
