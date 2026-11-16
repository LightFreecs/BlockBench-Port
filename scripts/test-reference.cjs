#!/usr/bin/env node
// Reference images / blueprints by touch (touch/reference.js), headless Chromium, emulated iPad.
//   Generic Model + cube → Mesh Tools › Reference › "+ Front" → pick image → pinned behind the
//   model in the front ortho view → pinch-resize + drag while editing → Done (image ignores
//   touches, viewport gestures work again) → Side / 3D views → opacity → saved in .bbmodel and
//   restored on reopen → delete.
// Usage: node scripts/test-reference.cjs [--screenshots]   (writes docs/screenshots/ref-*.png)
const { chromium } = require('playwright');
const path = require('path');
const { spawn } = require('child_process');

const root = path.resolve(__dirname, '..');
const port = 9265 + Math.floor(Math.random() * 100);
const shots = process.argv.includes('--screenshots');
const shotDir = path.join(root, 'docs/screenshots');
const IMAGE = path.join(root, 'blockbench/icon_full.png');

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
			viewport: { width: 1180, height: 820 }, deviceScaleFactor: shots ? 2 : 1, hasTouch: true, isMobile: true,
		});
		const page = await context.newPage();
		const errors = [];
		page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
		page.on('pageerror', e => errors.push('pageerror: ' + e.message));
		const cdp = await context.newCDPSession(page);
		const sleep = ms => page.waitForTimeout(ms);
		const ev = (fn, arg) => page.evaluate(fn, arg);
		const touch = (type, points) => cdp.send('Input.dispatchTouchEvent', {
			type, touchPoints: points.map((p, i) => ({ x: p[0], y: p[1], id: p[2] ?? i, radiusX: 5, radiusY: 5, force: 1 })),
		});
		async function tap(x, y, hold = 50) {
			await touch('touchStart', [[x, y]]); await sleep(hold); await touch('touchEnd', []); await sleep(150);
		}
		async function drag(from, to, steps = 12) {
			await touch('touchStart', [from]);
			for (let s = 1; s <= steps; s++) {
				const k = s / steps;
				await touch('touchMove', [[from[0] + (to[0] - from[0]) * k, from[1] + (to[1] - from[1]) * k]]);
				await sleep(16);
			}
			await touch('touchEnd', []); await sleep(150);
		}
		async function pinch(c, d0, d1, steps = 10) {
			await touch('touchStart', [[c[0] - d0 / 2, c[1], 0], [c[0] + d0 / 2, c[1], 1]]);
			for (let s = 1; s <= steps; s++) {
				const d = d0 + (d1 - d0) * s / steps;
				await touch('touchMove', [[c[0] - d / 2, c[1], 0], [c[0] + d / 2, c[1], 1]]);
				await sleep(16);
			}
			await touch('touchEnd', []); await sleep(200);
		}
		const rect = sel => ev(sel => {
			const el = document.querySelector(sel);
			if (!el) return null;
			const r = el.getBoundingClientRect();
			return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height };
		}, sel);
		const tapSel = async sel => { const r = await rect(sel); if (!r || !r.w) throw new Error('not visible: ' + sel); await tap(r.x, r.y); return r; };
		async function tapBar(id) {
			await ev(id => { const b = document.querySelector(`#bbt_meshbar .bbt_mb_row2 [data-bid="${id}"]`); if (b) b.scrollIntoView({ inline: 'center', block: 'nearest' }); }, id);
			await sleep(60);
			return tapSel(`#bbt_meshbar .bbt_mb_row2 [data-bid="${id}"]`);
		}
		const shot = async name => { if (shots) await page.screenshot({ path: path.join(shotDir, `ref-${name}.png`) }); };
		const refState = () => ev(() => {
			const r = BBTouch.reference.list()[0];
			if (!r) return null;
			const b = r.node.getBoundingClientRect();
			const hit = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2);
			return {
				n: BBTouch.reference.list().length, mode: r.view_mode, side: r.attached_side, layer: r.layer, opacity: r.opacity,
				size: r.size.slice(), pos: r.position.slice(), editing: BBTouch.reference.editing(), selected: ReferenceImage.selected === r,
				active: ReferenceImage.active.includes(r), angle: Preview.selected.angle, ortho: Preview.selected.isOrtho,
				cx: b.left + b.width / 2, cy: b.top + b.height / 2, w: b.width, h: b.height,
				hit: hit ? hit.tagName + (hit.classList.contains('reference_image') ? '.reference_image' : '') : null,
			};
		});

		await page.goto(`http://localhost:${port}/`, { waitUntil: 'load' });
		await page.waitForFunction(() => window.BBTouch && BBTouch.ready && BBTouch.reference && BBTouch.meshTools && window.ReferenceImage, null, { timeout: 30000 });
		await sleep(1200);

		await ev(() => {
			newProject(Formats.free);
			if (Dialog.open) Dialog.open.close(0);
			BBTouch.meshTools.addPrimitive('cuboid', { diameter: 16, height: 16 });
			unselectAllElements();
			BBTouch.meshTools.setCategory('ref');
		});
		await sleep(300);
		check('Mesh Tools has a Reference tab with add / view / edit buttons', await ev(() =>
			!!document.querySelector('#bbt_meshbar [data-cat="ref"]') && ['bbtouch_ref_add_front', 'bbtouch_ref_add_right', 'bbtouch_ref_view_front', 'bbtouch_ref_edit', 'bbtouch_ref_opacity']
				.every(id => document.querySelector(`#bbt_meshbar [data-bid="${id}"]`))));
		check('"Front" follows the Generic Model forward direction (-Z → north view)', await ev(() => BBTouch.reference.presetFor('front') === 'north' && BBTouch.reference.presetFor('back') === 'south' && BBTouch.reference.presetFor('right') === 'east'));

		// + Front → image picker (web: <input type=file>) → blueprint
		const chooser = page.waitForEvent('filechooser', { timeout: 6000 });
		await tapBar('bbtouch_ref_add_front');
		await (await chooser).setFiles(IMAGE);
		await page.waitForFunction(() => BBTouch.reference.list().length === 1, null, { timeout: 6000 }).catch(() => {});
		await sleep(600);
		let st = await refState();
		check('+ Front: switches to the front ortho view', st && st.ortho && st.angle === 'north', st && { angle: st.angle, ortho: st.ortho });
		check('+ Front: image added as a blueprint pinned to the front view, behind the model, 60% opacity', st && st.mode === 'blueprint' && st.side === 'north' && st.layer === 'background' && Math.abs(st.opacity - 0.6) < 1e-6, st);
		check('+ Front: opens reference editing with the new image selected and on top', st && st.editing && st.selected && st.hit === 'DIV.reference_image', st && { editing: st.editing, selected: st.selected, hit: st.hit });
		await shot('added');

		// pinch on the image = resize (upstream has no pinch); camera must not zoom
		const zoom0 = await ev(() => Preview.selected.camOrtho.zoom);
		const before = st;
		await pinch([st.cx, st.cy], 80, 160);
		st = await refState();
		const k = st.size[0] / before.size[0];
		check('editing: 2-finger pinch resizes the image (~2×), keeps aspect ratio', k > 1.7 && k < 2.3 && Math.abs(st.size[0] / st.size[1] - before.size[0] / before.size[1]) < 0.02, { k, size: st.size });
		check('editing: pinch does not zoom the camera', Math.abs((await ev(() => Preview.selected.camOrtho.zoom)) - zoom0) < 1e-6);
		// 1 finger drag on the image = move (upstream handler)
		await drag([st.cx, st.cy], [st.cx + 60, st.cy + 30]);
		const moved = await refState();
		check('editing: 1-finger drag moves the image', Math.abs(moved.cx - st.cx - 60) < 8 && Math.abs(moved.cy - st.cy - 30) < 8, { dx: moved.cx - st.cx, dy: moved.cy - st.cy });
		await shot('editing');

		// Done → image behind the model, ignores touches; gestures work again
		await tapBar('bbtouch_ref_edit');
		st = await refState();
		check('Done: leaves editing, image back behind the canvas (touches reach the viewport)', st && !st.editing && st.hit === 'CANVAS' && st.active, st && { editing: st.editing, hit: st.hit });
		await pinch([st.cx, st.cy], 160, 80);
		const zoom1 = await ev(() => Preview.selected.camOrtho.zoom);
		check('after Done: 2-finger pinch zooms the view again', Math.abs(zoom1 - zoom0) > 0.01, { zoom0, zoom1 });
		check('blueprint scales with the view (stays aligned to the model)', (await refState()).w < st.w * 0.9, { before: st.w, after: (await refState()).w });
		await shot('traced');

		// views
		await tapBar('bbtouch_ref_view_right');
		st = await refState();
		check('Side View: east ortho view, front blueprint hidden there', st.angle === 'east' && !st.active, { angle: st.angle, active: st.active });
		await tapBar('bbtouch_ref_view_3d');
		st = await refState();
		check('3D View: perspective camera', !st.ortho && !st.active, { ortho: st.ortho, active: st.active });
		await tapBar('bbtouch_ref_view_front');
		st = await refState();
		check('Front View: blueprint visible again', st.angle === 'north' && st.active);

		// opacity
		await tapBar('bbtouch_ref_opacity');
		const dlg = await page.waitForFunction(() => Dialog.open && Dialog.open.id === 'bbtouch_reference_opacity', null, { timeout: 4000 }).then(() => true, () => false);
		check('Opacity opens a slider dialog', dlg);
		await ev(() => { Dialog.open.setFormValues({ opacity: 30 }); Dialog.open.confirm(); });
		check('opacity applied', Math.abs((await refState()).opacity - 0.3) < 1e-6);

		// saved in the project and restored on reopen
		const saved = await ev(() => {
			const json = JSON.parse(Codecs.project.compile());
			return { refs: (json.reference_images || []).map(r => ({ mode: r.view_mode, side: r.attached_side, opacity: r.opacity })), keys: Object.keys((json.reference_images || [])[0] || {}), json: Codecs.project.compile() };
		});
		check('.bbmodel stores the blueprint (side, opacity)', saved.refs.length === 1 && saved.refs[0].mode === 'blueprint' && (saved.refs[0].side || 'north') === 'north' && Math.abs(saved.refs[0].opacity - 0.3) < 1e-6, { refs: saved.refs, keys: saved.keys });
		await ev(json => {
			Project.saved = true;
			Project.close(true);
			loadModelFile({ content: json, path: 'traced.bbmodel', name: 'traced.bbmodel' });
		}, saved.json);
		await sleep(800);
		st = await refState();
		check('reopened project restores the blueprint', st && st.n === 1 && st.mode === 'blueprint' && st.side === 'north', st);

		// delete
		await ev(() => { BBTouch.meshTools.setCategory('ref'); BBTouch.reference.setView('front'); });
		await sleep(200);
		await tapBar('bbtouch_ref_edit');
		await sleep(200);
		await ev(() => { const r = BBTouch.reference.list()[0]; if (r && ReferenceImage.selected !== r) r.select(); });
		await tapBar('bbtouch_ref_delete');
		await sleep(300);
		await ev(() => { if (Dialog.open && Dialog.open.confirm) Dialog.open.confirm(); });
		await sleep(300);
		check('Delete removes the selected reference', (await ev(() => BBTouch.reference.list().length)) === 0);
		await ev(() => BBTouch.reference.edit(false));

		const bad = errors.filter(e => !/service_worker|Failed to load resource|net::ERR|blckbn\.ch|CORS/i.test(e));
		check('no page errors', bad.length === 0, bad.slice(0, 5));
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
