#!/usr/bin/env node
// Gizmo fit + iPhone tool column (headless Chromium, iPhone 390x844 portrait, touch).
//  - zooming out shrinks the gizmo with the object (down to a finger-sized floor) instead of
//    keeping a constant, huge on-screen size;
//  - upstream's vertical tool column (narrow layout) stays above the Mesh Tools bar, also when the
//    bar is collapsed, and all its tools are reachable.
const { chromium } = require('playwright');
const path = require('path');
const { spawn } = require('child_process');

const root = path.resolve(__dirname, '..');
const port = 9365 + Math.floor(Math.random() * 100);
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
		const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
		const page = await context.newPage();
		const errors = [];
		page.on('pageerror', e => errors.push(e.message));
		await page.goto(`http://localhost:${port}/`, { waitUntil: 'load' });
		await page.waitForFunction(() => window.BBTouch && BBTouch.ready && BBTouch.meshTools, null, { timeout: 30000 });
		await page.waitForTimeout(1200);

		const sizes = await page.evaluate(async () => {
			newProject(Formats.free);
			if (Dialog.open) Dialog.open.close(0);
			BBTouch.meshTools.addPrimitive('cuboid', { diameter: 16, height: 16 });
			BarItems.move_tool.select();
			const P = Preview.selected, c = P.controls;
			const wait = ms => new Promise(r => setTimeout(r, ms));
			const out = [];
			for (const zoom of [1, 0.5, 0.2, 0.08]) {
				BBTouch.gestures.frameAll();
				await wait(300);
				const off = P.camera.position.clone().sub(c.target).multiplyScalar(1 / zoom);
				P.camera.position.copy(c.target).add(off);
				c.update();
				Transformer.update();
				await wait(150);
				const proj = v => { const w = v.clone().project(P.camera); return [(w.x + 1) / 2 * P.width, (1 - w.y) / 2 * P.height]; };
				const pos = Transformer.getWorldPosition(new THREE.Vector3());
				const right = new THREE.Vector3(1, 0, 0).applyQuaternion(P.camera.quaternion);
				const a0 = proj(pos), a1 = proj(pos.clone().add(right.clone().multiplyScalar(Transformer.scale.x)));
				const m = Mesh.all[0], box = new THREE.Box3();
				Object.keys(m.vertices).forEach(k => box.expandByPoint(m.mesh.localToWorld(new THREE.Vector3().fromArray(m.vertices[k]))));
				const h1 = proj(pos.clone().add(right.clone().multiplyScalar(box.getSize(new THREE.Vector3()).length() / 2)));
				out.push({ zoom, arm: Math.round(Math.hypot(a1[0] - a0[0], a1[1] - a0[1])), obj: Math.round(Math.hypot(h1[0] - a0[0], h1[1] - a0[1])) });
			}
			return out;
		});
		const [z1, z05, z02, z008] = sizes;
		check('gizmo shrinks as you zoom out (follows the object)', z05.arm < z1.arm * 0.8 && z02.arm < z05.arm, sizes);
		check('gizmo never smaller than the finger-sized floor (~80 px arm)', z008.arm >= 75 && z008.arm <= 90, z008);
		check('gizmo never bigger than the touch default', sizes.every(s => s.arm <= z1.arm + 1), sizes.map(s => s.arm));

		const layout = () => page.evaluate(() => {
			const tools = document.querySelector('#preview > .toolbar_wrapper.tools.narrow');
			const bar = document.getElementById('bbt_meshbar');
			if (!tools || !bar) return { tools: !!tools, bar: !!bar };
			const t = tools.getBoundingClientRect(), b = bar.getBoundingClientRect();
			const items = [...tools.querySelectorAll('.tool')].filter(e => e.offsetParent);
			const lastBottom = Math.max(...items.map(e => e.getBoundingClientRect().bottom));
			return { toolsBottom: Math.round(t.bottom), lastTool: Math.round(lastBottom), barTop: Math.round(b.top), n: items.length };
		});
		let l = await layout();
		check('iPhone: tool column ends above the Mesh Tools bar', l.toolsBottom <= l.barTop && l.lastTool <= l.barTop, l);
		await page.evaluate(() => document.querySelector('#bbt_meshbar [data-ctl="collapse"]').click());
		await page.waitForTimeout(400);
		const l2 = await layout();
		check('collapsed bar: tool column follows (more room, still above the bar)', l2.toolsBottom <= l2.barTop && l2.toolsBottom > l.toolsBottom, l2);
		check('collapse button actually collapses the bar', await page.evaluate(() => BBTouch.meshTools.collapsed && document.getElementById('bbt_meshbar').classList.contains('collapsed')));
		await page.evaluate(() => document.querySelector('#bbt_meshbar [data-ctl="collapse"]').click());
		await page.waitForTimeout(300);
		check('expand again restores the bar', await page.evaluate(() => !BBTouch.meshTools.collapsed && !document.getElementById('bbt_meshbar').classList.contains('collapsed')));
		check('no page errors', errors.length === 0, errors.slice(0, 3));
	} catch (e) {
		console.error(e);
		failed = true;
	} finally {
		await browser.close();
		server.kill();
	}
	const passed = results.filter(r => r.ok).length;
	console.log(`\n${passed}/${results.length} passed`);
	process.exit(failed || passed !== results.length ? 1 : 0);
})();
