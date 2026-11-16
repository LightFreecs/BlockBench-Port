/* Blockbench Touch layer — long-press = right click, everywhere outside the 3D viewport.
 *
 * iOS WKWebView never fires `contextmenu` for a long press, so every upstream
 * `@contextmenu` / `addEventListener('contextmenu')` handler (outliner, textures,
 * UV editor, timeline, animations, tabs, panels, sliders…) was unreachable.
 *
 *  - hold one finger still for BBTouch.config.ui_long_press_ms (≈450 ms) → a
 *    synthetic `contextmenu` MouseEvent is dispatched at the element under the
 *    finger (with clientX/Y, button 2), so upstream opens its own menu.
 *  - a progress ring grows under the finger while holding (visual feedback),
 *    plus a short vibration where supported / Capacitor Haptics if installed.
 *  - after it fired, the rest of the touch sequence is swallowed: no scroll,
 *    no upstream drag (e.g. outliner re-ordering), no click on the menu item that
 *    opened under the finger.
 *  - toolbar buttons (`.tool` with a `.tooltip`): the long press first shows the
 *    tooltip (hover tooltips are disabled in touch mode, see ui.css); keep holding
 *    another ~600 ms for the context menu.
 *  - Chromium's own (trusted) touch `contextmenu` is suppressed to avoid duplicates.
 *
 * The 3D viewport is left to gestures.js (it opens the menu while holding too).
 */
(function () {
	'use strict';
	const BBTouch = window.BBTouch;
	const cfg = BBTouch.config;
	cfg.ui_long_press_ms = cfg.ui_long_press_ms || 450;
	cfg.ui_long_press_slop = cfg.ui_long_press_slop || 10;
	cfg.tooltip_menu_extra_ms = cfg.tooltip_menu_extra_ms || 650;

	const LP = BBTouch.longpress = { fired_count: 0, last_target: null, last_touch_time: 0 };
	const synthetic = new WeakSet();
	let st = null;   // {id, x, y, target, timer, timer2, fired, ring}
	let ring = null;

	function active() { return BBTouch.enabled; }
	function isPreviewCanvas(t) {
		return t && t.tagName === 'CANVAS' && window.Preview && Preview.all && Preview.all.some(p => p.canvas === t);
	}
	const EXCLUDE = '#bbt_toolbar, .bbt_keypad, .bbt_edge, .nslide:not(.editing), .bbt_no_longpress, input:not([disabled]):not([readonly]):not([type="checkbox"]), textarea:not([disabled]), select, [contenteditable="true"], [contenteditable="plaintext-only"], .resizer, .panel_sidebar_resize_handle, #bbt_ring';

	function getRing() {
		if (!ring) {
			ring = document.createElement('div');
			ring.id = 'bbt_ring';
			document.body.append(ring);
		}
		return ring;
	}
	function showRing(x, y) {
		const r = getRing();
		r.style.left = x + 'px';
		r.style.top = y + 'px';
		r.style.setProperty('--bbt-ring-ms', cfg.ui_long_press_ms + 'ms');
		r.className = '';
		void r.offsetWidth; // restart animation
		r.className = 'holding';
	}
	function hideRing(done) {
		if (!ring) return;
		ring.className = done ? 'done' : '';
		if (done) setTimeout(() => { if (ring.className === 'done') ring.className = ''; }, 260);
	}

	function haptic() {
		// M7: shared helper (touch/pencil.js) – @capacitor/haptics, respects the haptics setting
		if (BBTouch.haptic) { BBTouch.haptic('medium'); return; }
		try {
			const H = window.Capacitor && Capacitor.Plugins && Capacitor.Plugins.Haptics;
			if (H && H.impact) { H.impact({ style: 'MEDIUM' }); return; }
		} catch (e) { /* ignore */ }
		try { if (navigator.vibrate) navigator.vibrate(12); } catch (e) { /* ignore */ }
	}

	LP.haptic = haptic;

	/** Dispatch a right click (contextmenu) at a target. Exposed for tests / other modules. */
	LP.dispatchContextMenu = function (target, x, y) {
		const init = {
			bubbles: true, cancelable: true, composed: true, view: window,
			clientX: x, clientY: y, screenX: x, screenY: y, button: 2, buttons: 2,
			shiftKey: !!(window.Pressing && Pressing.overrides && Pressing.overrides.shift),
			ctrlKey: !!(window.Pressing && Pressing.overrides && Pressing.overrides.ctrl),
			altKey: !!(window.Pressing && Pressing.overrides && Pressing.overrides.alt),
		};
		const ev = new MouseEvent('contextmenu', init);
		synthetic.add(ev);
		LP.fired_count++;
		LP.last_target = target;
		target.dispatchEvent(ev);
		// upstream outliner starts a drag after 320 ms on touch – its helper must not linger
		const helper = document.getElementById('outliner_drag_helper');
		if (helper) helper.remove();
		return ev;
	};

	// --- tooltip stage for toolbar buttons -------------------------------------
	let tooltip_el = null, tooltip_timer = 0;
	function tooltipTool(target) {
		const tool = target.closest('.tool');
		if (!tool || tool.classList.contains('nslide_tool')) return null;
		const tip = tool.querySelector(':scope > .tooltip');
		return tip && tip.textContent.trim() ? tool : null;
	}
	LP.showTooltip = function (tool, ms = 2600) {
		LP.hideTooltip();
		tooltip_el = tool;
		tool.classList.add('bbt_tooltip_visible');
		// keep it on screen
		const tip = tool.querySelector(':scope > .tooltip');
		if (tip) {
			tip.style.marginLeft = '';
			const r = tip.getBoundingClientRect();
			if (r.right > window.innerWidth - 4) tip.style.marginLeft = (window.innerWidth - 4 - r.right) + 'px';
			if (r.left < 4) tip.style.marginLeft = (4 - r.left) + 'px';
		}
		tooltip_timer = setTimeout(LP.hideTooltip, ms);
	};
	LP.hideTooltip = function () {
		clearTimeout(tooltip_timer);
		if (tooltip_el) {
			tooltip_el.classList.remove('bbt_tooltip_visible');
			const tip = tooltip_el.querySelector(':scope > .tooltip');
			if (tip) tip.style.marginLeft = '';
		}
		tooltip_el = null;
	};

	function cancel() {
		if (!st) return;
		clearTimeout(st.timer);
		clearTimeout(st.timer2);
		if (!st.fired) hideRing(false);
		st = null;
	}

	function fire() {
		if (!st) return;
		st.fired = true;
		hideRing(true);
		haptic();
		const tool = tooltipTool(st.target);
		if (tool) {
			LP.showTooltip(tool);
			const s = st;
			s.timer2 = setTimeout(() => {
				if (st !== s) return;
				LP.hideTooltip();
				haptic();
				LP.dispatchContextMenu(s.target, s.x, s.y);
			}, cfg.tooltip_menu_extra_ms);
			return;
		}
		LP.dispatchContextMenu(st.target, st.x, st.y);
	}

	window.addEventListener('touchstart', e => {
		LP.last_touch_time = performance.now();
		if (!active()) return;
		if (e.touches.length !== 1) { cancel(); return; }
		const t = e.touches[0];
		const target = e.target instanceof Element ? e.target : null;
		cancel();
		if (!target || isPreviewCanvas(target) || target.closest(EXCLUDE)) return;
		// M7: Apple Pencil never long-presses; painting in the UV editor (hold still = paint / navigate)
		if (t.touchType === 'stylus' || (BBTouch.pencil && BBTouch.pencil.blocksLongPress(target))) return;
		if (tooltip_el && !tooltip_el.contains(target)) LP.hideTooltip();
		st = { id: t.identifier, x: t.clientX, y: t.clientY, target, fired: false };
		st.timer = setTimeout(fire, cfg.ui_long_press_ms);
		const s = st;
		// delay the ring a little so plain taps don't flash it
		setTimeout(() => { if (st === s && !s.fired) showRing(s.x, s.y); }, 120);
	}, { capture: true, passive: true });

	window.addEventListener('touchmove', e => {
		if (!st) return;
		if (st.fired) {
			// swallow: no scrolling, no upstream drag, menu stays open
			if (e.cancelable) e.preventDefault();
			e.stopImmediatePropagation();
			return;
		}
		const t = [...e.touches].find(t => t.identifier === st.id);
		if (!t || e.touches.length > 1 || Math.hypot(t.clientX - st.x, t.clientY - st.y) > cfg.ui_long_press_slop) cancel();
	}, { capture: true, passive: false });

	function end(e) {
		LP.last_touch_time = performance.now();
		if (!st) return;
		if (st.fired) {
			// no compat mouse events / click on whatever is now under the finger (the menu)
			if (e.cancelable) e.preventDefault();
			clearTimeout(st.timer2);
			st = null;
			return;
		}
		cancel();
	}
	window.addEventListener('touchend', end, { capture: true, passive: false });
	window.addEventListener('touchcancel', end, { capture: true, passive: false });
	window.addEventListener('scroll', () => { if (st && !st.fired) cancel(); }, { capture: true, passive: true });

	// Chromium (and Android) fire a trusted contextmenu on long touch; we already sent ours.
	window.addEventListener('contextmenu', e => {
		if (synthetic.has(e) || !active()) return;
		const recent_touch = performance.now() - LP.last_touch_time < 1500;
		if (!recent_touch || isPreviewCanvas(e.target)) return;
		const t = e.target instanceof Element ? e.target : null;
		if (t && t.closest('input, textarea, .allow_default_menu')) return;
		e.preventDefault();
		e.stopImmediatePropagation();
	}, { capture: true });

	BBTouch.on('touch_mode', on => { if (!on) cancel(); });
})();
