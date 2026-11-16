/* Blockbench Touch layer — touch-friendly interface outside the 3D viewport (M6).
 *
 *  - Sidebar edge buttons (iPad / wide layouts): small tabs on the left/right edge of
 *    the viewport hide/show the left and right sidebars (Prop.show_left_bar/right_bar)
 *    to maximise the viewport. State persisted.
 *  - Compact layout (upstream "mobile" layout, iPhone / height ≤ 500 / width ≤ 960):
 *    upstream already shows panels as slide-over sheets from its panel selector bar;
 *    we enlarge its targets (ui.css) and keep our floating toolbar out of the way.
 *  - "Quick Actions" (command palette = upstream ActionControl): a button in the menu
 *    bar and in the floating toolbar; opens without popping the iOS keyboard (tap the
 *    search field to type), list is scrollable/tappable.
 *  - Menus: tap toggles menu-bar menus, submenus open on tap; iOS/Chromium compat
 *    `mouseenter/mouseover` from a touch no longer re-toggle menus (open→close flicker).
 *  - Tooltips: hover tooltips are off in touch mode (they stuck after a tap); the
 *    long press shows them (longpress.js) — ui.css provides the visible state.
 *  - Text inputs: the document is kept from scrolling when the iOS keyboard opens;
 *    a focused field inside a dialog that would end up under the keyboard lifts the dialog.
 *  - Resizers / panel scroll containers get touch-action + overscroll containment (ui.css).
 */
(function () {
	'use strict';
	const BBTouch = window.BBTouch;
	const UI = BBTouch.ui = { stats: { quick_actions: 0, sidebar_toggles: 0 } };
	function active() { return BBTouch.enabled; }
	function recentTouch(ms = 900) {
		const lp = BBTouch.longpress;
		return lp && performance.now() - lp.last_touch_time < ms;
	}

	// --- quick actions (command palette) ----------------------------------------------
	UI.quickActions = function (opts = {}) {
		if (!window.ActionControl) return;
		UI.stats.quick_actions++;
		if (window.Menu && Menu.open) Menu.open.hide();
		ActionControl.select(opts.input);
		if (active() && !opts.keyboard) {
			// don't pop the iOS keyboard; tapping the field focuses it normally
			const blur = () => {
				const inp = document.querySelector('#action_selector > input');
				if (inp && document.activeElement === inp) inp.blur();
			};
			setTimeout(blur, 0);
			setTimeout(blur, 60);
		}
	};

	// --- sidebar edge toggles -------------------------------------------------------
	const sb_state = BBTouch.store.get('sidebars', {});
	let edge_left, edge_right;

	function isCompact() { return !!(window.Blockbench && Blockbench.isMobile); }
	function sidebarsAvailable() {
		return !isCompact() && window.Mode && Mode.selected && !Mode.selected.hide_sidebars;
	}

	UI.setSidebar = function (side, show) {
		const key = side === 'left' ? 'show_left_bar' : 'show_right_bar';
		if (!window.Prop) return;
		Prop[key] = show === undefined ? !Prop[key] : !!show;
		sb_state[side] = Prop[key];
		BBTouch.store.set('sidebars', sb_state);
		UI.stats.sidebar_toggles++;
		if (window.updateInterface) updateInterface();
		else if (window.resizeWindow) resizeWindow();
		positionEdges();
	};

	function makeEdge(side) {
		const b = document.createElement('button');
		b.className = 'bbt_edge bbt_edge_' + side;
		b.dataset.side = side;
		b.title = side === 'left' ? 'Show / hide left sidebar' : 'Show / hide right sidebar';
		b.innerHTML = '<i class="material-icons"></i>';
		b.addEventListener('pointerdown', e => { e.preventDefault(); e.stopPropagation(); });
		b.addEventListener('click', e => { e.preventDefault(); e.stopPropagation(); UI.setSidebar(side); });
		b.addEventListener('contextmenu', e => { e.preventDefault(); e.stopPropagation(); });
		document.body.append(b);
		return b;
	}

	function positionEdges() {
		if (!edge_left) return;
		const center = document.getElementById('center');
		const show = active() && sidebarsAvailable() && center && center.offsetWidth > 0;
		[edge_left, edge_right].forEach(b => b.classList.toggle('visible', !!show));
		if (!show) return;
		const r = center.getBoundingClientRect();
		const y = Math.round(r.top + r.height / 2 - 28);
		edge_left.style.left = Math.round(r.left) + 'px';
		edge_left.style.top = y + 'px';
		edge_right.style.left = Math.round(r.right - edge_right.offsetWidth) + 'px';
		edge_right.style.top = y + 'px';
		edge_left.querySelector('i').textContent = Prop.show_left_bar ? 'chevron_left' : 'chevron_right';
		edge_right.querySelector('i').textContent = Prop.show_right_bar ? 'chevron_right' : 'chevron_left';
		edge_left.classList.toggle('collapsed', !Prop.show_left_bar);
		edge_right.classList.toggle('collapsed', !Prop.show_right_bar);
	}
	UI.positionEdges = positionEdges;

	// --- menu bar quick-actions button ---------------------------------------------------
	function addMenuBarButton() {
		const bar = document.getElementById('menu_bar');
		if (!bar || document.getElementById('bbt_quick_actions_menu')) return;
		const li = document.createElement('li');
		li.id = 'bbt_quick_actions_menu';
		li.className = 'menu_bar_point bbt_quick_actions';
		li.title = 'Quick Actions (search all actions)';
		li.innerHTML = '<i class="material-icons">bolt</i><span>Actions</span>';
		li.addEventListener('click', e => { e.stopPropagation(); UI.quickActions(); });
		bar.append(li);
	}

	// --- menus: tap semantics -----------------------------------------------------------
	// Compat mouse events after a touch would (a) re-open/close menu-bar menus and (b)
	// toggle submenus a second time. Block them; taps are handled explicitly below.
	['mouseenter', 'mouseover'].forEach(type => {
		window.addEventListener(type, e => {
			if (!active() || !recentTouch()) return;
			const t = e.target instanceof Element ? e.target : null;
			if (!t) return;
			if (t.closest('.menu_bar_point, ul.contextMenu li, .contextMenu .menu_more_button')) e.stopImmediatePropagation();
		}, { capture: true });
	});
	// Tap on a submenu parent opens it (click on li.parent does not close the menu upstream).
	window.addEventListener('pointerup', e => {
		if (!active() || e.pointerType === 'mouse') return;
		const t = e.target instanceof Element ? e.target : null;
		if (!t || !window.Menu || !Menu.open) return;
		const more = t.closest('.contextMenu .menu_more_button');
		const li = more ? more.closest('li') : t.closest('ul.contextMenu li.parent');
		if (!li || li.classList.contains('menu_separator')) return;
		try { Menu.open.hover(li, e, true); } catch (err) { /* ignore */ }
	}, { capture: true });

	// Long-press tooltips: hide any visible one when tapping elsewhere.
	window.addEventListener('pointerdown', e => {
		if (BBTouch.longpress && e.pointerType !== 'mouse') {
			const t = e.target instanceof Element ? e.target : null;
			if (!t || !t.closest('.bbt_tooltip_visible')) BBTouch.longpress.hideTooltip();
		}
	}, { capture: true });

	// --- keyboard / text input layout stability ------------------------------------------
	function lockScroll() {
		const se = document.scrollingElement || document.documentElement;
		if (se.scrollTop || se.scrollLeft) { se.scrollTop = 0; se.scrollLeft = 0; }
	}
	window.addEventListener('scroll', () => { if (active()) lockScroll(); }, { passive: true });
	let lifted = null;
	function unlift() {
		if (lifted) { lifted.style.transform = lifted.dataset.bbtTransform || ''; delete lifted.dataset.bbtTransform; lifted = null; }
	}
	function liftForKeyboard() {
		if (!active()) return;
		const vv = window.visualViewport;
		const el = document.activeElement;
		if (!vv || !el || !el.matches || !el.matches('input, textarea, [contenteditable="true"], [contenteditable="plaintext-only"]')) { unlift(); return; }
		lockScroll();
		const dialog = el.closest('dialog, .dialog, #action_selector');
		const visible_bottom = vv.offsetTop + vv.height;
		const r = el.getBoundingClientRect();
		if (!dialog) return;
		if (r.bottom + 12 > visible_bottom) {
			if (lifted !== dialog) { unlift(); lifted = dialog; dialog.dataset.bbtTransform = dialog.style.transform || ''; }
			const lift = Math.min(r.bottom + 12 - visible_bottom, dialog.getBoundingClientRect().top - 4 + (parseFloat(dialog.dataset.bbtLift) || 0));
			dialog.style.transform = `translateY(${-Math.max(lift, 0)}px)`;
		} else if (vv.height >= window.innerHeight - 1) {
			unlift();
		}
	}
	if (window.visualViewport) {
		visualViewport.addEventListener('resize', liftForKeyboard);
		visualViewport.addEventListener('scroll', liftForKeyboard);
	}
	document.addEventListener('focusin', () => setTimeout(liftForKeyboard, 50));
	document.addEventListener('focusout', () => setTimeout(() => {
		const el = document.activeElement;
		if (!el || !el.matches || !el.matches('input, textarea, [contenteditable="true"], [contenteditable="plaintext-only"]')) unlift();
	}, 50));

	// --- setup ---------------------------------------------------------------------------
	function syncClasses() {
		const html = document.documentElement;
		html.classList.toggle('bbt_compact', isCompact());
	}

	BBTouch.onReady(() => {
		syncClasses();
		if (window.MenuBar && MenuBar.update && !MenuBar.update.__bbtouch) {
			const orig = MenuBar.update;
			MenuBar.update = function () { const r = orig.apply(this, arguments); addMenuBarButton(); return r; };
			MenuBar.update.__bbtouch = true;
		}
		addMenuBarButton();
		edge_left = makeEdge('left');
		edge_right = makeEdge('right');
		// restore user's sidebar choice (wide layouts only)
		if (sidebarsAvailable() && window.Prop) {
			let changed = false;
			if (sb_state.left === false && Prop.show_left_bar) { Prop.show_left_bar = false; changed = true; }
			if (sb_state.right === false && Prop.show_right_bar) { Prop.show_right_bar = false; changed = true; }
			if (changed && window.updateInterface) updateInterface();
		}
		const center = document.getElementById('center');
		if (center && window.ResizeObserver) new ResizeObserver(positionEdges).observe(center);
		window.addEventListener('resize', () => { syncClasses(); positionEdges(); });
		if (window.Blockbench && Blockbench.on) {
			['select_mode', 'resize_window', 'update_interface'].forEach(ev => { try { Blockbench.on(ev, () => setTimeout(positionEdges, 0)); } catch (e) { /* ignore */ } });
		}
		// cheap safety net (mode switches, panel moves; MenuBar.update() rebuilds the bar)
		setInterval(() => { positionEdges(); addMenuBarButton(); }, 1000);
		positionEdges();
	});
	BBTouch.on('touch_mode', () => positionEdges());
})();
