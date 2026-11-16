/* Blockbench Touch layer — 3D viewport gestures.
 *
 * Replaces upstream OrbitControls' touch handling (which orbits even when a drag
 * starts on an element, selects on touch-down, resets `hasMoved` before the
 * preview's own touchend handler runs – so every orbit ended in "unselect all" –
 * and handles pinch/pan with jumpy page coordinates).
 *
 *  1 finger drag (not on gizmo)  → orbit
 *  1 finger drag on gizmo        → upstream transform (untouched)
 *  1 finger tap                  → upstream click/select (replayed on lift, so a drag never selects)
 *  1 finger long press           → upstream context menu (on lift, like upstream)
 *  double tap on element         → focus camera on selection (with zoom)
 *  double tap on empty space     → frame all elements
 *  2 finger drag + pinch         → pan + zoom simultaneously (zoom towards fingers)
 *  2 finger tap                  → undo
 *  3 finger tap                  → redo
 *
 * Paint tools / knife / weight brush keep upstream 1-finger behaviour (draw);
 * 2-finger navigation still works there.
 *
 * Implementation: window capture-phase pointer listeners run before any upstream
 * canvas listener. OrbitControls' own touch handlers are switched off per
 * instance by wrapping `controls.isEnabled` (it only gates touch + mouse
 * handlers, so mouse behaviour is unchanged when the last input was a mouse).
 */
(function () {
	'use strict';
	const BBTouch = window.BBTouch;
	const cfg = BBTouch.config;

	const G = BBTouch.gestures = {
		mode: 'idle',          // idle | pending | orbit | nav | gizmo | passthrough | tail
		pointers: new Map(),   // pointerId → {x, y, sx, sy}
		last_sequence_was_navigation: false,
		last_input_touch: false,
		stats: { orbit: 0, pan: 0, zoom: 0, taps: 0, double_taps: 0, undo: 0, redo: 0 },
	};

	let preview = null;        // Preview the current gesture belongs to
	let down_event = null;     // held-back pointerdown for tap replay
	let down_time = 0;
	let max_pointers = 0;
	let moved = false;
	let nav_prev = null;       // {cx, cy, dist}
	let last_tap = null;       // {time, x, y, hit}

	function isTouchLike(e) { return e.pointerType === 'touch' || e.pointerType === 'pen'; }
	function findPreview(target) {
		if (!window.Preview || !target || target.tagName !== 'CANVAS') return null;
		return Preview.all.find(p => p.canvas === target) || null;
	}
	function active() { return BBTouch.enabled; }

	// --- OrbitControls integration -------------------------------------------
	function patchControls(p) {
		const c = p && p.controls;
		if (!c || c.__bbtouch) return;
		c.__bbtouch = true;
		const orig = c.isEnabled;
		c.isEnabled = function () {
			// While touch mode is on and the last input was touch, our handlers drive the camera.
			if (active() && G.last_input_touch) return false;
			return orig.call(this);
		};
	}

	function passthroughTool(e) {
		const tool = window.Toolbox && Toolbox.selected;
		if (window.Modes && Modes.paint) return true;
		if (!tool) return false;
		if (tool.paintTool || tool.brush) return true;
		return ['knife_tool', 'weight_brush'].includes(tool.id);
	}

	function gizmoHit(p, e) {
		if (!window.Transformer || !Transformer.visible) return false;
		try {
			p.occupyTransformer();
			Transformer.dispatchPointerHover(e);
		} catch (err) { return false; }
		return Transformer.hoverAxis != null;
	}

	// --- camera ops ----------------------------------------------------------
	function viewportSize(el) {
		return Math.min(Math.max(el.clientWidth + el.clientHeight, 600), 1200);
	}
	function orbit(p, dx, dy) {
		const c = p.controls;
		if (!c.enabled || c.enableRotate === false) return;
		const size = viewportSize(p.canvas);
		c.rotateLeft(2 * Math.PI * dx / size * cfg.orbit_speed * c.rotateSpeed);
		c.rotateUp(2 * Math.PI * dy / size * cfg.orbit_speed * c.rotateSpeed);
		c.update();
		G.stats.orbit++;
	}
	// Same maths as OrbitControls' private pan(), using its public panLeft/panUp.
	function pan(p, dx, dy) {
		const c = p.controls, cam = c.object, el = p.canvas;
		if (!c.enabled || c.enablePan === false) return;
		if (cam.isPerspectiveCamera) {
			let d = cam.position.clone().sub(c.target).length();
			d *= Math.tan((cam.fov / 2) * Math.PI / 180);
			c.panLeft(2 * dx * d / el.clientHeight, cam.matrix);
			c.panUp(2 * dy * d / el.clientHeight, cam.matrix);
		} else if (cam.isOrthographicCamera) {
			c.panLeft(dx * (cam.right - cam.left) / cam.zoom / el.clientWidth, cam.matrix);
			c.panUp(dy * (cam.top - cam.bottom) / cam.zoom / el.clientHeight, cam.matrix);
		}
		G.stats.pan++;
	}
	// factor > 1 = fingers spread = zoom in. Zooms towards the pinch centre.
	function zoom(p, factor, cx, cy) {
		const c = p.controls, cam = c.object;
		if (!c.enabled || c.enableZoom === false || !isFinite(factor) || factor <= 0) return;
		factor = Math.min(Math.max(factor, 0.5), 2);
		const rect = p.canvas.getBoundingClientRect();
		// offset of pinch centre from viewport centre, in px
		const ox = cx - (rect.left + rect.width / 2);
		const oy = cy - (rect.top + rect.height / 2);
		if (cam.isPerspectiveCamera) {
			const dist = cam.position.distanceTo(c.target);
			const new_dist = Math.min(Math.max(dist / factor, c.minDistance), c.maxDistance);
			const real = dist / new_dist;
			c.dollyIn(real);
			// keep the point under the fingers fixed: pan by the change in world-per-pixel
			pan(p, -ox * (1 - 1 / real), -oy * (1 - 1 / real));
		} else if (cam.isOrthographicCamera) {
			const z0 = cam.zoom;
			c.dollyIn(factor); // changes cam.zoom immediately (clamped)
			const real = cam.zoom / z0;
			pan(p, ox * (1 - real), oy * (1 - real)); // pan() already uses the new zoom
		}
		G.stats.zoom++;
	}

	function animateCamera(p, target, position, frames = 10) {
		const c = p.controls;
		const t0 = c.target.clone(), p0 = c.object.position.clone();
		let i = 0;
		const step = () => {
			i++;
			const k = 1 - Math.pow(1 - i / frames, 3);
			c.target.lerpVectors(t0, target, k);
			if (position) c.object.position.lerpVectors(p0, position, k);
			c.update();
			if (window.Transformer) Transformer.update();
			if (i < frames) requestAnimationFrame(step);
		};
		requestAnimationFrame(step);
	}

	G.focusSelection = function () {
		const a = window.BarItems && BarItems.focus_on_selection;
		if (!a) return;
		// fake event: zoom variation (ctrl) so the selection fills the view
		a.trigger({ type: 'bbtouch', ctrlKey: true, ctrlOrCmd: true, shiftKey: false, altKey: false });
	};

	G.frameAll = function (p = window.Preview && Preview.selected) {
		if (!p || !p.controls.enabled || !window.Outliner) return;
		const box = new THREE.Box3();
		Outliner.elements.forEach(el => {
			if (el.visibility === false || !el.mesh) return;
			el.mesh.updateWorldMatrix(true, true);
			box.expandByObject(el.mesh);
		});
		if (box.isEmpty()) {
			if (BarItems.camera_initial) BarItems.camera_initial.trigger();
			return;
		}
		const center = box.getCenter(new THREE.Vector3());
		const radius = Math.max(box.getSize(new THREE.Vector3()).length() / 2, 1);
		const c = p.controls, cam = c.object;
		if (cam.isPerspectiveCamera) {
			const fov = Math.min(cam.fov, cam.fov * cam.aspect) * Math.PI / 180;
			const dist = radius / Math.sin(fov / 2) * 1.1;
			const dir = cam.position.clone().sub(c.target).normalize();
			animateCamera(p, center, center.clone().add(dir.multiplyScalar(dist)));
		} else {
			const span = Math.min(cam.right - cam.left, cam.top - cam.bottom);
			cam.zoom = Math.max(c.minZoom, Math.min(c.maxZoom, span / (radius * 2.4)));
			cam.updateProjectionMatrix();
			const offset = cam.position.clone().sub(c.target);
			animateCamera(p, center, center.clone().add(offset));
		}
	};

	function trigger(id) {
		const a = window.BarItems && BarItems[id];
		if (a) a.trigger();
	}

	// --- tap handling ----------------------------------------------------------
	function replayTap(p, e, long) {
		G.stats.taps++;
		p.controls.hasMoved = false;
		p.click(e);
		if (long && p.rclick_cooldown !== undefined) {
			// upstream opens the context menu on touchend if the press lasted ≥420ms
			clearTimeout(p.rclick_cooldown);
			p.rclick_cooldown = true;
		}
	}

	function handleSingleTap(p, e, duration) {
		const long = duration >= cfg.long_press_ms;
		const now = performance.now();
		const prev = last_tap;
		const is_double = !long && prev && now - prev.time < cfg.double_tap_ms &&
			Math.hypot(e.clientX - prev.x, e.clientY - prev.y) < cfg.double_tap_dist;
		let hit = false;
		try { hit = !!p.raycast(e); } catch (err) { /* ignore */ }
		replayTap(p, e, long);
		if (is_double) {
			G.stats.double_taps++;
			last_tap = null;
			if (hit || prev.hit) G.focusSelection();
			else G.frameAll(p);
		} else {
			last_tap = long ? null : { time: now, x: e.clientX, y: e.clientY, hit };
		}
	}

	// --- pointer listeners (capture phase, before upstream) -----------------------
	function reset() {
		G.mode = 'idle';
		preview = null;
		down_event = null;
		nav_prev = null;
		max_pointers = 0;
		moved = false;
	}

	function navMetrics() {
		const pts = [...G.pointers.values()];
		const a = pts[0], b = pts[1];
		return { cx: (a.x + b.x) / 2, cy: (a.y + b.y) / 2, dist: Math.max(Math.hypot(a.x - b.x, a.y - b.y), 1) };
	}

	window.addEventListener('pointerdown', e => {
		if (!isTouchLike(e)) {
			if (e.pointerType === 'mouse') G.last_input_touch = false;
			return;
		}
		G.last_input_touch = true;
		if (!active()) return;
		const p = findPreview(e.target);
		if (!p) return;
		patchControls(p);

		G.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY, sx: e.clientX, sy: e.clientY });
		max_pointers = Math.max(max_pointers, G.pointers.size);

		if (G.pointers.size === 1) {
			preview = p;
			window.Preview.selected = p;
			down_time = performance.now();
			moved = false;
			G.last_sequence_was_navigation = false;
			p.controls.hasMoved = false;
			if (gizmoHit(p, e)) { G.mode = 'gizmo'; return; }
			if (passthroughTool(e)) { G.mode = 'passthrough'; return; }
			// Hold the event back: it is replayed as a click if this turns out to be a tap.
			G.mode = 'pending';
			down_event = e;
			if (window.Menu && Menu.open) Menu.open.hide();
			if (document.activeElement && document.activeElement !== document.body && document.activeElement.blur) {
				document.activeElement.blur();
			}
			e.stopImmediatePropagation();
			return;
		}
		// Additional fingers never reach upstream's click() (it would raycast/select).
		if (G.mode === 'gizmo') return;
		e.stopImmediatePropagation();
		if (G.mode === 'pending' || G.mode === 'orbit' || G.mode === 'passthrough' || G.mode === 'nav') {
			G.mode = 'nav';
			down_event = null;
			nav_prev = navMetrics();
			G.last_sequence_was_navigation = true;
			preview.controls.hasMoved = true; // no "unselect all" on touchend
		}
	}, { capture: true, passive: false });

	window.addEventListener('pointermove', e => {
		if (!isTouchLike(e) || !G.pointers.has(e.pointerId)) return;
		const pt = G.pointers.get(e.pointerId);
		const dx = e.clientX - pt.x, dy = e.clientY - pt.y;
		pt.x = e.clientX; pt.y = e.clientY;
		if (Math.hypot(pt.x - pt.sx, pt.y - pt.sy) > cfg.tap_slop) moved = true;
		if (!preview) return;

		switch (G.mode) {
			case 'pending':
				if (moved) {
					G.mode = 'orbit';
					down_event = null;
					G.last_sequence_was_navigation = true;
					preview.controls.hasMoved = true;
					preview.static_rclick = false;
					orbit(preview, pt.x - pt.sx, pt.y - pt.sy);
				}
				break;
			case 'orbit':
				preview.controls.hasMoved = true;
				orbit(preview, dx, dy);
				break;
			case 'nav': {
				if (G.pointers.size < 2) break;
				const m = navMetrics();
				if (nav_prev) {
					pan(preview, m.cx - nav_prev.cx, m.cy - nav_prev.cy);
					zoom(preview, m.dist / nav_prev.dist, m.cx, m.cy);
					preview.controls.update();
				}
				nav_prev = m;
				preview.controls.hasMoved = true;
				break;
			}
		}
	}, { capture: true, passive: false });

	function onPointerEnd(e) {
		if (!G.pointers.has(e.pointerId)) return;
		G.pointers.delete(e.pointerId);
		const p = preview;
		const duration = performance.now() - down_time;

		if (G.mode === 'pending' && G.pointers.size === 0 && down_event && e.type === 'pointerup') {
			handleSingleTap(p, down_event, duration);
		} else if (G.mode === 'nav' || G.mode === 'tail') {
			if (G.mode === 'nav') G.mode = 'tail'; // remaining finger must not start an orbit jump
			nav_prev = G.pointers.size >= 2 ? navMetrics() : null;
			if (G.pointers.size === 0 && !moved && duration < cfg.multi_tap_ms + 200 && e.type === 'pointerup') {
				if (max_pointers === 2) { G.stats.undo++; trigger('undo'); }
				else if (max_pointers === 3) { G.stats.redo++; trigger('redo'); }
			}
			if (p) p.controls.hasMoved = true;
		}
		if (G.pointers.size === 0) {
			if (p && G.mode === 'orbit') p.controls.dispatchEvent({ type: 'end' });
			reset();
		}
	}
	window.addEventListener('pointerup', onPointerEnd, { capture: true, passive: false });
	window.addEventListener('pointercancel', onPointerEnd, { capture: true, passive: false });

	// Suppress browser scrolling/zoom and compat mouse events on the viewport.
	window.addEventListener('touchstart', e => {
		if (!active() || !findPreview(e.target)) return;
		if (e.cancelable) e.preventDefault();
	}, { capture: true, passive: false });
	window.addEventListener('touchmove', e => {
		if (!active() || !findPreview(e.target)) return;
		if (e.cancelable) e.preventDefault();
	}, { capture: true, passive: false });

	// --- bigger gizmo + more tolerant picking ----------------------------------------
	BBTouch.onReady(() => {
		Preview.all.forEach(patchControls);
		const T = window.Transformer;
		if (T && T.getScale && !T.getScale.__bbtouch) {
			const orig = T.getScale;
			T.getScale = function () {
				const s = orig.apply(this, arguments);
				return active() ? s * cfg.gizmo_scale : s;
			};
			T.getScale.__bbtouch = true;
		}
		// Runs after upstream's own listener (which already applies ×1.5 for touch).
		Blockbench.on('update_camera_position', () => {
			if (!active()) return;
			Preview.all.forEach(p => {
				const params = p.raycaster && p.raycaster.params;
				if (!params) return;
				params.Points.threshold *= cfg.pick_tolerance;
				params.Line.threshold *= cfg.pick_tolerance;
			});
		});
		BBTouch.on('touch_mode', () => {
			if (window.Transformer && Transformer.update) Transformer.update();
			if (Preview.selected) Preview.selected.controls.update();
		});
	});
})();
