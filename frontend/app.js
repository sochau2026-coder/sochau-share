'use strict';

import { Whiteboard } from './whiteboard.js';

/* ════════════════════════════════════════
   CONFIG
════════════════════════════════════════ */
const Config = Object.freeze({
  SIGNALING_URL: (() => {
    if (window.location.port === '5173') return 'http://localhost:3000';
    return window.location.origin;
  })(),
  CHUNK_SIZE: 64 * 1024,
  BUFFER_THRESHOLD: 8 * 1024 * 1024,
  ICE: [
    // STUN — free, fast; works when both peers have open/simple NAT
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun.cloudflare.com:3478' },
    // TURN relay — required when peers are behind symmetric NAT (most home/mobile ISPs)
    // Uses OpenRelay (metered.ca) public TURN — no server setup needed
    { urls: 'turn:openrelay.metered.ca:80', username: 'openrelayproject', credential: 'openrelayproject' },
    { urls: 'turn:openrelay.metered.ca:443', username: 'openrelayproject', credential: 'openrelayproject' },
    { urls: 'turn:openrelay.metered.ca:443?transport=tcp', username: 'openrelayproject', credential: 'openrelayproject' },
  ],
});


/* ════════════════════════════════════════
   STATE
════════════════════════════════════════ */
const State = {
  roomId: null,
  capacity: 2,
  myId: null,
  socket: null,
  isCreator: false,
  peers: new Map(),   // Map<peerId, { pc, dc }>
  outQueue: [],
  inbound: new Map(),
  activeSends: new Map(),

  get openPeerIds() {
    return [...State.peers.entries()]
      .filter(([, p]) => p.dc?.readyState === 'open')
      .map(([id]) => id);
  },
};

/* ════════════════════════════════════════
   WHITEBOARD BROADCAST
   Central function so it's always fresh
════════════════════════════════════════ */
function wbBroadcast(data) {
  // Iterate ALL peers directly - openPeerIds getter may race
  let sent = 0;
  State.peers.forEach((entry, pid) => {
    const dc = entry.dc;
    if (dc && dc.readyState === 'open') { try { dc.send(data); sent++; } catch (e) { console.warn('[wb send err]', pid, e); } }
  });
}

/* ════════════════════════════════════════
   ROUTER
════════════════════════════════════════ */
const Router = {
  init() {
    const parts = window.location.pathname.split('/').filter(Boolean);
    const roomId = parts[0]?.toLowerCase();
    if (roomId && /^[a-z0-9\-]{6,64}$/.test(roomId)) {
      Router.goToDashboard(roomId, false, 2);
    }
    window.addEventListener('popstate', () => {
      if (!window.location.pathname.split('/').filter(Boolean)[0]) Router.showLanding();
    });
  },

  showLanding() {
    State.socket?.disconnect();
    State.peers.forEach(({ pc }) => pc?.close());
    State.peers.clear();
    document.getElementById('page-landing').classList.add('active');
    document.getElementById('page-dashboard').classList.remove('active');
  },

  goToDashboard(roomId, isCreator, capacity) {
    State.roomId = roomId;
    State.isCreator = isCreator;
    State.capacity = capacity;
    document.getElementById('page-landing').classList.remove('active');
    document.getElementById('page-dashboard').classList.add('active');
    const url = '/' + roomId;
    if (window.location.pathname !== url) history.pushState({ roomId }, '', url);
    DashUI.setRoom(roomId);
    DashUI.setConn('connecting', 'Connecting…');
    App.startRoom(roomId, isCreator, capacity);
  },
};

/* ════════════════════════════════════════
   TAB MANAGER
════════════════════════════════════════ */
const Tabs = {
  init() {
    document.querySelectorAll('.dash-tab').forEach(btn => {
      btn.addEventListener('click', () => Tabs.go(btn.dataset.tab));
    });
  },
  go(id) {
    document.querySelectorAll('.dash-tab').forEach(b => {
      b.classList.toggle('active', b.dataset.tab === id);
      b.setAttribute('aria-selected', b.dataset.tab === id);
    });
    document.querySelectorAll('.dash-panel').forEach(p => {
      p.classList.toggle('active', p.id === `panel-${id}`);
    });
    if (id === 'whiteboard') Whiteboard.resize();
  },
};

/* ════════════════════════════════════════
   DASHBOARD UI
════════════════════════════════════════ */
const DashUI = {
  setRoom(id) { document.getElementById('dash-room-id').textContent = id; },

  setConn(state, text) {
    const el = document.getElementById('dash-conn');
    el.dataset.state = state;
    document.getElementById('dash-conn-text').textContent = text;
  },

  showError(msg) {
    document.getElementById('dash-error-text').textContent = msg;
    document.getElementById('dash-error').hidden = false;
  },
  hideError() { document.getElementById('dash-error').hidden = true; },

  updatePeers() {
    const el = document.getElementById('peer-list');
    const open = State.openPeerIds.length;
    el.innerHTML = '';
    for (let i = 0; i < State.capacity; i++) {
      const isSelf = i === 0;
      const isConn = !isSelf && open >= i;
      const s = document.createElement('div');
      s.className = `peer-slot${isSelf ? ' peer-slot--self' : ''}${isConn ? ' peer-slot--connected' : ''}`;
      s.innerHTML = `<div class="peer-slot__avatar">${isSelf ? 'You' : i}</div><span class="peer-slot__dot"></span>`;
      el.appendChild(s);
    }
  },
};

/* ════════════════════════════════════════
   FILES UI
════════════════════════════════════════ */
const FilesUI = {
  setSendEnabled(on) { document.getElementById('send-btn').disabled = !on; },
  setSendLabel(t) { document.getElementById('send-label').textContent = t; },

  updateCount(n) {
    document.getElementById('queue-count').textContent = n + (n === 1 ? ' file' : ' files');
    document.getElementById('empty-state').style.display = n ? 'none' : '';
    document.getElementById('clear-btn').hidden = n === 0;
  },

  addCard({ id, name, size, dir, peerId }) {
    const li = document.createElement('li');
    li.className = 'file-item';
    li.dataset.fileId = id;
    li.dataset.state = 'queued';
    const lbl = dir === 'out' ? 'Queued' : `Incoming${peerId ? ' · ' + peerId.slice(0, 4) : ''}`;
    li.innerHTML = `
      <div class="file-item__icon">${FU.icon(name)}</div>
      <div class="file-item__meta">
        <span class="file-item__name" title="${FU.esc(name)}">${FU.esc(name)}</span>
        <span class="file-item__size">${FU.size(size)}</span>
      </div>
      <div class="file-item__ctrl">
        <span data-role="speed" class="file-item__speed"></span>
        <span data-role="pct"   class="file-item__pct">${lbl}</span>
        ${dir === 'out' ? '<button data-role="cancel" class="file-item__cancel" title="Cancel">✕</button>' : ''}
      </div>
      <div class="file-item__bar-wrap"><div data-role="bar" class="file-item__bar"></div></div>`;
    document.getElementById('file-list').prepend(li);
  },

  updateCard(id, { state, pct, speed }) {
    const li = document.querySelector(`[data-file-id="${id}"]`);
    if (!li) return;
    if (state) li.dataset.state = state;
    const bar = li.querySelector('[data-role="bar"]');
    const pEl = li.querySelector('[data-role="pct"]');
    const sEl = li.querySelector('[data-role="speed"]');
    if (state === 'done') {
      if (pEl) pEl.outerHTML = `<span class="file-item__check"><svg width="13" height="13" viewBox="0 0 13 13" fill="none"><path d="M2 6.5l3 3 6-6" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg></span>`;
      if (sEl) sEl.textContent = '';
      li.querySelector('[data-role="cancel"]')?.remove();
    } else if (state === 'error' || state === 'cancelled') {
      if (pEl) pEl.textContent = state === 'error' ? 'Error' : 'Cancelled';
      if (sEl) sEl.textContent = '';
    } else {
      if (pct != null && bar) bar.style.width = pct + '%';
      if (pct != null && pEl) pEl.textContent = Math.round(pct) + '%';
      if (speed != null && sEl) sEl.textContent = FU.speed(speed);
    }
  },

  clear() {
    document.getElementById('file-list').innerHTML = '';
    this.updateCount(0);
  },
};

/* ════════════════════════════════════════
   FILE UTILITIES
════════════════════════════════════════ */
const FU = {
  size(b) {
    if (!b) return '0 B';
    const u = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(b) / Math.log(1024));
    return `${(b / 1024 ** i).toFixed(i ? 1 : 0)} ${u[i]}`;
  },
  speed(b) { return FU.size(b) + '/s'; },
  id() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 7); },
  esc(s) { return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); },
  icon(name) {
    const ext = (name.split('.').pop() || '').toLowerCase();
    if (['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg', 'avif'].includes(ext))
      return `<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><rect x="1" y="2" width="14" height="12" rx="2" stroke="currentColor" stroke-width="1.2"/><circle cx="5.5" cy="6" r="1" fill="currentColor"/><path d="M1 11l3.5-3.5L8 11l3-2.5L15 11" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
    return `<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><rect x="2" y="1" width="9" height="12" rx="1.5" stroke="currentColor" stroke-width="1.2"/><path d="M7.5 1l4 3.5H7.5V1Z" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/><path d="M4 8h5M4 10.5h5M4 5.5h2" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg>`;
  },
};

/* ════════════════════════════════════════
   SIGNALING
════════════════════════════════════════ */
const Signaling = {
  connect(roomId, capacity) {
    State.socket = io(Config.SIGNALING_URL, { transports: ['websocket'], reconnectionAttempts: 5 });
    const s = State.socket;

    s.on('connect', () => s.emit('join-room', { roomId, capacity }));

    s.on('joined', ({ socketId, capacity: cap, existingPeers }) => {
      State.myId = socketId;
      State.capacity = cap;
      DashUI.updatePeers();

      if (existingPeers.length === 0) {
        DashUI.setConn('waiting', 'Waiting for peers…');
      } else {
        DashUI.setConn('connecting', 'Connecting…');
        existingPeers.forEach(pid => Mesh.initPeer(pid, false));
        setTimeout(() => Whiteboard.requestSync(), 1200);
      }
    });

    s.on('peer-joined', ({ socketId }) => Mesh.initPeer(socketId, true));
    s.on('offer', ({ senderId, sdp }) => Mesh.handleOffer(senderId, sdp));
    s.on('answer', ({ senderId, sdp }) => Mesh.handleAnswer(senderId, sdp));
    s.on('ice-candidate', ({ senderId, candidate }) => Mesh.handleIce(senderId, candidate));
    s.on('peer-left', ({ socketId }) => Mesh.peerLeft(socketId));
    s.on('error', ({ message }) => { DashUI.showError(message); DashUI.setConn('error', 'Error'); });
    s.on('disconnect', () => DashUI.setConn('error', 'Disconnected'));
    s.on('connect_error', () => { DashUI.setConn('error', 'No server'); DashUI.showError('Cannot connect to signaling server.'); });
  },

  offer(t, sdp) { State.socket?.emit('offer', { targetId: t, sdp }); },
  answer(t, sdp) { State.socket?.emit('answer', { targetId: t, sdp }); },
  ice(t, c) { State.socket?.emit('ice-candidate', { targetId: t, candidate: c }); },
};

/* ════════════════════════════════════════
   MESH
════════════════════════════════════════ */
const Mesh = {
  initPeer(peerId, initiator) {
    if (State.peers.has(peerId)) State.peers.get(peerId).pc?.close();
    const pc = new RTCPeerConnection({ iceServers: Config.ICE });
    const entry = { pc, dc: null };
    State.peers.set(peerId, entry);

    pc.onicecandidate = ({ candidate }) => { if (candidate) Signaling.ice(peerId, candidate); };
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'connected') Mesh._peerUp(peerId);
      if (pc.connectionState === 'failed' ||
        pc.connectionState === 'disconnected') Mesh.peerLeft(peerId);
    };
    pc.ondatachannel = ({ channel }) => {
      entry.dc = channel;
      Mesh._setupDC(peerId, channel);
    };

    if (initiator) {
      const dc = pc.createDataChannel('sochau', { ordered: true });
      entry.dc = dc;
      Mesh._setupDC(peerId, dc);
      pc.createOffer()
        .then(o => pc.setLocalDescription(o))
        .then(() => Signaling.offer(peerId, pc.localDescription))
        .catch(e => console.error('[offer]', e));
    }
  },

  _setupDC(peerId, dc) {
    dc.binaryType = 'arraybuffer';
    dc.bufferedAmountLowThreshold = Config.BUFFER_THRESHOLD / 2;
    dc.onopen = () => Mesh._dcOpen(peerId);
    dc.onclose = () => Mesh.peerLeft(peerId);
    dc.onerror = e => console.error('[dc error]', e);
    dc.onmessage = ({ data }) => Receiver.handle(peerId, data);
    dc.onbufferedamountlow = () => Sender.drained(peerId);
  },

  _dcOpen(peerId) {
    // ── KEY FIX: assign broadcastFn as plain property ──────
    Whiteboard.broadcastFn = wbBroadcast;
    // Pass a direct send fn so sync-state can be answered only to the requester
    const entry = State.peers.get(peerId);
    const directSend = (data) => {
      const dc = entry?.dc;
      if (dc?.readyState === 'open') dc.send(data);
    };
    Whiteboard.addPeer(peerId, directSend);
    Mesh._peerUp(peerId);
  },

  _peerUp(peerId) {
    const n = State.openPeerIds.length;
    const needed = State.capacity - 1;
    DashUI.updatePeers();
    DashUI.setConn(
      n >= needed ? 'connected' : 'connecting',
      n >= needed ? `${State.capacity} peers connected` : `${n} / ${needed} peers`
    );
    FilesUI.setSendEnabled(State.outQueue.length > 0 && n > 0);
  },

  async handleOffer(senderId, sdp) {
    if (!State.peers.has(senderId)) Mesh.initPeer(senderId, false);
    const { pc } = State.peers.get(senderId);
    await pc.setRemoteDescription(new RTCSessionDescription(sdp));
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    Signaling.answer(senderId, pc.localDescription);
  },

  async handleAnswer(senderId, sdp) {
    const e = State.peers.get(senderId);
    if (e) await e.pc.setRemoteDescription(new RTCSessionDescription(sdp));
  },

  async handleIce(senderId, candidate) {
    const e = State.peers.get(senderId);
    if (!e || !candidate) return;
    try { await e.pc.addIceCandidate(new RTCIceCandidate(candidate)); }
    catch (err) { console.warn('[ice]', err); }
  },

  peerLeft(peerId) {
    const e = State.peers.get(peerId);
    if (e) { e.pc?.close(); State.peers.delete(peerId); }
    State.activeSends.get(peerId) && (State.activeSends.get(peerId).cancelled = true);
    Whiteboard.removePeer(peerId);
    const n = State.openPeerIds.length;
    DashUI.updatePeers();
    DashUI.setConn(n > 0 ? 'connected' : 'waiting', n > 0 ? `${n} peer(s)` : 'Waiting for peers…');
    DashUI.showError(`A peer disconnected. ${n} remaining.`);
  },
};

/* ════════════════════════════════════════
   SENDER
════════════════════════════════════════ */
const Sender = {
  _drains: new Map(),

  async sendAll() {
    const pids = State.openPeerIds;
    if (!pids.length) { DashUI.showError('No peers connected.'); return; }
    FilesUI.setSendEnabled(false);
    FilesUI.setSendLabel('Sending…');
    for (const { file, id } of State.outQueue) await Sender._sendFile(file, id, pids);
    FilesUI.setSendLabel('Send Files');
    FilesUI.setSendEnabled(false);
  },

  async _sendFile(file, fileId, pids) {
    const total = Math.ceil(file.size / Config.CHUNK_SIZE);
    const cancel = { cancelled: false };
    pids.forEach(p => State.activeSends.set(p, cancel));
    document.querySelector(`[data-file-id="${fileId}"] [data-role="cancel"]`)
      ?.addEventListener('click', () => { cancel.cancelled = true; }, { once: true });
    await Promise.all(pids.map(pid => {
      const entry = State.peers.get(pid);
      const dc = entry?.dc;
      return dc?.readyState === 'open' ? Sender._toPeer(file, fileId, total, pid, dc, cancel) : Promise.resolve();
    }));
    pids.forEach(p => State.activeSends.delete(p));
  },

  async _toPeer(file, fileId, total, pid, dc, cancel) {
    dc.send(JSON.stringify({ type: 'meta', fileId, name: file.name, size: file.size, total }));
    FilesUI.updateCard(fileId, { state: 'sending', pct: 0 });
    let offset = 0, chunk = 0, sent = 0;
    const t0 = Date.now();
    while (offset < file.size) {
      if (cancel.cancelled) { dc.send(JSON.stringify({ type: 'cancel', fileId })); FilesUI.updateCard(fileId, { state: 'cancelled' }); return; }
      if (dc.bufferedAmount > Config.BUFFER_THRESHOLD) await new Promise(r => Sender._drains.set(pid, r));
      const buf = await file.slice(offset, offset + Config.CHUNK_SIZE).arrayBuffer();
      dc.send(JSON.stringify({ type: 'chunk', fileId, index: chunk }));
      dc.send(buf);
      offset += buf.byteLength; sent += buf.byteLength; chunk++;
      const secs = (Date.now() - t0) / 1000 || .001;
      FilesUI.updateCard(fileId, { pct: (offset / file.size) * 100, speed: sent / secs });
      if (chunk % 4 === 0) await new Promise(r => setTimeout(r, 0));
    }
    dc.send(JSON.stringify({ type: 'done', fileId }));
    FilesUI.updateCard(fileId, { state: 'done' });
  },

  drained(pid) { const r = Sender._drains.get(pid); if (r) { Sender._drains.delete(pid); r(); } },
};

/* ════════════════════════════════════════
   RECEIVER
   ── KEY FIX: whiteboard messages are
   detected FIRST before file protocol
════════════════════════════════════════ */
const Receiver = {
  _pending: new Map(),

  handle(peerId, data) {
    if (typeof data === 'string') {
      let msg;
      try { msg = JSON.parse(data); } catch { return; }

      // ── Route whiteboard messages immediately ──────────
      if (msg._wb === true) {
        Whiteboard.handlePeerMessage(peerId, msg);
        return;
      }

      // File protocol
      switch (msg.type) {
        case 'meta': Receiver._meta(peerId, msg); break;
        case 'chunk': Receiver._pending.set(peerId, msg); break;
        case 'done': Receiver._done(peerId, msg.fileId); break;
        case 'cancel': Receiver._cancel(peerId, msg.fileId); break;
      }

    } else if (data instanceof ArrayBuffer) {
      Receiver._binary(peerId, data);
    }
  },

  _key(pid, fid) { return `${pid}:${fid}`; },

  _meta(pid, { fileId, name, size, total }) {
    const k = Receiver._key(pid, fileId);
    State.inbound.set(k, { name, size, total, chunks: new Array(total), received: 0, t0: Date.now(), bytesIn: 0 });
    FilesUI.addCard({ id: k, name, size, dir: 'in', peerId: pid });
    FilesUI.updateCard(k, { state: 'receiving', pct: 0 });
    FilesUI.updateCount(State.inbound.size);
    Tabs.go('files');
  },

  _binary(pid, buf) {
    const hdr = Receiver._pending.get(pid);
    if (!hdr) return;
    Receiver._pending.delete(pid);
    const k = Receiver._key(pid, hdr.fileId);
    const e = State.inbound.get(k);
    if (!e) return;
    e.chunks[hdr.index] = buf;
    e.received++; e.bytesIn += buf.byteLength;
    const secs = (Date.now() - e.t0) / 1000 || .001;
    FilesUI.updateCard(k, { pct: (e.received / e.total) * 100, speed: e.bytesIn / secs });
  },

  _done(pid, fileId) {
    const k = Receiver._key(pid, fileId);
    const e = State.inbound.get(k);
    if (!e) return;
    FilesUI.updateCard(k, { state: 'done' });
    const url = URL.createObjectURL(new Blob(e.chunks));
    Object.assign(document.createElement('a'), { href: url, download: e.name }).click();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
    State.inbound.delete(k);
  },

  _cancel(pid, fileId) {
    const k = Receiver._key(pid, fileId);
    FilesUI.updateCard(k, { state: 'cancelled' });
    State.inbound.delete(k);
    DashUI.showError('Sender cancelled the transfer.');
  },
};

/* ════════════════════════════════════════
   LANDING
════════════════════════════════════════ */
const Landing = {
  _cap: 2,
  ADJ: ['aurora', 'cosmic', 'silent', 'swift', 'bright', 'silver', 'golden', 'crystal', 'lunar', 'solar', 'neon', 'sonic', 'arctic', 'ember', 'frost', 'jade', 'nova', 'onyx', 'prism', 'storm'],
  NON: ['wave', 'spark', 'drift', 'bloom', 'pulse', 'forge', 'vault', 'orbit', 'crest', 'flash', 'mist', 'arc'],

  genName() {
    return this.ADJ[Math.floor(Math.random() * this.ADJ.length)] + Math.floor(100 + Math.random() * 900);
  },

  init() {
    const cIn = document.getElementById('create-room-input');
    const cHnt = document.getElementById('create-hint');
    const jIn = document.getElementById('join-room-input');
    const jHnt = document.getElementById('join-hint');

    cIn.value = Landing.genName();

    document.getElementById('create-refresh-btn')?.addEventListener('click', () => {
      cIn.value = Landing.genName();
      cIn.classList.remove('error');
      cHnt.classList.remove('error');
      cHnt.textContent = 'Letters, numbers and hyphens · min 6 chars';
    });

    document.querySelectorAll('.cap-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.cap-btn').forEach(b => b.classList.remove('cap-btn--active'));
        btn.classList.add('cap-btn--active');
        Landing._cap = parseInt(btn.dataset.cap);
      });
    });

    const validate = (raw, hntEl, inputEl) => {
      const clean = raw.trim().toLowerCase();
      if (!/^[a-z0-9\-]{6,64}$/.test(clean)) {
        inputEl.classList.add('error');
        hntEl.classList.add('error');
        hntEl.textContent = 'Use 6–64 letters, numbers, or hyphens';
        return null;
      }
      return clean;
    };

    document.getElementById('create-btn')?.addEventListener('click', () => {
      const id = validate(cIn.value.trim(), cHnt, cIn);
      if (id) Router.goToDashboard(id, true, Landing._cap);
    });
    cIn.addEventListener('keydown', e => {
      if (e.key === 'Enter') { const id = validate(cIn.value.trim(), cHnt, cIn); if (id) Router.goToDashboard(id, true, Landing._cap); }
    });
    cIn.addEventListener('input', () => { cIn.classList.remove('error'); cHnt.classList.remove('error'); cHnt.textContent = 'Letters, numbers and hyphens · min 6 chars'; });

    document.getElementById('join-btn')?.addEventListener('click', () => {
      const id = validate(jIn.value.trim(), jHnt, jIn);
      if (id) Router.goToDashboard(id, false, 2);
    });
    jIn.addEventListener('keydown', e => {
      if (e.key === 'Enter') { const id = validate(jIn.value.trim(), jHnt, jIn); if (id) Router.goToDashboard(id, false, 2); }
    });
    jIn.addEventListener('input', () => { jIn.classList.remove('error'); jHnt.classList.remove('error'); jHnt.textContent = 'Ask the room creator for the name'; });
  },
};

/* ════════════════════════════════════════
   APP
════════════════════════════════════════ */
const App = {
  init() {
    Landing.init();
    Tabs.init();
    Whiteboard.init();
    App._wireDash();
    App._wireFiles();
    Router.init();
  },

  startRoom(roomId, isCreator, capacity) {
    Whiteboard.broadcastFn = wbBroadcast; // set early, updated again on DC open
    Signaling.connect(roomId, isCreator ? capacity : 2);
    DashUI.updatePeers();
  },

  _wireDash() {
    document.getElementById('dash-back-btn')?.addEventListener('click', () => {
      history.pushState({}, '', '/');
      Router.showLanding();
    });
    document.getElementById('dash-copy-btn')?.addEventListener('click', () => {
      navigator.clipboard.writeText(window.location.href).then(() => {
        const btn = document.getElementById('dash-copy-btn');
        btn.style.color = 'var(--green)';
        setTimeout(() => btn.style.color = '', 2000);
      });
    });
    document.getElementById('dash-error-close')?.addEventListener('click', () => DashUI.hideError());
  },

  _wireFiles() {
    const dz = document.getElementById('dropzone');
    dz.addEventListener('dragenter', e => { e.preventDefault(); dz.classList.add('drag-over'); });
    dz.addEventListener('dragover', e => { e.preventDefault(); dz.classList.add('drag-over'); });
    dz.addEventListener('dragleave', e => { if (!dz.contains(e.relatedTarget)) dz.classList.remove('drag-over'); });
    dz.addEventListener('drop', e => { e.preventDefault(); dz.classList.remove('drag-over'); App._dropItems(e.dataTransfer.items); });
    dz.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); document.getElementById('file-input').click(); } });
    document.getElementById('file-input')?.addEventListener('change', e => { App._addFiles([...e.target.files]); e.target.value = ''; });
    document.getElementById('folder-input')?.addEventListener('change', e => { App._addFiles([...e.target.files]); e.target.value = ''; });
    document.getElementById('send-btn')?.addEventListener('click', () => Sender.sendAll());
    document.getElementById('clear-btn')?.addEventListener('click', () => {
      State.activeSends.forEach(h => h.cancelled = true);
      State.outQueue.length = 0;
      FilesUI.clear();
      FilesUI.setSendEnabled(false);
    });
  },

  async _dropItems(items) {
    const files = [];
    const walk = async entry => {
      if (entry.isFile) files.push(await new Promise((res, rej) => entry.file(res, rej)));
      else if (entry.isDirectory) {
        const r = entry.createReader();
        const read = () => new Promise((res, rej) => r.readEntries(res, rej));
        let batch;
        do { batch = await read(); for (const c of batch) await walk(c); } while (batch.length);
      }
    };
    for (const e of [...items].map(i => i.webkitGetAsEntry?.()).filter(Boolean)) await walk(e);
    App._addFiles(files);
  },

  _addFiles(files) {
    if (!files.length) return;
    files.forEach(f => { const id = FU.id(); State.outQueue.push({ file: f, id }); FilesUI.addCard({ id, name: f.name, size: f.size, dir: 'out' }); });
    FilesUI.updateCount(State.outQueue.length);
    FilesUI.setSendEnabled(State.openPeerIds.length > 0);
  },
};

document.addEventListener('DOMContentLoaded', () => App.init());