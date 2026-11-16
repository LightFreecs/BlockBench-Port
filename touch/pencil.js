/* Blockbench Touch layer — Apple Pencil + painting (M7).
 *
 * Loaded right after touch/touch.js (before gestures.js) so its window
 * capture-phase pointer listeners run before every other listener.
 *
 *  - Pencil (pointerType 'pen') is a precise pointer: it paints immediately with paint tools and acts
 *    like a mouse click/drag for everything else (select, gizmo). It never takes part in finger gestures.
 *  - Pressure → brush size and/or opacity (configurable curve, min size/opacity), optional tilt → size.
 *    Implemented by wrapping Painter.useBrush (the slider value is the size/opacity at full pressure).
 *  - Coalesced pointer events (getCoalescedEvents) are fed into upstream's stroke handlers so fast
 *    strokes follow the real pen path (3D viewport + 2D UV/texture editor).
 *  - Palm rejection: while a pen touches the screen (and ~300 ms after) touches on the 3D viewport and
 *    the UV editor are ignored; touches with a large contact area are always ignored; a touch that
 *    started up to 600 ms before the pen lands is cancelled and its camera/scroll movement reverted.
 *  - "Pencil only draws" (auto = on after the first Pencil use, on, off): fingers never paint, they
 *    navigate (3D: gestures.js orbit/pan/pinch; UV editor: 1-finger pan, 2-finger pan + pinch zoom).
 *    With it off, a finger paints; a second finger turns the stroke into navigation (young strokes
 *    are reverted, so a 2-finger tap is a clean undo).
 *  - Floating brush bar while a paint tool is active: tools, size, opacity, colour, undo/redo, settings.
 *  - Apple Pencil double-tap: native UIPencilInteraction (ios/App/App/SceneDelegate.swift) fires
 *    window event `bbtouchPencilTap` → eraser toggle / previous tool / colour popover.
 *  - Haptics via @capacitor/haptics (BBTouch.haptic), falls back to navigator.vibrate.
 */
(function () {
	'use strict';
	const BBTouch = window.BBTouch;

	const DEFAULTS = {
		pencil_only: 'auto',     // auto | on | off
		pressure_size: true,
		pressure_opacity: false,
		tilt_size: false,
		curve: 'soft',           // soft | linear | firm
		min_size: 0.15,          // fraction of the slider size at zero pressure
		min_opacity: 0.2,
		palm: true,              // ignore large touches
		palm_px: 56,             // contact diameter (CSS px) above which a touch is a palm
		palm_window_ms: 300,     // touches this long after the pen lifted are ignored
		palm_restore_ms: 600,    // a touch that began this long before the pen landed gets its view change reverted
		double_tap: 'system',    // system | eraser | previous | color | off
		haptics: true,
		brush_bar: true,
	};
	const CURVES = { soft: 0.55, linear: 1, firm: 1.8 };
	const PAINT_TOOLS = ['brush_tool', 'eraser', 'fill_tool', 'color_picker', 'draw_shape_tool', 'gradient_tool', 'copy_brush'];

	const P = BBTouch.pencil = {
		settings: Object.assign({}, DEFAULTS, BBTouch.store.get('pencil', {})),
		seen: !!BBTouch.store.get('pencil_seen', false),
		pen_down: false,
		last_pen_up: -1e9,
		last_pressure: null,
		stats: { pen_strokes: 0, rejected: 0, palms: 0, coalesced: 0, reverted: 0, canceled_touch: 0, uv_pan: 0, uv_zoom: 0, undo: 0, redo: 0, double_taps: 0 },
		last_brush: null,
	};
	const S = P.settings;
	function save() { BBTouch.store.set('pencil', S); }

	// --- haptics -----------------------------------------------------------------
	let haptics_plugin;
	function hapticsPlugin() {
		if (haptics_plugin !== undefined) return haptics_plugin;
		haptics_plugin = null;
		try {
			const c = window.Capacitor;
			if (c && typeof c.isNativePlatform == 'function' && c.isNativePlatform()) {
				haptics_plugin = (c.Plugins && c.Plugins.Haptics) || (c.registerPlugin && c.registerPlugin('Haptics')) || null;
			}
		} catch (e) { haptics_plugin = null; }
		return haptics_plugin;
	}
	/** style: 'light' | 'medium' | 'heavy' | 'selection' */
	BBTouch.haptic = function (style = 'light') {
		if (!S.haptics) return;
		P.stats.haptics = (P.stats.haptics || 0) + 1;
		const H = hapticsPlugin();
		try {
			if (H) {
				if (style === 'selection') H.selectionChanged();
				else H.impact({ style: style.toUpperCase() });
				return;
			}
		} catch (e) { /* ignore */ }
		try { if (navigator.vibrate) navigator.vibrate(style === 'heavy' ? 20 : 10); } catch (e) { /* ignore */ }
	};

	// --- state helpers -------------------------------------------------------------
	function tool() { return window.Toolbox && Toolbox.selected; }
	function isPaintTool(t = tool()) { return !!(t && (t.paintTool || PAINT_TOOLS.includes(t.id))); }
	P.isPaintTool = isPaintTool;
	P.pencilOnly = function () {
		if (window.settings && settings.paint_with_stylus_only && settings.paint_with_stylus_only.value) return true;
		return S.pencil_only === 'on' || (S.pencil_only === 'auto' && P.seen);
	};
	/** gestures.js: should a finger on the 3D viewport navigate instead of painting? */
	P.fingerPaintBlocked = function () {
		return BBTouch.enabled && P.pencilOnly() && isPaintTool();
	};
	/** longpress.js: no long-press menu while painting in the UV / texture editor. */
	P.blocksLongPress = function (target) {
		return !!(window.Modes && Modes.paint && isPaintTool() && target && target.closest && target.closest('#uv_viewport'));
	};
	/** gestures.js: suppress the replayed tap click (it would paint a dot). */
	P.suppressFingerClick = function () { return P.fingerPaintBlocked(); };

	function area(target) {
		if (!target || !target.closest) return null;
		if (target.tagName === 'CANVAS' && window.Preview && Preview.all.find(p => p.canvas === target)) return '3d';
		if (target.closest('#uv_viewport')) return 'uv';
		return null;
	}
	function previewOf(target) { return window.Preview && Preview.all.find(p => p.canvas === target); }

	function isPalm(e) {
		if (!S.palm) return false;
		const w = e.width || 0, h = e.height || 0;
		return Math.max(w, h) > S.palm_px;
	}

	function markSeen() {
		if (P.seen) return;
		P.seen = true;
		BBTouch.store.set('pencil_seen', true);
		if (S.pencil_only === 'auto' && window.Blockbench && Blockbench.showQuickMessage) {
			Blockbench.showQuickMessage('Apple Pencil detected: Pencil paints, fingers navigate (✎ settings)', 2600);
		}
		updateBar();
	}

	// --- pressure / tilt → brush ------------------------------------------------------
	function clamp(v, a, b) { return Math.min(Math.max(v, a), b); }
	function curve(p) { return Math.pow(clamp(p, 0, 1), CURVES[S.curve] || 1); }
	function altitude(e) {
		if (typeof e.altitudeAngle === 'number' && !(e.altitudeAngle === Math.PI / 2 && !e.tiltX && !e.tiltY)) return e.altitudeAngle;
		const tx = Math.tan((e.tiltX || 0) * Math.PI / 180), ty = Math.tan((e.tiltY || 0) * Math.PI / 180);
		return Math.PI / 2 - Math.atan(Math.sqrt(tx * tx + ty * ty));
	}
	/** Returns {size(base), opacity(base)} for a pen event, or null to leave upstream alone. */
	P.brushModifiers = function (e) {
		if (!e || e.pointerType !== 'pen' || typeof e.pressure !== 'number') return null;
		if (!S.pressure_size && !S.pressure_opacity && !S.tilt_size) return null;
		const p = e.pressure;
		const k = curve(p);
		const tilt = S.tilt_size ? 1 + (1 - clamp(altitude(e) / (Math.PI / 2), 0, 1)) * 2 : 1;
		return {
			pressure: p,
			size: base => {
				let s = base;
				if (S.pressure_size) s = base * (S.min_size + (1 - S.min_size) * k);
				s *= tilt;
				return Math.max(1, Math.round(s));
			},
			opacity: base => S.pressure_opacity ? Math.max(1, Math.round(base * (S.min_opacity + (1 - S.min_opacity) * k))) : base,
		};
	};

	function patchPainter() {
		const Painter = window.Painter;
		if (!Painter || !Painter.useBrush || Painter.useBrush.__bbtouch) return;
		const orig = Painter.useBrush;
		Painter.useBrush = function (texture, ctx, x, y, event) {
			const mod = BBTouch.enabled !== undefined && P.brushModifiers(event);
			if (!mod) return orig.apply(this, arguments);
			const sz = BarItems.slider_brush_size, op = BarItems.slider_brush_opacity;
			const own_sz = Object.prototype.hasOwnProperty.call(sz, 'get'), prev_sz = sz.get;
			const own_op = Object.prototype.hasOwnProperty.call(op, 'get'), prev_op = op.get;
			const base_size = sz.get(), base_op = op.get();
			const size = mod.size(base_size), opacity = mod.opacity(base_op);
			const st = window.settings || {};
			const m1 = st.brush_size_modifier, m2 = st.brush_opacity_modifier;
			const v1 = m1 && m1.value, v2 = m2 && m2.value;
			// our curve replaces upstream's built-in pressure handling (which caps size at 20 px)
			if (m1 && (S.pressure_size || S.tilt_size)) m1.value = 'none';
			if (m2 && S.pressure_opacity) m2.value = 'none';
			sz.get = () => size;
			op.get = () => opacity;
			try {
				return orig.apply(this, arguments);
			} finally {
				if (own_sz) sz.get = prev_sz; else delete sz.get;
				if (own_op) op.get = prev_op; else delete op.get;
				if (m1) m1.value = v1;
				if (m2) m2.value = v2;
				if (Painter.current) Painter.current.dynamic_brush_size = size;
				P.last_brush = { pressure: mod.pressure, size, opacity, base_size, base_opacity: base_op };
			}
		};
		Painter.useBrush.__bbtouch = true;
	}

	// --- stroke tracking ---------------------------------------------------------------
	// stroke: {id, type: 'pen'|'touch', area: '3d'|'uv', time, x, y, checked, active}
	let stroke = null;
	const rejected = new Set();       // pointerIds ignored for their whole lifetime
	const touches = new Map();        // accepted touch pointers on 3d/uv: id → {area, time, x, y, snapshot}

	function strokeActive() {
		return !!(window.Undo && Undo.current_save) && !(window.Painter && Painter.paint_stroke_canceled);
	}
	function brushLike() {
		const t = tool();
		return !!(t && t.brush && !['fill_tool', 'color_picker', 'draw_shape_tool', 'gradient_tool'].includes(t.id));
	}

	/** End (and optionally revert) the upstream stroke that is in progress. */
	function endStroke(revert) {
		if (!stroke) return;
		const s = stroke;
		stroke = null;
		try {
			if (revert && strokeActive()) {
				Undo.cancelEdit(true);
				Painter.brushChanges = false;
				P.stats.reverted++;
			}
			if (s.area === '3d') Painter.stopPaintToolCanvas();
			else if (window.UVEditor) UVEditor.stopBrush({});
		} catch (err) { console.error('[BBTouch] endStroke', err); }
	}
	P.endStroke = endStroke;

	function reject(e) {
		rejected.add(e.pointerId);
		P.stats.rejected++;
		e.stopImmediatePropagation();
		if (e.cancelable) e.preventDefault();
	}

	// camera / scroll snapshot so a palm that started moving the view can be undone when the pen lands
	function snapshot(a, target) {
		try {
			if (a === '3d') {
				const p = previewOf(target);
				if (!p) return null;
				const c = p.controls;
				return { a, p, pos: c.object.position.clone(), target: c.target.clone(), zoom: c.object.zoom };
			}
			const vp = uvViewport();
			if (vp) return { a, left: vp.scrollLeft, top: vp.scrollTop, zoom: UVEditor.vue.zoom };
		} catch (e) { /* ignore */ }
		return null;
	}
	function restore(s) {
		if (!s) return;
		try {
			if (s.a === '3d') {
				const c = s.p.controls;
				c.object.position.copy(s.pos);
				c.target.copy(s.target);
				if (s.zoom !== undefined && c.object.zoom !== s.zoom) { c.object.zoom = s.zoom; c.object.updateProjectionMatrix(); }
				c.update();
				c.object.updateMatrixWorld(true); // raycasts before the next render must see the restored camera
			} else {
				if (UVEditor.vue.zoom !== s.zoom) UVEditor.setZoom(s.zoom);
				const vp = uvViewport();
				vp.scrollLeft = s.left; vp.scrollTop = s.top;
			}
		} catch (e) { /* ignore */ }
	}

	/** Pen landed: drop every touch that is in progress (it's almost certainly the palm). */
	function cancelTouches(now) {
		if (!touches.size) return;
		let restored = false;
		touches.forEach((t, id) => {
			rejected.add(id);
			P.stats.canceled_touch++;
			if (!restored && now - t.time < S.palm_restore_ms) { restore(t.snapshot); restored = true; }
		});
		touches.clear();
		uvNav.reset();
		if (BBTouch.gestures && BBTouch.gestures.cancel) BBTouch.gestures.cancel();
		if (stroke && stroke.type === 'touch') endStroke(true);
	}

	// --- 2D UV / texture editor: finger navigation while painting ------------------------
	function uvViewport() { return window.UVEditor && UVEditor.vue && UVEditor.vue.$refs && UVEditor.vue.$refs.viewport; }
	const uvNav = {
		pts: new Map(), prev: null, max: 0, moved: false, start: 0,
		reset() { this.pts.clear(); this.prev = null; this.max = 0; this.moved = false; },
		metrics() {
			const a = [...this.pts.values()];
			if (a.length === 1) return { cx: a[0].x, cy: a[0].y, dist: 0 };
			return { cx: (a[0].x + a[1].x) / 2, cy: (a[0].y + a[1].y) / 2, dist: Math.max(Math.hypot(a[0].x - a[1].x, a[0].y - a[1].y), 1) };
		},
		add(e) {
			if (!this.pts.size) { this.start = performance.now(); this.moved = false; this.max = 0; }
			this.pts.set(e.pointerId, { x: e.clientX, y: e.clientY, sx: e.clientX, sy: e.clientY });
			this.max = Math.max(this.max, this.pts.size);
			this.prev = this.metrics();
			if (window.setActivePanel) setActivePanel('uv');
		},
		move(e) {
			const pt = this.pts.get(e.pointerId);
			pt.x = e.clientX; pt.y = e.clientY;
			if (Math.hypot(pt.x - pt.sx, pt.y - pt.sy) > (BBTouch.config.tap_slop || 10)) this.moved = true;
			if (!this.moved) return;
			const m = this.metrics(), vp = uvViewport();
			if (!vp || !this.prev) { this.prev = m; return; }
			vp.scrollLeft -= m.cx - this.prev.cx;
			vp.scrollTop -= m.cy - this.prev.cy;
			P.stats.uv_pan++;
			if (m.dist && this.prev.dist) {
				const f = m.dist / this.prev.dist;
				if (Math.abs(f - 1) > 0.002) uvZoomAt(UVEditor.vue.zoom * f, m.cx, m.cy);
			}
			UVEditor.updateUVNavigator && UVEditor.updateUVNavigator();
			this.prev = m;
		},
		end(e) {
			this.pts.delete(e.pointerId);
			if (this.pts.size) { this.prev = this.metrics(); return; }
			const dur = performance.now() - this.start;
			if (!this.moved && e.type === 'pointerup' && dur < (BBTouch.config.multi_tap_ms || 280) + 200) {
				if (this.max === 2) { P.stats.undo++; trigger('undo'); }
				else if (this.max === 3) { P.stats.redo++; trigger('redo'); }
			}
			this.reset();
		},
	};
	// Same maths as upstream's wheel zoom (uv.js onMouseWheel), anchored at a client point.
	function uvZoomAt(zoom, cx, cy) {
		const vue = UVEditor.vue, vp = uvViewport();
		const old_zoom = vue.zoom;
		const original_margin = vue.getFrameMargin();
		UVEditor.setZoom(Math.max(0.1, zoom));
		const apply = () => {
			const rect = vp.getBoundingClientRect();
			const margin = vue.getFrameMargin();
			const ox = cx - rect.left - margin[0], oy = cy - rect.top - margin[1];
			const diff = vue.zoom - old_zoom;
			vp.scrollLeft += ((vp.scrollLeft + ox) * diff) / old_zoom + margin[0] - original_margin[0];
			vp.scrollTop += ((vp.scrollTop + oy) * diff) / old_zoom + margin[1] - original_margin[1];
			vue.updateTextureCanvas && vue.updateTextureCanvas();
			if (vue.mode === 'paint') vue.mouse_coords.active = false;
		};
		if (vue.zoom > old_zoom && window.Vue) Vue.nextTick(apply); else apply();
		P.stats.uv_zoom++;
	}
	function trigger(id) { const a = window.BarItems && BarItems[id]; if (a) a.trigger(); }

	// --- pointer listeners (window, capture: before gestures.js and upstream) -----------------
	function onDown(e) {
		if (!BBTouch.enabled) return;
		const a = area(e.target);
		const now = performance.now();

		if (e.pointerType === 'pen') {
			markSeen();
			P.pen_down = true;
			P.last_pressure = e.pressure;
			cancelTouches(now);
			if (!a) return;
			if (a === '3d') {
				// no hover before a pen touch on most iPads: compute the gizmo hover like upstream does for touch
				const p = previewOf(e.target);
				try { if (p && window.Transformer && Transformer.visible) { p.occupyTransformer(); Transformer.dispatchPointerHover(e); } } catch (err) { /* ignore */ }
			}
			if (isPaintTool()) {
				stroke = { id: e.pointerId, type: 'pen', area: a, time: now, checked: false, active: false };
				P.stats.pen_strokes++;
			}
			return;
		}
		if (e.pointerType !== 'touch' || !a) return;

		// palm rejection
		if (isPalm(e)) { P.stats.palms++; reject(e); return; }
		if (P.pen_down || now - P.last_pen_up < S.palm_window_ms) { reject(e); return; }
		if (stroke && stroke.type === 'pen') { reject(e); return; }

		// a second finger turns a finger paint stroke into navigation
		if (stroke && stroke.type === 'touch') {
			const young = now - stroke.time < 450;
			const s = stroke;
			endStroke(young);
			if (s.area === 'uv') {
				uvNav.reset();
				uvNav.add({ pointerId: s.id, clientX: s.x, clientY: s.y });
			}
		}
		touches.set(e.pointerId, { area: a, time: now, snapshot: snapshot(a, e.target) });

		if (a === 'uv' && isPaintTool() && window.Modes && Modes.paint) {
			if (uvNav.pts.size || P.pencilOnly()) {
				uvNav.add(e);
				e.stopImmediatePropagation();
				if (e.cancelable) e.preventDefault();
				return;
			}
			stroke = { id: e.pointerId, type: 'touch', area: 'uv', time: now, x: e.clientX, y: e.clientY, checked: false, active: false };
			return;
		}
		if (a === '3d' && isPaintTool() && !P.fingerPaintBlocked() && touches.size === 1) {
			stroke = { id: e.pointerId, type: 'touch', area: '3d', time: now, x: e.clientX, y: e.clientY, checked: false, active: false };
		}
	}

	function onMove(e) {
		if (rejected.has(e.pointerId)) { e.stopImmediatePropagation(); if (e.cancelable) e.preventDefault(); return; }
		if (uvNav.pts.has(e.pointerId)) { uvNav.move(e); e.stopImmediatePropagation(); if (e.cancelable) e.preventDefault(); return; }
		if (e.pointerType === 'pen') {
			if (e.buttons || e.pressure) P.last_pressure = e.pressure;
		}
		if (!stroke || e.pointerId !== stroke.id) return;
		if (stroke.type === 'touch') { stroke.x = e.clientX; stroke.y = e.clientY; }
		if (!stroke.checked) { stroke.checked = true; stroke.active = strokeActive() && brushLike(); }
		if (!stroke.active || typeof e.getCoalescedEvents !== 'function') return;
		let list;
		try { list = e.getCoalescedEvents(); } catch (err) { return; }
		if (!list || list.length < 2) return;
		// feed the intermediate samples; the event itself is handled by upstream as usual
		for (let i = 0; i < list.length - 1; i++) {
			const ce = list[i];
			try {
				if (stroke.area === '3d') Painter.movePaintToolCanvas(ce);
				else UVEditor.movePaintTool(ce);
				P.stats.coalesced++;
			} catch (err) { break; }
		}
	}

	function onUp(e) {
		if (e.pointerType === 'pen') {
			P.pen_down = false;
			P.last_pen_up = performance.now();
		}
		touches.delete(e.pointerId);
		if (rejected.has(e.pointerId)) {
			rejected.delete(e.pointerId);
			e.stopImmediatePropagation();
			if (e.cancelable) e.preventDefault();
			return;
		}
		if (uvNav.pts.has(e.pointerId)) { uvNav.end(e); e.stopImmediatePropagation(); return; }
		if (stroke && e.pointerId === stroke.id) {
			const was = stroke;
			stroke = null;
			if (was.type === 'pen' && eyedropper_return && tool() && tool().id === 'color_picker') {
				setTimeout(returnFromEyedropper, 0);
			}
		}
	}

	window.addEventListener('pointerdown', onDown, { capture: true, passive: false });
	window.addEventListener('pointermove', onMove, { capture: true, passive: false });
	window.addEventListener('pointerup', onUp, { capture: true, passive: false });
	window.addEventListener('pointercancel', onUp, { capture: true, passive: false });
	// Touch events of rejected / navigating fingers must not reach upstream's touch handlers
	// (OrbitControls, UV editor pinch) – only possible to tell apart while nothing else is down.
	['touchstart', 'touchmove'].forEach(type => window.addEventListener(type, e => {
		if (!BBTouch.enabled || !area(e.target)) return;
		if (P.pen_down || uvNav.pts.size) {
			const stylus = [...e.touches].some(t => t.touchType === 'stylus');
			if (!stylus || uvNav.pts.size) { e.stopImmediatePropagation(); if (e.cancelable) e.preventDefault(); }
		}
	}, { capture: true, passive: false }));

	// --- tools ------------------------------------------------------------------------------
	let previous_paint_tool = 'brush_tool';
	let eyedropper_return = null;
	function selectTool(id) {
		const t = window.BarItems && BarItems[id];
		if (!t || !t.select) return;
		const cur = tool();
		if (cur && cur.id !== id && isPaintTool(cur) && cur.id !== 'color_picker') previous_paint_tool = cur.id;
		t.select();
		BBTouch.haptic('selection');
		updateBar();
	}
	P.selectTool = selectTool;
	P.toggleEraser = function () {
		const cur = tool();
		if (cur && cur.id === 'eraser') selectTool(previous_paint_tool !== 'eraser' ? previous_paint_tool : 'brush_tool');
		else selectTool('eraser');
	};
	P.previousTool = function () {
		const cur = tool();
		selectTool(previous_paint_tool && (!cur || previous_paint_tool !== cur.id) ? previous_paint_tool : 'brush_tool');
	};
	P.eyedropper = function () {
		const cur = tool();
		if (cur && cur.id === 'color_picker') { returnFromEyedropper(); return; }
		eyedropper_return = cur ? cur.id : 'brush_tool';
		selectTool('color_picker');
	};
	function returnFromEyedropper() {
		const id = eyedropper_return;
		eyedropper_return = null;
		if (id && tool() && tool().id === 'color_picker') selectTool(id);
	}

	// Apple Pencil double tap (native UIPencilInteraction → bridge.triggerWindowJSEvent)
	P.onDoubleTap = function (preferred, kind) {
		P.stats.double_taps++;
		let action = S.double_tap;
		if (action === 'off') return;
		// Pencil Pro squeeze (M8) always follows its own system preference; palettes → colour popover
		if (action === 'system' || kind === 'squeeze') {
			action = { switchEraser: 'eraser', switchPrevious: 'previous', showColorPalette: 'color', showInkAttributes: 'color', showContextualPalette: 'color', ignore: 'off' }[preferred]
				|| (kind === 'squeeze' ? 'color' : 'eraser');
			if (action === 'off') return;
		}
		if (!isPaintTool() && !(window.Modes && Modes.paint)) return;
		if (action === 'eraser') P.toggleEraser();
		else if (action === 'previous') P.previousTool();
		else if (action === 'color') openColor();
	};
	window.addEventListener('bbtouchPencilTap', e => {
		let d = e && e.detail;
		if (!d) { try { d = JSON.parse(e.data || '{}'); } catch (err) { d = {}; } }
		if (!d.action && e.action) d = e;
		P.onDoubleTap(d && d.action, d && d.kind);
	});

	// --- floating brush bar ------------------------------------------------------------------
	let bar = null, pop = null, colorPop = null;
	const icon = n => `<i class="material-icons">${n}</i>`;
	const fa = n => `<i class="fa ${n}"></i>`;

	function buildBar() {
		bar = document.createElement('div');
		bar.id = 'bbt_brushbar';
		bar.innerHTML = `
			<button class="bbt_bb_btn" data-tool="brush_tool" title="Brush">${fa('fa-paint-brush')}</button>
			<button class="bbt_bb_btn" data-act="eraser" title="Eraser (toggle)">${fa('fa-eraser')}</button>
			<button class="bbt_bb_btn" data-tool="fill_tool" title="Fill">${fa('fa-fill-drip')}</button>
			<button class="bbt_bb_btn" data-act="eyedropper" title="Eyedropper (returns to the previous tool)">${icon('colorize')}</button>
			<span class="bbt_bb_sep"></span>
			<label class="bbt_bb_range" title="Brush size (at full pressure)"><span class="bbt_bb_cap">Size</span>
				<input type="range" data-slider="slider_brush_size" min="1" max="64" step="1"><b data-val="slider_brush_size"></b></label>
			<label class="bbt_bb_range" title="Opacity"><span class="bbt_bb_cap">Opac.</span>
				<input type="range" data-slider="slider_brush_opacity" min="0" max="255" step="1"><b data-val="slider_brush_opacity"></b></label>
			<button class="bbt_bb_swatch" data-act="color" title="Colour"><span></span></button>
			<span class="bbt_bb_sep"></span>
			<button class="bbt_bb_btn" data-act="undo" title="Undo">${icon('undo')}</button>
			<button class="bbt_bb_btn" data-act="redo" title="Redo">${icon('redo')}</button>
			<button class="bbt_bb_btn" data-act="settings" title="Apple Pencil settings">${icon('edit')}<span class="bbt_bb_dot"></span></button>`;
		document.body.append(bar);
		bar.addEventListener('pointerdown', e => {
			if (e.target.tagName !== 'INPUT') e.preventDefault();
			e.stopPropagation();
		});
		bar.addEventListener('contextmenu', e => { e.preventDefault(); e.stopPropagation(); });
		bar.querySelectorAll('button').forEach(b => b.addEventListener('click', e => {
			e.preventDefault(); e.stopPropagation();
			if (b.dataset.tool) selectTool(b.dataset.tool);
			const act = b.dataset.act;
			if (act === 'eraser') P.toggleEraser();
			else if (act === 'eyedropper') P.eyedropper();
			else if (act === 'undo') { trigger('undo'); BBTouch.haptic('light'); }
			else if (act === 'redo') { trigger('redo'); BBTouch.haptic('light'); }
			else if (act === 'color') openColor();
			else if (act === 'settings') P.openSettings();
			updateBar();
		}));
		bar.querySelectorAll('input[type=range]').forEach(inp => {
			let undo_started = false;
			inp.addEventListener('input', () => {
				const s = BarItems[inp.dataset.slider];
				if (!s) return;
				const v = Number(inp.value);
				if (!undo_started && s.onBefore) { try { s.onBefore(); } catch (e) { /* ignore */ } undo_started = true; }
				s.change(() => v);
				s.update();
				updateValues();
			});
			inp.addEventListener('change', () => {
				const s = BarItems[inp.dataset.slider];
				if (undo_started && s && s.onAfter) { try { s.onAfter(); } catch (e) { /* ignore */ } }
				undo_started = false;
			});
		});
	}

	function sliderMax(s, fallback) {
		const m = s && s.settings && s.settings.max;
		return typeof m === 'number' ? m : fallback;
	}
	function updateValues() {
		if (!bar) return;
		bar.querySelectorAll('input[type=range]').forEach(inp => {
			const s = BarItems[inp.dataset.slider];
			if (!s) return;
			const v = s.get();
			if (inp.dataset.slider === 'slider_brush_size') inp.max = Math.max(64, Math.min(sliderMax(s, 1024), Math.ceil(v * 1.5)));
			else inp.max = sliderMax(s, 255);
			if (document.activeElement !== inp) inp.value = v;
			const out = bar.querySelector(`[data-val="${inp.dataset.slider}"]`);
			if (out) out.textContent = Math.round(v);
		});
		const sw = bar.querySelector('.bbt_bb_swatch span');
		try { if (sw && window.ColorPanel) sw.style.backgroundColor = ColorPanel.get(); } catch (e) { /* ignore */ }
	}

	function updateBar() {
		const show = !!(S.brush_bar && BBTouch.enabled && window.Project && window.Modes && Modes.paint && isPaintTool());
		if (!bar) { if (!show) return; buildBar(); }
		bar.classList.toggle('visible', show);
		document.documentElement.classList.toggle('bbt_brushbar_visible', show);
		if (!show) return;
		const cur = tool();
		bar.querySelectorAll('[data-tool]').forEach(b => b.classList.toggle('active', !!cur && cur.id === b.dataset.tool));
		const er = bar.querySelector('[data-act="eraser"]'); er.classList.toggle('active', !!cur && cur.id === 'eraser');
		const ey = bar.querySelector('[data-act="eyedropper"]'); ey.classList.toggle('active', !!cur && cur.id === 'color_picker');
		bar.querySelector('.bbt_bb_dot').classList.toggle('on', P.pencilOnly());
		const has_size = !!(cur && cur.brush && cur.brush.size !== false);
		bar.querySelectorAll('.bbt_bb_range').forEach(l => l.classList.toggle('disabled', !has_size));
		updateValues();
		placeBar();
	}
	P.updateBar = updateBar;

	function placeBar() {
		if (!bar) return;
		const ref = document.getElementById('preview') || document.getElementById('center');
		const r = ref && ref.getBoundingClientRect();
		const w = bar.offsetWidth || 600;
		let x = r && r.width ? r.left + r.width / 2 - w / 2 : (window.innerWidth - w) / 2;
		x = Math.max(4, Math.min(x, window.innerWidth - w - 4));
		const bottom = r && r.height ? Math.max(4, window.innerHeight - r.bottom + 10) : 12;
		bar.style.left = Math.round(x) + 'px';
		bar.style.bottom = Math.round(bottom) + 'px';
	}

	// --- popovers ---------------------------------------------------------------------------------
	function closePopovers() {
		if (pop) { pop.remove(); pop = null; }
		if (colorPop) { colorPop.remove(); colorPop = null; }
		document.removeEventListener('pointerdown', outside, true);
		document.removeEventListener('touchstart', outside, true);
	}
	P.closePopovers = closePopovers;
	function outside(e) {
		const el = e.target;
		if ((pop && pop.contains(el)) || (colorPop && colorPop.contains(el)) || (bar && bar.contains(el))) return;
		if (el.closest && el.closest('#bbt_toolbar')) return;
		closePopovers();
	}
	function showPopover(node, anchor) {
		document.body.append(node);
		const r = anchor && anchor.getBoundingClientRect && anchor.getBoundingClientRect();
		const w = node.offsetWidth, h = node.offsetHeight;
		let x, y;
		if (r && r.width) {
			x = r.left + r.width / 2 - w / 2;
			y = r.top - h - 8;
			if (y < 8) y = r.bottom + 8;
			if (r.left < 120 && r.width < 80) { x = r.right + 8; y = r.top; } // next to the vertical toolbar
		} else { x = (window.innerWidth - w) / 2; y = (window.innerHeight - h) / 2; }
		node.style.left = Math.round(Math.max(8, Math.min(x, window.innerWidth - w - 8))) + 'px';
		node.style.top = Math.round(Math.max(8, Math.min(y, window.innerHeight - h - 8))) + 'px';
		// touchstart too: gestures.js stops pointerdown on the 3D viewport before it reaches document
		setTimeout(() => {
			document.addEventListener('pointerdown', outside, true);
			document.addEventListener('touchstart', outside, true);
		}, 0);
	}

	function seg(key, options) {
		return `<div class="bbt_seg" data-key="${key}">` + options.map(([v, l]) =>
			`<button data-v="${v}" class="${S[key] === v ? 'active' : ''}">${l}</button>`).join('') + '</div>';
	}
	function toggle(key, label) {
		return `<label class="bbt_ps_row bbt_ps_toggle"><span>${label}</span><input type="checkbox" data-key="${key}" ${S[key] ? 'checked' : ''}></label>`;
	}
	function range(key, label, min, max, step, fmt) {
		return `<label class="bbt_ps_row"><span>${label}</span><input type="range" data-key="${key}" min="${min}" max="${max}" step="${step}" value="${S[key]}"><b data-out="${key}">${fmt(S[key])}</b></label>`;
	}
	const pct = v => Math.round(v * 100) + '%';

	P.openSettings = function (anchor) {
		if (pop) { closePopovers(); return; }
		closePopovers();
		anchor = anchor || (bar && bar.classList.contains('visible') && bar.querySelector('[data-act="settings"]')) ||
			document.querySelector('#bbt_toolbar [data-id="pencil"]');
		pop = document.createElement('div');
		pop.id = 'bbt_pencil_settings';
		pop.className = 'bbt_popover';
		pop.innerHTML = `
			<div class="bbt_ps_head">${icon('edit')}<b>Apple Pencil</b><span class="bbt_ps_status"></span><button class="bbt_ps_close" title="Close">${icon('close')}</button></div>
			<div class="bbt_ps_row bbt_ps_col"><span>Pencil only draws <small>(fingers navigate)</small></span>
				${seg('pencil_only', [['auto', 'Auto'], ['on', 'On'], ['off', 'Off']])}</div>
			${toggle('pressure_size', 'Pressure → size')}
			${toggle('pressure_opacity', 'Pressure → opacity')}
			${toggle('tilt_size', 'Tilt → size (shading)')}
			<div class="bbt_ps_row bbt_ps_col"><span>Pressure curve</span>${seg('curve', [['soft', 'Soft'], ['linear', 'Linear'], ['firm', 'Firm']])}</div>
			${range('min_size', 'Min size', 0, 1, 0.05, pct)}
			${range('min_opacity', 'Min opacity', 0, 1, 0.05, pct)}
			<div class="bbt_ps_test" title="Pressure test: draw here with the Pencil"><canvas width="560" height="90"></canvas><span>Pressure test – draw here</span></div>
			${toggle('palm', 'Palm rejection (ignore large touches)')}
			<div class="bbt_ps_row bbt_ps_col"><span>Double-tap (Pencil 2 / Pro)</span>
				${seg('double_tap', [['system', 'System'], ['eraser', 'Eraser'], ['previous', 'Last tool'], ['color', 'Colour'], ['off', 'Off']])}</div>
			${toggle('haptics', 'Haptic feedback')}
			${toggle('brush_bar', 'Brush bar in paint mode')}`;
		pop.addEventListener('pointerdown', e => e.stopPropagation());
		pop.querySelector('.bbt_ps_close').addEventListener('click', closePopovers);
		pop.querySelectorAll('.bbt_seg').forEach(sg => sg.querySelectorAll('button').forEach(b => b.addEventListener('click', () => {
			S[sg.dataset.key] = b.dataset.v;
			sg.querySelectorAll('button').forEach(x => x.classList.toggle('active', x === b));
			save(); BBTouch.haptic('selection'); refreshStatus(); updateBar();
		})));
		pop.querySelectorAll('input[type=checkbox]').forEach(c => c.addEventListener('change', () => {
			S[c.dataset.key] = c.checked; save(); BBTouch.haptic('selection'); updateBar();
		}));
		pop.querySelectorAll('input[type=range]').forEach(r => r.addEventListener('input', () => {
			S[r.dataset.key] = Number(r.value); save();
			const o = pop.querySelector(`[data-out="${r.dataset.key}"]`); if (o) o.textContent = pct(S[r.dataset.key]);
		}));
		setupTester(pop.querySelector('.bbt_ps_test canvas'));
		showPopover(pop, anchor);
		refreshStatus();
		return pop;
	};
	function refreshStatus() {
		const st = pop && pop.querySelector('.bbt_ps_status');
		if (st) st.textContent = P.seen ? (P.pencilOnly() ? 'fingers navigate' : 'fingers paint') : 'not used yet';
	}

	// small pressure test pad inside the settings popover: shows the effect of the curve
	function setupTester(cv) {
		const ctx = cv.getContext('2d');
		let last = null;
		const t = P.tester = { active: false };
		const pos = e => { const r = cv.getBoundingClientRect(); return [(e.clientX - r.left) * cv.width / r.width, (e.clientY - r.top) * cv.height / r.height]; };
		const color = () => { try { return ColorPanel.get(); } catch (e) { return '#4a9eff'; } };
		const draw = e => {
			const [x, y] = pos(e);
			const fake = { pointerType: 'pen', pressure: e.pointerType === 'pen' ? e.pressure : 0.5, altitudeAngle: e.altitudeAngle, tiltX: e.tiltX, tiltY: e.tiltY };
			const mod = P.brushModifiers(fake);
			const size = mod ? mod.size(14) : 14, op = mod ? mod.opacity(100) / 100 : 1;
			ctx.strokeStyle = color(); ctx.globalAlpha = op; ctx.lineWidth = size; ctx.lineCap = 'round';
			ctx.beginPath(); ctx.moveTo(...(last || [x, y])); ctx.lineTo(x, y); ctx.stroke();
			last = [x, y];
		};
		cv.addEventListener('pointerdown', e => { e.preventDefault(); ctx.clearRect(0, 0, cv.width, cv.height); last = null; t.active = true; cv.setPointerCapture && cv.setPointerCapture(e.pointerId); draw(e); });
		cv.addEventListener('pointermove', e => { if (!t.active) return; const l = e.getCoalescedEvents ? e.getCoalescedEvents() : [e]; (l.length ? l : [e]).forEach(draw); });
		const stop = () => { t.active = false; last = null; };
		cv.addEventListener('pointerup', stop); cv.addEventListener('pointercancel', stop);
	}

	function openColor(anchor) {
		if (colorPop) { closePopovers(); return; }
		closePopovers();
		anchor = anchor || (bar && bar.querySelector('.bbt_bb_swatch'));
		colorPop = document.createElement('div');
		colorPop.id = 'bbt_color_pop';
		colorPop.className = 'bbt_popover';
		let main = '#ffffff';
		try { main = ColorPanel.get(); } catch (e) { /* ignore */ }
		const vue = window.ColorPanel && ColorPanel.panel && ColorPanel.panel.vue;
		const history = (vue && vue._data && vue._data.history || []).slice(0, 12);
		const palette = (ColorPanel.palette || []).slice(0, 48);
		const sw = c => `<button class="bbt_cp_sw" data-c="${c}" style="background-color:${c}" title="${c}"></button>`;
		colorPop.innerHTML = `
			<div class="bbt_ps_head">${icon('palette')}<b>Colour</b><button class="bbt_ps_close" title="Close">${icon('close')}</button></div>
			<div class="bbt_cp_row"><input type="color" class="bbt_cp_native" value="${tinyHex(main)}" title="System colour picker">
				<button class="bbt_cp_btn" data-a="swap" title="Swap main / secondary">${icon('swap_vert')}</button>
				<button class="bbt_cp_btn" data-a="pick" title="Eyedropper">${icon('colorize')}</button>
				<button class="bbt_cp_btn" data-a="panel" title="Show the Color panel (wheel, sliders, palette)">${icon('tune')}</button></div>
			${history.length ? '<div class="bbt_cp_label">Recent</div><div class="bbt_cp_grid">' + history.map(sw).join('') + '</div>' : ''}
			${palette.length ? '<div class="bbt_cp_label">Palette</div><div class="bbt_cp_grid">' + palette.map(sw).join('') + '</div>' : ''}`;
		colorPop.addEventListener('pointerdown', e => e.stopPropagation());
		colorPop.querySelector('.bbt_ps_close').addEventListener('click', closePopovers);
		const native = colorPop.querySelector('.bbt_cp_native');
		native.addEventListener('input', () => { try { ColorPanel.set(native.value); } catch (e) { /* ignore */ } updateValues(); });
		colorPop.querySelectorAll('.bbt_cp_sw').forEach(b => b.addEventListener('click', () => {
			try { ColorPanel.set(b.dataset.c); } catch (e) { /* ignore */ }
			BBTouch.haptic('selection'); updateValues(); closePopovers();
		}));
		colorPop.querySelectorAll('.bbt_cp_btn').forEach(b => b.addEventListener('click', () => {
			const a = b.dataset.a;
			if (a === 'swap') trigger('swap_colors');
			else if (a === 'pick') { closePopovers(); P.eyedropper(); return; }
			else if (a === 'panel') { closePopovers(); showColorPanel(); return; }
			updateValues();
			try { native.value = tinyHex(ColorPanel.get()); } catch (e) { /* ignore */ }
		}));
		showPopover(colorPop, anchor);
		return colorPop;
	}
	P.openColor = openColor;
	function tinyHex(c) {
		try { return window.tinycolor ? tinycolor(c).toHexString() : c; } catch (e) { return '#ffffff'; }
	}
	function showColorPanel() {
		try {
			const panel = window.Panels && Panels.color;
			if (!panel) return;
			if (window.Blockbench && Blockbench.isMobile && window.Interface && Interface.PanelSelectorVue) {
				Interface.PanelSelectorVue.select('color');
				return;
			}
			if (panel.slot === 'left_bar' && window.Prop && !Prop.show_left_bar) { Prop.show_left_bar = true; updateInterface(); }
			if (panel.slot === 'right_bar' && window.Prop && !Prop.show_right_bar) { Prop.show_right_bar = true; updateInterface(); }
			if (panel.folded && panel.fold) panel.fold(false);
			if (panel.node && panel.node.scrollIntoView) panel.node.scrollIntoView({ block: 'nearest' });
		} catch (e) { console.error('[BBTouch] color panel', e); }
	}

	// --- boot ----------------------------------------------------------------------------------------
	BBTouch.onReady(() => {
		patchPainter();
		let last_key = '';
		setInterval(() => {
			const t = tool();
			const key = [t && t.id, window.Modes && Modes.selected && Modes.selected.id, BBTouch.enabled, S.brush_bar,
				window.Project && Project.uuid].join('|');
			if (key !== last_key) { last_key = key; if (t && isPaintTool(t) && t.id !== 'color_picker' && t.id !== 'eraser') previous_paint_tool = t.id; updateBar(); }
			else if (bar && bar.classList.contains('visible')) updateValues();
		}, 250);
		window.addEventListener('resize', () => setTimeout(placeBar, 50));
		BBTouch.on('touch_mode', updateBar);
	});
})();
