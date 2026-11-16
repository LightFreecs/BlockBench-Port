/* Blockbench Touch layer — floating modifier / quick-action toolbar.
 *
 * Draggable (grip), collapsible, position + collapsed state stored in localStorage.
 * Buttons: Shift, Ctrl(⌘), Alt (sticky: tap = next action, double-tap = lock),
 * Undo, Redo, Focus, Delete, Duplicate, Quick Actions, Touch-mode toggle.
 * Compact layouts (iPhone, html.bbt_compact): horizontal, collapsed by default, bottom-left.
 */
(function () {
	'use strict';
	const BBTouch = window.BBTouch;
	const is_mac = /Mac|iPhone|iPad|iPod/.test(navigator.platform || '') || /Mac OS X/.test(navigator.userAgent);

	const BUTTONS = [
		{ id: 'shift', mod: 'shift', label: 'Shift', glyph: '⇧', title: 'Shift (tap: next action, double-tap: lock)' },
		{ id: 'ctrl', mod: 'ctrl', label: is_mac ? '⌘' : 'Ctrl', glyph: is_mac ? '⌘' : '⌃', title: 'Ctrl / Cmd (tap: next action, double-tap: lock)' },
		{ id: 'alt', mod: 'alt', label: 'Alt', glyph: '⌥', title: 'Alt / Option (tap: next action, double-tap: lock)' },
		{ sep: true },
		{ id: 'undo', icon: 'undo', title: 'Undo', action: 'undo' },
		{ id: 'redo', icon: 'redo', title: 'Redo', action: 'redo' },
		{ id: 'focus', icon: 'center_focus_weak', title: 'Focus on selection (none selected: frame all)', run: focus },
		{ id: 'duplicate', icon: 'content_copy', title: 'Duplicate', action: 'duplicate' },
		{ id: 'delete', icon: 'delete', title: 'Delete', action: 'delete' },
		{ id: 'quick_actions', icon: 'bolt', title: 'Quick Actions (search every action)', run: () => BBTouch.ui && BBTouch.ui.quickActions() },
		{ sep: true },
		{ id: 'touch_mode', icon: 'touch_app', title: 'Touch mode (gestures, big gizmo)', run: () => BBTouch.setEnabled(!BBTouch.enabled) },
	];

	function focus() {
		const g = BBTouch.gestures;
		const has_selection = window.Outliner && (Outliner.selected.length || (window.Group && Group.first_selected));
		if (has_selection) g.focusSelection(); else g.frameAll();
	}

	function runAction(id) {
		const a = window.BarItems && BarItems[id];
		if (!a) return;
		// Toolbar buttons act on the 3D viewport context (delete/duplicate are panel-dependent).
		if (window.Prop && Prop.active_panel !== 'outliner' && Prop.active_panel !== 'uv' && Prop.active_panel !== 'timeline') {
			Prop.active_panel = 'preview';
		}
		a.trigger();
	}

	const saved = BBTouch.store.get('toolbar', {});
	let el, body;

	function build() {
		el = document.createElement('div');
		el.id = 'bbt_toolbar';
		el.setAttribute('role', 'toolbar');
		el.innerHTML = '<div class="bbt_grip" title="Drag to move"><i class="material-icons">drag_indicator</i></div>' +
			'<div class="bbt_body"></div>' +
			'<button class="bbt_btn bbt_collapse" data-id="collapse" title="Collapse / expand"><i class="material-icons">expand_less</i></button>';
		body = el.querySelector('.bbt_body');
		BUTTONS.forEach(b => {
			if (b.sep) { body.insertAdjacentHTML('beforeend', '<div class="bbt_sep"></div>'); return; }
			const btn = document.createElement('button');
			btn.className = 'bbt_btn' + (b.mod ? ' bbt_mod' : '');
			btn.dataset.id = b.id;
			btn.title = b.title;
			btn.innerHTML = b.icon ? `<i class="material-icons">${b.icon}</i>` : `<span class="bbt_glyph">${b.glyph}</span><span class="bbt_label">${b.label}</span>`;
			body.append(btn);
		});
		document.body.append(el);

		const compact = !!(window.Blockbench && Blockbench.isMobile);
		el.classList.toggle('horizontal', compact);
		el.classList.toggle('collapsed', saved.collapsed === undefined ? compact : !!saved.collapsed);
		place(saved.x, saved.y);
		// the interface layout settles after boot: re-apply the default position
		setTimeout(() => place(saved.x, saved.y), 400);
		setTimeout(() => place(saved.x, saved.y), 1500);

		// Don't steal focus / start text selection; act on pointerup for zero latency.
		el.addEventListener('pointerdown', e => {
			e.preventDefault();
			e.stopPropagation();
		});
		el.addEventListener('click', e => { e.preventDefault(); e.stopPropagation(); });
		el.addEventListener('contextmenu', e => { e.preventDefault(); e.stopPropagation(); });
		el.querySelectorAll('.bbt_btn').forEach(btn => {
			btn.addEventListener('pointerup', e => {
				e.preventDefault();
				e.stopPropagation();
				press(btn.dataset.id);
			});
		});
		setupDrag(el.querySelector('.bbt_grip'));
		render();
		window.addEventListener('resize', () => place(saved.x, saved.y));
	}

	function press(id) {
		if (id === 'collapse') {
			saved.collapsed = !el.classList.contains('collapsed');
			el.classList.toggle('collapsed', saved.collapsed);
			BBTouch.store.set('toolbar', saved);
			place(saved.x, saved.y);
			return;
		}
		const b = BUTTONS.find(b => b.id === id);
		if (!b) return;
		if (b.mod) BBTouch.modifiers.tap(b.mod);
		else if (b.action) runAction(b.action);
		else if (b.run) b.run();
		render();
	}

	function render() {
		if (!el) return;
		const m = BBTouch.modifiers;
		el.querySelectorAll('.bbt_mod').forEach(btn => {
			const s = m.get(btn.dataset.id);
			btn.classList.toggle('active', s !== 'off');
			btn.classList.toggle('locked', s === 'lock');
		});
		const tm = el.querySelector('[data-id="touch_mode"]');
		if (tm) tm.classList.toggle('active', !!BBTouch.enabled);
		const col = el.querySelector('.bbt_collapse i');
		if (col) {
			const c = el.classList.contains('collapsed'), hz = el.classList.contains('horizontal');
			col.textContent = hz ? (c ? 'chevron_right' : 'chevron_left') : (c ? 'expand_more' : 'expand_less');
		}
	}

	function place(x, y) {
		const w = el.offsetWidth, h = el.offsetHeight;
		const vw = window.innerWidth, vh = window.innerHeight;
		if (typeof x !== 'number' || typeof y !== 'number') {
			// default: inside the left edge of the 3D viewport
			const c = window.Preview && Preview.selected && Preview.selected.canvas;
			const r = c && c.isConnected ? c.getBoundingClientRect() : null;
			x = r && r.width ? r.left + 30 : 8; // clear of the sidebar edge toggle (ui.js)
			y = r && r.height ? r.top + 8 : Math.round(vh * 0.15);
			if (el.classList.contains('horizontal') && r && r.height) y = r.bottom - h - 8;
		}
		x = Math.min(Math.max(x, 0), Math.max(vw - w, 0));
		y = Math.min(Math.max(y, 0), Math.max(vh - h, 0));
		el.style.left = x + 'px';
		el.style.top = y + 'px';
		return { x, y };
	}

	function setupDrag(grip) {
		let start = null;
		grip.addEventListener('pointerdown', e => {
			const r = el.getBoundingClientRect();
			start = { id: e.pointerId, dx: e.clientX - r.left, dy: e.clientY - r.top };
			try { grip.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
			el.classList.add('dragging');
		});
		grip.addEventListener('pointermove', e => {
			if (!start || e.pointerId !== start.id) return;
			place(e.clientX - start.dx, e.clientY - start.dy);
		});
		const end = e => {
			if (!start || e.pointerId !== start.id) return;
			start = null;
			el.classList.remove('dragging');
			const r = el.getBoundingClientRect();
			saved.x = Math.round(r.left); saved.y = Math.round(r.top);
			BBTouch.store.set('toolbar', saved);
		};
		grip.addEventListener('pointerup', end);
		grip.addEventListener('pointercancel', end);
		grip.addEventListener('touchmove', e => e.preventDefault(), { passive: false });
	}

	BBTouch.toolbar = {
		get element() { return el; },
		press, render,
		resetPosition() { delete saved.x; delete saved.y; BBTouch.store.set('toolbar', saved); place(); },
	};
	BBTouch.on('modifiers', render);
	BBTouch.on('touch_mode', render);
	BBTouch.onReady(build);
})();
