/* Blockbench Touch layer — core / entry point.
 * Loaded as a classic script from www/index.html before the Blockbench bundle
 * (followed by touch/modifiers.js, touch/gestures.js, touch/toolbar.js).
 *
 * Provides the shared `window.BBTouch` namespace:
 *   BBTouch.enabled            – "touch mode" (gestures, bigger gizmo, toolbar modifiers)
 *   BBTouch.setEnabled(bool)
 *   BBTouch.store.get/set      – localStorage wrapper (never throws)
 *   BBTouch.onReady(fn)        – runs fn once Blockbench's interface + previews exist
 *   BBTouch.on(name, fn) / BBTouch.emit(name, data)
 */
(function () {
	'use strict';
	document.documentElement.classList.add('bb-touch');

	const BBTouch = window.BBTouch = window.BBTouch || {};
	BBTouch.version = '1.0.0';

	// --- storage -----------------------------------------------------------
	const PREFIX = 'bbtouch.';
	BBTouch.store = {
		get(key, fallback) {
			try {
				const raw = window.localStorage.getItem(PREFIX + key);
				return raw == null ? fallback : JSON.parse(raw);
			} catch (e) { return fallback; }
		},
		set(key, value) {
			try { window.localStorage.setItem(PREFIX + key, JSON.stringify(value)); } catch (e) { /* private mode etc. */ }
		},
	};

	// --- tiny event bus ------------------------------------------------------
	const listeners = {};
	BBTouch.on = function (name, fn) { (listeners[name] = listeners[name] || []).push(fn); };
	BBTouch.emit = function (name, data) {
		(listeners[name] || []).forEach(fn => { try { fn(data); } catch (e) { console.error('[BBTouch]', name, e); } });
	};

	// --- touch mode ----------------------------------------------------------
	// Default on for touch devices, off for mouse-only desktops (still toggleable).
	const default_enabled = ('ontouchend' in document) || navigator.maxTouchPoints > 0;
	BBTouch.enabled = BBTouch.store.get('enabled', default_enabled);
	document.documentElement.classList.toggle('bb-touch-mode', !!BBTouch.enabled);
	BBTouch.setEnabled = function (value) {
		BBTouch.enabled = !!value;
		BBTouch.store.set('enabled', BBTouch.enabled);
		document.documentElement.classList.toggle('bb-touch-mode', BBTouch.enabled);
		BBTouch.emit('touch_mode', BBTouch.enabled);
	};

	// Tunables (kept here so later milestones / a settings dialog can expose them).
	BBTouch.config = Object.assign({
		tap_slop: 10,            // px a finger may move and still count as a tap
		double_tap_ms: 320,
		double_tap_dist: 40,
		multi_tap_ms: 280,       // max duration of a 2/3-finger tap
		long_press_ms: 420,      // matches upstream's rclick_cooldown
		orbit_speed: 1.0,
		gizmo_scale: 1.5,        // multiplier on top of settings.control_size
		pick_tolerance: 1.5,     // extra multiplier on raycaster point/line thresholds
	}, BBTouch.config || {});

	// --- ready hook ----------------------------------------------------------
	const ready_queue = [];
	let is_ready = false;
	function checkReady() {
		const w = window;
		return w.Blockbench && w.Preview && w.Preview.all && w.Preview.all.length &&
			w.Transformer && w.BarItems && w.BarItems.undo && w.Pressing && w.THREE;
	}
	BBTouch.onReady = function (fn) {
		if (is_ready) { try { fn(); } catch (e) { console.error('[BBTouch]', e); } }
		else ready_queue.push(fn);
	};
	const timer = setInterval(() => {
		if (!checkReady()) return;
		clearInterval(timer);
		is_ready = true;
		BBTouch.ready = true;
		ready_queue.splice(0).forEach(fn => { try { fn(); } catch (e) { console.error('[BBTouch]', e); } });
		BBTouch.emit('ready');
	}, 100);

	// --- iOS WKWebView quirks -----------------------------------------------
	// Safari's proprietary gesture events would otherwise zoom/rotate the page.
	['gesturestart', 'gesturechange', 'gestureend'].forEach(type => {
		document.addEventListener(type, e => e.preventDefault(), { passive: false });
	});

	console.log('Blockbench Touch layer loaded');
})();
