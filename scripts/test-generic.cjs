#!/usr/bin/env node
// M5 E2E: the Generic Model workflow by touch, headless Chromium, emulated iPad (1180x820, touch),
// mocked Capacitor (in-memory Documents, from scripts/test-files.cjs).
//   start-screen quick start → Mesh Tools: add cube → face mode → tap a face → extrude → subdivide
//   → box select by drag → create texture → UV editor (pinch/pan) → animate: animation + keyframe,
//   timeline scrub/pinch, play → Quick Export GLB/glTF/OBJ/FBX + .bbmodel → reopen the .bbmodel.
// Usage: node scripts/test-generic.cjs [--screenshots]   (writes docs/screenshots/m5-*.png)
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const { installMock } = require('./test-files.cjs');

const root = path.resolve(__dirname, '..');
const port = 9065 + Math.floor(Math.random() * 100);
const shots = process.argv.includes('--screenshots');
const shotDir = path.join(root, 'docs/screenshots');

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
		page.on('console', m => { if (m.text().startsWith('PASSIVE-PD')) console.log(m.text()); if (m.type() === 'error') { errors.push(m.text()); if (process.env.DEBUG_ERRORS) console.log('   [console.error after: ' + (results[results.length - 1] || {}).name + '] ' + m.text()); } });
		page.on('pageerror', e => { errors.push('pageerror: ' + e.message); if (process.env.DEBUG_ERRORS) console.log(e.stack); });
		await page.addInitScript(installMock);
		if (process.env.DEBUG_PASSIVE) await page.addInitScript(() => {
			const orig = EventTarget.prototype.addEventListener;
			let inPassive = 0;
			EventTarget.prototype.addEventListener = function (type, fn, opts) {
				const passive = (opts && typeof opts === 'object' && opts.passive) || ((type === 'touchstart' || type === 'touchmove' || type === 'wheel') && (this === window || this === document || this === document.body) && !(opts && opts.passive === false));
				if (passive && typeof fn === 'function') { const f = fn; fn = function (e) { inPassive++; try { return f.call(this, e); } finally { inPassive--; } }; }
				return orig.call(this, type, fn, opts);
			};
			const pd = Event.prototype.preventDefault;
			Event.prototype.preventDefault = function () { if (inPassive) console.log('PASSIVE-PD ' + this.type + ' ' + new Error().stack.split('\n').slice(1, 5).join(' | ')); return pd.call(this); };
		});
		await page.route('**/touch/vendor/capacitor.js', r => r.fulfill({ contentType: 'text/javascript', body: '/* mocked */' }));
		const cdp = await context.newCDPSession(page);
		const sleep = ms => page.waitForTimeout(ms);
		const ev = (fn, arg) => page.evaluate(fn, arg);
		const touch = (type, points) => cdp.send('Input.dispatchTouchEvent', {
			type, touchPoints: points.map((p, i) => ({ x: p[0], y: p[1], id: p[2] ?? i, radiusX: 5, radiusY: 5, force: 1 })),
		});
		async function tap(x, y, hold = 50) {
			await touch('touchStart', [[x, y]]);
			await sleep(hold);
			await touch('touchEnd', []);
			await sleep(150);
		}
		async function drag(from, to, steps = 12, stepDelay = 16) {
			await touch('touchStart', [from]);
			for (let s = 1; s <= steps; s++) {
				const k = s / steps;
				await touch('touchMove', [[from[0] + (to[0] - from[0]) * k, from[1] + (to[1] - from[1]) * k]]);
				await sleep(stepDelay);
			}
			await touch('touchEnd', []);
			await sleep(150);
		}
		async function pinch(c, d0, d1, steps = 10, dx = 0) {
			await touch('touchStart', [[c[0] - d0 / 2, c[1], 0], [c[0] + d0 / 2, c[1], 1]]);
			for (let s = 1; s <= steps; s++) {
				const d = d0 + (d1 - d0) * s / steps, ox = dx * s / steps;
				await touch('touchMove', [[c[0] - d / 2 + ox, c[1], 0], [c[0] + d / 2 + ox, c[1], 1]]);
				await sleep(16);
			}
			await touch('touchEnd', []);
			await sleep(150);
		}
		const rect = sel => ev(sel => {
			const el = document.querySelector(sel);
			if (!el) return null;
			const r = el.getBoundingClientRect();
			return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height, left: r.left, top: r.top };
		}, sel);
		const tapSel = async sel => { const r = await rect(sel); if (!r || !r.w) throw new Error('not visible: ' + sel); await tap(r.x, r.y); return r; };
		const shot = async name => { if (shots) await page.screenshot({ path: path.join(shotDir, `m5-${name}.png`) }); };
		const waitDialog = (id, timeout = 6000) => page.waitForFunction(id => window.Dialog && Dialog.open && Dialog.open.id === id, id, { timeout }).then(() => sleep(60)).then(() => true, () => false);
		const mbBtn = id => `#bbt_meshbar .bbt_mb_row2 [data-bid="${id}"]`;
		async function tapBar(id) {
			// bring the button into view in the horizontally scrolling row, then tap it
			await ev(id => { const b = document.querySelector(`#bbt_meshbar .bbt_mb_row2 [data-bid="${id}"]`); if (b) b.scrollIntoView({ inline: 'center', block: 'nearest' }); }, id);
			await sleep(60);
			return tapSel(mbBtn(id));
		}
		// project a mesh face centre to client coordinates
		// screen point on a face that raycasts to that face and is clear of the transform gizmo
		const faceScreen = (fkey) => ev(fkey => {
			const mesh = Mesh.all[0], face = mesh.faces[fkey];
			const p = Preview.selected, r = p.canvas.getBoundingClientRect();
			const w = v => mesh.mesh.localToWorld(new THREE.Vector3().fromArray(mesh.vertices[v]));
			const c = new THREE.Vector3();
			face.vertices.forEach(v => c.add(w(v)));
			c.divideScalar(face.vertices.length);
			// choose the point farthest (on screen) from the gizmo centre
			const g = new THREE.Vector3();
			Transformer.getWorldPosition(g);
			g.project(p.camera);
			const gx = r.left + (g.x + 1) / 2 * r.width, gy = r.top + (1 - g.y) / 2 * r.height;
			let best = null, bd = -1;
			for (const t of [0.55, 0.7]) for (const v of face.vertices) {
				const q = c.clone().lerp(w(v), t).project(p.camera);
				const x = r.left + (q.x + 1) / 2 * r.width, y = r.top + (1 - q.y) / 2 * r.height;
				const hit = p.raycast({ clientX: x, clientY: y, target: p.canvas });
				const under = document.elementFromPoint(x, y);
				if (!hit || hit.face !== fkey || !under || under.closest('#bbt_meshbar, #bbt_toolbar, #amend_edit_menu')) continue;
				const d = Math.min(Math.abs(x - gx), 400) + Math.min(Math.abs(y - gy), 400) * 0.5;
				if (d > bd) { bd = d; best = { x, y }; }
			}
			const fallback = best;
			return fallback;
		}, fkey);

		await page.goto(`http://localhost:${port}/`, { waitUntil: 'load' });
		await page.waitForFunction(() => window.BBTouch && BBTouch.ready && BBTouch.generic && BBTouch.meshTools && BBTouch.quickExport && BBTouch.files, null, { timeout: 30000 });
		await sleep(1600);

		// ---- 1. start screen quick start --------------------------------------------------------
		const card = await rect('#bbt_generic_start');
		check('start screen: "New Generic Model" card on top and visible', card && card.top >= 0 && card.top < 300 && card.h > 100, card);
		check('File menu + floating toolbar entries', await ev(() => MenuBar.menus.file.structure.includes(BarItems.bbtouch_new_generic)
			&& MenuBar.menus.file.structure.includes(BarItems.bbtouch_quick_export) && !!document.querySelector('#bbt_toolbar [data-id="new_generic"]')));
		await shot('start');
		await tapSel('#bbt_generic_start .bbt_start_more');
		check('Options… opens New Generic Model dialog', await waitDialog('bbtouch_new_generic'));
		await shot('new-dialog');
		await tapSel('.bbt_size_btn[data-size="128"]');
		await tapSel('.bbt_preset_tile[data-preset="blank"]');
		await sleep(400);
		const proj = await ev(() => ({ format: Format.id, tw: Project.texture_width, th: Project.texture_height, box_uv: Project.box_uv, mode: Modes.selected.id, els: Outliner.elements.length, bar: BBTouch.meshTools.visible }));
		check('blank Generic Model created (128px, box UV off, Edit mode, Mesh Tools bar)', proj.format === 'free' && proj.tw === 128 && proj.th === 128 && proj.box_uv === false && proj.mode === 'edit' && proj.els === 0 && proj.bar, proj);
		check('texture size remembered', await ev(() => JSON.parse(localStorage.getItem('bbtouch.generic_new')).texture_size === 128));

		// ---- 2. modeling --------------------------------------------------------------------------
		await ev(() => BBTouch.meshTools.setCategory('add'));
		await sleep(100);
		await tapBar('prim_cuboid');
		await sleep(300);
		const added = await ev(() => ({ meshes: Mesh.all.length, faces: Mesh.all[0] && Object.keys(Mesh.all[0].faces).length, selected: Mesh.selected.length }));
		check('Mesh Tools › Add › Cube adds a selected mesh cube', added.meshes === 1 && added.faces === 6 && added.selected === 1, added);
		await ev(() => { Undo.closeAmendEditMenu && Undo.closeAmendEditMenu(); BBTouch.gestures.frameAll(); });
		await sleep(500);
		await shot('mesh-tools');

		await tapSel('#bbt_meshbar [data-sel="face"]');
		check('Face select mode via big toggle', await ev(() => BarItems.selection_mode.value === 'face'));
		// tap the top face: find the face with the highest centre
		const top = await ev(() => {
			const m = Mesh.all[0];
			let best = null, by = -1e9;
			for (const k in m.faces) { const y = m.faces[k].vertices.reduce((s, v) => s + m.vertices[v][1], 0) / m.faces[k].vertices.length; if (y > by) { by = y; best = k; } }
			return best;
		});
		const tp = await faceScreen(top);
		const pre = await ev(() => ({ taps: BBTouch.gestures.stats.taps, sel: Mesh.all[0].getSelectedFaces().length }));
		await tap(tp.x, tp.y);
		const sel1 = await ev(() => Mesh.all[0].getSelectedFaces());
		check('tap selects the top face', sel1.length === 1 && sel1[0] === top, { sel1, top, tp, pre, post: await ev(() => BBTouch.gestures.stats.taps) });

		// sticky Shift + tap another face = multi-select
		const side = await ev(top => Object.keys(Mesh.all[0].faces).find(k => {
			if (k === top) return false;
			const f = Mesh.all[0].faces[k]; const n = f.getNormal(true);
			const cam = Preview.selected.camera.getWorldDirection(new THREE.Vector3());
			return n[0] * cam.x + n[1] * cam.y + n[2] * cam.z < -0.3;
		}), top);
		await tapSel('#bbt_toolbar [data-id="shift"]');
		const sp = await faceScreen(side);
		await tap(sp.x, sp.y);
		const sel2 = await ev(() => Mesh.all[0].getSelectedFaces().slice());
		check('sticky Shift + tap adds a second face', sel2.length === 2, sel2);
		// back to only the top face
		await tap(tp.x, tp.y);
		await ev(() => BBTouch.meshTools.setCategory('mesh'));
		await sleep(100);
		const before = await ev(() => ({ v: Object.keys(Mesh.all[0].vertices).length, f: Object.keys(Mesh.all[0].faces).length, y: Math.max(...Object.values(Mesh.all[0].vertices).map(v => v[1])) }));
		await tapBar('extrude_mesh_selection');
		await sleep(250);
		const after = await ev(() => ({ v: Object.keys(Mesh.all[0].vertices).length, f: Object.keys(Mesh.all[0].faces).length, y: Math.max(...Object.values(Mesh.all[0].vertices).map(v => v[1])), sel: Mesh.all[0].getSelectedFaces().length, amend: !!document.getElementById('amend_edit_menu') }));
		check('Extrude button extrudes the selected face (+4 vertices, +4 faces, higher)', after.v === before.v + 4 && after.f === before.f + 4 && after.y > before.y, { before, after });
		const amend = await rect('#amend_edit_menu');
		const bar = await rect('#bbt_meshbar');
		check('upstream amend panel (extrude distance) sits above the Mesh Tools bar', !amend || amend.top + amend.h <= bar.top + 2, { amend, bar });
		await shot('extrude');
		await ev(() => Undo.closeAmendEditMenu && Undo.closeAmendEditMenu());

		const fc0 = await ev(() => Object.keys(Mesh.all[0].faces).length);
		await tapBar('bbtouch_subdivide');
		await sleep(200);
		const sub = await ev(() => {
			const m = Mesh.all[0];
			const sel = m.getSelectedFaces();
			// every edge of the mesh must be shared by exactly 2 faces (closed, no T-junction holes)
			const count = {};
			for (const k in m.faces) {
				const sv = m.faces[k].getSortedVertices();
				sv.forEach((v, i) => { const w = sv[(i + 1) % sv.length]; const e = v < w ? v + w : w + v; count[e] = (count[e] || 0) + 1; });
			}
			const bad = Object.values(count).filter(c => c !== 2).length;
			return { faces: Object.keys(m.faces).length, sel: sel.length, bad, undo: Undo.history[Undo.history.length - 1].action };
		});
		check('Subdivide splits the selected face into 4, mesh stays closed', sub.sel === 4 && sub.bad === 0 && sub.undo === 'Subdivide', Object.assign({ fc0 }, sub));
		await shot('subdivide');

		// precise numeric move of the selection
		const y0 = await ev(() => Math.max(...Object.values(Mesh.all[0].vertices).map(v => v[1])));
		await ev(() => BBTouch.meshTools.moveBy([0, 2, 0]));
		const y1 = await ev(() => Math.max(...Object.values(Mesh.all[0].vertices).map(v => v[1])));
		check('Move by… moves selected faces numerically', Math.abs(y1 - y0 - 2) < 1e-6, { y0, y1 });

		// box select by drag (vertex mode)
		await tapSel('#bbt_meshbar [data-sel="vertex"]');
		await tapSel('#bbt_meshbar [data-ctl="drag"]');
		check('Drag mode toggled to box select', await ev(() => BBTouch.meshTools.drag_select && document.querySelector('#bbt_meshbar [data-ctl="drag"]').classList.contains('active')));
		const cv = await rect('.preview canvas');
		const orbitsBefore = await ev(() => BBTouch.gestures.stats.orbit);
		await drag([cv.left + 100, cv.top + 30], [cv.left + cv.w - 8, cv.top + cv.h - 150], 14);
		const box = await ev(() => ({ n: Mesh.all[0].getSelectedVertices().length, total: Object.keys(Mesh.all[0].vertices).length, orbit: BBTouch.gestures.stats.orbit, boxes: BBTouch.meshTools.stats.box_selects }));
		check('1-finger drag box-selects vertices (no orbit)', box.n > 4 && box.orbit === orbitsBefore && box.boxes === 1, box);
		await tapSel('#bbt_meshbar [data-ctl="drag"]');
		await drag([cv.x + 30, cv.top + 50], [cv.x + 130, cv.top + 60], 8);
		check('drag = orbit again after toggling back', await ev(o => BBTouch.gestures.stats.orbit > o, orbitsBefore));
		await tapSel('#bbt_meshbar [data-sel="object"]');

		// ---- 3. texture + UV -----------------------------------------------------------------------
		await ev(() => BBTouch.meshTools.setCategory('uv'));
		await sleep(100);
		await tapBar('create_texture');
		check('New Texture opens upstream Create Texture dialog', await waitDialog('add_bitmap'));
		await ev(() => { Dialog.open.setFormValues({ name: 'skin', type: 'template', rearrange_uv: true }); });
		await sleep(80);
		await shot('texture-dialog');
		await ev(() => Dialog.open.confirm());
		await page.waitForFunction(() => Texture.all.length === 1, null, { timeout: 8000 }).catch(() => {});
		await sleep(300);
		const tex = await ev(() => ({ n: Texture.all.length, w: Texture.all[0] && Texture.all[0].width, applied: Object.values(Mesh.all[0].faces).every(f => f.texture === Texture.all[0].uuid) }));
		check('template texture created and applied to the mesh', tex.n === 1 && tex.w > 0 && tex.applied, tex);
		await tapBar('bbtouch_uv_editor');
		await sleep(250);
		check('UV editor visible', await ev(() => BBTouch.generic.uvVisible()));
		const uvr = await rect('#uv_frame');
		const zoom0 = await ev(() => UVEditor.zoom);
		await pinch([uvr.x, uvr.y], 80, 200);
		const zoom1 = await ev(() => UVEditor.zoom);
		check('UV editor: 2-finger pinch zooms', zoom1 > zoom0 * 1.3, { zoom0, zoom1 });
		// 1-finger drag on a selected face's UV moves it
		await ev(() => { Mesh.all[0].select(); BarItems.selection_mode.change('face'); const m = Mesh.all[0]; const k = Object.keys(m.faces)[0]; m.getSelectedFaces(true).splice(0, 99, k); UVEditor.vue.selected_faces = [k]; UVEditor.setZoom(1); UVEditor.loadData(); updateSelection(); const vp = document.getElementById('uv_viewport'); if (vp) { vp.scrollLeft = 0; vp.scrollTop = 0; } });
		await sleep(200);
		const uvFace = await ev(() => { const el = document.querySelector('#uv_frame .mesh_uv_face.selected'); if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width }; });
		const uv0 = await ev(() => { const m = Mesh.all[0]; const k = m.getSelectedFaces()[0]; return JSON.stringify(m.faces[k].uv); });
		if (uvFace) await drag([uvFace.x, uvFace.y], [uvFace.x + 30, uvFace.y + 20], 8);
		const uv1 = await ev(() => { const m = Mesh.all[0]; const k = m.getSelectedFaces()[0]; return JSON.stringify(m.faces[k].uv); });
		check('UV editor: 1-finger drag moves the face UV', uvFace && uv0 !== uv1, { uvFace, changed: uv0 !== uv1 });
		await shot('uv');
		await ev(() => BarItems.selection_mode.change('object'));

		// ---- 4. animation --------------------------------------------------------------------------
		await ev(() => { Mesh.all[0].select(); BBTouch.meshTools.setCategory('add'); });
		await tapBar('group_elements');
		await ev(() => { if (Dialog.open) Dialog.open.confirm(); });
		await sleep(150);
		check('group (bone) created around the mesh', await ev(() => Group.all.length === 1 && Mesh.all[0].parent === Group.all[0]));
		const tab = await rect('#mode_selector li:nth-child(3), #mode_selector [mode_id="animate"]');
		const animTab = await ev(() => { const li = [...document.querySelectorAll('#mode_selector li')].find(l => /animate/i.test(l.textContent)); const r = li.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2, h: r.height }; });
		check('Animate tab is a big target (≥34 px)', animTab.h >= 34, animTab);
		await tap(animTab.x, animTab.y);
		await sleep(400);
		check('Animate mode via tab tap; bar switches to animate controls', await ev(() => Modes.animate && document.getElementById('bbt_meshbar').classList.contains('animate')));
		await tapBar('add_animation');
		check('add animation dialog', await waitDialog('add_animation') || await ev(() => Animation.all.length > 0));
		await ev(() => { if (Dialog.open) Dialog.open.confirm(); });
		await sleep(300);
		check('animation created + selected', await ev(() => Animation.all.length === 1 && !!Animation.selected));
		await ev(() => { Group.all[0].select(); });
		await sleep(100);
		await tapBar('add_keyframe');
		await sleep(150);
		const kf0 = await ev(() => { const a = Animation.selected.getBoneAnimator(Group.all[0]); return a.keyframes.length; });
		check('Keyframe button keys the selected bone', kf0 >= 1, kf0);
		// move the playhead by dragging the time ruler, then key a rotation there
		const ruler = await rect('#timeline_time');
		await drag([ruler.left + (await ev(() => Timeline.vue._data.head_width)) + 5, ruler.y], [ruler.left + (await ev(() => Timeline.vue._data.head_width)) + 5 + (await ev(() => Timeline.vue._data.size)), ruler.y], 10);
		const t1 = await ev(() => Timeline.time);
		check('timeline: 1-finger drag on the ruler scrubs the playhead', t1 > 0.5, { t1 });
		await ev(() => {
			const a = Animation.selected.getBoneAnimator(Group.all[0]);
			a.addKeyframe({ channel: 'rotation', time: Timeline.time, data_points: [{ x: 0, y: 90, z: 0 }] });
			Animation.selected.setLength(Math.max(Animation.selected.length, Timeline.time));
		});
		const kf = await ev(() => { const a = Animation.selected.getBoneAnimator(Group.all[0]); return { rot: a.rotation.length, total: a.keyframes.length }; });
		check('second (rotation) key at the scrubbed playhead', kf.total > kf0 && kf.rot >= 1, kf);
		const tbody = await rect('#timeline_body');
		const size0 = await ev(() => Timeline.vue._data.size);
		await pinch([tbody.x, tbody.y], 60, 180);
		const size1 = await ev(() => Timeline.vue._data.size);
		check('timeline: 2-finger pinch zooms the time axis', size1 > size0 * 1.5, { size0, size1 });
		await tapBar('jump_to_timeline_start');
		check('Start button jumps the playhead to 0', await ev(() => Timeline.time === 0));
		await tapBar('bbtouch_play');
		await sleep(400);
		const playing = await ev(() => ({ playing: Timeline.playing, label: document.querySelector('#bbt_meshbar [data-bid="bbtouch_play"] .bbt_mb_label').textContent }));
		check('Play button plays (label → Pause)', playing.playing && playing.label === 'Pause', playing);
		await shot('animate');
		await tapBar('bbtouch_play');
		await sleep(100);
		check('Play button pauses', await ev(() => !Timeline.playing));
		await tapBar('timeline_graph_editor');
		await sleep(250);
		check('graph editor opens from the bar', await ev(() => Timeline.vue.graph_editor_open));
		await shot('graph');
		await tapBar('timeline_graph_editor');

		// ---- 5. Quick Export -------------------------------------------------------------------------
		await tapBar('bbtouch_quick_export');
		check('Quick Export dialog opens', await waitDialog('bbtouch_quick_export'));
		// select all four engine formats by tap (glb is preselected)
		for (const f of ['gltf', 'obj', 'fbx']) await tapSel(`.bbt_fmt_tile[data-fmt="${f}"]`);
		check('format tiles toggle', await ev(() => [...document.querySelectorAll('.bbt_fmt_tile.active')].map(b => b.dataset.fmt).sort().join() === 'fbx,glb,gltf,obj'));
		await shot('quick-export');
		await ev(() => Dialog.open.confirm());
		const done = await page.waitForFunction(() => Dialog.open && Dialog.open.title === 'Quick Export' && !document.querySelector('.bbt_fmt_grid'), null, { timeout: 30000 }).then(() => sleep(60)).then(() => true, () => false);
		check('one summary dialog after the batch', done);
		await shot('export-done');
		const out = await ev(() => {
			const files = Object.keys(__mock.files);
			const text = p => __mock.text(p);
			const glb = files.find(p => /^Exports\/.*\.glb$/.test(p));
			const gltf = files.find(p => /^Exports\/.*\.gltf$/.test(p));
			const obj = files.find(p => /^Exports\/.*\.obj$/.test(p));
			const mtl = files.find(p => /^Exports\/.*\.mtl$/.test(p));
			const fbx = files.find(p => /^Exports\/.*\.fbx$/.test(p));
			const pngs = files.filter(p => /^Exports\/.*\.png$/.test(p));
			let gl = null;
			try { gl = JSON.parse(text(gltf)); } catch (e) { /* */ }
			const glbBytes = glb && __mock.bytes(glb);
			const objText = obj && text(obj) || '';
			const fbxText = fbx && text(fbx) || '';
			return {
				files: files.filter(p => p.startsWith('Exports/')),
				glbMagic: glbBytes && String.fromCharCode(...glbBytes.slice(0, 4)),
				gltf: gl && { meshes: (gl.meshes || []).length, animations: (gl.animations || []).length, images: (gl.images || []).length, embedded: !!(gl.images && gl.images[0] && /^data:/.test(gl.images[0].uri || '')) },
				obj: { v: (objText.match(/^v /mg) || []).length, f: (objText.match(/^f /mg) || []).length, vt: (objText.match(/^vt /mg) || []).length, mtllib: /mtllib/.test(objText) },
				mtl: !!mtl && /newmtl/.test(text(mtl)),
				fbx: { header: /FBXHeaderExtension/.test(fbxText), geometry: /Geometry:/.test(fbxText), anim: /AnimationStack/.test(fbxText) },
				pngs: pngs.length,
				last: BBTouch.quickExport.last.map(o => ({ f: o.format, ok: !!(o.result && o.result.paths) })),
			};
		});
		console.log('      exports:', out.files.join(', '));
		check('GLB written with binary magic "glTF"', out.glbMagic === 'glTF', out.glbMagic);
		check('glTF JSON has meshes + animations + embedded texture', out.gltf && out.gltf.meshes >= 1 && out.gltf.animations >= 1 && out.gltf.embedded, out.gltf);
		check('OBJ has v/vt/f lines + mtllib, MTL + PNG next to it', out.obj.v >= 8 && out.obj.f >= 6 && out.obj.vt > 0 && out.obj.mtllib && out.mtl && out.pngs >= 1, out.obj);
		check('FBX (ASCII) has header, geometry and animation stack', out.fbx.header && out.fbx.geometry && out.fbx.anim, out.fbx);
		check('all 4 formats reported OK', out.last.length === 4 && out.last.every(o => o.ok), out.last);
		check('export options remembered', await ev(() => JSON.parse(localStorage.getItem('bbtouch.quick_export')).formats.length === 4));
		// Share from the summary
		await ev(() => { const d = Dialog.open; const i = d.buttons ? d.buttons.indexOf('Share') : 0; d.close(i); });
		await sleep(200);
		check('Share from the summary shares all exported files', await ev(() => __mock.shares.length >= 1 && (__mock.shares[__mock.shares.length - 1].files || []).length >= 5));

		// ---- 6. .bbmodel save + reload ----------------------------------------------------------------
		await ev(() => BBTouch.quickExport.run(['bbmodel']));
		await sleep(400);
		const saved = await ev(() => Object.keys(__mock.files).find(p => /^Projects\/.*\.bbmodel$/.test(p)));
		check('.bbmodel saved to Projects/', !!saved, saved);
		const reload = await ev(async (p) => {
			const meshes0 = Mesh.all.length;
			const faces0 = Object.keys(Mesh.all[0].faces).length;
			await BBTouch.files.openDocument(p);
			await new Promise(r => setTimeout(r, 600));
			return { projects: ModelProject.all.length, format: Format.id, meshes: Mesh.all.length, faces: Object.keys(Mesh.all[0].faces).length, faces0, meshes0, anims: Animation.all.length, textures: Texture.all.length, groups: Group.all.length };
		}, saved);
		check('.bbmodel reopens with mesh, texture, bone and animation', reload.format === 'free' && reload.meshes === reload.meshes0 && reload.faces === reload.faces0 && reload.anims === 1 && reload.textures === 1 && reload.groups === 1, reload);

		// ---- 7. preset + iPhone-ish sanity -----------------------------------------------------------
		await ev(() => BBTouch.generic.newModel('humanoid'));
		await sleep(400);
		const hum = await ev(() => ({ meshes: Mesh.all.length, groups: Group.all.length, minY: Math.min(...Mesh.all.map(m => Math.min(...Object.keys(m.vertices).map(k => m.mesh.localToWorld(new THREE.Vector3().fromArray(m.vertices[k])).y)))) }));
		check('Humanoid preset: 6 meshes in 6 bones, feet on the ground', hum.meshes === 6 && hum.groups === 6 && Math.abs(hum.minY) < 0.01, hum);
		await shot('humanoid');

		// (upstream TransformControls' passive touchmove hover calls preventDefault when a finger slides over the gizmo: benign)
		const bad = errors.filter(e => !/service_worker|blckbn\.ch|ERR_FAILED|favicon|404|CORS|net::|preventDefault inside passive/i.test(e));
		check('no console errors', bad.length === 0, bad.slice(0, 5));
	} catch (err) {
		console.error(err);
		failed = true;
	} finally {
		await browser.close();
		server.kill();
	}
	const nFail = results.filter(r => !r.ok).length;
	console.log(`\n${results.length - nFail}/${results.length} checks passed`);
	process.exit(failed || nFail ? 1 : 0);
})();
