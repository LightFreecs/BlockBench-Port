#!/usr/bin/env node
// Headless Apple Pencil / painting test (M7) on an emulated iPad 1180x820 (hasTouch, isMobile).
// Pen input: CDP Input.dispatchMouseEvent with pointerType 'pen' + force (→ PointerEvent.pressure).
// Fingers: CDP Input.dispatchTouchEvent (radiusX/Y → pointer width/height, used for palm detection).
// Usage: node scripts/test-pencil.cjs [--screenshot docs/screenshots/m7.png]
const { chromium } = require('playwright');
const path = require('path');
const { spawn } = require('child_process');

const root = path.resolve(__dirname, '..');
const port = 9065 + Math.floor(Math.random() * 100);
const shotArg = process.argv.indexOf('--screenshot');
const shot = shotArg > -1 ? path.resolve(root, process.argv[shotArg + 1]) : null;

const results = [];
function check(name, ok, info) {
	results.push({ name, ok: !!ok });
	console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${info !== undefined ? '  ' + JSON.stringify(info) : ''}`);
}

(async () => {
	const server = spawn(process.execPath, [path.join(root, 'scripts/serve.mjs'), String(port)], { stdio: 'ignore' });
	await new Promise(r => setTimeout(r, 500));
	const browser = await chromium.launch();
	let failed = false;
	try {
		const context = await browser.newContext({
			viewport: { width: 1180, height: 820 }, deviceScaleFactor: shot ? 2 : 1, hasTouch: true, isMobile: true,
		});
		const page = await context.newPage();
		await page.addInitScript(() => { try { localStorage.setItem('bbtouch.toolbar', JSON.stringify({ x: 8, y: 120 })); } catch (e) {} });
		const errors = [];
		page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
		page.on('pageerror', e => errors.push('pageerror: ' + e.message));
		const cdp = await context.newCDPSession(page);
		const sleep = ms => page.waitForTimeout(ms);

		// --- input helpers ---
		const pen = (type, x, y, force = 0.5, extra = {}) => cdp.send('Input.dispatchMouseEvent', Object.assign({
			type, x, y, button: type === 'mouseMoved' ? 'none' : 'left', buttons: type === 'mouseReleased' ? 0 : 1,
			clickCount: type === 'mouseMoved' ? 0 : 1, pointerType: 'pen', force,
		}, extra));
		async function penStroke(pts, force = 0.5, opts = {}) {
			const f = i => typeof force === 'function' ? force(i) : force;
			await pen('mousePressed', pts[0][0], pts[0][1], f(0));
			for (let i = 1; i < pts.length; i++) {
				await pen('mouseMoved', pts[i][0], pts[i][1], f(i), { button: 'left' });
				await sleep(12);
				if (opts.during && i === Math.floor(pts.length / 2)) await opts.during();
			}
			await pen('mouseReleased', pts[pts.length - 1][0], pts[pts.length - 1][1], 0);
			await sleep(opts.wait ?? 360); // fingers are ignored for 300 ms after the pen lifts (palm window)
		}
		const line = (x0, y0, x1, y1, n = 12) => Array.from({ length: n + 1 }, (_, i) => [x0 + (x1 - x0) * i / n, y0 + (y1 - y0) * i / n]);
		const touch = (type, points, r = 5) => cdp.send('Input.dispatchTouchEvent', {
			type, touchPoints: points.map((p, i) => ({ x: p[0], y: p[1], id: p[2] ?? i, radiusX: r, radiusY: r, force: 1 })),
		});
		async function fingerDrag(from, to, steps = 12, r = 5) {
			await touch('touchStart', from, r);
			for (let s = 1; s <= steps; s++) {
				const k = s / steps;
				await touch('touchMove', from.map((f, i) => [f[0] + (to[i][0] - f[0]) * k, f[1] + (to[i][1] - f[1]) * k]), r);
				await sleep(16);
			}
			await touch('touchEnd', [], r);
			await sleep(80);
		}
		async function fingerTap(points, hold = 40) {
			await touch('touchStart', points); await sleep(hold); await touch('touchEnd', []); await sleep(80);
		}

		await page.goto(`http://localhost:${port}/`, { waitUntil: 'load' });
		await page.waitForFunction(() => window.BBTouch && BBTouch.ready && BBTouch.pencil && window.Formats && Formats.free, null, { timeout: 30000 });
		await sleep(400);

		// Generic Model project: one cube, 32x32 white texture on every face, front face fills the view
		await page.evaluate(() => {
			Formats.free.new();
			if (window.Dialog && Dialog.open) Dialog.open.confirm();
			const cube = new Cube({ name: 'canvas', from: [-8, -8, -8], to: [8, 8, 8] }).init();
			const c = document.createElement('canvas');
			c.width = c.height = 32;
			const ctx = c.getContext('2d'); ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, 32, 32);
			const tex = new Texture({ name: 'paint' }).fromDataURL(c.toDataURL()).add(false);
			cube.applyTexture(tex, true);
			for (const f in cube.faces) cube.faces[f].uv = [0, 0, Project.texture_width, Project.texture_height];
			Canvas.updateAll();
			window.__tex = tex;
		});
		await sleep(600);
		await page.evaluate(() => {
			Modes.options.paint.select();
			BarItems.brush_tool.select();
			BarItems.slider_brush_size.change(() => 6); BarItems.slider_brush_size.update();
			BarItems.slider_brush_softness.change(() => 0); BarItems.slider_brush_softness.update();
			BarItems.slider_brush_opacity.change(() => 255); BarItems.slider_brush_opacity.update();
			ColorPanel.set('#ff0000');
		});
		await sleep(500);
		const setCam = () => page.evaluate(() => {
			const p = Preview.selected, c = p.controls;
			c.target.set(0, 0, 0); c.object.position.set(0, 0, 40); c.update();
		});
		await setCam();
		await sleep(200);
		const box = await page.evaluate(() => { const r = Preview.selected.canvas.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height, cx: r.left + r.width / 2, cy: r.top + r.height / 2 }; });

		// texture helpers (in page)
		await page.evaluate(() => {
			window.__snap = () => { const { canvas } = __tex.getActiveCanvas(); return Array.from(canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data); };
			window.__diff = (a, b = __snap()) => {
				const w = __tex.width; let n = 0, minx = 1e9, maxx = -1, miny = 1e9, maxy = -1, g = 0;
				for (let i = 0; i < a.length; i += 4) {
					if (a[i] !== b[i] || a[i + 1] !== b[i + 1] || a[i + 2] !== b[i + 2] || a[i + 3] !== b[i + 3]) {
						n++; const x = (i / 4) % w, y = Math.floor(i / 4 / w);
						minx = Math.min(minx, x); maxx = Math.max(maxx, x); miny = Math.min(miny, y); maxy = Math.max(maxy, y); g += b[i + 1];
					}
				}
				return { n, w: maxx - minx + 1, h: maxy - miny + 1, minx, miny, g: n ? Math.round(g / n) : 0 };
			};
			window.__s0 = __snap();
		});
		const probe = await page.evaluate(({ x, y }) => {
			const d = Preview.selected.raycast({ clientX: x, clientY: y, which: 1, button: 0 });
			return d ? { face: d.face, uv: d.intersects[0].uv } : null;
		}, { x: box.cx, y: box.cy });
		check('cube front face under the viewport centre', probe && probe.face === 'south', probe);


		// white canvas + snapshot before each measured stroke
		const reset = () => page.evaluate(() => {
			__tex.edit(c => { const x = c.getContext('2d'); x.fillStyle = '#ffffff'; x.fillRect(0, 0, c.width, c.height); }, { no_undo: true });
			window.__s0 = __snap();
		});
		const diff = () => page.evaluate(() => __diff(__s0));
		const cam = () => page.evaluate(() => { const c = Preview.selected.controls; return c.object.position.toArray().map(v => +v.toFixed(3)).join(',') + '|' + c.target.toArray().map(v => +v.toFixed(3)).join(','); });
		const P = (expr, arg) => page.evaluate(expr, arg);

		let st = await P(() => ({ paint: Modes.paint, tool: Toolbox.selected.id, bar: !!document.querySelector('#bbt_brushbar.visible'), seen: BBTouch.pencil.seen, only: BBTouch.pencil.pencilOnly() }));
		check('paint mode + brush tool, brush bar visible, pencil not seen yet', st.paint && st.tool === 'brush_tool' && st.bar && !st.seen && !st.only, st);

		// 1. no pencil used yet → a finger paints
		await reset();
		let cam0 = await cam();
		await fingerDrag([[box.cx - 80, box.cy + 120]], [[box.cx + 80, box.cy + 120]]);
		let d = await diff();
		check('finger paints before any Pencil use', d.n > 20, d);
		check('finger painting does not orbit', (await cam()) === cam0);
		await P(() => Undo.undo());

		// 2. Pencil: pressure → size
		await reset();
		await penStroke(line(box.cx - 100, box.cy - 150, box.cx + 100, box.cy - 150), 0.15);
		const low = await P(() => Object.assign(__diff(__s0), { brush: BBTouch.pencil.last_brush }));
		await reset();
		await penStroke(line(box.cx - 100, box.cy + 60, box.cx + 100, box.cy + 60), 1);
		const high = await P(() => Object.assign(__diff(__s0), { brush: BBTouch.pencil.last_brush }));
		check('pencil paints', low.n > 10 && high.n > 10, { low: low.n, high: high.n });
		check('pressure → brush size (light stroke thinner than firm stroke)', low.h < high.h && low.brush.size < high.brush.size && high.brush.size === 6, { low: [low.h, low.brush.size], high: [high.h, high.brush.size] });
		st = await P(() => ({ seen: BBTouch.pencil.seen, only: BBTouch.pencil.pencilOnly(), strokes: BBTouch.pencil.stats.pen_strokes }));
		check('first Pencil use → "Pencil only draws" (auto) active', st.seen && st.only, st);

		// variable pressure within one stroke
		await reset();
		await penStroke(line(box.cx - 120, box.cy - 20, box.cx + 120, box.cy - 20, 16), i => 0.1 + i * 0.056);
		d = await P(() => {
			const { canvas } = __tex.getActiveCanvas(); const w = canvas.width;
			const a = __s0, b = __snap(); const cols = {};
			for (let i = 0; i < a.length; i += 4) if (a[i + 1] !== b[i + 1]) { const x = (i / 4) % w; cols[x] = (cols[x] || 0) + 1; }
			const xs = Object.keys(cols).map(Number).sort((p, q) => p - q);
			return { first: cols[xs[1]], last: cols[xs[xs.length - 2]], xs: xs.length };
		});
		check('pressure ramp within one stroke → stroke gets thicker', d.last > d.first, d);

		// 3. pencil-only: a finger now navigates, never paints
		await reset();
		cam0 = await cam();
		await fingerDrag([[box.cx - 80, box.cy + 140]], [[box.cx + 80, box.cy + 140]]);
		d = await diff();
		check('pencil-only: finger drag does not paint', d.n === 0, d);
		check('pencil-only: finger drag orbits instead', (await cam()) !== cam0);
		await setCam(); await sleep(100);
		await reset();
		await fingerTap([[box.cx, box.cy]]);
		await sleep(400);
		check('pencil-only: finger tap does not paint a dot', (await diff()).n === 0);
		// 2-finger pan/pinch still works in paint mode
		cam0 = await cam();
		await fingerDrag([[box.cx - 60, box.cy], [box.cx + 60, box.cy]], [[box.cx - 120, box.cy + 20], [box.cx + 120, box.cy + 20]]);
		check('pencil-only: 2-finger pinch/pan navigates', (await cam()) !== cam0 && (await diff()).n === 0);
		await setCam(); await sleep(100);

		// 4. palm rejection: touch while the pen is down → ignored (no paint, no camera move)
		await reset();
		cam0 = await cam();
		const rej0 = await P(() => BBTouch.pencil.stats.rejected);
		await penStroke(line(box.cx - 100, box.cy - 100, box.cx + 100, box.cy - 100), 0.6, {
			during: async () => {
				await touch('touchStart', [[box.cx + 60, box.cy + 200]]);
				for (let i = 1; i <= 6; i++) { await touch('touchMove', [[box.cx + 60 + i * 15, box.cy + 200 - i * 10]]); await sleep(12); }
				await touch('touchEnd', []);
			},
		});
		d = await diff();
		st = await P(() => ({ rejected: BBTouch.pencil.stats.rejected }));
		check('palm during pen stroke: rejected, pen stroke intact, palm area unpainted', st.rejected > rej0 && d.n > 10 && d.miny < 12 && d.miny + d.h < 20, { d, st });
		check('palm during pen stroke: camera did not move', (await cam()) === cam0);
		// touch right after the pen lifted (inside the palm window)
		await P(() => { BBTouch.pencil.settings.palm_window_ms = 2000; }); // headless timing is slow; default 300
		await reset();
		cam0 = await cam();
		await pen('mousePressed', box.cx, box.cy - 200, 0.5); await pen('mouseReleased', box.cx, box.cy - 200, 0);
		await reset();
		await fingerDrag([[box.cx - 50, box.cy + 120]], [[box.cx + 50, box.cy + 120]], 4);
		check('touch within 300 ms after pen lift is ignored', (await cam()) === cam0 && (await diff()).n === 0);
		await P(() => { BBTouch.pencil.settings.palm_window_ms = 300; });
		await sleep(400);
		// large contact = palm, ignored even without a pen
		await P(() => { BBTouch.pencil.settings.pencil_only = 'off'; });
		await reset();
		cam0 = await cam();
		const palms0 = await P(() => BBTouch.pencil.stats.palms);
		await fingerDrag([[box.cx - 80, box.cy + 120]], [[box.cx + 80, box.cy + 120]], 12, 45);
		check('large-radius touch (palm) is ignored: no paint, no orbit', (await cam()) === cam0 && (await diff()).n === 0 && (await P(() => BBTouch.pencil.stats.palms)) > palms0);
		// palm landing before the pen: cancelled + camera restored when the pen lands
		await P(() => { BBTouch.pencil.settings.pencil_only = 'on'; BBTouch.pencil.settings.palm_restore_ms = 3000; });
		await reset();
		cam0 = await cam();
		await touch('touchStart', [[box.cx - 150, box.cy + 250]]);
		for (let i = 1; i <= 5; i++) { await touch('touchMove', [[box.cx - 150 + i * 12, box.cy + 250]]); await sleep(16); }
		const moved = (await cam()) !== cam0;
		await penStroke(line(box.cx - 60, box.cy - 60, box.cx + 60, box.cy - 60), 0.7);
		await touch('touchEnd', []); await sleep(80);
		await P(() => { BBTouch.pencil.settings.palm_restore_ms = 600; });
		const pl = { moved, cam: (await cam()) === cam0, d: (await diff()).n, cancelled: await P(() => BBTouch.pencil.stats.canceled_touch) };
		check('palm that landed first: orbit reverted when the pen lands, pen still paints', pl.moved && pl.cam && pl.d > 10, pl);

		// 5. finger painting (pencil-only off): second finger cancels the young stroke; 2-finger tap = clean undo
		await P(() => { BBTouch.pencil.settings.pencil_only = 'off'; });
		await reset();
		await penStroke(line(box.cx - 80, box.cy + 30, box.cx + 80, box.cy + 30), 0.8);
		const after_stroke = await diff();
		await sleep(400);
		await fingerTap([[box.cx - 40, box.cy + 160], [box.cx + 40, box.cy + 160]], 60);
		await sleep(200);
		d = await diff();
		check('finger mode: 2-finger tap during painting undoes the last stroke, leaves no dot', after_stroke.n > 10 && d.n === 0, { after_stroke: after_stroke.n, d: d.n });
		await reset();
		await fingerDrag([[box.cx - 80, box.cy + 120]], [[box.cx + 80, box.cy + 120]]);
		check('finger mode: finger paints again', (await diff()).n > 10);
		await P(() => { BBTouch.pencil.settings.pencil_only = 'auto'; });

		// 6. pressure → opacity
		await P(() => Object.assign(BBTouch.pencil.settings, { pressure_size: false, pressure_opacity: true }));
		await reset();
		await penStroke(line(box.cx - 100, box.cy - 200, box.cx + 100, box.cy - 200), 0.1);
		const op_low = await diff();
		await reset();
		await penStroke(line(box.cx - 100, box.cy + 200, box.cx + 100, box.cy + 200), 1);
		const op_high = await diff();
		check('pressure → opacity (light stroke more transparent: red over white stays pinker)', op_low.g > op_high.g + 60 && op_low.h === op_high.h, { low: op_low, high: op_high });
		await P(() => Object.assign(BBTouch.pencil.settings, { pressure_size: true, pressure_opacity: false }));

		// 7. coalesced events: intermediate samples are painted
		await reset();
		await P(() => { window.__pid = null; window.addEventListener('pointerdown', e => { window.__pid = e.pointerId; }, { once: true, capture: true }); });
		await pen('mousePressed', box.cx - 120, box.cy, 1);
		const pid = await P(() => window.__pid);
		const co0 = await P(() => BBTouch.pencil.stats.coalesced);
		await P(({ pid, box }) => {
			const mk = (x, y) => new PointerEvent('pointermove', { pointerId: pid, pointerType: 'pen', clientX: x, clientY: y, pressure: 1, buttons: 1, bubbles: true, cancelable: true, isPrimary: true });
			// a V shape: the low point only exists as a coalesced sample
			const co = [mk(box.cx - 60, box.cy + 30), mk(box.cx, box.cy + 160), mk(box.cx + 60, box.cy + 30), mk(box.cx + 120, box.cy)];
			const ev = new PointerEvent('pointermove', { pointerId: pid, pointerType: 'pen', clientX: box.cx + 120, clientY: box.cy, pressure: 1, buttons: 1, bubbles: true, cancelable: true, isPrimary: true, coalescedEvents: co });
			Preview.selected.canvas.dispatchEvent(ev);
		}, { pid, box });
		await pen('mouseReleased', box.cx + 120, box.cy, 0);
		await sleep(100);
		d = await diff();

		const co1 = await P(() => BBTouch.pencil.stats.coalesced);
		check('coalesced pointer events are fed into the stroke (V shape reaches the low point)', co1 - co0 >= 3 && d.h > 8, { coalesced: co1 - co0, d });

		// 8. brush bar
		await P(() => { const i = document.querySelector('#bbt_brushbar input[data-slider="slider_brush_size"]'); i.value = 10; i.dispatchEvent(new Event('input')); i.dispatchEvent(new Event('change')); });
		check('brush bar size slider sets brush size', (await P(() => BarItems.slider_brush_size.get())) === 10);
		await P(() => { const i = document.querySelector('#bbt_brushbar input[data-slider="slider_brush_size"]'); i.value = 6; i.dispatchEvent(new Event('input')); i.dispatchEvent(new Event('change')); });
		const bb = sel => P(sel => { const r = document.querySelector(sel).getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2, r.width, r.height]; }, sel);
		const h0 = await P(() => BBTouch.pencil.stats.haptics || 0);
		let b = await bb('#bbt_brushbar [data-act="eraser"]');
		check('brush bar buttons ≥ 40 px', b[2] >= 40 && b[3] >= 40, b);
		await fingerTap([[b[0], b[1]]]);
		st = await P(() => ({ tool: Toolbox.selected.id, h: BBTouch.pencil.stats.haptics || 0 }));
		check('brush bar: eraser toggle (tap) selects eraser + haptic', st.tool === 'eraser' && st.h > h0, st);
		await fingerTap([[b[0], b[1]]]);
		check('brush bar: eraser toggle again returns to brush', (await P(() => Toolbox.selected.id)) === 'brush_tool');
		// eyedropper: one pick with the pencil, then back to the brush
		await reset();
		await penStroke(line(box.cx - 30, box.cy - 100, box.cx + 30, box.cy - 100), 1);
		await P(() => ColorPanel.set('#00ff00'));
		b = await bb('#bbt_brushbar [data-act="eyedropper"]');
		await fingerTap([[b[0], b[1]]]);
		const eye = await P(() => Toolbox.selected.id);
		await pen('mousePressed', box.cx, box.cy - 100, 0.5); await pen('mouseReleased', box.cx, box.cy - 100, 0);
		await sleep(150);
		st = await P(() => ({ tool: Toolbox.selected.id, color: ColorPanel.get() }));
		check('brush bar: eyedropper picks a colour with the Pencil and returns to the brush', eye === 'color_picker' && st.tool === 'brush_tool' && st.color.toLowerCase() === '#ff0000', { eye, st });
		// undo button
		await reset();
		await penStroke(line(box.cx - 80, box.cy + 90, box.cx + 80, box.cy + 90), 0.8);
		b = await bb('#bbt_brushbar [data-act="undo"]');
		await fingerTap([[b[0], b[1]]]);
		check('brush bar: undo', (await diff()).n === 0);
		// colour popover
		b = await bb('#bbt_brushbar [data-act="color"]');
		await fingerTap([[b[0], b[1]]]);
		st = await P(() => ({ open: !!document.getElementById('bbt_color_pop'), sw: document.querySelectorAll('#bbt_color_pop .bbt_cp_sw').length, native: !!document.querySelector('#bbt_color_pop input[type=color]') }));
		check('brush bar: colour swatch opens colour popover (system picker + recent/palette)', st.open && st.native && st.sw > 0, st);
		b = await bb('#bbt_color_pop .bbt_cp_sw');
		await fingerTap([[b[0], b[1]]]);
		check('colour popover: tapping a swatch sets the colour and closes', !(await P(() => !!document.getElementById('bbt_color_pop'))));

		// 9. settings popover from the floating toolbar
		b = await bb('#bbt_toolbar [data-id="pencil"]');
		await fingerTap([[b[0], b[1]]]);
		st = await P(() => ({ open: !!document.getElementById('bbt_pencil_settings') }));
		check('toolbar ✎ opens the Pencil settings popover', st.open, st);
		b = await bb('#bbt_pencil_settings .bbt_seg[data-key="curve"] button[data-v="firm"]');
		await fingerTap([[b[0], b[1]]]);
		check('settings: curve segment works + persisted', (await P(() => BBTouch.pencil.settings.curve === 'firm' && JSON.parse(localStorage.getItem('bbtouch.pencil')).curve === 'firm')));
		// pressure test pad draws with the pen
		b = await bb('#bbt_pencil_settings .bbt_ps_test canvas');
		await penStroke(line(b[0] - 80, b[1], b[0] + 80, b[1], 8), 0.6);
		check('settings: pressure test pad draws', await P(() => { const c = document.querySelector('#bbt_pencil_settings canvas'); const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; for (let i = 3; i < d.length; i += 4) if (d[i]) return true; return false; }));
		b = await bb('#bbt_pencil_settings .bbt_seg[data-key="curve"] button[data-v="soft"]');
		await fingerTap([[b[0], b[1]]]);
		await fingerTap([[box.cx + 200, box.cy - 300]]);
		check('settings popover closes on outside tap', !(await P(() => !!document.getElementById('bbt_pencil_settings'))));
		await setCam(); await sleep(100);

		// 10. Apple Pencil double tap (native UIPencilInteraction → window event)
		await P(() => window.Capacitor ? Capacitor.triggerEvent && Capacitor.triggerEvent('bbtouchPencilTap', 'window', { action: 'switchEraser' }) : null);
		let t1 = await P(() => Toolbox.selected.id);
		if (t1 !== 'eraser') { await P(() => { const e = new Event('bbtouchPencilTap'); e.action = 'switchEraser'; window.dispatchEvent(e); }); t1 = await P(() => Toolbox.selected.id); }
		await P(() => { const e = new Event('bbtouchPencilTap'); e.action = 'switchEraser'; window.dispatchEvent(e); });
		const t2 = await P(() => Toolbox.selected.id);
		check('Pencil double-tap toggles eraser ↔ brush', t1 === 'eraser' && t2 === 'brush_tool', { t1, t2 });
		// Pencil Pro squeeze (iOS 17.5+): system "contextual palette" → colour popover
		await P(() => { const e = new Event('bbtouchPencilTap'); e.action = 'showContextualPalette'; e.kind = 'squeeze'; window.dispatchEvent(e); });
		await sleep(100);
		check('Pencil Pro squeeze (contextual palette) opens the colour popover', await P(() => !!document.getElementById('bbt_color_pop')));
		await P(() => BBTouch.pencil.closePopovers());

		// 11. 2D UV / texture editor
		const uv = await P(() => { const vp = UVEditor.vue.$refs.viewport, f = document.getElementById('uv_frame'); const r = f.getBoundingClientRect(), rv = vp.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height, vx: rv.left, vy: rv.top, vw: rv.width, vh: rv.height }; });
		await reset();
		await penStroke(line(uv.x + uv.w * 0.2, uv.y + uv.h * 0.3, uv.x + uv.w * 0.8, uv.y + uv.h * 0.3), 1);
		d = await diff();
		check('UV editor: Pencil paints', d.n > 10, d);
		await reset();
		const uvs = () => P(() => ({ z: +UVEditor.vue.zoom.toFixed(3), l: UVEditor.vue.$refs.viewport.scrollLeft, t: UVEditor.vue.$refs.viewport.scrollTop }));
		let u0 = await uvs();
		const ucx = uv.x + uv.w / 2, ucy = uv.y + uv.h * 0.6;
		await fingerDrag([[ucx - 30, ucy], [ucx + 30, ucy]], [[ucx - 80, ucy], [ucx + 80, ucy]]);
		let u1 = await uvs();
		check('UV editor (pencil-only): 2-finger pinch zooms, no paint', u1.z > u0.z * 1.3 && (await diff()).n === 0, { u0, u1 });
		u0 = u1;
		await fingerDrag([[ucx, ucy]], [[ucx - 60, ucy - 40]]);
		u1 = await uvs();
		check('UV editor (pencil-only): 1-finger drag pans, no paint', (u1.l !== u0.l || u1.t !== u0.t) && (await diff()).n === 0, { u0, u1 });
		await P(() => { UVEditor.setZoom(1); UVEditor.vue.centerView && UVEditor.vue.centerView(); });
		await sleep(200);
		// finger painting in the UV editor when pencil-only is off; 2nd finger converts to navigation
		await P(() => { BBTouch.pencil.settings.pencil_only = 'off'; });
		const uv2 = await P(() => { const r = document.getElementById('uv_frame').getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; });
		await reset();
		await fingerDrag([[uv2.x + uv2.w * 0.2, uv2.y + uv2.h * 0.7]], [[uv2.x + uv2.w * 0.8, uv2.y + uv2.h * 0.7]]);
		check('UV editor (finger mode): finger paints', (await diff()).n > 10);
		await reset();
		u0 = await uvs();
		await fingerDrag([[uv2.x + uv2.w * 0.4, uv2.y + uv2.h * 0.5], [uv2.x + uv2.w * 0.6, uv2.y + uv2.h * 0.5]], [[uv2.x + uv2.w * 0.3, uv2.y + uv2.h * 0.5], [uv2.x + uv2.w * 0.7, uv2.y + uv2.h * 0.5]]);
		u1 = await uvs();
		check('UV editor (finger mode): 2-finger pinch zooms without painting', u1.z > u0.z && (await diff()).n === 0, { u0, u1, d: await diff() });
		await P(() => { BBTouch.pencil.settings.pencil_only = 'auto'; UVEditor.setZoom(1); UVEditor.vue.centerView && UVEditor.vue.centerView(); });

		// 12. Pencil as a precise pointer outside painting: edit mode, tap selects, no finger gesture
		await P(() => { Modes.options.edit.select(); BarItems.move_tool.select(); unselectAllElements(); });
		await sleep(300);
		await setCam(); await sleep(100);
		const g0 = await P(() => JSON.stringify(BBTouch.gestures.stats));
		await pen('mousePressed', box.cx + 30, box.cy + 30, 0.5); await sleep(30); await pen('mouseReleased', box.cx + 30, box.cy + 30, 0);
		await sleep(200);
		st = await P(() => ({ sel: Outliner.selected.map(e => e.name), bar: !!document.querySelector('#bbt_brushbar.visible'), mode: BBTouch.gestures.mode }));
		check('edit mode: Pencil tap selects (precise pointer), brush bar hidden', st.sel.includes('canvas') && !st.bar && st.mode === 'idle', st);
		check('edit mode: Pencil never enters finger gesture logic', (await P(() => JSON.stringify(BBTouch.gestures.stats))) === g0);

		const bad = errors.filter(e => !/service_worker|blckbn\.ch|ERR_FAILED|404|CORS|Failed to load resource/i.test(e));
		check('no console errors', bad.length === 0, bad.slice(0, 5));
		await P(() => { Modes.options.paint.select(); BarItems.brush_tool.select(); });
		await sleep(400);
		if (shot) {
			// a few pressure-varying strokes in 3D and in the UV editor, settings popover open
			await reset();
			await setCam(); await sleep(100);
			const wave = (y, c, amp) => Array.from({ length: 25 }, (_, i) => [box.cx - 150 + i * 12.5, y + Math.sin(i / 3) * amp]);
			for (const [y, col] of [[box.cy - 120, '#e8453c'], [box.cy - 30, '#f5b400'], [box.cy + 60, '#3c8de8'], [box.cy + 150, '#34a853']]) {
				await P(c => ColorPanel.set(c), col);
				await penStroke(wave(y, col, 25), i => 0.08 + 0.9 * Math.sin(Math.PI * i / 24), { wait: 60 });
			}
			await P(() => { BarItems.slider_brush_size.change(() => 4); BarItems.slider_brush_size.update(); ColorPanel.set('#9c27b0'); });
			const uvr = await P(() => { const r = document.getElementById('uv_frame').getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; });
			await penStroke(Array.from({ length: 21 }, (_, i) => [uvr.x + uvr.w * (0.15 + i * 0.035), uvr.y + uvr.h * (0.85 - 0.1 * Math.sin(i / 2))]), i => 0.1 + i * 0.045, { wait: 60 });
			await P(() => BBTouch.pencil.openSettings(document.querySelector('#bbt_brushbar [data-act="settings"]')));
			await sleep(400);
			await page.screenshot({ path: shot });
			console.log('screenshot', shot);
		}
	} catch (e) {
		console.error(e); failed = true;
	} finally {
		await browser.close();
		server.kill();
	}
	const fails = results.filter(r => !r.ok).length;
	console.log(`\n${results.length - fails}/${results.length} checks passed`);
	process.exit(failed || fails ? 1 : 0);
})();
