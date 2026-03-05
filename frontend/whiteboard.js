'use strict';

export const Whiteboard = (() => {

  // ── State ─────────────────────────────────────────────────
  let canvas, ctx, wrap;
  let tool     = 'pen';
  let color    = '#e2e8f0';
  let brushSize = 2;
  let drawing  = false;
  let startX   = 0, startY = 0;
  let lastX    = 0, lastY  = 0;
  let snapshot = null;

  const history  = [];
  const MAX_HIST = 40;
  const peers    = new Map();
  const COLORS   = ['#f97316','#00d4ff','#a78bfa','#4ade80','#fb7185','#fbbf24'];
  let colorIdx   = 0;

  // ── broadcastFn: simple module-level variable ─────────────
  // app.js sets:  Whiteboard.broadcastFn = fn
  // which triggers the setter defined in the returned object
  let _broadcastFn = null;

  function _broadcast(obj) {
    if (typeof _broadcastFn !== 'function') return;
    try {
      _broadcastFn(JSON.stringify({ _wb: true, ...obj }));
    } catch(e) {
      console.warn('[wb] broadcast error:', e);
    }
  }

  // ── Init ──────────────────────────────────────────────────
  function init() {
    wrap   = document.getElementById('wb-canvas-wrap');
    canvas = document.getElementById('wb-canvas');
    if (!canvas) { console.error('[wb] canvas not found'); return; }
    ctx = canvas.getContext('2d');
    resize();
    window.addEventListener('resize', resize);
    _bindToolbar();
    _bindCanvas();
    console.log('[wb] initialized');
  }

  function resize() {
    if (!canvas || !wrap) return;
    const snapshot_data = canvas.width > 0 && canvas.height > 0 ? canvas.toDataURL() : null;
    canvas.width  = wrap.clientWidth;
    canvas.height = wrap.clientHeight;
    _resetCtx();
    if (snapshot_data) {
      const img = new Image();
      img.onload = () => ctx.drawImage(img, 0, 0);
      img.src = snapshot_data;
    }
  }

  function _resetCtx() {
    ctx.lineCap   = 'round';
    ctx.lineJoin  = 'round';
    ctx.globalCompositeOperation = 'source-over';
    ctx.strokeStyle = color;
    ctx.fillStyle   = color;
    ctx.lineWidth   = brushSize;
  }

  // ── Toolbar ───────────────────────────────────────────────
  function _bindToolbar() {
    document.querySelectorAll('.wb-tool[data-tool]').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.wb-tool[data-tool]').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        tool = btn.dataset.tool;
        wrap.style.cursor = tool === 'text' ? 'text' : 'crosshair';
      });
    });

    document.querySelectorAll('.wb-size[data-size]').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.wb-size').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        brushSize = parseInt(btn.dataset.size);
      });
    });

    document.querySelectorAll('.wb-color[data-color]').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.wb-color').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        color = btn.dataset.color;
      });
    });

    const picker = document.getElementById('wb-color-custom');
    picker?.addEventListener('input', () => {
      document.querySelectorAll('.wb-color').forEach(b => b.classList.remove('active'));
      picker.closest('.wb-color--custom')?.classList.add('active');
      color = picker.value;
    });

    document.getElementById('wb-undo')?.addEventListener('click', _undo);
    document.getElementById('wb-clear')?.addEventListener('click', () => {
      _pushHistory();
      _clear();
      _broadcast({ type: 'clear' });
    });

    document.addEventListener('keydown', e => {
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
      if (!document.getElementById('panel-whiteboard')?.classList.contains('active')) return;
      const map = { p:'pen', e:'eraser', t:'text', r:'rect', c:'circle' };
      if (map[e.key]) document.querySelector(`.wb-tool[data-tool="${map[e.key]}"]`)?.click();
      if ((e.ctrlKey || e.metaKey) && e.key === 'z') { e.preventDefault(); _undo(); }
    });
  }

  // ── Canvas events ─────────────────────────────────────────
  function _bindCanvas() {
    canvas.addEventListener('pointerdown',  _onDown);
    canvas.addEventListener('pointermove',  _onMove);
    canvas.addEventListener('pointerup',    _onUp);
    canvas.addEventListener('pointerleave', _onLeave);
    canvas.addEventListener('click',        _onClick);
  }

  function _pos(e) {
    const r = canvas.getBoundingClientRect();
    return {
      x: (e.clientX - r.left) * (canvas.width  / r.width),
      y: (e.clientY - r.top)  * (canvas.height / r.height),
    };
  }

  function _onDown(e) {
    if (tool === 'text') return;
    const { x, y } = _pos(e);
    drawing = true;
    startX = lastX = x;
    startY = lastY = y;
    _pushHistory();
    if (tool === 'pen' || tool === 'eraser') {
      _applyPenCtx();
      ctx.beginPath();
      ctx.moveTo(x, y);
    } else {
      snapshot = ctx.getImageData(0, 0, canvas.width, canvas.height);
    }
  }

  function _onMove(e) {
    const { x, y } = _pos(e);
    // Always broadcast cursor
    _broadcast({ type: 'cursor', x: x / canvas.width, y: y / canvas.height });
    if (!drawing) return;

    if (tool === 'pen' || tool === 'eraser') {
      _applyPenCtx();
      ctx.lineTo(x, y);
      ctx.stroke();
      _broadcast({
        type: 'draw',
        tool,
        color,
        size: brushSize,
        fromX: lastX / canvas.width,
        fromY: lastY / canvas.height,
        toX:   x     / canvas.width,
        toY:   y     / canvas.height,
      });
      lastX = x; lastY = y;
    } else if (snapshot) {
      ctx.putImageData(snapshot, 0, 0);
      _drawShape(tool, startX, startY, x, y, color, brushSize);
    }
  }

  function _onUp(e) {
    if (!drawing) return;
    _finishStroke(e);
  }

  function _onLeave(e) {
    if (!drawing) return;
    _finishStroke(e);
  }

  function _finishStroke(e) {
    drawing = false;
    if ((tool === 'rect' || tool === 'circle') && snapshot && e) {
      const { x, y } = _pos(e);
      _broadcast({
        type: 'shape', tool, color, size: brushSize,
        x1: startX / canvas.width,  y1: startY / canvas.height,
        x2: x      / canvas.width,  y2: y      / canvas.height,
      });
      snapshot = null;
    }
    ctx.closePath();
    _resetCtx();
  }

  function _onClick(e) {
    if (tool !== 'text') return;
    const { x, y } = _pos(e);
    _showTextInput(x, y);
  }

  // ── Draw helpers ──────────────────────────────────────────
  function _applyPenCtx() {
    if (tool === 'eraser') {
      ctx.globalCompositeOperation = 'destination-out';
      ctx.strokeStyle = 'rgba(0,0,0,1)';
      ctx.lineWidth   = brushSize * 4;
    } else {
      ctx.globalCompositeOperation = 'source-over';
      ctx.strokeStyle = color;
      ctx.lineWidth   = brushSize;
    }
    ctx.lineCap  = 'round';
    ctx.lineJoin = 'round';
  }

  function _drawShape(shapeTool, x1, y1, x2, y2, col, sw) {
    ctx.globalCompositeOperation = 'source-over';
    ctx.strokeStyle = col;
    ctx.lineWidth   = sw;
    ctx.lineCap     = 'round';
    ctx.beginPath();
    if (shapeTool === 'rect') {
      ctx.strokeRect(x1, y1, x2 - x1, y2 - y1);
    } else if (shapeTool === 'circle') {
      const cx = (x1 + x2) / 2, cy = (y1 + y2) / 2;
      ctx.ellipse(cx, cy, Math.abs(x2-x1)/2, Math.abs(y2-y1)/2, 0, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.closePath();
  }

  function _drawText(text, x, y, col, fontSize) {
    ctx.globalCompositeOperation = 'source-over';
    ctx.fillStyle = col;
    ctx.font      = `${fontSize}px Sora, sans-serif`;
    ctx.fillText(text, x, y + fontSize);
  }

  function _clear() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
  }

  // ── Text input ────────────────────────────────────────────
  function _showTextInput(x, y) {
    const wrapEl = document.getElementById('wb-text-input-wrap');
    const ta     = document.getElementById('wb-text-input');
    wrapEl.style.left = x + 'px';
    wrapEl.style.top  = y + 'px';
    wrapEl.hidden = false;
    ta.value          = '';
    ta.style.color    = color;
    ta.style.fontSize = Math.max(14, brushSize * 4) + 'px';
    ta.focus();

    const fontSize = Math.max(14, brushSize * 4);
    const commit = () => {
      const text = ta.value.trim();
      if (text) {
        _pushHistory();
        _drawText(text, x, y, color, fontSize);
        _broadcast({ type: 'text', text, x: x / canvas.width, y: y / canvas.height, color, fontSize });
      }
      wrapEl.hidden = true;
      ta.removeEventListener('keydown', onKey);
    };
    const onKey = e => {
      if (e.key === 'Escape') {
        wrapEl.hidden = true;
        ta.removeEventListener('blur', commit);
        ta.removeEventListener('keydown', onKey);
      }
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); commit(); }
    };
    ta.addEventListener('blur',    commit, { once: true });
    ta.addEventListener('keydown', onKey);
  }

  // ── History / Undo ────────────────────────────────────────
  function _pushHistory() {
    if (!canvas.width || !canvas.height) return;
    history.push(ctx.getImageData(0, 0, canvas.width, canvas.height));
    if (history.length > MAX_HIST) history.shift();
  }

  function _undo() {
    if (!history.length) return;
    ctx.putImageData(history.pop(), 0, 0);
    _broadcast({ type: 'undo-snapshot', data: canvas.toDataURL() });
  }

  // ── Peer cursors ──────────────────────────────────────────
  function addPeer(peerId) {
    if (peers.has(peerId)) return;
    const col = COLORS[colorIdx++ % COLORS.length];
    const dot = document.createElement('div');
    dot.style.cssText = `position:absolute;width:10px;height:10px;border-radius:50%;background:${col};pointer-events:none;transform:translate(-50%,-50%);transition:left .06s linear,top .06s linear;z-index:5;display:none;box-shadow:0 0 6px ${col};`;
    wrap?.appendChild(dot);
    const leg = document.createElement('div');
    leg.className = 'wb-peer-cursor';
    leg.innerHTML = `<span class="wb-peer-cursor__dot" style="background:${col}"></span><span>${peerId.slice(0,4)}</span>`;
    document.getElementById('wb-peers')?.appendChild(leg);
    peers.set(peerId, { col, dot, leg });
    console.log('[wb] peer added:', peerId);
  }

  function removePeer(peerId) {
    const p = peers.get(peerId);
    if (!p) return;
    p.dot?.remove();
    p.leg?.remove();
    peers.delete(peerId);
  }

  function _moveCursor(peerId, nx, ny) {
    const p = peers.get(peerId);
    if (!p || !wrap) return;
    p.dot.style.display = 'block';
    p.dot.style.left = (nx * wrap.clientWidth)  + 'px';
    p.dot.style.top  = (ny * wrap.clientHeight) + 'px';
  }

  // ── Handle incoming peer messages ─────────────────────────
  // Called from app.js Receiver with already-parsed object (msg._wb === true)
  function handlePeerMessage(peerId, msg) {
    // Accept both raw string and already-parsed object
    if (typeof msg === 'string') {
      try { msg = JSON.parse(msg); } catch { return; }
    }
    if (!msg || !msg.type) return;

    switch (msg.type) {

      case 'cursor':
        _moveCursor(peerId, msg.x, msg.y);
        break;

      case 'draw': {
        const x1 = msg.fromX * canvas.width,  y1 = msg.fromY * canvas.height;
        const x2 = msg.toX   * canvas.width,  y2 = msg.toY   * canvas.height;
        if (msg.tool === 'eraser') {
          ctx.globalCompositeOperation = 'destination-out';
          ctx.strokeStyle = 'rgba(0,0,0,1)';
          ctx.lineWidth   = msg.size * 4;
        } else {
          ctx.globalCompositeOperation = 'source-over';
          ctx.strokeStyle = msg.color;
          ctx.lineWidth   = msg.size;
        }
        ctx.lineCap  = 'round';
        ctx.lineJoin = 'round';
        ctx.beginPath();
        ctx.moveTo(x1, y1);
        ctx.lineTo(x2, y2);
        ctx.stroke();
        _resetCtx();
        break;
      }

      case 'shape':
        _drawShape(msg.tool,
          msg.x1 * canvas.width,  msg.y1 * canvas.height,
          msg.x2 * canvas.width,  msg.y2 * canvas.height,
          msg.color, msg.size);
        break;

      case 'text':
        _drawText(msg.text,
          msg.x * canvas.width, msg.y * canvas.height,
          msg.color, msg.fontSize);
        break;

      case 'clear':
        _clear();
        break;

      case 'undo-snapshot': {
        const img = new Image();
        img.onload = () => { _clear(); ctx.drawImage(img, 0, 0); };
        img.src = msg.data;
        break;
      }

      case 'sync-request':
        // Peer joined and wants the current board state
        console.log('[wb] sync-request from', peerId);
        _broadcast({ type: 'sync-state', data: canvas.toDataURL() });
        break;

      case 'sync-state': {
        console.log('[wb] sync-state received');
        const img = new Image();
        img.onload = () => { _clear(); ctx.drawImage(img, 0, 0); };
        img.src = msg.data;
        break;
      }
    }
  }

  function requestSync() {
    console.log('[wb] requesting sync from peers');
    _broadcast({ type: 'sync-request' });
  }

  // ── Public API ────────────────────────────────────────────
  return {
    init,
    resize,
    handlePeerMessage,
    requestSync,
    addPeer,
    removePeer,
    get broadcastFn()    { return _broadcastFn; },
    set broadcastFn(fn)  { _broadcastFn = fn; console.log('[wb] broadcastFn set:', typeof fn); },
  };

})();