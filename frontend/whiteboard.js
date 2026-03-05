/**
 * Sochau Share — Whiteboard Module
 *
 * Collaborative canvas synced in real-time over WebRTC DataChannel.
 * Tools: pen, eraser, text, rect, circle
 * Sync: drawing operations broadcast as JSON events to all peers.
 *
 * API (called by app.js):
 *   Whiteboard.init(canvasWrap)
 *   Whiteboard.handlePeerMessage(peerId, data)  ← called from Receiver
 *   Whiteboard.broadcastFn = (data) => {}       ← set by app.js to send to all peers
 *   Whiteboard.addPeer(peerId, color)
 *   Whiteboard.removePeer(peerId)
 *   Whiteboard.resize()
 */

'use strict';

export const Whiteboard = (() => {

  // ── State ────────────────────────────────────────────────
  let canvas, ctx, wrap;
  let tool     = 'pen';
  let color    = '#e2e8f0';
  let size     = 2;
  let drawing  = false;
  let startX   = 0, startY  = 0;
  let lastX    = 0, lastY   = 0;

  // Snapshot for shape preview
  let snapshot = null;

  // Stroke history for undo
  const history = [];      // each entry: ImageData
  const MAX_HISTORY = 40;

  // Peer cursors: Map<peerId, { x, y, color, el }>
  const peers = new Map();

  // Peer colors (assigned on join)
  const PEER_COLORS = ['#f97316','#22d3ee','#a78bfa','#4ade80','#fb7185','#fbbf24'];
  let peerColorIdx = 0;

  // ── Broadcast fn (set by app.js) ─────────────────────────
  let broadcastFn = null;
  function broadcast(data) {
    if (broadcastFn) broadcastFn(JSON.stringify({ _wb: true, ...data }));
  }

  // ── Init ─────────────────────────────────────────────────
  function init() {
    wrap   = document.getElementById('wb-canvas-wrap');
    canvas = document.getElementById('wb-canvas');
    ctx    = canvas.getContext('2d');

    resize();
    window.addEventListener('resize', resize);

    _bindToolbar();
    _bindCanvas();
  }

  function resize() {
    if (!canvas) return;
    // Save current drawing
    const img = canvas.toDataURL();
    canvas.width  = wrap.clientWidth;
    canvas.height = wrap.clientHeight;
    // Restore
    const image = new Image();
    image.onload = () => ctx.drawImage(image, 0, 0);
    image.src = img;
    _setCtxDefaults();
  }

  function _setCtxDefaults() {
    ctx.lineCap     = 'round';
    ctx.lineJoin    = 'round';
    ctx.strokeStyle = color;
    ctx.lineWidth   = size;
  }

  // ── Toolbar bindings ─────────────────────────────────────
  function _bindToolbar() {
    // Tool buttons
    document.querySelectorAll('.wb-tool[data-tool]').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.wb-tool[data-tool]').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        tool = btn.dataset.tool;
        wrap.style.cursor = tool === 'text' ? 'text' : 'crosshair';
      });
    });

    // Size buttons
    document.querySelectorAll('.wb-size[data-size]').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.wb-size').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        size = parseInt(btn.dataset.size);
        ctx.lineWidth = size;
      });
    });

    // Color swatches
    document.querySelectorAll('.wb-color[data-color]').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.wb-color').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        color = btn.dataset.color;
        ctx.strokeStyle = color;
        ctx.fillStyle   = color;
      });
    });

    // Custom color
    const customInput = document.getElementById('wb-color-custom');
    customInput?.addEventListener('input', () => {
      document.querySelectorAll('.wb-color').forEach(b => b.classList.remove('active'));
      customInput.closest('.wb-color--custom').classList.add('active');
      color = customInput.value;
      ctx.strokeStyle = color;
      ctx.fillStyle   = color;
    });

    // Undo
    document.getElementById('wb-undo')?.addEventListener('click', undo);

    // Clear
    document.getElementById('wb-clear')?.addEventListener('click', () => {
      _pushHistory();
      _clearCanvas();
      broadcast({ type: 'clear' });
    });

    // Keyboard shortcuts
    document.addEventListener('keydown', e => {
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
      if (!document.getElementById('panel-whiteboard').classList.contains('active')) return;
      const map = { p:'pen', e:'eraser', t:'text', r:'rect', c:'circle' };
      if (map[e.key]) {
        document.querySelector(`.wb-tool[data-tool="${map[e.key]}"]`)?.click();
      }
      if ((e.ctrlKey || e.metaKey) && e.key === 'z') { e.preventDefault(); undo(); }
    });
  }

  // ── Canvas events ─────────────────────────────────────────
  function _bindCanvas() {
    canvas.addEventListener('pointerdown', onDown);
    canvas.addEventListener('pointermove', onMove);
    canvas.addEventListener('pointerup',   onUp);
    canvas.addEventListener('pointerleave',onUp);
    canvas.addEventListener('click', onClick);
  }

  function _getPos(e) {
    const r = canvas.getBoundingClientRect();
    return {
      x: (e.clientX - r.left) * (canvas.width  / r.width),
      y: (e.clientY - r.top)  * (canvas.height / r.height),
    };
  }

  function onDown(e) {
    if (tool === 'text') return; // handled by onClick
    const { x, y } = _getPos(e);
    drawing = true;
    startX = lastX = x;
    startY = lastY = y;

    _pushHistory();

    if (tool === 'pen' || tool === 'eraser') {
      ctx.beginPath();
      ctx.moveTo(x, y);
      _applyTool();
    } else {
      // Save snapshot for shape preview
      snapshot = ctx.getImageData(0, 0, canvas.width, canvas.height);
    }
  }

  function onMove(e) {
    const { x, y } = _getPos(e);

    // Broadcast cursor position
    broadcast({ type: 'cursor', x: x / canvas.width, y: y / canvas.height });

    if (!drawing) return;

    if (tool === 'pen' || tool === 'eraser') {
      _applyTool();
      ctx.lineTo(x, y);
      ctx.stroke();
      broadcast({ type: 'draw', tool, color: tool === 'eraser' ? '#bg' : color, size, fromX: lastX / canvas.width, fromY: lastY / canvas.height, toX: x / canvas.width, toY: y / canvas.height });
      lastX = x; lastY = y;
    } else if (snapshot) {
      // Shape preview
      ctx.putImageData(snapshot, 0, 0);
      _drawShape(tool, startX, startY, x, y);
    }
  }

  function onUp(e) {
    if (!drawing) return;
    drawing = false;
    const { x, y } = _getPos(e);

    if ((tool === 'rect' || tool === 'circle') && snapshot) {
      broadcast({
        type: 'shape', tool, color, size,
        x1: startX / canvas.width, y1: startY / canvas.height,
        x2: x / canvas.width,      y2: y / canvas.height,
      });
      snapshot = null;
    }
    ctx.closePath();
  }

  function onClick(e) {
    if (tool !== 'text') return;
    const { x, y } = _getPos(e);
    _showTextInput(x, y);
  }

  // ── Drawing helpers ───────────────────────────────────────
  function _applyTool() {
    if (tool === 'eraser') {
      ctx.globalCompositeOperation = 'destination-out';
      ctx.strokeStyle = 'rgba(0,0,0,1)';
      ctx.lineWidth   = size * 4;
    } else {
      ctx.globalCompositeOperation = 'source-over';
      ctx.strokeStyle = color;
      ctx.lineWidth   = size;
    }
  }

  function _drawShape(shapeTool, x1, y1, x2, y2, col = color, sw = size) {
    ctx.globalCompositeOperation = 'source-over';
    ctx.strokeStyle = col;
    ctx.lineWidth   = sw;
    ctx.beginPath();
    if (shapeTool === 'rect') {
      ctx.strokeRect(x1, y1, x2 - x1, y2 - y1);
    } else if (shapeTool === 'circle') {
      const rx = Math.abs(x2 - x1) / 2;
      const ry = Math.abs(y2 - y1) / 2;
      const cx = x1 + (x2 - x1) / 2;
      const cy = y1 + (y2 - y1) / 2;
      ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
      ctx.stroke();
    }
  }

  function _clearCanvas() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
  }

  // ── Text tool ─────────────────────────────────────────────
  function _showTextInput(x, y) {
    const wrap2 = document.getElementById('wb-text-input-wrap');
    const ta    = document.getElementById('wb-text-input');

    wrap2.style.left = x + 'px';
    wrap2.style.top  = y + 'px';
    wrap2.hidden = false;
    ta.value = '';
    ta.style.color    = color;
    ta.style.fontSize = Math.max(14, size * 4) + 'px';
    ta.focus();

    const commit = () => {
      const text = ta.value.trim();
      if (text) {
        _pushHistory();
        _drawText(text, x, y, color, Math.max(14, size * 4));
        broadcast({
          type: 'text', text,
          x: x / canvas.width, y: y / canvas.height,
          color, fontSize: Math.max(14, size * 4),
        });
      }
      wrap2.hidden = true;
      ta.removeEventListener('blur', commit);
      ta.removeEventListener('keydown', onKey);
    };

    const onKey = (e) => {
      if (e.key === 'Escape') { wrap2.hidden = true; ta.removeEventListener('blur', commit); ta.removeEventListener('keydown', onKey); }
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); commit(); }
    };

    ta.addEventListener('blur',   commit,  { once: true });
    ta.addEventListener('keydown', onKey);
  }

  function _drawText(text, x, y, col, fontSize) {
    ctx.globalCompositeOperation = 'source-over';
    ctx.fillStyle = col;
    ctx.font = `${fontSize}px ${getComputedStyle(document.documentElement).getPropertyValue('--font-body')}`;
    ctx.fillText(text, x, y + fontSize);
  }

  // ── History / Undo ────────────────────────────────────────
  function _pushHistory() {
    history.push(ctx.getImageData(0, 0, canvas.width, canvas.height));
    if (history.length > MAX_HISTORY) history.shift();
  }

  function undo() {
    if (!history.length) return;
    ctx.putImageData(history.pop(), 0, 0);
    broadcast({ type: 'undo-snapshot', data: canvas.toDataURL() });
  }

  // ── Peer cursors ──────────────────────────────────────────
  function addPeer(peerId) {
    const peerColor = PEER_COLORS[peerColorIdx % PEER_COLORS.length];
    peerColorIdx++;

    // Cursor dot overlay
    const dot = document.createElement('div');
    dot.style.cssText = `position:absolute;width:10px;height:10px;border-radius:50%;background:${peerColor};pointer-events:none;transform:translate(-50%,-50%);transition:left .05s,top .05s;z-index:5;`;
    wrap?.appendChild(dot);

    // Peer legend
    const legend = document.getElementById('wb-peers');
    const el = document.createElement('div');
    el.className = 'wb-peer-cursor';
    el.innerHTML = `<span class="wb-peer-cursor__dot" style="background:${peerColor}"></span><span>${peerId.slice(0,4)}</span>`;
    legend?.appendChild(el);

    peers.set(peerId, { color: peerColor, dot, legendEl: el });
  }

  function removePeer(peerId) {
    const p = peers.get(peerId);
    if (!p) return;
    p.dot?.remove();
    p.legendEl?.remove();
    peers.delete(peerId);
  }

  function _updateCursor(peerId, nx, ny) {
    const p = peers.get(peerId);
    if (!p || !wrap) return;
    p.dot.style.left = (nx * wrap.clientWidth)  + 'px';
    p.dot.style.top  = (ny * wrap.clientHeight) + 'px';
  }

  // ── Incoming peer messages ────────────────────────────────
  function handlePeerMessage(peerId, raw) {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    if (!msg._wb) return;

    switch (msg.type) {
      case 'cursor':
        _updateCursor(peerId, msg.x, msg.y);
        break;

      case 'draw': {
        const x1 = msg.fromX * canvas.width,  y1 = msg.fromY * canvas.height;
        const x2 = msg.toX   * canvas.width,  y2 = msg.toY   * canvas.height;
        ctx.globalCompositeOperation = msg.tool === 'eraser' ? 'destination-out' : 'source-over';
        ctx.strokeStyle = msg.tool === 'eraser' ? 'rgba(0,0,0,1)' : msg.color;
        ctx.lineWidth   = msg.tool === 'eraser' ? msg.size * 4 : msg.size;
        ctx.lineCap = 'round'; ctx.lineJoin = 'round';
        ctx.beginPath();
        ctx.moveTo(x1, y1);
        ctx.lineTo(x2, y2);
        ctx.stroke();
        break;
      }

      case 'shape': {
        const x1 = msg.x1 * canvas.width,  y1 = msg.y1 * canvas.height;
        const x2 = msg.x2 * canvas.width,  y2 = msg.y2 * canvas.height;
        _drawShape(msg.tool, x1, y1, x2, y2, msg.color, msg.size);
        break;
      }

      case 'text': {
        const tx = msg.x * canvas.width, ty = msg.y * canvas.height;
        _drawText(msg.text, tx, ty, msg.color, msg.fontSize);
        break;
      }

      case 'clear':
        _clearCanvas();
        break;

      case 'undo-snapshot': {
        const img = new Image();
        img.onload = () => { _clearCanvas(); ctx.drawImage(img, 0, 0); };
        img.src = msg.data;
        break;
      }

      case 'sync-request':
        // Peer joined and wants the current canvas state
        broadcast({ type: 'sync-state', data: canvas.toDataURL() });
        break;

      case 'sync-state': {
        const img = new Image();
        img.onload = () => { _clearCanvas(); ctx.drawImage(img, 0, 0); };
        img.src = msg.data;
        break;
      }
    }
  }

  // Called when we join an existing room — ask for current state
  function requestSync() {
    broadcast({ type: 'sync-request' });
  }

  // ── Public API ────────────────────────────────────────────
  return {
    init,
    resize,
    handlePeerMessage,
    requestSync,
    addPeer,
    removePeer,
    set broadcastFn(fn) { broadcastFn = fn; },
  };

})();