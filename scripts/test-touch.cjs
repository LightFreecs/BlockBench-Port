#!/usr/bin/env node
// Headless touch-gesture test (M3) on an emulated iPad 1180x820.
// Uses CDP Input.dispatchTouchEvent for real multi-touch (→ touch + pointer events).
// Usage: node scripts/test-touch.cjs [--screenshot docs/screenshots/m3.png]
const { chromium } = require('playwright');
const path = require('path');
const { spawn } = require('child_process');

const root = path.resolve(__dirname, '..');
const port = 8865 + Math.floor(Math.random() * 100);
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
			viewport: { width: 1180, height: 820 }, deviceScaleFactor: 1, hasTouch: true, isMobile: true,
		});
		const page = await context.newPage();
		const errors = [];
		page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
		page.on('pageerror', e => errors.push('pageerror: ' + e.message));
		const cdp = await context.newCDPSession(page);

		const sleep = ms => page.waitForTimeout(ms);
		const touch = (type, points) => cdp.send('Input.dispatchTouchEvent', {
			type, touchPoints: points.map((p, i) => ({ x: p[0], y: p[1], id: p[2] ?? i, radiusX: 5, radiusY: 5, force: 1 })),
		});
		// Move fingers from `from` to `to` (arrays of [x,y]) in `steps`.
		async function drag(from, to, steps = 12) {
			await touch('touchStart', from);
			for (let s = 1; s <= steps; s++) {
				const k = s / steps;
				await touch('touchMove', from.map((f, i) => [f[0] + (to[i][0] - f[0]) * k, f[1] + (to[i][1] - f[1]) * k]));
				await sleep(16);
			}
			await touch('touchEnd', []);
			await sleep(60);
		}
		async function tap(points, hold = 40) {
			await touch('touchStart', points);
			await sleep(hold);
			await touch('touchEnd', []);
			await sleep(60);
		}
		const cam = () => page.evaluate(() => {
			const p = Preview.selected, c = p.controls;
			return {
				pos: c.object.position.toArray(), target: c.target.toArray(),
				dist: c.object.position.distanceTo(c.target), zoom: c.object.zoom,
			};
		});
		const vdist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

		await page.goto(`http://localhost:${port}/`, { waitUntil: 'load' });
		await page.waitForFunction(() => window.BBTouch && BBTouch.ready && window.Formats && Formats.free, null, { timeout: 30000 });
		await sleep(500);

		const setup = await page.evaluate(() => {
			Formats.free.new();
			if (window.Dialog && Dialog.open) Dialog.open.confirm();
			const cube = new Cube({ name: 'cube_a', from: [-4, 0, -4], to: [4, 8, 4] }).init();
			const cube2 = new Cube({ name: 'cube_b', from: [10, 0, -4], to: [18, 8, 4] }).init();
			Canvas.updateAll();
			unselectAllElements();
			BarItems.move_tool.select();
			Preview.selected.loadAnglePreset(DefaultCameraPresets[0]);
			return {
				touchMode: BBTouch.enabled, toolbar: !!document.getElementById('bbt_toolbar'),
				canvas: Preview.selected.canvas.getBoundingClientRect().toJSON(),
			};
		});
		await sleep(300);
		check('touch mode on + toolbar present', setup.touchMode && setup.toolbar, setup);
		const R = setup.canvas;
		// screen position of a cube centre
		const screenOf = (elName) => page.evaluate((name) => {
			const el = Outliner.elements.find(e => e.name === name);
			const p = Preview.selected;
			const r = p.canvas.getBoundingClientRect();
			const v = new THREE.Box3().setFromObject(el.mesh).getCenter(new THREE.Vector3()).project(p.camera);
			const c = [r.left + (v.x + 1) / 2 * r.width, r.top + (1 - v.y) / 2 * r.height];
			let best = null, bestD = Infinity;
			for (let x = r.left + 4; x < r.right; x += 6) for (let y = r.top + 4; y < r.bottom; y += 6) {
				const hit = p.raycast({ clientX: x, clientY: y, which: 1, button: 0 });
				if (!hit || hit.element !== el) continue;
				const d = Math.hypot(x - c[0], y - c[1]);
				if (d < bestD) { bestD = d; best = [x, y]; }
			}
			return best || c;
		}, elName);
		const selectedNames = () => page.evaluate(() => Outliner.selected.map(e => e.name).sort());
		const empty = [R.left + R.width * 0.85, R.top + R.height * 0.2];

		// --- tap select ---
		let a = await screenOf('cube_a');
		await tap([a]);
		check('tap on cube selects it', JSON.stringify(await selectedNames()) === '["cube_a"]', await selectedNames());

		// --- orbit (must not unselect) ---
		let c0 = await cam();
		await drag([empty], [[empty[0] - 200, empty[1] + 80]]);
		let c1 = await cam();
		check('1-finger drag on empty space orbits camera', vdist(c0.pos, c1.pos) > 1 && vdist(c0.target, c1.target) < 1e-6,
			{ moved: vdist(c0.pos, c1.pos).toFixed(2) });
		check('orbit keeps selection', JSON.stringify(await selectedNames()) === '["cube_a"]', await selectedNames());

		// --- 1-finger drag starting on element also orbits and does not change selection ---
		await page.evaluate(() => unselectAllElements());
		a = await screenOf('cube_a');
		c0 = await cam();
		await drag([a], [[a[0] + 150, a[1]]]);
		c1 = await cam();
		check('drag starting on element orbits, no select', vdist(c0.pos, c1.pos) > 1 && (await selectedNames()).length === 0);

		// --- pinch zoom ---
		const cx = R.left + R.width / 2, cy = R.top + R.height / 2;
		c0 = await cam();
		await drag([[cx - 60, cy], [cx + 60, cy]], [[cx - 200, cy], [cx + 200, cy]]);
		c1 = await cam();
		check('pinch out zooms in (distance shrinks)', c1.dist < c0.dist * 0.6, { before: c0.dist.toFixed(1), after: c1.dist.toFixed(1) });
		c0 = c1;
		await drag([[cx - 200, cy], [cx + 200, cy]], [[cx - 100, cy], [cx + 100, cy]]);
		c1 = await cam();
		check('pinch in zooms out', c1.dist > c0.dist * 1.5, { before: c0.dist.toFixed(1), after: c1.dist.toFixed(1) });

		// --- two-finger pan ---
		c0 = await cam();
		await drag([[cx - 50, cy], [cx + 50, cy]], [[cx + 100, cy + 60], [cx + 200, cy + 60]]);
		c1 = await cam();
		check('2-finger drag pans target', vdist(c0.target, c1.target) > 1 && Math.abs(c1.dist - c0.dist) / c0.dist < 0.05,
			{ targetMoved: vdist(c0.target, c1.target).toFixed(2), distChange: (c1.dist - c0.dist).toFixed(2) });

		// --- simultaneous pinch + pan ---
		c0 = await cam();
		await drag([[cx - 60, cy], [cx + 60, cy]], [[cx - 150, cy - 80], [cx + 150, cy - 80]]);
		c1 = await cam();
		check('pinch + pan simultaneously', c1.dist < c0.dist && vdist(c0.target, c1.target) > 1);

		// --- double tap empty: frame all; double tap element: focus ---
		await page.evaluate(() => { Preview.selected.loadAnglePreset(DefaultCameraPresets[0]); unselectAllElements(); });
		await sleep(200);
		await drag([[cx - 50, cy], [cx + 50, cy]], [[cx + 200, cy + 150], [cx + 300, cy + 150]]); // pan away
		await tap([empty]); await sleep(40); await tap([empty]);
		await sleep(400);
		c1 = await cam();
		const all_center = await page.evaluate(() => {
			const b = new THREE.Box3(); Outliner.elements.forEach(e => b.expandByObject(e.mesh));
			return b.getCenter(new THREE.Vector3()).toArray();
		});
		check('double-tap empty frames all', vdist(c1.target, all_center) < 0.5, { target: c1.target, all_center });

		const b = await screenOf('cube_b');
		await tap([b]); await sleep(40); await tap([b]);
		await sleep(400);
		c1 = await cam();
		const b_center = await page.evaluate(() => getSelectionCenter());
		check('double-tap element focuses it', JSON.stringify(await selectedNames()) === '["cube_b"]' && vdist(c1.target, b_center) < 0.5,
			{ target: c1.target, b_center });

		// --- modifier toolbar: Shift one-shot multi-select ---
		const btn = id => page.evaluate(id => {
			const r = document.querySelector(`#bbt_toolbar [data-id="${id}"]`).getBoundingClientRect();
			return [r.left + r.width / 2, r.top + r.height / 2];
		}, id);
		await page.evaluate(() => Preview.selected.loadAnglePreset(DefaultCameraPresets[0]));
		await sleep(300);
		a = await screenOf('cube_a');
		const b2 = await screenOf('cube_b');
		await tap([a]);
		await tap([await btn('shift')]);
		let st = await page.evaluate(() => ({ s: BBTouch.modifiers.get('shift'), o: Pressing.overrides.shift }));
		check('Shift tap → one-shot, Pressing.overrides.shift = true', st.s === 'once' && st.o === true, st);
		await tap([b2]);
		await sleep(200);
		st = await page.evaluate(() => ({ s: BBTouch.modifiers.get('shift'), o: Pressing.overrides.shift }));
		check('Shift+tap multi-selects', JSON.stringify(await selectedNames()) === '["cube_a","cube_b"]', await selectedNames());
		check('one-shot Shift consumed after action', st.s === 'off' && st.o === false, st);
		await tap([await btn('ctrl')]);
		await tap([b2]);
		await sleep(200);
		check('Ctrl+tap toggles element out of selection (multi_select)', JSON.stringify(await selectedNames()) === '["cube_a"]', await selectedNames());

		// double-tap = lock
		const sb = await btn('shift');
		await tap([sb]); await sleep(50); await tap([sb]);
		st = await page.evaluate(() => ({ s: BBTouch.modifiers.get('shift'), o: Pressing.overrides.shift, cls: document.querySelector('#bbt_toolbar [data-id="shift"]').className }));
		check('Shift double-tap → locked', st.s === 'lock' && st.o && /locked/.test(st.cls), st);
		await tap([empty]); await sleep(200);
		st = await page.evaluate(() => ({ s: BBTouch.modifiers.get('shift'), o: Pressing.overrides.shift }));
		check('locked Shift survives an action', st.s === 'lock' && st.o, st);
		await tap([sb]);
		st = await page.evaluate(() => ({ s: BBTouch.modifiers.get('shift'), o: Pressing.overrides.shift }));
		check('tap locked Shift → off', st.s === 'off' && !st.o, st);

		// Ctrl / Alt reach Keybind checks
		await tap([await btn('ctrl')]);
		await tap([await btn('alt')]);
		st = await page.evaluate(() => ({
			ctrl: Pressing.overrides.ctrl, alt: Pressing.overrides.alt,
			kb: new Keybind({ key: 65, ctrl: true, alt: true }).isTriggered({ which: 65, keyCode: 65, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false }),
		}));
		check('Ctrl + Alt toggles set Pressing.overrides and satisfy Keybind.isTriggered', st.ctrl && st.alt && st.kb, st);
		await page.evaluate(() => BBTouch.modifiers.clearAll());

		// --- undo / redo: 2-finger tap / 3-finger tap / toolbar ---
		const count = () => page.evaluate(() => Cube.all.length);
		await page.evaluate(() => BarItems.add_cube.trigger());
		await sleep(100);
		const n0 = await count();
		await tap([[cx - 40, cy], [cx + 40, cy]], 60);
		await sleep(150);
		const n1 = await count();
		check('2-finger tap = undo', n1 === n0 - 1, { n0, n1 });
		await tap([[cx - 60, cy], [cx, cy], [cx + 60, cy]], 60);
		await sleep(150);
		const n2 = await count();
		check('3-finger tap = redo', n2 === n0, { n2 });
		await tap([await btn('undo')]); await sleep(100);
		const n3 = await count();
		await tap([await btn('redo')]); await sleep(100);
		const n4 = await count();
		check('toolbar undo / redo buttons', n3 === n0 - 1 && n4 === n0, { n3, n4 });

		// --- toolbar duplicate / delete ---
		await page.evaluate(() => { unselectAllElements(); Cube.all.find(c => c.name === 'cube_a').select(); Prop.active_panel = 'preview'; });
		const d0 = await count();
		await tap([await btn('duplicate')]); await sleep(150);
		const d1 = await count();
		await tap([await btn('delete')]); await sleep(150);
		const d2 = await count();
		check('toolbar duplicate / delete', d1 === d0 + 1 && d2 === d0, { d0, d1, d2 });

		// --- gizmo: bigger on touch + drag on gizmo transforms instead of orbiting ---
		await page.evaluate(() => { unselectAllElements(); Cube.all.find(c => c.name === 'cube_a').select(); BarItems.move_tool.select(); Preview.selected.loadAnglePreset(DefaultCameraPresets[0]); });
		await sleep(300);
		const giz = await page.evaluate(() => {
			Transformer.update();
			const big = Transformer.scale.x;
			BBTouch.enabled = false; Transformer.update(); const small = Transformer.scale.x; BBTouch.enabled = true; Transformer.update();
			// find the X-axis picker of the translate gizmo and project its centre
			let picker = null;
			Transformer.traverse(o => { if (!picker && o.name === 'X' && o.parent && o.parent.name === 'pickers' && o.parent.parent && o.parent.parent.visible) picker = o; });
			if (!picker) Transformer.traverse(o => { if (!picker && o.name === 'X' && o.visible !== false && o.geometry && o.parent && o.parent.visible) picker = o; });
			const p = Preview.selected;
			const box = new THREE.Box3().setFromObject(picker);
			const v = box.getCenter(new THREE.Vector3()).project(p.camera);
			const r = p.canvas.getBoundingClientRect();
			return { big, small, pt: [r.left + (v.x + 1) / 2 * r.width, r.top + (1 - v.y) / 2 * r.height], from: Cube.all.find(c => c.name === 'cube_a').from.slice() };
		});
		check('gizmo is scaled up in touch mode', giz.big > giz.small * 1.4, { big: giz.big.toFixed(3), small: giz.small.toFixed(3) });
		c0 = await cam();
		await drag([giz.pt], [[giz.pt[0] + 120, giz.pt[1] + 10]], 15);
		c1 = await cam();
		const from2 = await page.evaluate(() => Cube.all.find(c => c.name === 'cube_a').from.slice());
		check('drag on gizmo moves cube, camera stays', from2[0] !== giz.from[0] && vdist(c0.pos, c1.pos) < 1e-6, { before: giz.from, after: from2 });
		await tap([[cx - 40, cy], [cx + 40, cy]], 60); await sleep(150);
		const from3 = await page.evaluate(() => Cube.all.find(c => c.name === 'cube_a').from.slice());
		check('2-finger tap undoes gizmo move', from3[0] === giz.from[0], { from3 });

		// --- toolbar: collapse + drag + persisted position ---
		const tb0 = await page.evaluate(() => document.getElementById('bbt_toolbar').getBoundingClientRect().toJSON());
		const grip = [tb0.left + tb0.width / 2, tb0.top + 12];
		await drag([grip], [[grip[0] + 300, grip[1] + 40]], 10);
		const tb1 = await page.evaluate(() => ({ r: document.getElementById('bbt_toolbar').getBoundingClientRect().toJSON(), saved: BBTouch.store.get('toolbar') }));
		check('toolbar drags and saves position', Math.abs(tb1.r.left - tb0.left - 300) < 3 && tb1.saved && Math.abs(tb1.saved.x - tb1.r.left) < 2, tb1.saved);
		await tap([await btn('collapse')]);
		const col = await page.evaluate(() => document.getElementById('bbt_toolbar').classList.contains('collapsed'));
		await tap([await btn('collapse')]);
		check('toolbar collapses', col);
		// put it back to the default spot for the screenshot
		await page.evaluate(() => BBTouch.toolbar.resetPosition());

		// --- touch mode toggle off restores upstream controls ---
		await tap([await btn('touch_mode')]);
		const off = await page.evaluate(() => ({ enabled: BBTouch.enabled, ctrlEnabled: Preview.selected.controls.isEnabled() }));
		await tap([await btn('touch_mode')]);
		const on = await page.evaluate(() => BBTouch.enabled);
		check('touch mode toggle', off.enabled === false && off.ctrlEnabled === true && on === true, off);

		// --- browser zoom/scroll suppressed ---
		const vv = await page.evaluate(() => ({ scale: window.visualViewport ? visualViewport.scale : 1, sx: scrollX, sy: scrollY, ta: getComputedStyle(Preview.selected.canvas).touchAction }));
		check('no page zoom/scroll, touch-action none', vv.scale === 1 && vv.sx === 0 && vv.sy === 0 && vv.ta === 'none', vv);

		if (shot) {
			await page.evaluate(() => {
				unselectAllElements(); Cube.all.find(c => c.name === 'cube_a').select();
				Preview.selected.loadAnglePreset(DefaultCameraPresets[0]);
				BBTouch.modifiers.set('shift', 'lock'); BBTouch.modifiers.set('ctrl', 'once');
			});
			await sleep(500);
			await page.screenshot({ path: shot });
			await page.evaluate(() => BBTouch.modifiers.clearAll());
		}

		const fatal = errors.filter(e => !/Failed to load resource|service_worker|net::ERR|blckbn\.ch|favicon|bad HTTP response code \(404\) was received when fetching the script/i.test(e));
		check('no fatal console errors', fatal.length === 0, fatal);
		failed = results.some(r => !r.ok);
	} catch (e) {
		console.error(e); failed = true;
	} finally {
		await browser.close();
		server.kill();
	}
	console.log(`${results.filter(r => r.ok).length}/${results.length} checks passed`);
	console.log(failed ? 'TOUCH TEST FAILED' : 'TOUCH TEST PASSED');
	process.exit(failed ? 1 : 0);
})();
