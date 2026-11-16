/* Blockbench Touch layer — numeric sliders and number inputs on touch.
 *
 * Upstream NumSliders (`.nslide`, e.g. position/rotation/size in the Element
 * panel) start a scrub on *any* touchmove (so scrolling a panel over them
 * changed values) and enter contenteditable on tap (iOS keyboard pops up).
 * In touch mode we take over the touch sequence on `.nslide` (window capture,
 * before upstream's jQuery handlers):
 *
 *   horizontal drag           → scrub (≈12 px per step, upstream interval incl.
 *                               sticky Shift/Ctrl modifiers); value bubble above the finger
 *   vertical drag             → the panel scrolls (touch-action: pan-y), value untouched
 *   hold still ≈400 ms, drag  → precision scrub (×0.1), ring + "fine" badge
 *   …also: finger dragged >70 px above/below the slider → ×0.1 (iOS scrubbing style)
 *   hold still, lift          → upstream slider context menu (copy / paste / round / reset)
 *   tap                       → keypad popover (digits, . − ± ⌫, + − × ÷ ( ), nudge −/+ step,
 *                               keyboard fallback). Expressions go through upstream's own
 *                               NumSlider input path (MolangParser, "+5" = relative, "val", %).
 *
 * `.numeric_input` / `input[type=number]` fields in dialogs: tap opens the same keypad
 * (no iOS keyboard); the keypad's ⌨ button focuses the field for native typing.
 */
(function () {
	'use strict';
	const BBTouch = window.BBTouch;
	const cfg = BBTouch.config;
	cfg.scrub_px_per_step = cfg.scrub_px_per_step || 12;
	cfg.scrub_hold_ms = cfg.scrub_hold_ms || 400;
	cfg.scrub_fine_factor = cfg.scrub_fine_factor || 0.1;
	cfg.scrub_fine_distance = cfg.scrub_fine_distance || 70;

	const I = BBTouch.inputs = { stats: { scrubs: 0, keypad_opens: 0, keypad_applies: 0, menus: 0 } };
	function active() { return BBTouch.enabled; }
	function fmt(n) {
		if (typeof n !== 'number' || !isFinite(n)) return String(n);
		return window.trimFloatNumber ? trimFloatNumber(n, 6) : String(Math.round(n * 1e6) / 1e6);
	}
	function modifierEvent(extra) {
		const o = (window.Pressing && Pressing.overrides) || {};
		return Object.assign({ shiftKey: !!o.shift, ctrlKey: !!o.ctrl, ctrlOrCmd: !!o.ctrl, altKey: !!o.alt, metaKey: false, type: 'bbtouch' }, extra);
	}
	function sliderFromNode(node) {
		const tool = node.closest('[toolbar_item]');
		const id = (tool && tool.getAttribute('toolbar_item')) || node.getAttribute('n-action');
		const s = id && window.BarItems && BarItems[id];
		return s && s.type === 'numslider' ? s : null;
	}

	// --- value bubble ------------------------------------------------------------
	let bubble = null;
	function showBubble(x, y, text, fine) {
		if (!bubble) {
			bubble = document.createElement('div');
			bubble.id = 'bbt_scrub_bubble';
			document.body.append(bubble);
		}
		bubble.textContent = text;
		bubble.classList.toggle('fine', !!fine);
		bubble.style.left = x + 'px';
		bubble.style.top = Math.max(y - 64, 4) + 'px';
		bubble.style.display = 'block';
	}
	function hideBubble() { if (bubble) bubble.style.display = 'none'; }

	// --- NumSlider touch handling -------------------------------------------------
	let sc = null; // scrub state

	function onSliderTouchStart(e, inner) {
		const slider = sliderFromNode(inner);
		if (!slider) return false;
		if (window.Condition && slider.condition && !Condition(slider.condition)) return false;
		const t = e.changedTouches[0];
		e.stopImmediatePropagation(); // upstream mousedown/touchstart scrub never starts
		if (KP.isOpen()) KP.close(false);
		sc = {
			id: t.identifier, slider, inner, sx: t.clientX, sy: t.clientY, lx: t.clientX,
			t0: performance.now(), mode: 'pending', fine: false, acc: 0, steps: 0, start_value: slider.value,
			rect: inner.getBoundingClientRect(),
		};
		const s = sc;
		s.hold = setTimeout(() => {
			if (sc !== s || s.mode !== 'pending') return;
			s.fine = true;
			s.held = true;
			inner.classList.add('bbt_fine');
			if (BBTouch.longpress && BBTouch.longpress.haptic) BBTouch.longpress.haptic();
			showBubble(s.sx, s.rect.top, fmt(Number(slider.value)) + '  fine', true);
		}, cfg.scrub_hold_ms);
		return true;
	}

	function scrubMove(e, t) {
		const s = sc;
		const dx = t.clientX - s.sx, dy = t.clientY - s.sy;
		if (s.mode === 'pending') {
			if (Math.hypot(dx, dy) < cfg.tap_slop) return;
			if (Math.abs(dy) > Math.abs(dx) && !s.held) {
				// vertical: hand over to native panel scrolling
				s.mode = 'scroll';
				clearTimeout(s.hold);
				return;
			}
			s.mode = 'scrub';
			clearTimeout(s.hold);
			s.lx = s.sx + Math.sign(dx) * cfg.tap_slop * 0.5; // small dead zone, no jump
			I.stats.scrubs++;
			s.slider.last_value = s.slider.value;
			s.slider.sliding = true;
			if (typeof s.slider.onBefore === 'function') s.slider.onBefore();
			document.documentElement.classList.add('bbt_scrubbing');
		}
		if (s.mode !== 'scrub') return;
		if (e.cancelable) e.preventDefault();
		const off_y = t.clientY < s.rect.top ? s.rect.top - t.clientY : (t.clientY > s.rect.bottom ? t.clientY - s.rect.bottom : 0);
		const fine = s.held || off_y > cfg.scrub_fine_distance;
		s.inner.classList.toggle('bbt_fine', fine);
		// s.acc / s.steps are in units of the slider interval; fine mode moves in 0.1 steps
		const q = fine ? cfg.scrub_fine_factor : 1;
		s.acc += (t.clientX - s.lx) / cfg.scrub_px_per_step * q;
		s.lx = t.clientX;
		const target = Math.round((s.steps + Math.trunc((s.acc - s.steps) / q) * q) * 1e6) / 1e6;
		if (target !== s.steps) {
			const ev = modifierEvent({ clientX: t.clientX, clientY: t.clientY });
			const interval = s.slider.getInterval(ev) || 1;
			const difference = (target - s.steps) * interval;
			s.steps = target;
			s.slider.change(n => n + difference, ev);
			s.slider.update();
		}
		showBubble(t.clientX, s.rect.top, fmt(Number(s.slider.value)) + (fine ? '  fine' : ''), fine);
	}

	function scrubEnd(e, cancelled) {
		const s = sc;
		sc = null;
		clearTimeout(s.hold);
		s.inner.classList.remove('bbt_fine');
		hideBubble();
		document.documentElement.classList.remove('bbt_scrubbing');
		if (s.mode === 'scrub') {
			delete s.slider.sliding;
			if (typeof s.slider.onAfter === 'function') {
				s.slider.onAfter(parseFloat(s.slider.value) - parseFloat(s.start_value));
			}
			if (e.cancelable) e.preventDefault();
			return;
		}
		if (cancelled || s.mode !== 'pending') return;
		if (e.cancelable) e.preventDefault(); // no compat mousedown/click → no contenteditable/keyboard
		if (s.held) {
			I.stats.menus++;
			if (BBTouch.longpress) BBTouch.longpress.dispatchContextMenu(s.inner, s.sx, s.sy);
			return;
		}
		KP.openForSlider(s.slider, s.inner);
	}

	// --- plain number inputs (dialogs, forms) --------------------------------------
	let ip = null;
	function numericInputTarget(el) {
		if (!(el instanceof HTMLInputElement) || el.readOnly || el.disabled) return null;
		if (el.type === 'number' || el.closest('.numeric_input')) return el;
		return null;
	}

	window.addEventListener('touchstart', e => {
		if (!active() || e.touches.length !== 1) return;
		const target = e.target instanceof Element ? e.target : null;
		if (!target) return;
		const inner = target.closest('.nslide');
		if (inner && !inner.classList.contains('editing')) {
			if (onSliderTouchStart(e, inner)) return;
		}
		const input = numericInputTarget(target);
		if (input && document.activeElement !== input) {
			const t = e.changedTouches[0];
			ip = { id: t.identifier, input, sx: t.clientX, sy: t.clientY, moved: false };
		}
	}, { capture: true, passive: false });

	window.addEventListener('touchmove', e => {
		if (sc) {
			const t = [...e.changedTouches].find(t => t.identifier === sc.id);
			if (e.touches.length > 1) { scrubEnd(e, true); return; }
			if (t) scrubMove(e, t);
			if (sc && sc.mode === 'scrub') e.stopImmediatePropagation();
		}
		if (ip) {
			const t = [...e.changedTouches].find(t => t.identifier === ip.id);
			if (t && Math.hypot(t.clientX - ip.sx, t.clientY - ip.sy) > cfg.tap_slop) ip = null;
		}
	}, { capture: true, passive: false });

	function onEnd(e) {
		if (sc && [...e.changedTouches].some(t => t.identifier === sc.id)) {
			scrubEnd(e, e.type === 'touchcancel');
		}
		if (ip && [...e.changedTouches].some(t => t.identifier === ip.id)) {
			const input = ip.input;
			ip = null;
			if (e.type === 'touchend') {
				if (e.cancelable) e.preventDefault(); // no focus → no iOS keyboard
				KP.openForInput(input);
			}
		}
	}
	window.addEventListener('touchend', onEnd, { capture: true, passive: false });
	window.addEventListener('touchcancel', onEnd, { capture: true, passive: false });

	// Compat mouse events after a touch on a slider must not reach upstream (would start
	// a pointer-locked scrub / contenteditable).
	window.addEventListener('mousedown', e => {
		if (!active()) return;
		const lp = BBTouch.longpress;
		if (!lp || performance.now() - lp.last_touch_time > 800) return;
		const t = e.target instanceof Element ? e.target : null;
		const inner = t && t.closest('.nslide');
		if (inner && !inner.classList.contains('editing')) e.stopImmediatePropagation();
	}, { capture: true });

	// --- keypad popover --------------------------------------------------------------
	const KP = I.keypad = (function () {
		let el = null, display = null, target = null, text = '', fresh = true, original = '';

		const KEYS = [
			['7', '8', '9', '÷', '⌫'],
			['4', '5', '6', '×', '('],
			['1', '2', '3', '−', ')'],
			['0', '.', '±', '+', 'C'],
		];

		function build() {
			el = document.createElement('div');
			el.className = 'bbt_keypad';
			el.setAttribute('role', 'dialog');
			el.innerHTML = `
				<div class="bbt_kp_head">
					<span class="bbt_kp_title"></span>
					<button class="bbt_kp_btn bbt_kp_icon" data-k="keyboard" title="Use keyboard"><i class="material-icons">keyboard</i></button>
					<button class="bbt_kp_btn bbt_kp_icon" data-k="cancel" title="Cancel"><i class="material-icons">close</i></button>
				</div>
				<div class="bbt_kp_display" aria-live="polite"></div>
				<div class="bbt_kp_main">
					<div class="bbt_kp_nudge">
						<button class="bbt_kp_btn" data-k="nudge-"><i class="material-icons">remove</i><span class="bbt_kp_step"></span></button>
						<button class="bbt_kp_btn" data-k="nudge+"><i class="material-icons">add</i><span class="bbt_kp_step"></span></button>
					</div>
					<div class="bbt_kp_grid">${KEYS.flat().map(k => `<button class="bbt_kp_btn${'÷×−+()'.includes(k) ? ' op' : ''}" data-k="${k}">${k}</button>`).join('')}</div>
					<button class="bbt_kp_btn bbt_kp_ok" data-k="ok"><i class="material-icons">check</i></button>
				</div>`;
			display = el.querySelector('.bbt_kp_display');
			// buttons act on pointerup; never take focus (iOS keyboard) or start text selection
			el.addEventListener('pointerdown', e => { e.preventDefault(); e.stopPropagation(); });
			el.addEventListener('mousedown', e => { e.preventDefault(); e.stopPropagation(); });
			el.addEventListener('touchstart', e => e.stopPropagation(), { passive: true });
			// cancel compat mouse events + the click: after OK/Cancel the keypad is gone and the
			// click would otherwise hit-test to whatever lies underneath (e.g. another slider)
			el.addEventListener('touchend', e => { if (e.cancelable) e.preventDefault(); }, { passive: false });
			el.addEventListener('click', e => { e.preventDefault(); e.stopPropagation(); });
			el.addEventListener('contextmenu', e => { e.preventDefault(); e.stopPropagation(); });
			el.addEventListener('pointerup', e => {
				const b = e.target.closest('.bbt_kp_btn');
				if (!b) return;
				e.preventDefault();
				press(b.dataset.k);
			});
			document.body.append(el);
		}

		function render() {
			display.textContent = text || '0';
			display.classList.toggle('fresh', fresh);
		}

		function step() {
			if (!target) return 1;
			if (target.slider) return target.slider.getInterval(modifierEvent()) || 1;
			const s = parseFloat(target.input.step);
			return isFinite(s) && s > 0 ? s : 1;
		}

		function evaluate(str) {
			const expr = toExpr(str);
			if (window.NumSlider && NumSlider.MolangParser) {
				const cur = target && target.slider ? Number(target.slider.value) : parseFloat(original) || 0;
				try { return NumSlider.MolangParser.parse(expr, { val: cur, n: 0 }); } catch (e) { return NaN; }
			}
			return parseFloat(expr);
		}
		function toExpr(str) { return String(str).replace(/×/g, '*').replace(/÷/g, '/').replace(/−/g, '-'); }

		function press(k) {
			if (!target) return;
			switch (k) {
				case 'ok': apply(); return;
				case 'cancel': close(false); return;
				case 'keyboard': {
					const t = target;
					close(false);
					if (t.slider) {
						t.inner.classList.contains('editing') || t.slider.startInput();
					} else {
						t.input.focus();
						try { t.input.select(); } catch (e) { /* ignore */ }
					}
					return;
				}
				case 'C': text = ''; fresh = false; break;
				case '⌫': text = fresh ? '' : text.slice(0, -1); fresh = false; break;
				case '±': {
					const v = evaluate(text || '0');
					text = /^-?[\d.]*$/.test(text) ? (text.startsWith('-') ? text.slice(1) : (text ? '-' + text : '-')) : fmt(-v);
					fresh = false;
					break;
				}
				case 'nudge-': case 'nudge+': {
					const v = evaluate(text || '0');
					const base = isFinite(v) ? v : 0;
					text = fmt(base + (k === 'nudge+' ? 1 : -1) * step());
					fresh = false;
					if (target.slider) applySlider(text, true);
					break;
				}
				default: {
					// typing on a fresh display replaces it, except operators which extend it ("+5" = relative)
					if (fresh) text = '÷×−+)'.includes(k) ? text : '';
					fresh = false;
					text += k;
				}
			}
			render();
		}

		function applySlider(str, keep_open) {
			const s = target.slider;
			let expr = toExpr(str).trim();
			if (!expr) expr = '0';
			s.last_value = s.value;
			s.jq_inner.addClass('editing');
			s.jq_inner.text(expr);
			s.stopInput();
			if (keep_open) original = String(s.value);
		}

		function apply() {
			const t = target;
			I.stats.keypad_applies++;
			if (t.slider) {
				if (!fresh) applySlider(text, false);
			} else if (!fresh) {
				const v = evaluate(text || '0');
				const input = t.input;
				input.value = isFinite(v) ? fmt(v) : text;
				input.dispatchEvent(new Event('input', { bubbles: true }));
				input.dispatchEvent(new Event('change', { bubbles: true }));
				input.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
			}
			close(true);
		}

		function open(t, anchor, title, value) {
			if (!el) build();
			target = t;
			original = String(value);
			text = fmt(typeof value === 'number' ? value : parseFloat(value) || 0);
			if (typeof value === 'string' && value.trim() && isNaN(Number(value))) text = value;
			fresh = true;
			el.querySelector('.bbt_kp_title').textContent = title || '';
			el.querySelectorAll('.bbt_kp_step').forEach(s => { s.textContent = fmt(step()); });
			render();
			// short screens (iPhone landscape): side-by-side layout
			el.classList.toggle('wide', window.innerHeight < 520);
			el.classList.add('open');
			I.stats.keypad_opens++;
			position(anchor);
			BBTouch.emit('keypad', true);
		}

		function position(anchor) {
			const r = anchor.getBoundingClientRect();
			const w = el.offsetWidth, h = el.offsetHeight;
			const vw = window.innerWidth, vh = window.innerHeight;
			let x = r.left + r.width / 2 - w / 2;
			let y = r.bottom + 6;
			if (y + h > vh - 4) y = r.top - h - 6;
			if (y < 4) {
				// no room above/below: beside the anchor
				y = Math.max(4, Math.min(vh - h - 4, r.top + r.height / 2 - h / 2));
				x = r.left - w - 8 >= 4 ? r.left - w - 8 : r.right + 8;
			}
			x = Math.min(Math.max(x, 4), Math.max(vw - w - 4, 4));
			el.style.left = Math.round(x) + 'px';
			el.style.top = Math.round(y) + 'px';
		}

		function close(applied) {
			if (!el || !target) return;
			el.classList.remove('open');
			target = null;
			BBTouch.emit('keypad', false);
		}

		// tap outside closes (cancel)
		window.addEventListener('pointerdown', e => {
			if (target && el && !el.contains(e.target)) close(false);
		}, { capture: true });
		window.addEventListener('keydown', e => {
			if (!target) return;
			if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); apply(); }
			else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(false); }
			else if (/^[\d.()+\-*/]$/.test(e.key)) {
				e.preventDefault(); e.stopPropagation();
				press({ '*': '×', '/': '÷', '-': '−' }[e.key] || e.key);
			} else if (e.key === 'Backspace') { e.preventDefault(); e.stopPropagation(); press('⌫'); }
		}, { capture: true });

		return {
			isOpen: () => !!target,
			get element() { return el; },
			get text() { return text; },
			press, apply, close,
			openForSlider(slider, inner) {
				let title = '';
				try { title = (window.tl ? tl(slider.name) : slider.name) || ''; } catch (e) { title = slider.name || ''; }
				open({ slider, inner }, inner, title, Number(slider.value));
			},
			openForInput(input) {
				const label = input.closest('.dialog_bar, .form_bar');
				const lab = label && label.querySelector('label');
				open({ input }, input, lab ? lab.textContent.trim() : '', input.value);
			},
		};
	})();

	BBTouch.on('touch_mode', on => { if (!on) KP.close(false); });
})();
