/* Blockbench Touch layer — sticky modifier keys (Shift / Ctrl(⌘) / Alt).
 *
 * Upstream already reads `Pressing.overrides.{shift,ctrl,alt}` almost everywhere
 * it checks a modifier (Keybind.isTriggered, additionalModifierTriggered, snapping
 * in transform.js / edit_transform.js, multi-select in preview.ts, outliner, UV…).
 * We drive those overrides, and additionally patch `shiftKey`/`ctrlKey`/`metaKey`/
 * `altKey` on pointer/mouse/touch events (window capture phase) for the few code
 * paths that only look at the event.
 *
 * States per key: 'off' | 'once' (cleared after the next action) | 'lock'.
 * Tap = off→once, tap again quickly = lock, tap while on = off.
 */
(function () {
	'use strict';
	const BBTouch = window.BBTouch;
	const KEYS = ['shift', 'ctrl', 'alt'];
	const state = { shift: 'off', ctrl: 'off', alt: 'off' };
	const last_tap = { shift: 0, ctrl: 0, alt: 0 };

	function pressing() { return window.Pressing && window.Pressing.overrides; }

	function apply() {
		const o = pressing();
		if (o) KEYS.forEach(k => { o[k] = state[k] !== 'off'; });
		BBTouch.emit('modifiers', Object.assign({}, state));
	}

	const Modifiers = BBTouch.modifiers = {
		state,
		get(key) { return state[key]; },
		isActive(key) { return state[key] !== 'off'; },
		anyActive() { return KEYS.some(k => state[k] !== 'off'); },
		set(key, value) {
			if (!KEYS.includes(key)) return;
			state[key] = value;
			apply();
		},
		/** Toolbar tap: off → once; once tapped again within double_tap_ms → lock; else → off. */
		tap(key) {
			const now = performance.now();
			const quick = now - last_tap[key] < BBTouch.config.double_tap_ms;
			last_tap[key] = now;
			if (state[key] === 'off') state[key] = 'once';
			else if (state[key] === 'once' && quick) state[key] = 'lock';
			else state[key] = 'off';
			apply();
			return state[key];
		},
		/** Clear one-shot modifiers (called after the next real action). */
		consume() {
			let changed = false;
			KEYS.forEach(k => { if (state[k] === 'once') { state[k] = 'off'; changed = true; } });
			if (changed) apply();
		},
		clearAll() { KEYS.forEach(k => { state[k] = 'off'; }); apply(); },
		/** Re-read Pressing.overrides in case upstream's own modifier menu changed them. */
		sync() {
			const o = pressing();
			if (!o) return;
			let changed = false;
			KEYS.forEach(k => {
				if (o[k] && state[k] === 'off') { state[k] = 'lock'; changed = true; }
				if (!o[k] && state[k] !== 'off') { state[k] = 'off'; changed = true; }
			});
			if (changed) BBTouch.emit('modifiers', Object.assign({}, state));
		},
	};

	// --- patch modifier flags onto input events ---------------------------------
	const PATCH_EVENTS = ['pointerdown', 'pointermove', 'pointerup', 'mousedown', 'mousemove', 'mouseup',
		'click', 'dblclick', 'contextmenu', 'touchstart', 'touchmove', 'touchend', 'wheel'];
	const is_mac = /Mac|iPhone|iPad|iPod/.test(navigator.platform || '') || /Mac OS X/.test(navigator.userAgent);

	function patchEvent(e) {
		if (!Modifiers.anyActive()) return;
		if (e.target && e.target.closest && e.target.closest('#bbt_toolbar')) return;
		const define = (prop) => {
			if (e[prop]) return;
			try { Object.defineProperty(e, prop, { value: true, configurable: true }); } catch (err) { /* ignore */ }
		};
		if (state.shift !== 'off') define('shiftKey');
		if (state.alt !== 'off') define('altKey');
		if (state.ctrl !== 'off') { define('ctrlKey'); if (is_mac) define('metaKey'); }
	}
	PATCH_EVENTS.forEach(type => window.addEventListener(type, patchEvent, { capture: true, passive: true }));

	// --- consume one-shot modifiers after the next action -------------------------
	// A "use" = a pointer sequence outside the toolbar that wasn't pure camera
	// navigation (tap-select, gizmo drag, outliner click, button press, ...).
	let pending_down = null;
	window.addEventListener('pointerdown', e => {
		const in_toolbar = e.target && e.target.closest && e.target.closest('#bbt_toolbar');
		pending_down = in_toolbar ? null : e.pointerId;
	}, { capture: true, passive: true });
	window.addEventListener('pointerup', e => {
		if (pending_down !== e.pointerId) return;
		pending_down = null;
		// Let the up/touchend/click handlers (which may still read the modifier) run first.
		setTimeout(() => {
			const g = BBTouch.gestures;
			if (g && g.last_sequence_was_navigation) return;
			Modifiers.consume();
		}, 80);
	}, { capture: true, passive: true });

	BBTouch.onReady(() => {
		apply();
		setInterval(Modifiers.sync, 500);
	});
})();
