/** The atlas camera is a view preference, independent of the hero's actions. */
const WorldMap = (() => {
  const BASE_WIDTH = 250, DRAG_THRESHOLD = 6, MAX_ZOOM = 2.5;
  let sourceState = null, svgElement = null, camera = null, dragging = null, completedGesture = null;
  let resizeObserver = null, previousSize = '';
  const text = (en, zh) => getLang() === 'zh' ? zh : en;
  const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

  function bounds() {
    const rooms = Object.values(WORLD_ROOMS).filter(r => Number.isFinite(r.x) && Number.isFinite(r.y));
    const points = rooms.length ? rooms : [{ x: 0, y: 0 }];
    // Include marker rings, boss symbols and the longest visible room labels.
    return {
      left: Math.min(...points.map(r => r.x)) - 64,
      right: Math.max(...points.map(r => r.x)) + 64,
      top: Math.min(...points.map(r => r.y)) - 32,
      bottom: Math.max(...points.map(r => r.y)) + 32
    };
  }
  function ensureCamera() {
    if (!camera || sourceState !== state) {
      sourceState = state;
      const room = WORLD_ROOMS[state.world.currentRoom] || WORLD_ROOMS.r_town_square;
      const savedZoom = Number(state.mapZoom);
      camera = { mode: 'follow', centerX: room.x, centerY: room.y,
        zoom: Number.isFinite(savedZoom) ? clamp(savedZoom, .55, MAX_ZOOM) : 1 };
      dragging = null; completedGesture = null;
      svgElement?.removeAttribute('data-dragging');
    }
    return camera;
  }
  function geometry(svg = svgElement) {
    const c = ensureCamera(), room = WORLD_ROOMS[state.world.currentRoom] || WORLD_ROOMS.r_town_square;
    const rect = svg?.getBoundingClientRect();
    const aspect = rect?.width > 0 && rect?.height > 0 ? rect.width / rect.height : 250 / 150;
    const b = bounds(), widthOfMap = b.right - b.left, heightOfMap = b.bottom - b.top;
    const fitZoom = BASE_WIDTH / Math.max(widthOfMap, heightOfMap * aspect);
    if (c.mode === 'fit') {
      c.zoom = fitZoom; c.centerX = (b.left + b.right) / 2; c.centerY = (b.top + b.bottom) / 2;
    } else if (c.mode === 'follow') {
      c.centerX = room.x; c.centerY = room.y;
    }
    const width = BASE_WIDTH / c.zoom, height = width / aspect;
    if (c.mode === 'free') {
      // At least part of the map stays visible. Wide views keep the full axis centered.
      c.centerX = width >= widthOfMap ? (b.left + b.right) / 2 : clamp(c.centerX, b.left + width * .15, b.right - width * .15);
      c.centerY = height >= heightOfMap ? (b.top + b.bottom) / 2 : clamp(c.centerY, b.top + height * .15, b.bottom - height * .15);
    }
    return { x: c.centerX - width / 2, y: c.centerY - height / 2, width, height,
      centerX: c.centerX, centerY: c.centerY, zoom: c.zoom, mode: c.mode, fitZoom };
  }
  function updateLabels(svg, view) {
    const label = document.getElementById('map-view-mode');
    if (label) label.textContent = view.mode === 'follow' ? text('🎯 Follow hero', '🎯 跟随角色')
      : view.mode === 'fit' ? text('▣ Full map', '▣ 全图') : text('✋ Free view', '✋ 自由查看');
    const hint = document.getElementById('map-interaction-hint');
    if (hint) hint.textContent = text('Drag to explore · wheel to zoom · click a place to travel. Arrow keys pan; Home follows your hero; F fits the map.', '拖动查看 · 滚轮缩放 · 点击地点寻路。方向键平移；Home 回到角色；F 显示全图。');
    const labels = [
      ['btn-map-zoom-in', null, text('Zoom in', '放大地图')],
      ['btn-map-zoom-out', null, text('Zoom out', '缩小地图')],
      ['btn-map-reset-zoom', text('🎯 Hero', '🎯 角色'), text('Follow hero at normal zoom', '回到角色并恢复标准缩放')],
      ['btn-map-fit-all', text('▣ Fit all', '▣ 全图'), text('Show every location, including the frontier', '显示所有地点，包含新开拓区域')]
    ];
    for (const [id, caption, title] of labels) {
      const el = document.getElementById(id); if (!el) continue;
      if (caption) el.textContent = caption;
      el.title = title; el.setAttribute('aria-label', title);
    }
    svg.setAttribute('aria-label', text('Interactive world map', '可拖动的世界地图'));
    svg.setAttribute('data-map-mode', view.mode);
  }
  function redraw() { if (typeof renderWorldMinimap === 'function') renderWorldMinimap(); }
  function centerOnHero() {
    const c = ensureCamera(); c.mode = 'follow'; c.zoom = 1;
    redraw();
  }
  function fitAll() { ensureCamera().mode = 'fit'; redraw(); }
  function panBy(dx, dy) {
    if (!Number.isFinite(dx) || !Number.isFinite(dy)) return false;
    const view = geometry(), c = ensureCamera();
    c.mode = 'free'; c.centerX = view.centerX + dx; c.centerY = view.centerY + dy;
    redraw(); return true;
  }
  function zoom(delta, anchor = null) {
    if (!Number.isFinite(delta) || delta === 0) return false;
    const before = geometry(), c = ensureCamera();
    c.zoom = clamp(before.zoom * Math.pow(1.4, delta / .25), Math.min(.55, before.fitZoom * .8), MAX_ZOOM);
    if (c.mode === 'fit') c.mode = 'free';
    if (anchor) {
      const rect = svgElement?.getBoundingClientRect();
      if (rect?.width && rect?.height) {
        // SVG uses xMidYMid meet. Account for any letterboxing in the conversion.
        const scale = Math.min(rect.width / before.width, rect.height / before.height);
        const offsetX = (rect.width - before.width * scale) / 2;
        const offsetY = (rect.height - before.height * scale) / 2;
        const x = before.x + (anchor.x - rect.left - offsetX) / scale;
        const y = before.y + (anchor.y - rect.top - offsetY) / scale;
        c.mode = 'free';
        c.centerX = x - (x - before.centerX) * before.zoom / c.zoom;
        c.centerY = y - (y - before.centerY) * before.zoom / c.zoom;
      }
    }
    redraw(); return true;
  }
  function roomFromTarget(target) {
    const marker = target?.closest?.('[data-map-room]');
    return marker && svgElement?.contains?.(marker) ? marker.getAttribute('data-map-room') : null;
  }
  function releasePointer(svg, id) {
    try { if (svg.hasPointerCapture?.(id)) svg.releasePointerCapture(id); } catch (_) { /* A canceled pointer may already be released. */ }
  }
  function mount(svg) {
    if (svgElement === svg) return;
    svgElement = svg;
    svg.setAttribute('tabindex', '0');
    svg.setAttribute('role', 'group');
    svg.setAttribute('aria-describedby', 'map-interaction-hint');
    svg.addEventListener('pointerdown', event => {
      if (dragging) { dragging.moved = true; return; }
      if (event.isPrimary === false || (event.button !== undefined && event.button !== 0)) return;
      completedGesture = null;
      const view = geometry(svg), rect = svg.getBoundingClientRect();
      const scale = Math.min(rect.width / view.width, rect.height / view.height);
      if (!(scale > 0)) return;
      dragging = { id: event.pointerId, x: event.clientX, y: event.clientY, centerX: view.centerX,
        centerY: view.centerY, scale, moved: false, roomId: roomFromTarget(event.target) };
      svg.focus({ preventScroll: true });
      try { svg.setPointerCapture?.(event.pointerId); } catch (_) { /* Synthetic pointers do not have capture. */ }
    });
    svg.addEventListener('pointermove', event => {
      if (!dragging || dragging.id !== event.pointerId) return;
      const dx = event.clientX - dragging.x, dy = event.clientY - dragging.y;
      if (!dragging.moved && Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
      dragging.moved = true;
      const c = ensureCamera(); c.mode = 'free';
      c.centerX = dragging.centerX - dx / dragging.scale;
      c.centerY = dragging.centerY - dy / dragging.scale;
      svg.setAttribute('data-dragging', 'true');
      event.preventDefault(); redraw();
    });
    svg.addEventListener('pointerup', event => {
      if (!dragging || dragging.id !== event.pointerId) return;
      const rect = svg.getBoundingClientRect();
      const outside = event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom;
      completedGesture = { moved: dragging.moved || outside, roomId: dragging.roomId, at: performance.now() };
      dragging = null; svg.removeAttribute('data-dragging'); releasePointer(svg, event.pointerId);
    });
    const cancel = event => {
      if (!dragging || dragging.id !== event.pointerId) return;
      dragging = null; completedGesture = { moved: true, roomId: null, at: performance.now() };
      svg.removeAttribute('data-dragging'); releasePointer(svg, event.pointerId);
    };
    svg.addEventListener('pointercancel', cancel);
    svg.addEventListener('lostpointercapture', cancel);
    svg.addEventListener('click', event => {
      const gesture = completedGesture;
      completedGesture = null;
      let id;
      if (event.detail !== 0 && gesture && performance.now() - gesture.at < 1200) {
        event.preventDefault(); event.stopImmediatePropagation();
        if (gesture.moved) return;
        id = gesture.roomId;
      } else {
        id = roomFromTarget(event.target);
        if (id) { event.preventDefault(); event.stopImmediatePropagation(); }
      }
      if (id && Object.hasOwn(WORLD_ROOMS, id)) travelToRoomByClick(id);
    }, true);
    svg.addEventListener('wheel', event => {
      if (dragging || !event.deltaY) return;
      event.preventDefault(); zoom(event.deltaY < 0 ? .25 : -.25, { x: event.clientX, y: event.clientY });
    }, { passive: false });
    svg.addEventListener('keydown', event => {
      if (event.ctrlKey || event.metaKey || event.altKey) return;
      const view = geometry(svg), key = event.key;
      const direction = { ArrowLeft: [-.2, 0], ArrowRight: [.2, 0], ArrowUp: [0, -.2], ArrowDown: [0, .2] }[key];
      if (!direction && !['+', '=', '-', '_', 'Home', 'f', 'F'].includes(key)) return;
      event.preventDefault(); event.stopPropagation();
      if (direction) panBy(direction[0] * view.width, direction[1] * view.height);
      else if (key === 'Home') centerOnHero();
      else if (key === 'f' || key === 'F') fitAll();
      else zoom(key === '+' || key === '=' ? .25 : -.25);
    });
    if (typeof ResizeObserver !== 'undefined') {
      resizeObserver?.disconnect();
      resizeObserver = new ResizeObserver(() => {
        const rect = svg.getBoundingClientRect(), size = `${rect.width}:${rect.height}`;
        if (size !== previousSize) { previousSize = size; redraw(); }
      });
      resizeObserver.observe(svg);
    }
  }
  window.addEventListener('resize', redraw);
  function getViewport(svg) {
    mount(svg);
    const view = geometry(svg); updateLabels(svg, view); return view;
  }
  function getView() {
    const { fitZoom, ...view } = geometry(); return view;
  }
  return { getViewport, getView, zoom, panBy, centerOnHero, fitAll };
})();
window.WorldMap = WorldMap;
