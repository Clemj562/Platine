/*
 * Platine — moteur du widget
 * ─────────────────────────────────────────────────────────────────────────────
 * Pas besoin de modifier ce fichier : ton design se fait dans widget.html,
 * widget.css et widget.js. Ce script remplit ton HTML grâce à des attributs
 * (data-bind, data-action, data-seek) et expose l'état sur <html> et en
 * variables CSS. Tout est détaillé dans LISEZMOI-DESIGN.md.
 *
 * Quatre modes :
 * - « app »       : dans l'appli Windows / Mac Platine (fenêtre transparente) ;
 * - « web »       : appli web (iPhone, Android…), voir platine-web.js ;
 * - « extension » : dans la fenêtre flottante de Chrome/Edge ;
 * - « demo »      : fichier ouvert directement dans le navigateur (ou dans
 *                   apercu.html) → faux lecteur pour travailler le design.
 */
(() => {
  'use strict';

  const params = new URLSearchParams(location.search);
  const APP = window.platineApp || null;
  const MODE = APP ? (APP.web ? 'web' : 'app') : params.has('pip') && window.parent !== window ? 'extension' : 'demo';
  const SPOTIFY = 'https://open.spotify.com';
  const root = document.documentElement;
  const hasChrome = typeof chrome !== 'undefined' && !!(chrome.runtime && chrome.runtime.id);

  /* ------------------------------------------------------------------ */
  /* Événements publics                                                  */
  /* ------------------------------------------------------------------ */
  const listeners = Object.create(null);
  function emit(name, data) {
    (listeners[name] || []).slice().forEach((fn) => {
      try { fn(data); } catch (e) { console.error('[Platine]', e); }
    });
  }

  /* ------------------------------------------------------------------ */
  /* État                                                                */
  /* ------------------------------------------------------------------ */
  const state = {
    mode: MODE,
    track: null,      // { title, artist, album, cover }
    playing: false,
    position: 0,      // en secondes
    duration: 0,
    progress: 0,      // de 0 à 1
    liked: null,      // true, false ou null (inconnu)
    shuffle: false,
    repeat: 'off',    // 'off' | 'context' | 'track'
    device: '',
    api: false,       // connexion à l'API Spotify configurée ?
    accent: null,     // couleur tirée de la pochette
  };

  let media = null;          // dernière photo envoyée par l'onglet Spotify
  let pos = null;            // { duration, position, rate, at }
  let lastPosAt = 0;
  let apiState = null;
  let apiAt = 0;
  let likedUri = null;
  let override = null;       // retour visuel immédiat après un clic lecture/pause
  let lastTrackKey = null;
  let dragging = false;
  let dragRatio = 0;
  let lastTimes = '';
  let lastProgress = '';
  let messageTimer = 0;
  let newTrackTimer = 0;
  let apiTimer = 0;
  let pollBusy = false;

  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

  const ERRORS = {
    not_configured: 'Connecte l’API Spotify dans les réglages de Platine.',
    auth: 'Jeton refusé par Spotify : reconnecte-toi dans les réglages.',
    scope: 'Autorisation manquante : « Reconnecter » dans les réglages.',
    forbidden: 'Spotify refuse l’action (autorisation ou Premium).',
    rate_limited: 'Trop de requêtes, réessaie dans quelques secondes.',
    network: 'Impossible de joindre Spotify.',
    no_device: 'Aucun appareil Spotify actif.',
    extension: 'Extension mise à jour : recharge l’onglet Spotify.',
    http: 'Spotify a renvoyé une erreur.',
  };

  function fmt(sec) {
    if (!Number.isFinite(sec) || sec < 0) sec = 0;
    sec = Math.floor(sec);
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = String(sec % 60).padStart(2, '0');
    return h ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
  }

  function pickArtwork(list) {
    if (!list || !list.length) return '';
    let best = list[0];
    let bestSize = 0;
    for (const a of list) {
      const s = parseInt(String(a.sizes || '').split('x')[0], 10) || 0;
      if (s > bestSize) { best = a; bestSize = s; }
    }
    return best.src || '';
  }

  /* ------------------------------------------------------------------ */
  /* Position et lecture                                                 */
  /* ------------------------------------------------------------------ */
  function computePlaying() {
    if (override && Date.now() < override.until) return override.playing;
    override = null;
    const st = media && media.playbackState;
    if (st === 'playing') return true;
    if (st === 'paused') return false;
    if (apiState && apiState.active && Date.now() - apiAt < 15000) return !!apiState.isPlaying;
    return state.playing;
  }

  function currentPos() {
    if (pos && pos.duration > 0) {
      let p = pos.position;
      if (state.playing) p += ((Date.now() - pos.at) / 1000) * (pos.rate || 1);
      return { pos: clamp(p, 0, pos.duration), dur: pos.duration };
    }
    if (apiState && apiState.active && apiState.durationMs > 0 && state.track && apiState.name === state.track.title) {
      let p = apiState.progressMs / 1000;
      if (state.playing) p += (Date.now() - apiAt) / 1000;
      return { pos: clamp(p, 0, apiState.durationMs / 1000), dur: apiState.durationMs / 1000 };
    }
    return null;
  }

  function freeze() {
    const p = currentPos();
    if (pos && p) pos = { ...pos, position: p.pos, at: Date.now() };
    if (apiState && apiState.active) {
      const ms = apiState.progressMs + (Date.now() - apiAt);
      apiState = { ...apiState, progressMs: Math.min(ms, apiState.durationMs || ms), isPlaying: false };
      apiAt = Date.now();
    }
  }
  function resume() {
    if (pos) pos = { ...pos, at: Date.now() };
    if (apiState) { apiState = { ...apiState, isPlaying: true }; apiAt = Date.now(); }
  }

  /* ------------------------------------------------------------------ */
  /* Rendu dans ton HTML                                                 */
  /* ------------------------------------------------------------------ */
  function all(sel) { return document.querySelectorAll(sel); }

  function setText(name, value) {
    all(`[data-bind="${name}"]`).forEach((el) => {
      const v = value || el.getAttribute('data-empty-text') || '';
      if (el.textContent !== v) el.textContent = v;
    });
  }

  function setCover(src) {
    all('[data-bind="cover"]').forEach((el) => {
      if (el.tagName === 'IMG') {
        if (!src) {
          el.removeAttribute('src');
          el.removeAttribute('data-loaded');
          return;
        }
        if (el.getAttribute('src') === src) return;
        el.removeAttribute('data-loaded');
        el.onload = () => el.setAttribute('data-loaded', '');
        el.src = src;
      } else {
        el.style.backgroundImage = src ? `url("${src}")` : '';
      }
    });
    if (src) root.style.setProperty('--cover', `url("${src}")`);
    else root.style.removeProperty('--cover');
  }

  function renderRoot() {
    root.dataset.mode = MODE;
    root.dataset.state = !state.track ? 'empty' : state.playing ? 'playing' : 'paused';
    if (state.liked === null) delete root.dataset.liked;
    else root.dataset.liked = String(state.liked);
    root.dataset.shuffle = String(state.shuffle);
    root.dataset.repeat = state.repeat;
    root.dataset.api = state.api ? 'on' : 'off';
    all('[data-action="like"]').forEach((b) => b.setAttribute('aria-pressed', String(state.liked === true)));
    all('[data-action="shuffle"]').forEach((b) => b.setAttribute('aria-pressed', String(state.shuffle)));
    all('[data-action="playpause"]').forEach((b) => b.setAttribute('aria-label', state.playing ? 'Pause' : 'Lecture'));
    setText('device', state.device);
  }

  function renderTrack() {
    const t = state.track;
    setText('title', t && t.title);
    setText('artist', t && t.artist);
    setText('album', t && t.album);
    setCover(t && t.cover);
  }

  function frame() {
    const p = currentPos();
    const ratio = p ? (dragging ? dragRatio : (p.dur ? p.pos / p.dur : 0)) : 0;
    state.position = p ? (dragging ? dragRatio * p.dur : p.pos) : 0;
    state.duration = p ? p.dur : 0;
    state.progress = ratio;

    const pr = ratio.toFixed(4);
    if (pr !== lastProgress) {
      lastProgress = pr;
      root.style.setProperty('--progress', pr);
    }
    const times = p ? `${fmt(state.position)}|${fmt(p.dur)}|-${fmt(p.dur - state.position)}` : '||';
    if (times !== lastTimes) {
      lastTimes = times;
      const [a, b, c] = times.split('|');
      setText('time', a || '0:00');
      setText('duration', b || '0:00');
      setText('remaining', c || '-0:00');
    }
    emit('tick', { position: state.position, duration: state.duration, progress: state.progress });
    requestAnimationFrame(frame);
  }

  function tick() {
    const meta = media && media.meta;
    const track = meta ? { title: meta.title, artist: meta.artist, album: meta.album, cover: pickArtwork(meta.artwork) } : null;
    const key = track ? `${track.title}\u0001${track.artist}\u0001${track.cover}` : '';
    let changed = false;

    if (key !== lastTrackKey) {
      lastTrackKey = key;
      state.track = track;
      state.liked = null;
      likedUri = null;
      renderTrack();
      onAccent(track);
      if (track) {
        root.setAttribute('data-new-track', '');
        clearTimeout(newTrackTimer);
        newTrackTimer = setTimeout(() => root.removeAttribute('data-new-track'), 900);
      }
      emit('track', track ? { ...track } : null);
      scheduleApi(700);
      changed = true;
    }

    const now = computePlaying();
    if (now !== state.playing) {
      if (!now) freeze(); else resume();
      state.playing = now;
      changed = true;
    }
    if (changed) { renderRoot(); emit('change', publicState()); }

    if (MODE === 'demo') demo.step();
  }

  /* ------------------------------------------------------------------ */
  /* Couleur d'accent tirée de la pochette                               */
  /* ------------------------------------------------------------------ */
  const accentCache = new Map();
  async function averageColor(src) {
    if (accentCache.has(src)) return accentCache.get(src);
    let source;
    if (MODE === 'extension') {
      const blob = await (await fetch(src)).blob();
      source = await createImageBitmap(blob);
    } else if (APP) {
      const data = await APP.coverData(src);
      if (!data) return null;
      source = await new Promise((res, rej) => {
        const img = new Image();
        img.onload = () => res(img);
        img.onerror = rej;
        img.src = data;
      });
    } else {
      source = await new Promise((res, rej) => {
        const img = new Image();
        img.crossOrigin = 'anonymous';
        img.onload = () => res(img);
        img.onerror = rej;
        img.src = src;
      });
    }
    const N = 24;
    const c = document.createElement('canvas');
    c.width = c.height = N;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(source, 0, 0, N, N);
    const px = ctx.getImageData(0, 0, N, N).data;
    let r = 0, g = 0, b = 0, w = 0;
    for (let i = 0; i < px.length; i += 4) {
      const R = px[i], G = px[i + 1], B = px[i + 2];
      const max = Math.max(R, G, B), min = Math.min(R, G, B);
      const sat = max ? (max - min) / max : 0;
      const lum = (max + min) / 510;
      const k = 0.03 + sat * sat * Math.max(0, 1 - Math.abs(lum - 0.5) * 1.4);
      r += R * k; g += G * k; b += B * k; w += k;
    }
    const col = toAccent(r / w, g / w, b / w);
    accentCache.set(src, col);
    return col;
  }
  function toAccent(r, g, b) {
    r /= 255; g /= 255; b /= 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    const l = (max + min) / 2, d = max - min;
    let h = 0, s = 0;
    if (d) {
      s = d / (1 - Math.abs(2 * l - 1));
      if (max === r) h = ((g - b) / d) % 6;
      else if (max === g) h = (b - r) / d + 2;
      else h = (r - g) / d + 4;
      h *= 60; if (h < 0) h += 360;
    }
    if (s < 0.12) return 'hsl(0 0% 92%)';
    return `hsl(${Math.round(h)} ${Math.round(clamp(s, 0.45, 0.85) * 100)}% 66%)`;
  }
  async function onAccent(track) {
    let col = null;
    if (track && track.cover) {
      if (MODE === 'demo') col = demo.accentFor(track.cover);
      if (!col) { try { col = await averageColor(track.cover); } catch (_) { col = null; } }
    }
    if (state.track !== track) return;
    state.accent = col;
    if (col) root.style.setProperty('--accent', col);
    else root.style.removeProperty('--accent');
    emit('change', publicState());
  }

  /* ------------------------------------------------------------------ */
  /* Commandes                                                           */
  /* ------------------------------------------------------------------ */
  function sendCmd(action, extra = {}) {
    if (MODE === 'demo') { demo.cmd(action, extra); return; }
    if (APP) { fallback({ action, ...extra }); return; }
    window.parent.postMessage({ platine: 'cmd', action, ...extra }, SPOTIFY);
  }

  function play() { override = { playing: true, until: Date.now() + 1500 }; tick(); sendCmd('play'); }
  function pause() { override = { playing: false, until: Date.now() + 1500 }; tick(); sendCmd('pause'); }
  function toggle() { if (state.playing) pause(); else play(); }
  function next() { sendCmd('next'); }
  function prev() { sendCmd('prev'); }
  function seekTo(sec) {
    const p = currentPos();
    if (!p) return;
    sec = clamp(sec, 0, Math.max(0, p.dur - 0.5));
    if (pos) pos = { ...pos, position: sec, at: Date.now() };
    if (apiState && apiState.active) { apiState = { ...apiState, progressMs: sec * 1000 }; apiAt = Date.now(); }
    sendCmd('seek', { seekTime: sec });
  }
  function seekBy(delta) { const p = currentPos(); if (p) seekTo(p.pos + delta); }

  // Si Spotify n'a pas la commande sous la main, on passe par l'API.
  async function fallback(d) {
    if (!state.api) { message(APP ? ERRORS.not_configured : 'Commande indisponible : recharge l’onglet Spotify.'); return; }
    const map = { play: 'play', pause: 'pause', next: 'next', prev: 'previous', seek: 'seek' };
    const res = await sw('control', { action: map[d.action], positionMs: Math.round((Number(d.seekTime) || 0) * 1000) });
    if (!res.ok) showError(res);
    scheduleApi(400);
  }

  async function toggleLike() {
    if (!state.api) { message(ERRORS.not_configured); return; }
    if (MODE === 'demo') { demo.like(); return; }
    const uri = likedUri || (apiState && state.track && apiState.name === state.track.title ? apiState.uri : null);
    if (!uri) { message('Titre pas encore identifié, réessaie dans une seconde.'); scheduleApi(0); return; }
    const want = !(state.liked === true);
    setApi({ liked: want });
    const res = await sw('setLiked', { uri, liked: want });
    if (!res.ok) { setApi({ liked: !want }); showError(res); return; }
    message(want ? 'Ajouté aux Titres likés' : 'Retiré des Titres likés');
  }

  async function toggleShuffle() {
    if (!state.api) { message(ERRORS.not_configured); return; }
    if (MODE === 'demo') { demo.shuffle(); return; }
    if (!apiState || !apiState.active) { message(ERRORS.no_device); scheduleApi(0); return; }
    const want = !state.shuffle;
    setApi({ shuffle: want });
    const res = await sw('shuffle', { state: want });
    if (!res.ok) { setApi({ shuffle: !want }); showError(res); }
    scheduleApi(1200);
  }

  async function cycleRepeat() {
    if (!state.api) { message(ERRORS.not_configured); return; }
    if (MODE === 'demo') { demo.repeat(); return; }
    if (!apiState || !apiState.active) { message(ERRORS.no_device); scheduleApi(0); return; }
    const order = ['off', 'context', 'track'];
    const before = state.repeat;
    const want = order[(order.indexOf(before) + 1) % order.length];
    setApi({ repeat: want });
    const res = await sw('repeat', { state: want });
    if (!res.ok) { setApi({ repeat: before }); showError(res); }
    scheduleApi(1200);
  }

  function setApi(patch) {
    if ('liked' in patch) state.liked = patch.liked;
    if ('shuffle' in patch) { state.shuffle = patch.shuffle; if (apiState) apiState = { ...apiState, shuffle: patch.shuffle }; }
    if ('repeat' in patch) { state.repeat = patch.repeat; if (apiState) apiState = { ...apiState, repeat: patch.repeat }; }
    renderRoot();
    emit('change', publicState());
  }

  /* ------------------------------------------------------------------ */
  /* API Spotify (via le service worker de l'extension)                  */
  /* ------------------------------------------------------------------ */
  function sw(type, payload = {}) {
    if (APP) {
      return APP.call(type, payload).then((r) => r || { ok: false, error: 'http' }, () => ({ ok: false, error: 'http' }));
    }
    if (!hasChrome) return Promise.resolve({ ok: false, error: 'extension' });
    return chrome.runtime.sendMessage({ type, payload }).then(
      (r) => r || { ok: false, error: 'extension' },
      () => ({ ok: false, error: 'extension' })
    );
  }

  function scheduleApi(delay) {
    clearTimeout(apiTimer);
    if (APP) { APP.refresh(delay); return; }
    if (MODE !== 'extension' || !state.api) return;
    apiTimer = setTimeout(pollApi, delay);
  }

  function applyApi(res) {
    apiState = res;
    apiAt = Date.now();
    state.shuffle = !!(res.active && res.shuffle);
    state.repeat = (res.active && res.repeat) || 'off';
    state.device = (res.active && res.device) || '';
    // L'API peut avoir un léger retard sur l'onglet : on ne prend le cœur que si c'est le même titre.
    const same = res.active && state.track && res.name === state.track.title;
    if (same && res.liked !== null && res.liked !== undefined) { state.liked = !!res.liked; likedUri = res.uri; }
    renderRoot();
    emit('change', publicState());
    return same;
  }

  async function pollApi() {
    if (MODE !== 'extension' || !state.api) return;
    if (pollBusy) { scheduleApi(1000); return; }
    pollBusy = true;
    const res = await sw('state');
    pollBusy = false;
    if (!res.ok) {
      scheduleApi(res.error === 'rate_limited' ? 15000 : 8000);
      return;
    }
    const same = applyApi(res);
    scheduleApi(same ? 5000 : res.active ? 1500 : 6000);
  }

  function showError(res) { message(ERRORS[res && res.error] || ERRORS.http); }

  /* ------------------------------------------------------------------ */
  /* Messages courts (data-bind="message")                               */
  /* ------------------------------------------------------------------ */
  function message(text) {
    setText('message', text);
    root.setAttribute('data-message', '');
    clearTimeout(messageTimer);
    messageTimer = setTimeout(() => root.removeAttribute('data-message'), 3200);
    emit('message', text);
  }

  /* ------------------------------------------------------------------ */
  /* Clics, glisser sur la barre, clavier                                */
  /* ------------------------------------------------------------------ */
  const ACTIONS = {
    playpause: toggle, play, pause, next, prev,
    like: toggleLike, shuffle: toggleShuffle, repeat: cycleRepeat,
    back: () => seekBy(-10), forward: () => seekBy(10),
  };

  document.addEventListener('click', (e) => {
    const el = e.target.closest('[data-action]');
    if (!el) return;
    const fn = ACTIONS[el.getAttribute('data-action')];
    if (fn) { e.preventDefault(); fn(); }
  });

  document.addEventListener('pointerdown', (e) => {
    const bar = e.target.closest('[data-seek]');
    if (!bar || e.button !== 0 || !currentPos()) return;
    e.preventDefault();
    const update = (ev) => {
      const r = bar.getBoundingClientRect();
      dragRatio = clamp((ev.clientX - r.left) / (r.width || 1), 0, 1);
    };
    dragging = true;
    root.setAttribute('data-dragging', '');
    update(e);
    try { bar.setPointerCapture(e.pointerId); } catch (_) {}
    const move = (ev) => update(ev);
    const end = (ev) => {
      bar.removeEventListener('pointermove', move);
      bar.removeEventListener('pointerup', end);
      bar.removeEventListener('pointercancel', end);
      const p = currentPos();
      dragging = false;
      root.removeAttribute('data-dragging');
      if (ev.type === 'pointerup' && p) seekTo(dragRatio * p.dur);
    };
    bar.addEventListener('pointermove', move);
    bar.addEventListener('pointerup', end);
    bar.addEventListener('pointercancel', end);
  });

  document.addEventListener('keydown', (e) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const onControl = e.target.closest && e.target.closest('button, a, input, textarea, select, [data-action]');
    if (e.code === 'Space' && !onControl) { e.preventDefault(); toggle(); }
    else if (e.code === 'ArrowRight') { e.preventDefault(); if (e.shiftKey) next(); else seekBy(10); }
    else if (e.code === 'ArrowLeft') { e.preventDefault(); if (e.shiftKey) prev(); else seekBy(-10); }
    else if (e.key && e.key.toLowerCase() === 'l') { e.preventDefault(); toggleLike(); }
    else if (MODE === 'demo') demo.key(e);
  });

  /* ------------------------------------------------------------------ */
  /* Mode démo : faux lecteur pour travailler le design                  */
  /* ------------------------------------------------------------------ */
  const DEMO_TRACKS = [
    { title: 'Marée basse', artist: 'Les Cartographes', album: 'Côtes', cover: 'demo/pochette-1.jpg', accent: 'hsl(18 85% 66%)', duration: 212 },
    { title: 'Un titre volontairement très long pour vérifier que ton design tient le coup', artist: 'Collectif Interminable, Quelqu’un d’autre et leurs amis', album: 'Débordements', cover: 'demo/pochette-2.jpg', accent: 'hsl(204 85% 70%)', duration: 187 },
    { title: 'Néon', artist: 'Studio Carreaux', album: 'Néon', cover: 'demo/pochette-3.jpg', accent: 'hsl(82 75% 64%)', duration: 245 },
  ];

  const demo = (() => {
    let i = 0;
    let playing = true;
    let position = 37;
    let at = Date.now();
    let empty = params.has('vide');
    let shuffle = false;
    let repeat = 'off';
    const liked = new Set([2]);
    const accents = new Map();
    DEMO_TRACKS.forEach((t) => accents.set(new URL(t.cover, location.href).href, t.accent));

    const cur = () => (playing ? position + (Date.now() - at) / 1000 : position);

    function publish() {
      const t = DEMO_TRACKS[i];
      const cover = new URL(t.cover, location.href).href;
      media = empty ? { meta: null, playbackState: 'none', position: null } : {
        meta: { title: t.title, artist: t.artist, album: t.album, artwork: [{ src: cover, sizes: '640x640' }] },
        playbackState: playing ? 'playing' : 'paused',
        position: { duration: t.duration, position: Math.min(cur(), t.duration), rate: 1, at: Date.now() },
      };
      ingestPosition(media.position);
      tick();
      applyApi(empty ? { active: false } : {
        active: true, isPlaying: playing, progressMs: cur() * 1000, durationMs: t.duration * 1000,
        name: t.title, uri: `demo:${i}`, shuffle, repeat, device: 'Aperçu', liked: liked.has(i),
      });
    }
    function go(n) {
      i = (n + DEMO_TRACKS.length) % DEMO_TRACKS.length;
      position = 0;
      at = Date.now();
      publish();
    }
    return {
      start() {
        state.api = !params.has('sans-api');
        if (params.has('pause')) playing = false;
        publish();
      },
      step() {
        if (!playing || empty) return;
        if (cur() >= DEMO_TRACKS[i].duration) {
          if (repeat === 'track') { position = 0; at = Date.now(); publish(); } else go(i + 1);
        }
      },
      cmd(action, extra) {
        if (action === 'play' || action === 'pause') { position = cur(); at = Date.now(); playing = action === 'play'; }
        else if (action === 'next') { go(i + 1); return; }
        else if (action === 'prev') { if (cur() > 3) { position = 0; at = Date.now(); } else { go(i - 1); return; } }
        else if (action === 'seek') { position = extra.seekTime; at = Date.now(); }
        publish();
      },
      like() {
        if (liked.has(i)) liked.delete(i); else liked.add(i);
        publish();
        message(liked.has(i) ? 'Ajouté aux Titres likés' : 'Retiré des Titres likés');
      },
      shuffle() { shuffle = !shuffle; publish(); },
      repeat() { repeat = { off: 'context', context: 'track', track: 'off' }[repeat]; publish(); },
      accentFor(src) { return accents.get(src) || null; },
      key(e) {
        const k = e.key.toLowerCase();
        if (k === 'e') { empty = !empty; publish(); message(empty ? 'Démo : rien en lecture' : 'Démo : lecture'); }
        else if (k === 'a') { state.api = !state.api; renderRoot(); message(state.api ? 'Démo : API connectée' : 'Démo : API non connectée'); }
        else if (k === 'm') message('Exemple de message du widget');
      },
    };
  })();

  /* ------------------------------------------------------------------ */
  /* Mode extension : liaison avec l'onglet Spotify                      */
  /* ------------------------------------------------------------------ */
  function ingestPosition(p) {
    if (p) {
      if (p.at !== lastPosAt) { lastPosAt = p.at; pos = { ...p }; }
    } else {
      pos = null;
      lastPosAt = 0;
    }
  }

  function startExtension() {
    // Les messages partent du script de l'onglet Spotify (même origine que la fenêtre
    // flottante) : on vérifie l'origine, pas la fenêtre émettrice.
    window.addEventListener('message', (e) => {
      if (e.origin !== SPOTIFY || !e.data || typeof e.data.platine !== 'string') return;
      const d = e.data;
      if (d.platine === 'media') {
        media = d;
        ingestPosition(d.position);
        tick();
      } else if (d.platine === 'fallback') {
        fallback(d);
      }
    });

    if (hasChrome && chrome.storage) {
      const readApi = () => chrome.storage.local.get({ clientId: '', refreshToken: '' }).then((s) => {
        state.api = !!(s.clientId && s.refreshToken);
        renderRoot();
        scheduleApi(150);
      });
      readApi();
      chrome.storage.onChanged.addListener((c, area) => {
        if (area === 'local' && (c.clientId || c.refreshToken)) readApi();
      });
    }

    // Fond de la fenêtre flottante assorti à ton design (évite un flash à l'ouverture).
    const bodyBg = getComputedStyle(document.body).backgroundColor;
    const htmlBg = getComputedStyle(root).backgroundColor;
    const bg = bodyBg && bodyBg !== 'rgba(0, 0, 0, 0)' ? bodyBg : htmlBg;
    if (bg && bg !== 'rgba(0, 0, 0, 0)') window.parent.postMessage({ platine: 'bg', color: bg }, SPOTIFY);
    window.parent.postMessage({ platine: 'ready' }, SPOTIFY);
  }

  /* ------------------------------------------------------------------ */
  /* Mode appli Windows : l'état arrive de l'API Spotify via l'appli     */
  /* ------------------------------------------------------------------ */
  function startApp() {
    APP.onState((s) => {
      state.api = !!s.configured;
      const t = s.active && s.track ? s.track : null;
      media = t ? {
        meta: { title: t.title, artist: t.artist, album: t.album, artwork: t.cover ? [{ src: t.cover, sizes: '640x640' }] : [] },
        playbackState: s.isPlaying ? 'playing' : 'paused',
        position: s.durationMs ? { duration: s.durationMs / 1000, position: (s.progressMs || 0) / 1000, rate: 1, at: s.fetchedAt || Date.now() } : null,
      } : { meta: null, playbackState: 'none', position: null };
      ingestPosition(media.position);
      tick();
      applyApi({
        active: !!s.active, isPlaying: !!s.isPlaying, progressMs: s.progressMs || 0, durationMs: s.durationMs || 0,
        name: t ? t.title : '', uri: s.uri || null, shuffle: s.shuffle, repeat: s.repeat, device: s.device, liked: s.liked,
      });
      if (!s.ok && s.error && s.error !== lastAppError) message(ERRORS[s.error] || ERRORS.http);
      lastAppError = s.ok ? null : s.error;
    });

    // Boutons de fenêtre : data-app="hide" | "settings" | "quit"
    document.addEventListener('click', (e) => {
      const el = e.target.closest('[data-app]');
      if (el) { e.preventDefault(); APP.windowAction(el.getAttribute('data-app')); }
    });

    if (MODE === 'app') startFenetre();
    APP.ready();
  }

  function startFenetre() {
    // Les zones transparentes laissent passer les clics vers le bureau :
    // seuls les éléments marqués data-solide (et leur contenu) restent cliquables.
    let solid = false;
    let moving = false;
    const setSolid = (v) => { if (v !== solid) { solid = v; APP.setSolid(v); } };
    document.addEventListener('mousemove', (e) => { if (!moving) setSolid(!!(e.target.closest && e.target.closest('[data-solide]'))); });
    document.addEventListener('mouseleave', () => { if (!moving) setSolid(false); });

    // Déplacer (data-deplacer) et redimensionner (data-redimensionner) la fenêtre.
    const INTERACTIF = 'button, a, input, select, textarea, [data-action], [data-app], [data-seek]';
    document.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      const poignee = e.target.closest('[data-redimensionner]');
      const zone = !poignee && e.target.closest('[data-deplacer]');
      if (!poignee && (!zone || e.target.closest(INTERACTIF))) return;
      e.preventDefault();
      const kind = poignee ? 'resize' : 'move';
      const el = e.target;
      moving = true;
      solid = true;
      root.setAttribute(kind === 'move' ? 'data-deplacement' : 'data-redimensionnement', '');
      APP.dragStart(kind, e.screenX, e.screenY);
      try { el.setPointerCapture(e.pointerId); } catch (_) {}
      const move = (ev) => {
        if (!(ev.buttons & 1)) { end(); return; }
        APP.dragMove(ev.screenX, ev.screenY);
      };
      const end = () => {
        if (!moving) return;
        moving = false;
        el.removeEventListener('pointermove', move);
        el.removeEventListener('pointerup', end);
        el.removeEventListener('pointercancel', end);
        el.removeEventListener('lostpointercapture', end);
        root.removeAttribute('data-deplacement');
        root.removeAttribute('data-redimensionnement');
        APP.dragEnd();
      };
      el.addEventListener('pointermove', move);
      el.addEventListener('pointerup', end);
      el.addEventListener('pointercancel', end);
      el.addEventListener('lostpointercapture', end);
    });
  }
  let lastAppError = null;

  /* ------------------------------------------------------------------ */
  /* API publique pour widget.js                                         */
  /* ------------------------------------------------------------------ */
  function publicState() {
    return { ...state, track: state.track ? { ...state.track } : null };
  }

  window.Platine = {
    get state() { return publicState(); },
    on(name, fn) {
      (listeners[name] = listeners[name] || []).push(fn);
      if (name === 'ready' && isReady) fn(publicState());
      return () => { listeners[name] = (listeners[name] || []).filter((f) => f !== fn); };
    },
    play, pause, toggle, next, prev,
    seek: seekTo,
    seekBy,
    like: toggleLike,
    shuffle: toggleShuffle,
    repeat: cycleRepeat,
    message,
  };

  /* ------------------------------------------------------------------ */
  /* Démarrage                                                           */
  /* ------------------------------------------------------------------ */
  let isReady = false;
  function init() {
    if (isReady) return;
    isReady = true;
    renderTrack();
    renderRoot();
    if (APP) startApp();
    else if (MODE === 'extension') startExtension();
    else demo.start();
    setInterval(tick, 200);
    requestAnimationFrame(frame);
    emit('ready', publicState());
  }
  // On attend que widget.js ait pu s'abonner (scripts « defer » exécutés avant DOMContentLoaded).
  if (document.readyState === 'complete') init();
  else document.addEventListener('DOMContentLoaded', init, { once: true });
})();
