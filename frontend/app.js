/**
 * Sochau Share — app.js (multi-peer mesh edition)
 *
 * Topology: full mesh — every peer holds one RTCPeerConnection per remote peer.
 * When peer C joins a room with A and B already present:
 *   A ←→ B  (existing)
 *   A ←→ C  (A creates offer to C)
 *   B ←→ C  (B creates offer to C)
 *
 * State.peers: Map<socketId, { pc, dc }>
 *
 * Modules:
 *   Config · State · FileUtils · UI · Signaling · Mesh · Sender · Receiver · App
 */

'use strict';

/* ═══════════════════════════════════════════════════════════
   CONFIG
═══════════════════════════════════════════════════════════ */
const Config = Object.freeze({
  SIGNALING_URL: (() => {
    if (window.location.port === '5173') return 'http://localhost:3000';
    return '';
  })(),
  CHUNK_SIZE:       64 * 1024,
  BUFFER_THRESHOLD: 8 * 1024 * 1024,
  ICE_SERVERS: [
    { urls: 'stun:stun.l.google.com:19302'  },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun.cloudflare.com:3478' },
  ],
});

/* ═══════════════════════════════════════════════════════════
   STATE
═══════════════════════════════════════════════════════════ */
const State = {
  roomId:    null,
  capacity:  2,              // chosen by first peer, 2|3|4
  myId:      null,           // our socket ID
  socket:    null,

  /** Map<peerId, { pc: RTCPeerConnection, dc: RTCDataChannel|null }> */
  peers: new Map(),

  /** Outbound queue: Array<{ file, id }> */
  outQueue: [],

  /** Inbound reassembly: Map<fileId, { meta, chunks[], received, startTime, bytesIn }> */
  inboundMap: new Map(),

  /** Active send tracker per peer: Map<peerId, { fileId, cancelled }> */
  activeSends: new Map(),

  get connectedPeerIds() {
    return [...State.peers.entries()]
      .filter(([, p]) => p.dc?.readyState === 'open')
      .map(([id]) => id);
  },
};

/* ═══════════════════════════════════════════════════════════
   FILE UTILITIES
═══════════════════════════════════════════════════════════ */
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

/* ═══════════════════════════════════════════════════════════
   UI
═══════════════════════════════════════════════════════════ */
const UI = {
  refs: {},

  init() {
    [
      'room-id-display','copy-btn','copy-label',
      'status-bar','status-text','peer-info',
      'error-banner','error-text','error-close',
      'dropzone','file-input','folder-input',
      'capacity-picker',
      'send-btn','send-label',
      'file-list','queue-count','empty-state','clear-btn',
      'peer-list',
    ].forEach(id => { this.refs[id] = document.getElementById(id); });
  },

  setRoomId(id) { this.refs['room-id-display'].textContent = id; },

  setStatus(state, text, sub = '') {
    const bar = this.refs['status-bar'];
    bar.dataset.state = state;
    this.refs['status-text'].textContent = text;
    this.refs['peer-info'].textContent   = sub;
  },

  showError(msg) {
    this.refs['error-text'].textContent = msg;
    this.refs['error-banner'].hidden = false;
  },
  hideError() { this.refs['error-banner'].hidden = true; },

  setSendEnabled(on) { this.refs['send-btn'].disabled = !on; },
  setSendLabel(t)    { this.refs['send-label'].textContent = t; },

  /** Show/hide capacity picker (only for the room creator) */
  showCapacityPicker(show) {
    this.refs['capacity-picker'].hidden = !show;
  },

  /** Update the peer mesh visualiser strip */
  updatePeerList() {
    const el   = this.refs['peer-list'];
    const open = State.connectedPeerIds;
    const total = State.capacity;

    el.innerHTML = '';
    for (let i = 0; i < total; i++) {
      const slot   = document.createElement('div');
      const isSelf = i === 0; // slot 0 = always us
      const isConn = isSelf || open.length >= i;

      slot.className  = `peer-slot ${isSelf ? 'peer-slot--self' : ''} ${isConn && !isSelf ? 'peer-slot--connected' : ''}`;
      slot.title      = isSelf ? 'You' : (isConn ? `Peer ${i}` : 'Waiting…');
      slot.innerHTML  = `
        <div class="peer-slot__avatar">${isSelf ? 'You' : i}</div>
        <span class="peer-slot__dot"></span>`;
      el.appendChild(slot);
    }
  },

  updateQueueCount(n) {
    this.refs['queue-count'].textContent = n + (n === 1 ? ' file' : ' files');
    this.refs['empty-state'].style.display = n ? 'none' : '';
    this.refs['clear-btn'].hidden = n === 0;
  },

  addFileCard({ id, name, size, direction, peerId }) {
    const li = document.createElement('li');
    li.className      = 'file-item';
    li.dataset.fileId = id;
    li.dataset.state  = 'queued';

    const peerLabel = peerId ? ` · peer ${peerId.slice(0,4)}` : '';
    const dirLabel  = direction === 'out' ? 'Queued' : `Incoming${peerLabel}`;

    li.innerHTML = `
      <div class="file-item__icon" aria-hidden="true">${FileUtils.iconFor(name)}</div>
      <div class="file-item__meta">
        <span class="file-item__name" title="${FileUtils.esc(name)}">${FileUtils.esc(name)}</span>
        <span class="file-item__size">${FileUtils.formatSize(size)}</span>
      </div>
      <div class="file-item__ctrl">
        <span class="file-item__speed" data-role="speed"></span>
        <span class="file-item__pct"   data-role="pct">${dirLabel}</span>
        ${direction === 'out'
          ? `<button class="file-item__cancel" data-role="cancel" title="Cancel">✕</button>`
          : ''}
      </div>
      <div class="file-item__bar-wrap">
        <div class="file-item__bar" data-role="bar"></div>
      </div>`;

    this.refs['file-list'].prepend(li);
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
      if (pctEl) pctEl.outerHTML = `<span class="file-item__check" aria-label="Complete"><svg width="13" height="13" viewBox="0 0 13 13" fill="none"><path d="M2 6.5l3 3 6-6" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg></span>`;
      if (spEl)  spEl.textContent = '';
      li.querySelector('[data-role="cancel"]')?.remove();
    } else if (state === 'error')     { if (pctEl) pctEl.textContent = 'Error';     if (spEl) spEl.textContent = ''; }
      else if (state === 'cancelled') { if (pctEl) pctEl.textContent = 'Cancelled'; if (spEl) spEl.textContent = ''; }
      else {
        if (pct   !== undefined && bar)   bar.style.width       = pct + '%';
        if (pct   !== undefined && pctEl) pctEl.textContent     = Math.round(pct) + '%';
        if (speed !== undefined && spEl)  spEl.textContent      = FileUtils.formatSpeed(speed);
      }
  },

  clearFileList() {
    this.refs['file-list'].innerHTML = '';
    this.updateQueueCount(0);
  },
};

/* ═══════════════════════════════════════════════════════════
   SIGNALING
═══════════════════════════════════════════════════════════ */
const Signaling = {
  connect(roomId, capacity) {
    State.socket = io(Config.SIGNALING_URL, {
      transports: ['websocket'],
      reconnectionAttempts: 5,
    });
    const s = State.socket;

    s.on('connect', () => {
      UI.setStatus('connecting', 'Joining room…');
      s.emit('join-room', { roomId, capacity });
    });

    // Server tells us our ID, room capacity, and who is already here
    s.on('joined', ({ socketId, capacity: cap, existingPeers }) => {
      State.myId     = socketId;
      State.capacity = cap;

      UI.showCapacityPicker(false); // hide picker once joined
      UI.updatePeerList();

      if (existingPeers.length === 0) {
        // First in room — wait
        UI.setStatus('waiting', 'Waiting for peers…', `0 / ${cap - 1} connected`);
      } else {
        // Others are already here — responder side, init PC for each
        UI.setStatus('connecting', 'Connecting to peers…');
        existingPeers.forEach(peerId => {
          Mesh.initPeer(peerId, false); // false = responder
        });
      }
    });

    // A new peer joined — we (and all existing peers) become the initiator
    s.on('peer-joined', ({ socketId }) => {
      Mesh.initPeer(socketId, true); // true = initiator
    });

    // Targeted signaling messages
    s.on('offer',         ({ senderId, sdp })       => Mesh.handleOffer(senderId, sdp));
    s.on('answer',        ({ senderId, sdp })       => Mesh.handleAnswer(senderId, sdp));
    s.on('ice-candidate', ({ senderId, candidate }) => Mesh.handleCandidate(senderId, candidate));

    s.on('peer-left', ({ socketId }) => Mesh.handlePeerLeft(socketId));

    s.on('error', ({ message }) => {
      UI.showError(message);
      UI.setStatus('error', 'Error');
    });

    s.on('disconnect', () => UI.setStatus('error', 'Disconnected from signaling server'));

    s.on('connect_error', () => {
      UI.setStatus('error', 'Cannot reach signaling server');
      UI.showError('Cannot connect to signaling server. Is the backend running?');
    });
  },

  sendOffer(targetId, sdp)      { State.socket?.emit('offer',         { targetId, sdp }); },
  sendAnswer(targetId, sdp)     { State.socket?.emit('answer',        { targetId, sdp }); },
  sendCandidate(targetId, c)    { State.socket?.emit('ice-candidate', { targetId, candidate: c }); },
};

/* ═══════════════════════════════════════════════════════════
   MESH  — one RTCPeerConnection per remote peer
═══════════════════════════════════════════════════════════ */
const Mesh = {
  /** Create (or replace) a peer entry and open a connection */
  initPeer(peerId, isInitiator) {
    // Clean up any stale connection
    if (State.peers.has(peerId)) {
      State.peers.get(peerId).pc?.close();
    }

    const pc = new RTCPeerConnection({ iceServers: Config.ICE_SERVERS });
    const entry = { pc, dc: null };
    State.peers.set(peerId, entry);

    pc.onicecandidate = ({ candidate }) => {
      if (candidate) Signaling.sendCandidate(peerId, candidate);
    };

    pc.onconnectionstatechange = () => {
      console.log(`[rtc] ${peerId.slice(0,4)} state: ${pc.connectionState}`);
      if (pc.connectionState === 'connected')   Mesh._onPeerConnected(peerId);
      if (pc.connectionState === 'failed')      Mesh.handlePeerLeft(peerId);
      if (pc.connectionState === 'disconnected') Mesh.handlePeerLeft(peerId);
    };

    // Responder receives the data channel
    pc.ondatachannel = ({ channel }) => {
      entry.dc = channel;
      Mesh._setupDC(peerId, channel);
    };

    if (isInitiator) {
      const dc = pc.createDataChannel('fileTransfer', { ordered: true });
      entry.dc = dc;
      Mesh._setupDC(peerId, dc);
      // Create and send offer
      pc.createOffer()
        .then(offer => pc.setLocalDescription(offer))
        .then(() => Signaling.sendOffer(peerId, pc.localDescription))
        .catch(e => console.error('[mesh] offer error:', e));
    }
  },

  _setupDC(peerId, dc) {
    dc.binaryType = 'arraybuffer';
    dc.bufferedAmountLowThreshold = Config.BUFFER_THRESHOLD / 2;

    dc.onopen  = () => Mesh._onDCOpen(peerId);
    dc.onclose = () => Mesh.handlePeerLeft(peerId);
    dc.onerror = (e) => { console.error('[dc] error:', e); };
    dc.onmessage = ({ data }) => Receiver.handleMessage(peerId, data);
    dc.onbufferedamountlow = () => Sender.onBufferDrained(peerId);
  },

  _onDCOpen(peerId) {
    console.log('[dc] open with', peerId.slice(0,4));
    Mesh._onPeerConnected(peerId);
  },

  _onPeerConnected(peerId) {
    const openCount = State.connectedPeerIds.length;
    const needed    = State.capacity - 1;
    UI.updatePeerList();
    UI.setStatus(
      openCount >= needed ? 'connected' : 'connecting',
      openCount >= needed ? `All ${State.capacity} peers connected` : `${openCount} / ${needed} peers connected`,
      'WebRTC P2P'
    );
    UI.setSendEnabled(State.outQueue.length > 0 && openCount > 0);
  },

  async handleOffer(senderId, sdp) {
    let entry = State.peers.get(senderId);
    if (!entry) {
      // Shouldn't happen but handle gracefully
      Mesh.initPeer(senderId, false);
      entry = State.peers.get(senderId);
    }
    const { pc } = entry;
    await pc.setRemoteDescription(new RTCSessionDescription(sdp));
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    Signaling.sendAnswer(senderId, pc.localDescription);
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
    catch (e) { console.warn('[mesh] ICE candidate error:', e); }
  },

  handlePeerLeft(peerId) {
    console.log('[mesh] peer left:', peerId.slice(0,4));
    const entry = State.peers.get(peerId);
    if (entry) { entry.pc?.close(); State.peers.delete(peerId); }

    // Cancel any active send to this peer
    if (State.activeSends.has(peerId)) {
      State.activeSends.get(peerId).cancelled = true;
    }

    const openCount = State.connectedPeerIds.length;
    UI.updatePeerList();
    UI.setStatus(
      openCount > 0 ? 'connected' : 'waiting',
      openCount > 0 ? `${openCount} peer(s) connected` : 'Waiting for peers…'
    );
    UI.showError(`A peer disconnected. ${openCount} peer(s) remaining.`);
  },
};

/* ═══════════════════════════════════════════════════════════
   SENDER — broadcasts file to ALL connected peers
═══════════════════════════════════════════════════════════ */
const Sender = {
  _drainResolvers: new Map(), // peerId → resolve fn

  async sendAll() {
    const peerIds = State.connectedPeerIds;
    if (!peerIds.length) { UI.showError('No peers connected.'); return; }

    UI.setStatus('transferring', 'Sending files…', 'WebRTC P2P');
    UI.setSendEnabled(false);
    UI.setSendLabel('Sending…');

    for (const { file, id } of State.outQueue) {
      await Sender.sendFile(file, id, peerIds);
    }

    UI.setStatus('connected', `${State.connectedPeerIds.length} peer(s) connected`, 'WebRTC P2P');
    UI.setSendLabel('Send Files');
    UI.setSendEnabled(false);
  },

  /** Send one file to all peers in parallel */
  async sendFile(file, fileId, peerIds) {
    const totalChunks = Math.ceil(file.size / Config.CHUNK_SIZE);

    // Cancel handle
    const cancelHandle = { cancelled: false };

    // Register cancel for each peer
    peerIds.forEach(pid => State.activeSends.set(pid, cancelHandle));

    // Wire up cancel button
    const cancelBtn = document.querySelector(`[data-file-id="${fileId}"] [data-role="cancel"]`);
    if (cancelBtn) {
      cancelBtn.addEventListener('click', () => { cancelHandle.cancelled = true; }, { once: true });
    }

    // Send to all peers in parallel
    await Promise.all(peerIds.map(peerId => {
      const dc = State.peers.get(peerId)?.dc;
      if (!dc || dc.readyState !== 'open') return Promise.resolve();
      return Sender._sendToPeer(file, fileId, totalChunks, peerId, dc, cancelHandle);
    }));

    peerIds.forEach(pid => State.activeSends.delete(pid));
  },

  async _sendToPeer(file, fileId, totalChunks, peerId, dc, cancelHandle) {
    const meta = { type:'meta', fileId, name:file.name, size:file.size, total:totalChunks };
    dc.send(JSON.stringify(meta));

    UI.updateFileCard(fileId, { state:'sending', pct:0 });

    let offset = 0, chunkIndex = 0, bytesSent = 0;
    const startTime = Date.now();

    while (offset < file.size) {
      if (cancelHandle.cancelled) {
        dc.send(JSON.stringify({ type:'cancel', fileId }));
        UI.updateFileCard(fileId, { state:'cancelled' });
        return;
      }

      if (dc.bufferedAmount > Config.BUFFER_THRESHOLD) {
        await Sender._waitDrain(peerId);
      }

      const slice  = file.slice(offset, offset + Config.CHUNK_SIZE);
      const buffer = await slice.arrayBuffer();

      dc.send(JSON.stringify({ type:'chunk', fileId, index:chunkIndex }));
      dc.send(buffer);

      offset     += buffer.byteLength;
      bytesSent  += buffer.byteLength;
      chunkIndex++;

      const elapsed = (Date.now() - startTime) / 1000 || 0.001;
      UI.updateFileCard(fileId, {
        pct:   (offset / file.size) * 100,
        speed: bytesSent / elapsed,
      });

      if (chunkIndex % 4 === 0) await new Promise(r => setTimeout(r, 0));
    }

    dc.send(JSON.stringify({ type:'done', fileId }));
    UI.updateFileCard(fileId, { state:'done' });
  },

  _waitDrain(peerId) {
    return new Promise(r => { Sender._drainResolvers.set(peerId, r); });
  },

  onBufferDrained(peerId) {
    const r = Sender._drainResolvers.get(peerId);
    if (r) { Sender._drainResolvers.delete(peerId); r(); }
  },
};

/* ═══════════════════════════════════════════════════════════
   RECEIVER — one inbound stream per peer
   Key: `${peerId}:${fileId}` to avoid collisions across peers
═══════════════════════════════════════════════════════════ */
const Receiver = {
  _pendingHeaders: new Map(), // peerId → last JSON header

  handleMessage(peerId, data) {
    if (typeof data === 'string') {
      const msg = JSON.parse(data);
      this._handleJson(peerId, msg);
    } else if (data instanceof ArrayBuffer) {
      this._handleBinary(peerId, data);
    }
  },

  _handleJson(peerId, msg) {
    switch (msg.type) {
      case 'meta':   this._handleMeta(peerId, msg);       break;
      case 'chunk':  this._pendingHeaders.set(peerId, msg); break;
      case 'done':   this._handleDone(peerId, msg.fileId); break;
      case 'cancel': this._handleCancel(peerId, msg.fileId); break;
    }
  },

  _key(peerId, fileId) { return `${peerId}:${fileId}`; },

  _handleMeta(peerId, { fileId, name, size, total }) {
    const key = this._key(peerId, fileId);
    State.inboundMap.set(key, {
      name, size, total,
      chunks: new Array(total),
      received: 0,
      startTime: Date.now(),
      bytesIn: 0,
    });
    UI.addFileCard({ id: key, name, size, direction:'in', peerId });
    UI.updateFileCard(key, { state:'receiving', pct:0 });
    UI.updateQueueCount(State.inboundMap.size);
  },

  _handleBinary(peerId, buffer) {
    const header = this._pendingHeaders.get(peerId);
    if (!header) return;
    this._pendingHeaders.delete(peerId);

    const key   = this._key(peerId, header.fileId);
    const entry = State.inboundMap.get(key);
    if (!entry) return;

    entry.chunks[header.index] = buffer;
    entry.received++;
    entry.bytesIn += buffer.byteLength;

    const elapsed = (Date.now() - entry.startTime) / 1000 || 0.001;
    UI.updateFileCard(key, {
      pct:   (entry.received / entry.total) * 100,
      speed: entry.bytesIn / elapsed,
    });
  },

  _handleDone(peerId, fileId) {
    const key   = this._key(peerId, fileId);
    const entry = State.inboundMap.get(key);
    if (!entry) return;

    UI.updateFileCard(key, { state:'done' });

    const blob = new Blob(entry.chunks);
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href     = url;
    a.download = entry.name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);

    State.inboundMap.delete(key);
  },

  _handleCancel(peerId, fileId) {
    const key = this._key(peerId, fileId);
    UI.updateFileCard(key, { state:'cancelled' });
    State.inboundMap.delete(key);
    UI.showError('Sender cancelled the transfer.');
  },
};

/* ═══════════════════════════════════════════════════════════
   APP — orchestration + event wiring
═══════════════════════════════════════════════════════════ */
const App = {
  init() {
    UI.init();

    const pathParts = window.location.pathname.split('/').filter(Boolean);
    const roomId    = pathParts[0] || null;

    if (!roomId || !/^[a-zA-Z0-9]{6,64}$/.test(roomId)) {
      UI.setStatus('error', 'Invalid or missing room ID in URL');
      UI.showError('URL must be: http://localhost:5173/{roomId}  (min 6 alphanumeric chars)');
      return;
    }

    State.roomId = roomId;
    UI.setRoomId(roomId);
    UI.setStatus('idle', 'Choose room size, then connect…');

    // Show capacity picker — only first peer to join sets capacity
    UI.showCapacityPicker(true);

    App._wireEvents(roomId);
  },

  _wireEvents(roomId) {
    const refs = UI.refs;

    // Copy room link
    refs['copy-btn'].addEventListener('click', () => {
      navigator.clipboard.writeText(window.location.href).then(() => {
        refs['copy-btn'].classList.add('copied');
        refs['copy-label'].textContent = 'Copied!';
        setTimeout(() => {
          refs['copy-btn'].classList.remove('copied');
          refs['copy-label'].textContent = 'Copy link';
        }, 2200);
      });
    });

    // Dismiss error
    refs['error-close'].addEventListener('click', () => UI.hideError());

    // Capacity picker buttons
    refs['capacity-picker'].querySelectorAll('.cap-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        refs['capacity-picker'].querySelectorAll('.cap-btn')
          .forEach(b => b.classList.remove('cap-btn--active'));
        btn.classList.add('cap-btn--active');
        State.capacity = parseInt(btn.dataset.cap, 10);
      });
    });

    // Connect button
    document.getElementById('connect-btn').addEventListener('click', () => {
      document.getElementById('connect-btn').disabled = true;
      UI.showCapacityPicker(false);
      UI.setStatus('connecting', 'Connecting to signaling…');
      Signaling.connect(roomId, State.capacity);
    });

    // Drag & drop
    const dz = refs['dropzone'];
    dz.addEventListener('dragenter', e => { e.preventDefault(); dz.classList.add('drag-over'); });
    dz.addEventListener('dragover',  e => { e.preventDefault(); dz.classList.add('drag-over'); });
    dz.addEventListener('dragleave', e => { if (!dz.contains(e.relatedTarget)) dz.classList.remove('drag-over'); });
    dz.addEventListener('drop', e => {
      e.preventDefault();
      dz.classList.remove('drag-over');
      App._handleDroppedItems(e.dataTransfer.items);
    });
    dz.addEventListener('keydown', e => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); refs['file-input'].click(); }
    });

    refs['file-input'].addEventListener('change',   e => { App._addFiles(Array.from(e.target.files)); e.target.value=''; });
    refs['folder-input'].addEventListener('change', e => { App._addFiles(Array.from(e.target.files)); e.target.value=''; });

    document.getElementById('send-btn').addEventListener('click', () => Sender.sendAll());

    refs['clear-btn'].addEventListener('click', () => {
      State.activeSends.forEach(h => { h.cancelled = true; });
      State.outQueue.length = 0;
      UI.clearFileList();
      UI.setSendEnabled(false);
    });
  },

  async _handleDroppedItems(items) {
    if (!items) return;
    const files = [];
    const traverse = async (entry) => {
      if (entry.isFile) {
        files.push(await new Promise((res, rej) => entry.file(res, rej)));
      } else if (entry.isDirectory) {
        const reader = entry.createReader();
        const readAll = () => new Promise((res, rej) => reader.readEntries(res, rej));
        let batch;
        do { batch = await readAll(); for (const c of batch) await traverse(c); }
        while (batch.length > 0);
      }
    };
    for (const entry of Array.from(items).map(i => i.webkitGetAsEntry?.()).filter(Boolean)) {
      await traverse(entry);
    }
    App._addFiles(files);
  },

  _addFiles(files) {
    if (!files.length) return;
    files.forEach(file => {
      const id = FileUtils.newId();
      State.outQueue.push({ file, id });
      UI.addFileCard({ id, name:file.name, size:file.size, direction:'out' });
    });
    UI.updateQueueCount(State.outQueue.length);
    UI.setSendEnabled(State.connectedPeerIds.length > 0);
  },
};

document.addEventListener('DOMContentLoaded', () => App.init());