'use strict';

export const Whiteboard = (() => {

  // ── State ─────────────────────────────────────────────────
  let canvas, ctx, wrap;
  let tool = 'pen';
  let color = '#e2e8f0';
  let brushSize = 2;
  let drawing = false;
  let startX = 0, startY = 0;
  let lastX = 0, lastY = 0;
  let snapshot = null;
  
  // Pan & Zoom state
  let panX = 0, panY = 0;
  let zoomLevel = 1;
  let isPanning = false;
  let panStartX = 0, panStartY = 0;
  const MIN_ZOOM = 0.1;  // Infinite zoom: zoom out to 10%
  const MAX_ZOOM = 10;   // Infinite zoom: zoom in to 1000%

  const history = [];
  const MAX_HIST = 40;
  const peers = new Map();   // Map<peerId, { col, dot, leg, path: {lastX,lastY,drawing} }>
  const COLORS = ['#f97316', '#00d4ff', '#a78bfa', '#4ade80', '#fb7185', '#fbbf24'];
  let colorIdx = 0;

  // ── broadcastFn: simple module-level variable ─────────────
  // app.js sets:  Whiteboard.broadcastFn = fn
  // which triggers the setter defined in the returned object
  let _broadcastFn = null;

  function _broadcast(obj) {
    if (typeof _broadcastFn !== 'function') return;
    try {
      _broadcastFn(JSON.stringify({ _wb: true, ...obj }));
    } catch (e) {
      console.warn('[wb] broadcast error:', e);
    }
  }

  // ── Init ──────────────────────────────────────────────────
  function init() {
    wrap = document.getElementById('wb-canvas-wrap');
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
    const cw = wrap.clientWidth;
    const ch = wrap.clientHeight;
    if (cw === 0 || ch === 0) {
      console.warn('[wb] resize deferred: wrap is 0x0');
      return;
    }

    console.log(`[wb] resizing to ${cw}x${ch}`);
    const snapshot_data = canvas.width > 0 && canvas.height > 0 ? canvas.toDataURL() : null;
    // Set canvas to display size for zooming/panning
    canvas.width = cw;
    canvas.height = ch;
    _resetCtx();
    if (snapshot_data) {
      const img = new Image();
      img.onload = () => _redraw(img);
      img.src = snapshot_data;
    }
  }
  
  function _redraw(img) {
    ctx.save();
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.translate(panX, panY);
    ctx.scale(zoomLevel, zoomLevel);
    ctx.drawImage(img, 0, 0, img.width / zoomLevel, img.height / zoomLevel);
    ctx.restore();
  }

  function _resetCtx() {
    ctx.setTransform(1, 0, 0, 1, 0, 0); // Reset transform
    ctx.translate(panX, panY);
    ctx.scale(zoomLevel, zoomLevel);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.globalCompositeOperation = 'source-over';
    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    ctx.lineWidth = brushSize;
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

    // New size control with +/- buttons
    const sizeDecBtn = document.getElementById('wb-size-dec');
    const sizeIncBtn = document.getElementById('wb-size-inc');
    const sizeDisplay = document.getElementById('wb-size-display');
    
    const updateSizeDisplay = () => {
      if (sizeDisplay) sizeDisplay.textContent = brushSize;
    };
    
    if (sizeDecBtn) {
      sizeDecBtn.addEventListener('click', () => {
        brushSize = Math.max(1, brushSize - 1);
        updateSizeDisplay();
      });
    }
    
    if (sizeIncBtn) {
      sizeIncBtn.addEventListener('click', () => {
        brushSize = Math.min(30, brushSize + 1);
        updateSizeDisplay();
      });
    }
    
    updateSizeDisplay();

    // Zoom controls
    const zoomInBtn = document.getElementById('wb-zoom-in');
    const zoomOutBtn = document.getElementById('wb-zoom-out');
    const zoomDisplay = document.getElementById('wb-zoom-display');
    
    const updateZoomDisplay = () => {
      if (zoomDisplay) zoomDisplay.textContent = Math.round(zoomLevel * 100) + '%';
    };
    
    if (zoomInBtn) {
      zoomInBtn.addEventListener('click', () => {
        const oldZoom = zoomLevel;
        zoomLevel = Math.min(MAX_ZOOM, zoomLevel * 1.2);  // 20% zoom increment (exponential)
        if (zoomLevel !== oldZoom) {
          _resetCtx();
          updateZoomDisplay();
        }
      });
    }
    
    if (zoomOutBtn) {
      zoomOutBtn.addEventListener('click', () => {
        const oldZoom = zoomLevel;
        zoomLevel = Math.max(MIN_ZOOM, zoomLevel / 1.2);  // 20% zoom decrement (exponential)
        if (zoomLevel !== oldZoom) {
          _resetCtx();
          updateZoomDisplay();
        }
      });
    }
    
    updateZoomDisplay();

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
      const map = { p: 'pen', e: 'eraser', t: 'text', r: 'rect', c: 'circle' };
      if (map[e.key]) document.querySelector(`.wb-tool[data-tool="${map[e.key]}"]`)?.click();
      if ((e.ctrlKey || e.metaKey) && e.key === 'z') { e.preventDefault(); _undo(); }
      // Zoom with +/- keys
      if (e.key === '=' || e.key === '+') { e.preventDefault(); zoomInBtn?.click(); }
      if (e.key === '-' || e.key === '_') { e.preventDefault(); zoomOutBtn?.click(); }
    });
  }

  // ── Canvas events ─────────────────────────────────────────
  function _bindCanvas() {
    canvas.addEventListener('pointerdown', _onDown);
    canvas.addEventListener('pointermove', _onMove);
    canvas.addEventListener('pointerup', _onUp);
    canvas.addEventListener('pointerleave', _onLeave);
    canvas.addEventListener('click', _onClick);
    
    // Pan with middle mouse button or spacebar+drag
    canvas.addEventListener('pointerdown', (e) => {
      if (e.button === 1 || (e.pointerType === 'mouse' && e.button === 2)) { // Middle or right click
        isPanning = true;
        const r = canvas.getBoundingClientRect();
        panStartX = (e.clientX - r.left) - panX;
        panStartY = (e.clientY - r.top) - panY;
        e.preventDefault();
      }
    });
    
    canvas.addEventListener('pointermove', (e) => {
      if (isPanning && e.buttons & 4) { // Middle button held
        const r = canvas.getBoundingClientRect();
        panX = (e.clientX - r.left) - panStartX;
        panY = (e.clientY - r.top) - panStartY;
        _resetCtx();
      }
    });
    
    canvas.addEventListener('pointerup', () => {
      isPanning = false;
    });
    
    // Zoom with mouse wheel
    canvas.addEventListener('wheel', (e) => {
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        const delta = e.deltaY > 0 ? 1 / 1.2 : 1.2;  // 20% zoom increment (exponential)
        zoomLevel = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, zoomLevel * delta));
        _resetCtx();
        const zoomDisplay = document.getElementById('wb-zoom-display');
        if (zoomDisplay) zoomDisplay.textContent = Math.round(zoomLevel * 100) + '%';
      }
    }, { passive: false });
  }

  function _pos(e) {
    const r = canvas.getBoundingClientRect();
    const screenX = (e.clientX - r.left) * (canvas.width / r.width);
    const screenY = (e.clientY - r.top) * (canvas.height / r.height);
    // Convert screen coords to canvas coords accounting for pan/zoom
    return {
      x: (screenX - panX) / zoomLevel,
      y: (screenY - panY) / zoomLevel,
    };
  }

  function _onDown(e) {
    if (isPanning || tool === 'text') return;
    if (canvas.width === 0 || canvas.height === 0) {
      console.warn('[wb] skip drawing: canvas is 0x0');
      resize();
      if (canvas.width === 0) return;
    }
    const { x, y } = _pos(e);
    drawing = true;
    startX = lastX = x;
    startY = lastY = y;
    _pushHistory();
    if (tool === 'pen' || tool === 'eraser') {
      _applyPenCtx();
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.stroke();
    } else {
      try {
        // Save image data without transform
        ctx.save();
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        snapshot = ctx.getImageData(0, 0, canvas.width, canvas.height);
        ctx.restore();
      } catch (err) {
        console.error('[wb] getImageData failed:', err);
        snapshot = null;
      }
    }
  }

  function _onMove(e) {
    const { x, y } = _pos(e);
    if (canvas.width === 0 || canvas.height === 0) return;
    // Broadcast cursor as canvas coordinates relative to view
    const screenX = x * zoomLevel + panX;
    const screenY = y * zoomLevel + panY;
    _broadcast({ type: 'cursor', x: screenX / canvas.width, y: screenY / canvas.height });
    if (!drawing || isPanning) return;

    if (tool === 'pen' || tool === 'eraser') {
      _applyPenCtx();
      ctx.beginPath();
      ctx.moveTo(lastX, lastY);
      ctx.lineTo(x, y);
      ctx.stroke();
      _broadcast({
        type: 'draw',
        tool,
        color,
        size: brushSize,
        fromX: lastX,
        fromY: lastY,
        toX: x,
        toY: y,
        zoom: zoomLevel,
      });
      lastX = x; lastY = y;
    } else if (snapshot) {
      ctx.save();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.putImageData(snapshot, 0, 0);
      ctx.restore();
      ctx.translate(panX, panY);
      ctx.scale(zoomLevel, zoomLevel);
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
        x1: startX,
        y1: startY,
        x2: x,
        y2: y,
        zoom: zoomLevel,
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
      ctx.lineWidth = brushSize * 4 / zoomLevel;
    } else {
      ctx.globalCompositeOperation = 'source-over';
      ctx.strokeStyle = color;
      ctx.lineWidth = brushSize / zoomLevel;
    }
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
  }

  function _drawShape(shapeTool, x1, y1, x2, y2, col, sw) {
    ctx.globalCompositeOperation = 'source-over';
    ctx.strokeStyle = col;
    ctx.lineWidth = sw;
    ctx.lineCap = 'round';
    ctx.beginPath();
    if (shapeTool === 'rect') {
      ctx.strokeRect(x1, y1, x2 - x1, y2 - y1);
    } else if (shapeTool === 'circle') {
      const cx = (x1 + x2) / 2, cy = (y1 + y2) / 2;
      ctx.ellipse(cx, cy, Math.abs(x2 - x1) / 2, Math.abs(y2 - y1) / 2, 0, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.closePath();
  }

  function _drawText(text, x, y, col, fontSize) {
    ctx.globalCompositeOperation = 'source-over';
    ctx.fillStyle = col;
    ctx.font = `${fontSize}px Sora, sans-serif`;
    ctx.fillText(text, x, y + fontSize);
  }

  function _clear() {
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.restore();
  }

  // ── Text input ────────────────────────────────────────────
  function _showTextInput(x, y) {
    const wrapEl = document.getElementById('wb-text-input-wrap');
    const ta = document.getElementById('wb-text-input');
    wrapEl.style.left = x + 'px';
    wrapEl.style.top = y + 'px';
    wrapEl.hidden = false;
    ta.value = '';
    ta.style.color = color;
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
    ta.addEventListener('blur', commit, { once: true });
    ta.addEventListener('keydown', onKey);
  }

  // ── History / Undo ────────────────────────────────────────
  function _pushHistory() {
    if (!canvas.width || !canvas.height) return;
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    history.push(ctx.getImageData(0, 0, canvas.width, canvas.height));
    ctx.restore();
    if (history.length > MAX_HIST) history.shift();
  }

  function _undo() {
    if (!history.length) return;
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.putImageData(history.pop(), 0, 0);
    ctx.restore();
    _broadcast({ type: 'undo-snapshot', data: canvas.toDataURL() });
  }

  // ── Peer cursors ──────────────────────────────────────────
  function addPeer(peerId, sendFn) {
    if (peers.has(peerId)) return;
    const col = COLORS[colorIdx++ % COLORS.length];
    const dot = document.createElement('div');
    dot.style.cssText = `position:absolute;width:10px;height:10px;border-radius:50%;background:${col};pointer-events:none;transform:translate(-50%,-50%);transition:left .06s linear,top .06s linear;z-index:5;display:none;box-shadow:0 0 6px ${col};`;
    wrap?.appendChild(dot);
    const leg = document.createElement('div');
    leg.className = 'wb-peer-cursor';
    leg.innerHTML = `<span class="wb-peer-cursor__dot" style="background:${col}"></span><span>${peerId.slice(0, 4)}</span>`;
    document.getElementById('wb-peers')?.appendChild(leg);
    // sendFn: direct-send to only this peer (for targeted sync-state reply)
    peers.set(peerId, { col, dot, leg, sendFn: sendFn || null, path: { drawing: false, lastX: 0, lastY: 0 } });
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
    // nx, ny are normalized canvas coordinates (0-1 range)
    p.dot.style.left = (nx * canvas.width) + 'px';
    p.dot.style.top = (ny * canvas.height) + 'px';
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
        ctx.save();
        const x1 = msg.fromX, y1 = msg.fromY;
        const x2 = msg.toX, y2 = msg.toY;
        ctx.translate(panX, panY);
        ctx.scale(msg.zoom || 1, msg.zoom || 1);
        if (msg.tool === 'eraser') {
          ctx.globalCompositeOperation = 'destination-out';
          ctx.strokeStyle = 'rgba(0,0,0,1)';
          ctx.lineWidth = msg.size * 4 / (msg.zoom || 1);
        } else {
          ctx.globalCompositeOperation = 'source-over';
          ctx.strokeStyle = msg.color;
          ctx.lineWidth = msg.size / (msg.zoom || 1);
        }
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        ctx.beginPath();
        ctx.moveTo(x1, y1);
        ctx.lineTo(x2, y2);
        ctx.stroke();
        ctx.restore();
        break;
      }

      case 'shape':
        ctx.save();
        ctx.translate(panX, panY);
        ctx.scale(msg.zoom || 1, msg.zoom || 1);
        _drawShape(msg.tool,
          msg.x1, msg.y1, msg.x2, msg.y2,
          msg.color, msg.size);
        ctx.restore();
        break;

      case 'text':
        ctx.save();
        ctx.translate(panX, panY);
        ctx.scale(msg.zoom || 1, msg.zoom || 1);
        _drawText(msg.text, msg.x, msg.y, msg.color, msg.fontSize);
        ctx.restore();
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

      case 'sync-request': {
        // Send the board state ONLY back to the requesting peer (not broadcast to all)
        console.log('[wb] sync-request from', peerId);
        const peer = peers.get(peerId);
        const syncPayload = JSON.stringify({ _wb: true, type: 'sync-state', data: canvas.toDataURL() });
        if (peer?.sendFn) {
          // Direct send to requesting peer only
          try { peer.sendFn(syncPayload); } catch (e) { console.warn('[wb] sync-state direct send failed:', e); }
        } else {
          // Fallback: broadcast (old behavior, works with 2 peers)
          _broadcast({ type: 'sync-state', data: canvas.toDataURL() });
        }
        break;
      }

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
    get broadcastFn() { return _broadcastFn; },
    set broadcastFn(fn) { _broadcastFn = fn; console.log('[wb] broadcastFn set:', typeof fn); },
  };

})();