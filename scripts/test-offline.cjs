#!/usr/bin/env node
// M8: privacy / offline. Headless Chromium, emulated iPad, mocked Capacitor (as in the iOS app),
// every request to a non-local host is aborted (page.route). Checks:
//   - the app boots, the touch layer loads, the start screen shows the Generic Model card
//   - upstream telemetry / update check / remote news are blocked by touch/net.js before they
//     reach the network (fresh profile → upstream sends "new_installation" on first start)
//   - the Generic Model flow works: preset model, add mesh, extrude, texture, animation,
//     Quick Export GLB / glTF / OBJ / FBX / .bbmodel into Documents
//   - no uncaught errors (pageerror / unhandled rejection) and no unexpected console errors
// Usage: node scripts/test-offline.cjs
const { chromium } = require('playwright');
const path = require('path');
const { spawn } = require('child_process');
const { installMock } = require('./test-files.cjs');

const root = path.resolve(__dirname, '..');
const port = 9265 + Math.floor(Math.random() * 100);
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
		const context = await browser.newContext({ viewport: { width: 1180, height: 820 }, hasTouch: true, isMobile: true });
		const page = await context.newPage();
		const errors = [], uncaught = [], remote = [];
		page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
		page.on('pageerror', e => uncaught.push(e.message + ' ' + (e.stack || '').split('\n').slice(0, 3).join(' | ')));
		await page.addInitScript(() => {
			window.addEventListener('unhandledrejection', e => console.error('UNHANDLED-REJECTION ' + (e.reason && (e.reason.stack || e.reason.message) || e.reason)));
		});
		await page.addInitScript(installMock);
		await page.route('**/*', route => {
			const u = new URL(route.request().url());
			if (u.hostname === 'localhost' || u.hostname === '127.0.0.1' || u.protocol === 'data:' || u.protocol === 'blob:') {
				if (u.pathname.endsWith('/touch/vendor/capacitor.js')) return route.fulfill({ contentType: 'text/javascript', body: '/* mocked */' });
				return route.continue();
			}
			remote.push(route.request().method() + ' ' + u.href);
			return route.abort('internetdisconnected');
		});
		const ev = (fn, arg) => page.evaluate(fn, arg);
		const sleep = ms => page.waitForTimeout(ms);

		await page.goto(`http://localhost:${port}/`, { waitUntil: 'load' });
		await page.waitForFunction(() => window.BBTouch && BBTouch.ready && BBTouch.generic && BBTouch.quickExport && BBTouch.files, null, { timeout: 30000 });
		await sleep(2500); // let boot-time requests (news, plugins, stats, telemetry) settle

		let st = await ev(() => ({ native: BBTouch.files.cap.isNative(), card: !!document.querySelector('#bbt_generic_start'), net: !!BBTouch.net, blocked: BBTouch.net.blocked.slice(), startup: Blockbench.startup_count }));
		check('boots offline (native mock, touch layer, Generic Model start card)', st.native && st.card && st.net, st);
		check('telemetry blocked before the network (new_installation event, plugin stats)', st.blocked.some(u => /blckbn\.ch\/api\/event\/new_installation/.test(u)) && st.blocked.some(u => /blckbn\.ch\/api\/stats/.test(u)), st.blocked);
		check('remote start-screen news → bundled content/news.json', (await ev(() => BBTouch.net.redirected)).some(u => /web\.blockbench\.net\/content\/news\.json/.test(u)));
		check('no blocked URL reached the network', !remote.some(r => /blckbn\.ch\/api\/(event|stats)|web\.blockbench\.net\/content\/news|api\.github\.com\/repos\/JannisX11\/blockbench\/releases/.test(r)), remote);

		// About dialog: update check is blocked, dialog still opens
		await ev(() => BarItems.about_window.click());
		await sleep(400);
		st = await ev(() => ({ open: !!(Dialog.open && Dialog.open.id === 'about'), blocked: BBTouch.net.blocked.some(u => /api\.github\.com\/repos\/JannisX11\/blockbench\/releases/.test(u)) }));
		check('About opens; its GitHub update check is blocked', st.open && st.blocked, st);
		await ev(() => Dialog.open && Dialog.open.close());

		// Generic Model flow
		await ev(() => BBTouch.generic.newModel('cube'));
		await sleep(500);
		st = await ev(() => ({ format: Format.id, meshes: Mesh.all.length, mode: Modes.selected.id }));
		check('Generic Model "Cube" preset created', st.format === 'free' && st.meshes === 1 && st.mode === 'edit', st);
		st = await ev(() => {
			const m = Mesh.all[0];
			m.select();
			const top = Object.keys(m.faces).sort((a, b) => {
				const cy = k => m.faces[k].vertices.reduce((s, v) => s + m.vertices[v][1], 0);
				return cy(b) - cy(a);
			})[0];
			BarItems.selection_mode.change('face');
			Project.mesh_selection[m.uuid] = { vertices: m.faces[top].vertices.slice(), edges: [], faces: [top] };
			const v0 = Object.keys(m.vertices).length;
			BarItems.extrude_mesh_selection.click();
			if (Dialog.open) Dialog.open.confirm();
			return { v0, v1: Object.keys(m.vertices).length };
		});
		check('extrude a face', st.v1 > st.v0, st);
		await ev(() => { Undo.closeAmendEditMenu && Undo.closeAmendEditMenu(); });
		await ev(() => {
			const t = new Texture({ name: 'skin' }).fromDataURL(document.createElement('canvas').toDataURL()).add(false);
			Mesh.all[0].applyTexture(t, true);
			Modes.options.animate.select();
			new Animation({ name: 'idle', length: 1 }).add().select();
		});
		await sleep(400);
		st = await ev(() => ({ tex: Texture.all.length, anims: Animation.all.length }));
		check('texture + animation added', st.tex === 1 && st.anims === 1, st);

		const out = await ev(async () => {
			await BBTouch.quickExport.run(['glb', 'gltf', 'obj', 'fbx', 'bbmodel']);
			await new Promise(r => setTimeout(r, 300));
			if (Dialog.open) Dialog.open.close();
			return { files: Object.keys(__mock.files).filter(p => /^(Exports|Projects)\//.test(p)), last: BBTouch.quickExport.last.map(o => ({ f: o.format, ok: !!(o.result && o.result.paths) })) };
		});
		check('Quick Export GLB / glTF / OBJ / FBX / .bbmodel offline', out.last.length === 5 && out.last.every(o => o.ok)
			&& ['glb', 'gltf', 'obj', 'fbx', 'bbmodel'].every(x => out.files.some(p => p.endsWith('.' + x))), out);

		check('no uncaught errors / unhandled rejections', uncaught.length === 0 && !errors.some(e => /UNHANDLED-REJECTION/.test(e)), { uncaught, rej: errors.filter(e => /UNHANDLED/.test(e)) });
		// expected while offline: the plugin store (allowed, fails gracefully) and Chromium's net:: logs
		const bad = errors.filter(e => !/plugin server|plugin updates|net::ERR_INTERNET_DISCONNECTED|Failed to load resource|service_worker|preventDefault inside passive/i.test(e));
		check('no unexpected console errors', bad.length === 0, bad.slice(0, 5));
		console.log('      remote requests attempted (aborted):', remote.length ? remote.join(', ') : 'none');
		console.log('      blocked by touch/net.js:', (await ev(() => BBTouch.net.blocked)).join(', '));
		await context.close();
	} catch (err) {
		console.error(err);
		failed = true;
	} finally {
		await browser.close();
		server.kill();
	}
	const passed = results.filter(r => r.ok).length;
	console.log(`\n${passed}/${results.length} checks passed`);
	process.exit(failed || passed !== results.length ? 1 : 0);
})();
