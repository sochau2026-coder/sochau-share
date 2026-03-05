/**
 * Sochau Share — app.js
 *
 * Flow:
 *   Landing → Create Room (pick name + capacity) → dashboard as CREATOR
 *   Landing → Join Room  (type name)             → dashboard as JOINER
 *
 *   Creator: connects immediately, waits for peers (no button needed)
 *   Joiner:  connects immediately, auto-joins (no button needed)
 *
 * Modules: Config · State · Router · TabManager · DashboardUI · FilesUI
 *          FileUtils · Signaling · Mesh · Sender · Receiver · Landing · App
 */

'use strict';

import { Whiteboard } from './whiteboard.js';

/* ═══════════════════════════════════════════════
   CONFIG
═══════════════════════════════════════════════ */
const Config = Object.freeze({
  SIGNALING_URL: (() => {
    if (window.location.port === '5173') return 'http://localhost:3000';
    return window.location.origin;
  })(),
  CHUNK_SIZE:       64 * 1024,
  BUFFER_THRESHOLD: 8 * 1024 * 1024,
  ICE_SERVERS: [
    { urls: 'stun:stun.l.google.com:19302'  },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun.cloudflare.com:3478' },
  ],
});

/* ═══════════════════════════════════════════════
   STATE
═══════════════════════════════════════════════ */
const State = {
  roomId:   null,
  capacity: 2,
  myId:     null,
  socket:   null,
  isCreator: false,
  peers:    new Map(),
  outQueue: [],
  inboundMap:  new Map(),
  activeSends: new Map(),

  get connectedPeerIds() {
    return [...State.peers.entries()]
      .filter(([, p]) => p.dc?.readyState === 'open')
      .map(([id]) => id);
  },
};

/* ═══════════════════════════════════════════════
   ROUTER
═══════════════════════════════════════════════ */
const Router = {
  init() {
    // If URL already has a room ID (e.g. shared link), go straight to join
    const parts  = window.location.pathname.split('/').filter(Boolean);
    const roomId = parts[0] || null;
    if (roomId && /^[a-zA-Z0-9]{6,64}$/.test(roomId)) {
      // Treat direct URL access as a join
      Router.goToDashboard(roomId, false, 2);
    }

    // Handle browser back/forward
    window.addEventListener('popstate', () => {
      const p = window.location.pathname.split('/').filter(Boolean)[0];
      if (!p) Router.showLanding();
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
    State.roomId   = roomId;
    State.isCreator = isCreator;
    State.capacity = capacity;

    document.getElementById('page-landing').classList.remove('active');
    document.getElementById('page-dashboard').classList.add('active');

    const newUrl = '/' + roomId;
    if (window.location.pathname !== newUrl) {
      history.pushState({ roomId }, '', newUrl);
    }

    DashboardUI.setRoomId(roomId);
    DashboardUI.setConn('connecting', 'Connecting…');
    App.startRoom(roomId, isCreator, capacity);
  },
};

/* ═══════════════════════════════════════════════
   TAB MANAGER
   Add a new feature: push to TABS + add panel in HTML
═══════════════════════════════════════════════ */
const TabManager = {
  TABS: [
    { id: 'whiteboard', label: 'Whiteboard' },
    { id: 'files',      label: 'Files'      },
    // { id: 'chat',    label: 'Chat'        },
  ],

  init() {
    document.querySelectorAll('.dash-tab').forEach(btn => {
      btn.addEventListener('click', () => TabManager.switch(btn.dataset.tab));
    });
  },

  switch(tabId) {
    document.querySelectorAll('.dash-tab').forEach(btn => {
      const active = btn.dataset.tab === tabId;
      btn.classList.toggle('active', active);
      btn.setAttribute('aria-selected', active);
    });
    document.querySelectorAll('.dash-panel').forEach(panel => {
      panel.classList.toggle('active', panel.id === `panel-${tabId}`);
    });
    if (tabId === 'whiteboard') Whiteboard.resize();
  },
};

/* ═══════════════════════════════════════════════
   DASHBOARD UI
═══════════════════════════════════════════════ */
const DashboardUI = {
  setRoomId(id) { document.getElementById('dash-room-id').textContent = id; },

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

  updatePeerList() {
    const el    = document.getElementById('peer-list');
    const open  = State.connectedPeerIds;
    const total = State.capacity;
    el.innerHTML = '';
    for (let i = 0; i < total; i++) {
      const isSelf = i === 0;
      const isConn = isSelf || open.length >= i;
      const slot   = document.createElement('div');
      slot.className = `peer-slot ${isSelf ? 'peer-slot--self' : ''} ${isConn && !isSelf ? 'peer-slot--connected' : ''}`;
      slot.title     = isSelf ? 'You' : (isConn ? `Peer ${i}` : 'Waiting…');
      slot.innerHTML = `<div class="peer-slot__avatar">${isSelf ? 'You' : i}</div><span class="peer-slot__dot"></span>`;
      el.appendChild(slot);
    }
  },
};

/* ═══════════════════════════════════════════════
   FILES UI
═══════════════════════════════════════════════ */
const FilesUI = {
  setSendEnabled(on) { document.getElementById('send-btn').disabled = !on; },
  setSendLabel(t)    { document.getElementById('send-label').textContent = t; },

  updateQueueCount(n) {
    document.getElementById('queue-count').textContent = n + (n === 1 ? ' file' : ' files');
    document.getElementById('empty-state').style.display = n ? 'none' : '';
    document.getElementById('clear-btn').hidden = n === 0;
  },

  addFileCard({ id, name, size, direction, peerId }) {
    const li = document.createElement('li');
    li.className = 'file-item';
    li.dataset.fileId = id;
    li.dataset.state  = 'queued';
    const peerLabel = peerId ? ` · peer ${peerId.slice(0,4)}` : '';
    const dirLabel  = direction === 'out' ? 'Queued' : `Incoming${peerLabel}`;
    li.innerHTML = `
      <div class="file-item__icon">${FileUtils.iconFor(name)}</div>
      <div class="file-item__meta">
        <span class="file-item__name" title="${FileUtils.esc(name)}">${FileUtils.esc(name)}</span>
        <span class="file-item__size">${FileUtils.formatSize(size)}</span>
      </div>
      <div class="file-item__ctrl">
        <span class="file-item__speed" data-role="speed"></span>
        <span class="file-item__pct"   data-role="pct">${dirLabel}</span>
        ${direction === 'out' ? `<button class="file-item__cancel" data-role="cancel" title="Cancel">✕</button>` : ''}
      </div>
      <div class="file-item__bar-wrap"><div class="file-item__bar" data-role="bar"></div></div>`;
    document.getElementById('file-list').prepend(li);
    return li;
  },

  updateFileCard(id, { state, pct, speed }) {
    const li = document.querySelector(`[data-file-id="${id}"]`);
    if (!li) return;
    if (state) li.dataset.state = state;
    const bar   = li.querySelector('[data-role="bar"]');
    const pctEl = li.querySelector('[data-role="pct"]');
    const spEl  = li.querySelector('[data-role="speed"]');
    if (state === 'done') {
      if (pctEl) pctEl.outerHTML = `<span class="file-item__check"><svg width="13" height="13" viewBox="0 0 13 13" fill="none"><path d="M2 6.5l3 3 6-6" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg></span>`;
      if (spEl) spEl.textContent = '';
      li.querySelector('[data-role="cancel"]')?.remove();
    } else if (state === 'error')     { if (pctEl) pctEl.textContent = 'Error';     if (spEl) spEl.textContent = ''; }
      else if (state === 'cancelled') { if (pctEl) pctEl.textContent = 'Cancelled'; if (spEl) spEl.textContent = ''; }
      else {
        if (pct   !== undefined && bar)   bar.style.width   = pct + '%';
        if (pct   !== undefined && pctEl) pctEl.textContent = Math.round(pct) + '%';
        if (speed !== undefined && spEl)  spEl.textContent  = FileUtils.formatSpeed(speed);
      }
  },

  clearFileList() {
    document.getElementById('file-list').innerHTML = '';
    this.updateQueueCount(0);
  },
};

/* ═══════════════════════════════════════════════
   FILE UTILITIES
═══════════════════════════════════════════════ */
const FileUtils = {
  formatSize(bytes) {
    if (!bytes) return '0 B';
    const u = ['B','KB','MB','GB','TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(1024));
    return `${(bytes / Math.pow(1024, i)).toFixed(i ? 1 : 0)} ${u[i]}`;
  },
  formatSpeed(bps) { return FileUtils.formatSize(bps) + '/s'; },
  newId() { return Date.now().toString(36) + Math.random().toString(36).slice(2,7); },
  esc(s)  { return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); },
  iconFor(name) {
    const ext = (name.split('.').pop()||'').toLowerCase();
    if (['jpg','jpeg','png','gif','webp','svg','avif'].includes(ext))
      return `<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><rect x="1" y="2" width="14" height="12" rx="2" stroke="currentColor" stroke-width="1.2"/><circle cx="5.5" cy="6" r="1" fill="currentColor"/><path d="M1 11l3.5-3.5L8 11l3-2.5L15 11" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
    if (['mp4','mov','avi','mkv','webm'].includes(ext))
      return `<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><rect x="1" y="3" width="10" height="10" rx="1.5" stroke="currentColor" stroke-width="1.2"/><path d="M11 6l4-2v8l-4-2V6Z" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/></svg>`;
    if (['mp3','wav','ogg','flac','aac'].includes(ext))
      return `<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M6 13a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z" stroke="currentColor" stroke-width="1.2"/><path d="M9 10V3l5-1v4" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
    if (['zip','tar','gz','rar','7z'].includes(ext))
      return `<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><rect x="2" y="1" width="12" height="14" rx="1.5" stroke="currentColor" stroke-width="1.2"/><path d="M6 1v14M6 4h4M6 7h4M6 10h4" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg>`;
    return `<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><rect x="2" y="1" width="9" height="12" rx="1.5" stroke="currentColor" stroke-width="1.2"/><path d="M7.5 1l4 3.5H7.5V1Z" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/><path d="M4 8h5M4 10.5h5M4 5.5h2" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg>`;
  },
};

/* ═══════════════════════════════════════════════
   SIGNALING
═══════════════════════════════════════════════ */
const Signaling = {
  connect(roomId, capacity) {
    State.socket = io(Config.SIGNALING_URL, {
      transports: ['websocket'],
      reconnectionAttempts: 5,
    });
    const s = State.socket;

    s.on('connect', () => {
      s.emit('join-room', { roomId, capacity });
    });

    s.on('joined', ({ socketId, capacity: cap, existingPeers }) => {
      State.myId     = socketId;
      State.capacity = cap;
      DashboardUI.updatePeerList();

      if (existingPeers.length === 0) {
        // Creator — waiting for others
        DashboardUI.setConn('waiting', 'Waiting for peers…');
      } else {
        // Joiner — connect to existing peers
        DashboardUI.setConn('connecting', 'Connecting…');
        existingPeers.forEach(peerId => Mesh.initPeer(peerId, false));
        setTimeout(() => Whiteboard.requestSync(), 1200);
      }
    });

    s.on('peer-joined',   ({ socketId })           => Mesh.initPeer(socketId, true));
    s.on('offer',         ({ senderId, sdp })       => Mesh.handleOffer(senderId, sdp));
    s.on('answer',        ({ senderId, sdp })       => Mesh.handleAnswer(senderId, sdp));
    s.on('ice-candidate', ({ senderId, candidate }) => Mesh.handleCandidate(senderId, candidate));
    s.on('peer-left',     ({ socketId })            => Mesh.handlePeerLeft(socketId));

    s.on('error', ({ message }) => {
      DashboardUI.showError(message);
      DashboardUI.setConn('error', 'Error');
    });
    s.on('disconnect',    () => DashboardUI.setConn('error', 'Disconnected'));
    s.on('connect_error', () => {
      DashboardUI.setConn('error', 'Cannot reach server');
      DashboardUI.showError('Cannot connect to signaling server.');
    });
  },

  sendOffer(t, sdp)   { State.socket?.emit('offer',         { targetId: t, sdp }); },
  sendAnswer(t, sdp)  { State.socket?.emit('answer',        { targetId: t, sdp }); },
  sendCandidate(t, c) { State.socket?.emit('ice-candidate', { targetId: t, candidate: c }); },
};

/* ═══════════════════════════════════════════════
   MESH
═══════════════════════════════════════════════ */
const Mesh = {
  initPeer(peerId, isInitiator) {
    if (State.peers.has(peerId)) State.peers.get(peerId).pc?.close();

    const pc    = new RTCPeerConnection({ iceServers: Config.ICE_SERVERS });
    const entry = { pc, dc: null };
    State.peers.set(peerId, entry);

    pc.onicecandidate = ({ candidate }) => { if (candidate) Signaling.sendCandidate(peerId, candidate); };
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'connected')    Mesh._onPeerConnected(peerId);
      if (pc.connectionState === 'failed')       Mesh.handlePeerLeft(peerId);
      if (pc.connectionState === 'disconnected') Mesh.handlePeerLeft(peerId);
    };
    pc.ondatachannel = ({ channel }) => { entry.dc = channel; Mesh._setupDC(peerId, channel); };

    if (isInitiator) {
      const dc = pc.createDataChannel('sochau', { ordered: true });
      entry.dc = dc;
      Mesh._setupDC(peerId, dc);
      pc.createOffer()
        .then(o => pc.setLocalDescription(o))
        .then(() => Signaling.sendOffer(peerId, pc.localDescription))
        .catch(e => console.error('[mesh] offer error:', e));
    }
  },

  _setupDC(peerId, dc) {
    dc.binaryType = 'arraybuffer';
    dc.bufferedAmountLowThreshold = Config.BUFFER_THRESHOLD / 2;
    dc.onopen    = () => Mesh._onDCOpen(peerId);
    dc.onclose   = () => Mesh.handlePeerLeft(peerId);
    dc.onerror   = e => console.error('[dc] error:', e);
    dc.onmessage = ({ data }) => Receiver.handleMessage(peerId, data);
    dc.onbufferedamountlow = () => Sender.onBufferDrained(peerId);
  },

  _onDCOpen(peerId) {
    // Set whiteboard broadcast function
    Whiteboard.broadcastFn = (data) => {
      State.connectedPeerIds.forEach(pid => {
        const dc = State.peers.get(pid)?.dc;
        if (dc?.readyState === 'open') dc.send(data);
      });
    };
    Whiteboard.addPeer(peerId);
    Mesh._onPeerConnected(peerId);
  },

  _onPeerConnected(peerId) {
    const openCount = State.connectedPeerIds.length;
    const needed    = State.capacity - 1;
    DashboardUI.updatePeerList();
    DashboardUI.setConn(
      openCount >= needed ? 'connected' : 'connecting',
      openCount >= needed ? `${State.capacity} peers connected` : `${openCount} / ${needed} peers`
    );
    FilesUI.setSendEnabled(State.outQueue.length > 0 && openCount > 0);
  },

  async handleOffer(senderId, sdp) {
    let entry = State.peers.get(senderId);
    if (!entry) { Mesh.initPeer(senderId, false); entry = State.peers.get(senderId); }
    await entry.pc.setRemoteDescription(new RTCSessionDescription(sdp));
    const answer = await entry.pc.createAnswer();
    await entry.pc.setLocalDescription(answer);
    Signaling.sendAnswer(senderId, entry.pc.localDescription);
  },

  async handleAnswer(senderId, sdp) {
    const entry = State.peers.get(senderId);
    if (!entry) return;
    await entry.pc.setRemoteDescription(new RTCSessionDescription(sdp));
  },

  async handleCandidate(senderId, candidate) {
    const entry = State.peers.get(senderId);
    if (!entry || !candidate) return;
    try { await entry.pc.addIceCandidate(new RTCIceCandidate(candidate)); }
    catch (e) { console.warn('[mesh] ICE error:', e); }
  },

  handlePeerLeft(peerId) {
    const entry = State.peers.get(peerId);
    if (entry) { entry.pc?.close(); State.peers.delete(peerId); }
    if (State.activeSends.has(peerId)) State.activeSends.get(peerId).cancelled = true;
    Whiteboard.removePeer(peerId);
    const openCount = State.connectedPeerIds.length;
    DashboardUI.updatePeerList();
    DashboardUI.setConn(openCount > 0 ? 'connected' : 'waiting', openCount > 0 ? `${openCount} peer(s)` : 'Waiting for peers…');
    DashboardUI.showError(`A peer disconnected. ${openCount} remaining.`);
  },
};

/* ═══════════════════════════════════════════════
   SENDER
═══════════════════════════════════════════════ */
const Sender = {
  _drainResolvers: new Map(),

  async sendAll() {
    const peerIds = State.connectedPeerIds;
    if (!peerIds.length) { DashboardUI.showError('No peers connected.'); return; }
    FilesUI.setSendEnabled(false);
    FilesUI.setSendLabel('Sending…');
    for (const { file, id } of State.outQueue) await Sender.sendFile(file, id, peerIds);
    FilesUI.setSendLabel('Send Files');
    FilesUI.setSendEnabled(false);
  },

  async sendFile(file, fileId, peerIds) {
    const totalChunks  = Math.ceil(file.size / Config.CHUNK_SIZE);
    const cancelHandle = { cancelled: false };
    peerIds.forEach(pid => State.activeSends.set(pid, cancelHandle));
    const cancelBtn = document.querySelector(`[data-file-id="${fileId}"] [data-role="cancel"]`);
    if (cancelBtn) cancelBtn.addEventListener('click', () => { cancelHandle.cancelled = true; }, { once: true });
    await Promise.all(peerIds.map(peerId => {
      const dc = State.peers.get(peerId)?.dc;
      if (!dc || dc.readyState !== 'open') return Promise.resolve();
      return Sender._sendToPeer(file, fileId, totalChunks, peerId, dc, cancelHandle);
    }));
    peerIds.forEach(pid => State.activeSends.delete(pid));
  },

  async _sendToPeer(file, fileId, totalChunks, peerId, dc, cancelHandle) {
    dc.send(JSON.stringify({ type:'meta', fileId, name:file.name, size:file.size, total:totalChunks }));
    FilesUI.updateFileCard(fileId, { state:'sending', pct:0 });
    let offset = 0, chunkIndex = 0, bytesSent = 0;
    const startTime = Date.now();
    while (offset < file.size) {
      if (cancelHandle.cancelled) { dc.send(JSON.stringify({ type:'cancel', fileId })); FilesUI.updateFileCard(fileId, { state:'cancelled' }); return; }
      if (dc.bufferedAmount > Config.BUFFER_THRESHOLD) await Sender._waitDrain(peerId);
      const buffer = await file.slice(offset, offset + Config.CHUNK_SIZE).arrayBuffer();
      dc.send(JSON.stringify({ type:'chunk', fileId, index:chunkIndex }));
      dc.send(buffer);
      offset += buffer.byteLength; bytesSent += buffer.byteLength; chunkIndex++;
      const elapsed = (Date.now() - startTime) / 1000 || 0.001;
      FilesUI.updateFileCard(fileId, { pct: (offset / file.size) * 100, speed: bytesSent / elapsed });
      if (chunkIndex % 4 === 0) await new Promise(r => setTimeout(r, 0));
    }
    dc.send(JSON.stringify({ type:'done', fileId }));
    FilesUI.updateFileCard(fileId, { state:'done' });
  },

  _waitDrain(peerId) { return new Promise(r => Sender._drainResolvers.set(peerId, r)); },
  onBufferDrained(peerId) { const r = Sender._drainResolvers.get(peerId); if (r) { Sender._drainResolvers.delete(peerId); r(); } },
};

/* ═══════════════════════════════════════════════
   RECEIVER
═══════════════════════════════════════════════ */
const Receiver = {
  _pendingHeaders: new Map(),

  handleMessage(peerId, data) {
    if (typeof data === 'string') {
      try {
        const msg = JSON.parse(data);
        if (msg._wb) { Whiteboard.handlePeerMessage(peerId, data); return; }
        this._handleJson(peerId, msg);
      } catch { /* ignore */ }
    } else if (data instanceof ArrayBuffer) {
      this._handleBinary(peerId, data);
    }
  },

  _handleJson(peerId, msg) {
    switch (msg.type) {
      case 'meta':   this._handleMeta(peerId, msg);          break;
      case 'chunk':  this._pendingHeaders.set(peerId, msg);  break;
      case 'done':   this._handleDone(peerId, msg.fileId);   break;
      case 'cancel': this._handleCancel(peerId, msg.fileId); break;
    }
  },

  _key(peerId, fileId) { return `${peerId}:${fileId}`; },

  _handleMeta(peerId, { fileId, name, size, total }) {
    const key = this._key(peerId, fileId);
    State.inboundMap.set(key, { name, size, total, chunks: new Array(total), received: 0, startTime: Date.now(), bytesIn: 0 });
    FilesUI.addFileCard({ id: key, name, size, direction:'in', peerId });
    FilesUI.updateFileCard(key, { state:'receiving', pct:0 });
    FilesUI.updateQueueCount(State.inboundMap.size);
    TabManager.switch('files');
  },

  _handleBinary(peerId, buffer) {
    const header = this._pendingHeaders.get(peerId);
    if (!header) return;
    this._pendingHeaders.delete(peerId);
    const key   = this._key(peerId, header.fileId);
    const entry = State.inboundMap.get(key);
    if (!entry) return;
    entry.chunks[header.index] = buffer;
    entry.received++; entry.bytesIn += buffer.byteLength;
    const elapsed = (Date.now() - entry.startTime) / 1000 || 0.001;
    FilesUI.updateFileCard(key, { pct: (entry.received / entry.total) * 100, speed: entry.bytesIn / elapsed });
  },

  _handleDone(peerId, fileId) {
    const key   = this._key(peerId, fileId);
    const entry = State.inboundMap.get(key);
    if (!entry) return;
    FilesUI.updateFileCard(key, { state:'done' });
    const url = URL.createObjectURL(new Blob(entry.chunks));
    Object.assign(document.createElement('a'), { href: url, download: entry.name }).click();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
    State.inboundMap.delete(key);
  },

  _handleCancel(peerId, fileId) {
    FilesUI.updateFileCard(this._key(peerId, fileId), { state:'cancelled' });
    State.inboundMap.delete(this._key(peerId, fileId));
    DashboardUI.showError('Sender cancelled the transfer.');
  },
};

/* ═══════════════════════════════════════════════
   LANDING
═══════════════════════════════════════════════ */
const Landing = {
  _capacity: 2,

  ADJECTIVES: ['aurora','cosmic','silent','swift','bright','silver','golden','crystal','lunar','solar','neon','sonic','arctic','ember','frost','jade','nova','onyx','prism','storm'],
  NOUNS:      ['wave','spark','drift','bloom','pulse','forge','vault','orbit','crest','flash','mist','arc','bay','code','dash','echo','fuse','gate','haze','isle'],

  generateName() {
    const adj = this.ADJECTIVES[Math.floor(Math.random() * this.ADJECTIVES.length)];
    const num = Math.floor(100 + Math.random() * 900);
    return `${adj}${num}`;
  },

  init() {
    const createInput   = document.getElementById('create-room-input');
    const createHint    = document.getElementById('create-hint');
    const refreshBtn    = document.getElementById('create-refresh-btn');
    const createBtn     = document.getElementById('create-btn');
    const joinInput     = document.getElementById('join-room-input');
    const joinHint      = document.getElementById('join-hint');
    const joinBtn       = document.getElementById('join-btn');

    // Seed create input with a generated name
    createInput.value = Landing.generateName();

    // Refresh button
    refreshBtn.addEventListener('click', () => {
      createInput.value = Landing.generateName();
      createInput.classList.remove('error');
      createHint.classList.remove('error');
      createHint.textContent = 'Letters, numbers and hyphens · min 6 chars';
    });

    // Capacity buttons
    document.querySelectorAll('.cap-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.cap-btn').forEach(b => b.classList.remove('cap-btn--active'));
        btn.classList.add('cap-btn--active');
        Landing._capacity = parseInt(btn.dataset.cap, 10);
      });
    });

    // Create
    const tryCreate = () => {
      const raw   = createInput.value.trim();
      const clean = raw.replace(/-/g, '');
      if (!/^[a-zA-Z0-9\-]{6,64}$/.test(raw) || clean.length < 6) {
        createInput.classList.add('error');
        createHint.classList.add('error');
        createHint.textContent = 'Must be 6–64 chars, letters and numbers only';
        return;
      }
      Router.goToDashboard(clean.slice(0, 64), true, Landing._capacity);
    };
    createBtn.addEventListener('click', tryCreate);
    createInput.addEventListener('keydown', e => { if (e.key === 'Enter') tryCreate(); });
    createInput.addEventListener('input', () => {
      createInput.classList.remove('error');
      createHint.classList.remove('error');
      createHint.textContent = 'Letters, numbers and hyphens · min 6 chars';
    });

    // Join
    const tryJoin = () => {
      const raw   = joinInput.value.trim();
      const clean = raw.replace(/-/g, '');
      if (!/^[a-zA-Z0-9\-]{6,64}$/.test(raw) || clean.length < 6) {
        joinInput.classList.add('error');
        joinHint.classList.add('error');
        joinHint.textContent = 'Must be 6–64 chars, letters and numbers only';
        return;
      }
      Router.goToDashboard(clean.slice(0, 64), false, 2);
    };
    joinBtn.addEventListener('click', tryJoin);
    joinInput.addEventListener('keydown', e => { if (e.key === 'Enter') tryJoin(); });
    joinInput.addEventListener('input', () => {
      joinInput.classList.remove('error');
      joinHint.classList.remove('error');
      joinHint.textContent = 'Ask the room creator for the name';
    });
  },
};

/* ═══════════════════════════════════════════════
   APP
═══════════════════════════════════════════════ */
const App = {
  init() {
    Landing.init();
    TabManager.init();
    Whiteboard.init();
    App._wireDashNav();
    App._wireFileEvents();
    Router.init();
  },

  startRoom(roomId, isCreator, capacity) {
    // Connect immediately — no button needed
    Signaling.connect(roomId, isCreator ? capacity : 2);
    DashboardUI.updatePeerList();
  },

  _wireDashNav() {
    document.getElementById('dash-back-btn').addEventListener('click', () => {
      history.pushState({}, '', '/');
      Router.showLanding();
    });

    document.getElementById('dash-copy-btn').addEventListener('click', () => {
      navigator.clipboard.writeText(window.location.href).then(() => {
        const btn = document.getElementById('dash-copy-btn');
        btn.style.color = 'var(--green)';
        setTimeout(() => { btn.style.color = ''; }, 2000);
      });
    });

    document.getElementById('dash-error-close').addEventListener('click', () => DashboardUI.hideError());
  },

  _wireFileEvents() {
    const dz = document.getElementById('dropzone');
    dz.addEventListener('dragenter', e => { e.preventDefault(); dz.classList.add('drag-over'); });
    dz.addEventListener('dragover',  e => { e.preventDefault(); dz.classList.add('drag-over'); });
    dz.addEventListener('dragleave', e => { if (!dz.contains(e.relatedTarget)) dz.classList.remove('drag-over'); });
    dz.addEventListener('drop', e => { e.preventDefault(); dz.classList.remove('drag-over'); App._handleDroppedItems(e.dataTransfer.items); });
    dz.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); document.getElementById('file-input').click(); } });

    document.getElementById('file-input').addEventListener('change',   e => { App._addFiles(Array.from(e.target.files)); e.target.value=''; });
    document.getElementById('folder-input').addEventListener('change', e => { App._addFiles(Array.from(e.target.files)); e.target.value=''; });
    document.getElementById('send-btn').addEventListener('click', () => Sender.sendAll());
    document.getElementById('clear-btn').addEventListener('click', () => {
      State.activeSends.forEach(h => { h.cancelled = true; });
      State.outQueue.length = 0;
      FilesUI.clearFileList();
      FilesUI.setSendEnabled(false);
    });
  },

  async _handleDroppedItems(items) {
    if (!items) return;
    const files = [];
    const traverse = async (entry) => {
      if (entry.isFile) files.push(await new Promise((res, rej) => entry.file(res, rej)));
      else if (entry.isDirectory) {
        const reader = entry.createReader();
        const readAll = () => new Promise((res, rej) => reader.readEntries(res, rej));
        let batch;
        do { batch = await readAll(); for (const c of batch) await traverse(c); } while (batch.length > 0);
      }
    };
    for (const entry of Array.from(items).map(i => i.webkitGetAsEntry?.()).filter(Boolean)) await traverse(entry);
    App._addFiles(files);
  },

  _addFiles(files) {
    if (!files.length) return;
    files.forEach(file => {
      const id = FileUtils.newId();
      State.outQueue.push({ file, id });
      FilesUI.addFileCard({ id, name: file.name, size: file.size, direction: 'out' });
    });
    FilesUI.updateQueueCount(State.outQueue.length);
    FilesUI.setSendEnabled(State.connectedPeerIds.length > 0);
  },
};

document.addEventListener('DOMContentLoaded', () => App.init());