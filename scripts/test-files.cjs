#!/usr/bin/env node
// M4 test: iOS Files integration (touch/files.js) with a mocked window.Capacitor
// (in-memory Filesystem, Share and App plugins). Headless Chromium, emulated iPad.
// Usage: node scripts/test-files.cjs [--screenshot docs/screenshots/m4.png]
const { chromium } = require('playwright');
const path = require('path');
const { spawn } = require('child_process');

const root = path.resolve(__dirname, '..');
const port = 8965 + Math.floor(Math.random() * 100);
const shotArg = process.argv.indexOf('--screenshot');
const shot = shotArg > -1 ? path.resolve(root, process.argv[shotArg + 1]) : null;

const results = [];
function check(name, ok, info) {
	results.push({ name, ok: !!ok });
	console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${info !== undefined ? '  ' + JSON.stringify(info) : ''}`);
}

// Runs in the page before any script. Mimics @capacitor/filesystem semantics:
// data without `encoding` is base64, with encoding 'utf8' it is text.
function installMock() {
	const files = {};   // path → base64
	const dirs = new Set(['']);
	const mtimes = {};
	const enc = new TextEncoder(), dec = new TextDecoder();
	const b64 = bytes => { let s = ''; for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000)); return btoa(s); };
	const unb64 = s => { const bin = atob(s), u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); return u; };
	const norm = p => String(p || '').replace(/^\/+|\/+$/g, '').replace(/\/+/g, '/');
	const parent = p => p.split('/').slice(0, -1).join('/');
	const calls = [];
	const DOC_URI = 'file:///private/var/mobile/Containers/Data/Application/MOCK/Documents';
	function need(o) { if (o.directory !== 'DOCUMENTS') throw new Error('unexpected directory ' + o.directory); }
	function addDirs(p) { while (p) { dirs.add(p); p = parent(p); } }
	const Filesystem = {
		async writeFile(o) {
			need(o); const p = norm(o.path);
			if (!o.recursive && !dirs.has(parent(p))) throw new Error('Parent directory missing');
			files[p] = o.encoding === 'utf8' ? b64(enc.encode(o.data)) : o.data;
			mtimes[p] = Date.now();
			addDirs(parent(p));
			calls.push({ op: 'writeFile', path: p, encoding: o.encoding || null, length: o.data.length });
			return { uri: DOC_URI + '/' + p };
		},
		async readFile(o) {
			need(o); const p = norm(o.path);
			if (!(p in files)) throw new Error('File does not exist');
			calls.push({ op: 'readFile', path: p, encoding: o.encoding || null });
			return { data: o.encoding === 'utf8' ? dec.decode(unb64(files[p])) : files[p] };
		},
		async readdir(o) {
			need(o); const p = norm(o.path);
			if (!dirs.has(p)) throw new Error('Folder does not exist');
			const out = [];
			const pre = p ? p + '/' : '';
			for (const d of dirs) if (d && parent(d) === p) out.push({ name: d.substring(pre.length), type: 'directory', size: 0, mtime: 0, uri: DOC_URI + '/' + d });
			for (const f in files) if (parent(f) === p) out.push({ name: f.substring(pre.length), type: 'file', size: unb64(files[f]).length, mtime: mtimes[f], uri: DOC_URI + '/' + f });
			calls.push({ op: 'readdir', path: p });
			return { files: out };
		},
		async stat(o) {
			need(o); const p = norm(o.path);
			if (p in files) return { type: 'file', size: unb64(files[p]).length, mtime: mtimes[p], uri: DOC_URI + '/' + p };
			if (dirs.has(p)) return { type: 'directory', size: 0, mtime: 0, uri: DOC_URI + '/' + p };
			throw new Error('Entry does not exist');
		},
		async mkdir(o) { need(o); const p = norm(o.path); if (dirs.has(p)) throw new Error('Directory exists'); addDirs(p); calls.push({ op: 'mkdir', path: p }); },
		async deleteFile(o) { need(o); const p = norm(o.path); if (!(p in files)) throw new Error('File does not exist'); delete files[p]; calls.push({ op: 'deleteFile', path: p }); },
		async rmdir(o) {
			need(o); const p = norm(o.path);
			for (const f of Object.keys(files)) if (f.startsWith(p + '/')) delete files[f];
			for (const d of [...dirs]) if (d === p || d.startsWith(p + '/')) dirs.delete(d);
			calls.push({ op: 'rmdir', path: p });
		},
		async rename(o) {
			need(o); const a = norm(o.from), b = norm(o.to);
			if (a in files) { files[b] = files[a]; mtimes[b] = Date.now(); delete files[a]; }
			else if (dirs.has(a)) {
				for (const f of Object.keys(files)) if (f.startsWith(a + '/')) { files[b + f.substring(a.length)] = files[f]; delete files[f]; }
				for (const d of [...dirs]) if (d === a || d.startsWith(a + '/')) { dirs.delete(d); dirs.add(b + d.substring(a.length)); }
			} else throw new Error('Source does not exist');
			addDirs(parent(b));
			calls.push({ op: 'rename', from: a, to: b });
		},
		async getUri(o) { need(o); return { uri: DOC_URI + (norm(o.path) ? '/' + norm(o.path) : '') }; },
	};
	const shares = [];
	const Share = { async share(o) { shares.push(o); return { activityType: 'mock' }; } };
	const appListeners = {};
	const App = {
		addListener(ev, fn) { (appListeners[ev] = appListeners[ev] || []).push(fn); return Promise.resolve({ remove() {} }); },
		async getLaunchUrl() { return undefined; },
	};
	window.__mock = {
		files, dirs: () => [...dirs], calls, shares, DOC_URI,
		text: p => (p in files ? dec.decode(unb64(files[p])) : null),
		bytes: p => (p in files ? Array.from(unb64(files[p]).subarray(0, 16)) : null),
		put: (p, text) => { files[norm(p)] = b64(enc.encode(text)); mtimes[norm(p)] = Date.now(); addDirs(parent(norm(p))); },
		fire: (ev, data) => (appListeners[ev] || []).forEach(fn => fn(data)),
	};
	window.Capacitor = { isNativePlatform: () => true, getPlatform: () => 'ios', Plugins: { Filesystem, Share, App } };
}

(async () => {
	const server = spawn(process.execPath, [path.join(root, 'scripts/serve.mjs'), String(port)], { stdio: 'ignore' });
	await new Promise(r => setTimeout(r, 500));
	const browser = await chromium.launch();
	let failed = false;
	try {
		const context = await browser.newContext({
			viewport: { width: 1180, height: 820 }, deviceScaleFactor: 1, hasTouch: true, isMobile: true, acceptDownloads: true,
		});
		const page = await context.newPage();
		const errors = [];
		page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
		page.on('pageerror', e => { errors.push('pageerror: ' + e.message); if (process.env.DEBUG_ERRORS) console.log(e.stack); });
		await page.addInitScript(installMock);
		// The real Capacitor core would replace isNativePlatform() with "web"; keep the mock.
		await page.route('**/touch/vendor/capacitor.js', r => r.fulfill({ contentType: 'text/javascript', body: '/* mocked */' }));
		const sleep = ms => page.waitForTimeout(ms);
		const ev = (fn, arg) => page.evaluate(fn, arg);
		// (short pause after a dialog appears: upstream measures it in a 1 ms timeout after show())
		const waitDialog = (pred, timeout = 8000) => page.waitForFunction(pred, null, { timeout }).then(() => sleep(30)).then(() => true, () => false);
		const savedOpen = () => waitDialog(() => Dialog.open && /saved|Exported/i.test(Dialog.open.title || ''));
		const closeDialog = (i) => ev(i => { const d = Dialog.open; if (d) d.close(i ?? d.cancelIndex); }, i);

		await page.goto(`http://localhost:${port}/`, { waitUntil: 'load' });
		await page.waitForFunction(() => window.BBTouch && BBTouch.ready && BBTouch.files && window.Formats && Formats.free, null, { timeout: 30000 });
		await sleep(800);

		const boot = await ev(() => ({
			active: BBTouch.files.isActive(),
			cls: document.documentElement.classList.contains('bb-touch-native'),
			dirs: __mock.dirs(),
			menu: !!BarItems.bbtouch_browse_documents && MenuBar.menus.file.structure.includes(BarItems.bbtouch_browse_documents),
			start: !!document.querySelector('#start_screen [section_id="bbtouch_documents"], #start_screen .bbtouch_documents, #start_screen [id*="bbtouch_documents"]') || [...document.querySelectorAll('#start_screen h3')].some(h => h.textContent == 'Your files'),
		}));
		check('native mode active with mocked Capacitor', boot.active && boot.cls, boot);
		check('Projects/Exports/Textures folders created', ['Projects', 'Exports', 'Textures'].every(d => boot.dirs.includes(d)), boot.dirs);
		check('File menu has "Browse Documents"', boot.menu);
		check('start screen has "Your files" section', boot.start);

		// --- Generic Model project with a textured cube ----------------------
		await ev(() => {
			Formats.free.new();
			if (Dialog.open) Dialog.open.confirm();
			Project.name = 'testmodel';
			const c = document.createElement('canvas'); c.width = c.height = 16;
			const ctx = c.getContext('2d'); ctx.fillStyle = '#e04040'; ctx.fillRect(0, 0, 16, 16); ctx.fillStyle = '#40e040'; ctx.fillRect(0, 0, 8, 8);
			const tex = new Texture({ name: 'skin' }).fromDataURL(c.toDataURL()).add(false);
			const cube = new Cube({ name: 'cube_a', from: [-4, 0, -4], to: [4, 8, 4] }).init();
			cube.applyTexture(tex, true);
			Canvas.updateAll();
		});
		await sleep(400);

		// --- Save .bbmodel (Ctrl+S) -------------------------------------------
		await ev(() => BarItems.export_over.trigger());
		check('first save shows "Saved" dialog', await savedOpen());
		let r = await ev(() => {
			const t = __mock.text('Projects/testmodel.bbmodel');
			let j = null; try { j = JSON.parse(t); } catch (e) { /* */ }
			return {
				doc: Project.bbtouch_doc_path, saved: Project.saved, meta: j && j.meta, elements: j && j.elements.length,
				tex: j && j.textures && j.textures.length, enc: (__mock.calls.find(c => c.op == 'writeFile' && c.path == 'Projects/testmodel.bbmodel') || {}).encoding,
				msg: Dialog.open && Dialog.open.object && Dialog.open.object.textContent,
				textureDownloads: Object.keys(__mock.files).filter(f => f.startsWith('Textures/')),
			};
		});
		check('.bbmodel written to Projects/testmodel.bbmodel (utf8)', r.doc == 'Projects/testmodel.bbmodel' && r.meta && r.meta.model_format == 'free' && r.elements == 1 && r.tex == 1 && r.enc == 'utf8', r);
		check('dialog names "Blockbench Touch/Projects/testmodel.bbmodel"', /Blockbench Touch\/Projects\/testmodel\.bbmodel/.test(r.msg || ''), r.msg);
		check('project save does not also export textures', r.textureDownloads.length == 0 && r.saved, r.textureDownloads);
		// Share button
		await closeDialog(0);
		await sleep(200);
		r = await ev(() => __mock.shares.slice(-1)[0]);
		check('Share button opens share sheet with file URL', r && r.files && r.files[0] == 'file:///private/var/mobile/Containers/Data/Application/MOCK/Documents/Projects/testmodel.bbmodel', r);

		// --- Save again in place -------------------------------------------------
		await ev(() => { new Cube({ name: 'cube_b', from: [10, 0, -4], to: [18, 8, 4] }).init(); Canvas.updateAll(); Project.saved = false; });
		const nWrites = await ev(() => __mock.calls.filter(c => c.op == 'writeFile').length);
		await ev(() => BarItems.export_over.trigger());
		await sleep(600);
		r = await ev(() => ({
			dialog: !!Dialog.open, files: Object.keys(__mock.files).filter(f => f.startsWith('Projects/')),
			elements: JSON.parse(__mock.text('Projects/testmodel.bbmodel')).elements.length, saved: Project.saved,
		}));
		const nWrites2 = await ev(() => __mock.calls.filter(c => c.op == 'writeFile').length);
		check('Ctrl+S again overwrites in place without dialog', !r.dialog && r.files.length == 1 && r.elements == 2 && r.saved && nWrites2 == nWrites + 1, r);

		// --- Save As ---------------------------------------------------------------
		await ev(() => BarItems.save_project_as.trigger());
		const prompt = await waitDialog(() => Dialog.open && Dialog.open.id == 'text_input');
		check('Save As asks for a name', prompt);
		await ev(() => { Dialog.open.setFormValues({ text: 'other model' }); Dialog.open.confirm(); });
		check('Save As shows "Saved" dialog', await savedOpen());
		await closeDialog();
		r = await ev(() => ({ doc: Project.bbtouch_doc_path, name: Project.name, ok: !!__mock.text('Projects/other model.bbmodel') }));
		check('Save As writes Projects/other model.bbmodel and remembers it', r.ok && r.doc == 'Projects/other model.bbmodel' && r.name == 'other model', r);
		await ev(() => { Project.name = 'testmodel'; });

		// --- glTF (ascii, embedded textures) -----------------------------------------
		await ev(() => { Codecs.gltf.export(); });
		await waitDialog(() => Dialog.open && Dialog.open.id == 'export_options');
		await ev(() => { Dialog.open.setFormValues({ encoding: 'ascii', embed_textures: true }); Dialog.open.confirm(); });
		check('glTF export shows "Exported" dialog', await savedOpen());
		await closeDialog();
		r = await ev(() => {
			const t = __mock.text('Exports/testmodel.gltf'); let j = null; try { j = JSON.parse(t); } catch (e) { /* */ }
			return { ok: !!j, meshes: j && j.meshes && j.meshes.length, img: j && j.images && j.images[0] && j.images[0].uri.substring(0, 22), version: j && j.asset && j.asset.version };
		});
		check('glTF written to Exports/testmodel.gltf (valid JSON, 2 meshes, embedded PNG)', r.ok && r.meshes == 2 && r.img == 'data:image/png;base64,' && r.version == '2.0', r);

		// --- glTF with external textures → folder ------------------------------------
		await ev(() => { Codecs.gltf.export(); });
		await waitDialog(() => Dialog.open && Dialog.open.id == 'export_options');
		await ev(() => { Dialog.open.setFormValues({ encoding: 'ascii', embed_textures: false }); Dialog.open.confirm(); });
		await savedOpen(); await closeDialog();
		r = await ev(() => ({ files: Object.keys(__mock.files).filter(f => f.startsWith('Exports/testmodel_gltf/')).sort(), png: __mock.bytes('Exports/testmodel_gltf/skin.png') }));
		check('glTF with external textures → Exports/testmodel_gltf/{testmodel.gltf, skin.png}',
			r.files.join() == 'Exports/testmodel_gltf/skin.png,Exports/testmodel_gltf/testmodel.gltf' && r.png && r.png[1] == 0x50 && r.png[2] == 0x4E, r);

		// --- GLB (binary) ---------------------------------------------------------------
		await ev(() => { Codecs.gltf.export(); });
		await waitDialog(() => Dialog.open && Dialog.open.id == 'export_options');
		await ev(() => { Dialog.open.setFormValues({ encoding: 'binary', embed_textures: true }); Dialog.open.confirm(); });
		check('GLB export shows "Exported" dialog', await savedOpen());
		await closeDialog();
		r = await ev(() => ({ head: __mock.bytes('Exports/testmodel.glb'), call: __mock.calls.find(c => c.op == 'writeFile' && c.path == 'Exports/testmodel.glb') }));
		check('GLB written as base64 binary with glTF magic', r.head && String.fromCharCode(...r.head.slice(0, 4)) == 'glTF' && r.head[4] == 2 && r.call && r.call.encoding == null, r);

		// --- OBJ (+MTL +PNG) → folder ----------------------------------------------------
		await ev(() => { Codecs.obj.export(); });
		check('OBJ export shows dialog', await savedOpen());
		r = await ev(() => ({ msg: Dialog.open && Dialog.open.object.textContent, buttons: Dialog.open && Dialog.open.buttons }));
		check('multi-file dialog lists folder + offers "Share .zip"', /Exports\/testmodel_obj\//.test(r.msg) && r.buttons.includes('Share .zip'), r);
		await closeDialog(0); // Share all files
		await sleep(200);
		r = await ev(() => ({
			files: Object.keys(__mock.files).filter(f => f.startsWith('Exports/testmodel_obj/')).sort(),
			obj: (__mock.text('Exports/testmodel_obj/testmodel.obj') || '').split('\n').filter(l => l.startsWith('v ')).length,
			mtl: /map_Kd/.test(__mock.text('Exports/testmodel_obj/materials.mtl') || ''),
			share: __mock.shares.slice(-1)[0],
		}));
		check('OBJ → Exports/testmodel_obj/{testmodel.obj, materials.mtl, skin.png}',
			r.files.join() == 'Exports/testmodel_obj/materials.mtl,Exports/testmodel_obj/skin.png,Exports/testmodel_obj/testmodel.obj' && r.obj == 16 && r.mtl, r);
		check('Share for multi-file export shares all files', r.share && r.share.files && r.share.files.length == 3, r.share);

		// --- FBX ------------------------------------------------------------------------
		await ev(() => { Codecs.fbx.export(); });
		await waitDialog(() => Dialog.open && Dialog.open.id == 'export_options');
		await ev(() => Dialog.open.confirm());
		check('FBX export shows dialog', await savedOpen());
		await closeDialog();
		r = await ev(() => ({ files: Object.keys(__mock.files).filter(f => f.startsWith('Exports/testmodel_fbx/')).sort(), head: (__mock.text('Exports/testmodel_fbx/testmodel.fbx') || '').substring(0, 40) }));
		check('FBX → Exports/testmodel_fbx/{testmodel.fbx, skin.png}', r.files.length == 2 && r.files.includes('Exports/testmodel_fbx/testmodel.fbx') && r.head.length > 0, r);

		// --- Texture save → Textures/ --------------------------------------------------------
		await ev(() => Texture.all[0].save(true));
		await savedOpen(); await closeDialog();
		r = await ev(() => __mock.bytes('Textures/skin.png'));
		check('texture "Save As" → Textures/skin.png (binary PNG)', r && r[1] == 0x50 && r[2] == 0x4E && r[3] == 0x47, r);

		// --- Documents browser: open a .bbmodel ------------------------------------------------
		await ev(() => {
			const j = JSON.parse(__mock.text('Projects/testmodel.bbmodel'));
			j.elements = j.elements.slice(0, 1); j.elements[0].name = 'fixture_cube';
			__mock.put('Projects/fixture.bbmodel', JSON.stringify(j));
		});
		await ev(() => BBTouch.files.openBrowser(''));
		await page.waitForSelector('#bbtouch_documents .bbtouch_browser_entry[data-path="Projects"]', { timeout: 5000 });
		const rootList = await ev(() => [...document.querySelectorAll('#bbtouch_documents .bbtouch_browser_entry .bbtouch_browser_name')].map(e => e.textContent));
		check('browser lists Documents root (folders first)', ['Exports', 'Projects', 'Textures'].every(n => rootList.includes(n)), rootList);
		await page.tap('#bbtouch_documents .bbtouch_browser_entry[data-path="Projects"]');
		await page.waitForSelector('#bbtouch_documents .bbtouch_browser_entry[data-path="Projects/fixture.bbmodel"]', { timeout: 5000 });
		if (shot) await page.screenshot({ path: shot });
		const nProjects = await ev(() => ModelProject.all.length);
		await page.tap('#bbtouch_documents .bbtouch_browser_entry[data-path="Projects/fixture.bbmodel"]');
		await page.waitForFunction(() => Project && Project.name == 'fixture', null, { timeout: 8000 }).catch(() => {});
		await sleep(300);
		r = await ev(() => ({
			name: Project && Project.name, doc: Project && Project.bbtouch_doc_path, els: Outliner.elements.map(e => e.name),
			format: Format && Format.id, dialog: !!Dialog.open, n: ModelProject.all.length,
		}));
		check('tapping fixture.bbmodel opens it as a new project', r.name == 'fixture' && r.els.join() == 'fixture_cube' && r.format == 'free' && r.n == nProjects + 1 && !r.dialog, r);
		check('opened project remembers Documents path', r.doc == 'Projects/fixture.bbmodel', r.doc);
		await ev(() => { new Cube({ name: 'added' }).init(); Project.saved = false; BarItems.export_over.trigger(); });
		await sleep(500);
		r = await ev(() => ({ els: JSON.parse(__mock.text('Projects/fixture.bbmodel')).elements.length, dialog: !!Dialog.open }));
		check('saving an opened document overwrites it in place', r.els == 2 && !r.dialog, r);

		// --- Browser rename + delete -----------------------------------------------------------
		await ev(() => BBTouch.files.openBrowser('Projects'));
		await page.waitForSelector('#bbtouch_documents .bbtouch_browser_entry[data-path="Projects/fixture.bbmodel"]', { timeout: 5000 });
		await ev(() => { const vm = BBTouch.files.browser.vm; vm.rename(vm.entries.find(e => e.name == 'fixture.bbmodel')); });
		await waitDialog(() => Dialog.open && Dialog.open.id == 'text_input');
		await ev(() => { Dialog.open.setFormValues({ text: 'renamed.bbmodel' }); Dialog.open.confirm(); });
		await page.waitForSelector('#bbtouch_documents .bbtouch_browser_entry[data-path="Projects/renamed.bbmodel"]', { timeout: 5000 }).catch(() => {});
		r = await ev(() => ({ moved: !!__mock.text('Projects/renamed.bbmodel') && !__mock.text('Projects/fixture.bbmodel'), doc: Project.bbtouch_doc_path }));
		check('rename moves the file and updates the open project path', r.moved && r.doc == 'Projects/renamed.bbmodel', r);
		await ev(() => { const vm = BBTouch.files.browser.vm; vm.remove(vm.entries.find(e => e.name == 'renamed.bbmodel')); });
		await waitDialog(() => Dialog.open && Dialog.open.title == 'Delete');
		await ev(() => Dialog.open.close(0));
		await sleep(400);
		r = await ev(() => ({ gone: !__mock.text('Projects/renamed.bbmodel'), listed: [...document.querySelectorAll('#bbtouch_documents .bbtouch_browser_entry')].map(e => e.dataset.path) }));
		check('delete removes the file', r.gone && !r.listed.includes('Projects/renamed.bbmodel'), r);
		await ev(() => BBTouch.files.browser.vm.showRecent());
		await sleep(150);
		r = await ev(() => [...document.querySelectorAll('#bbtouch_documents .bbtouch_browser_entry')].map(e => e.dataset.path));
		check('Recent tab lists recently saved/opened files', r.includes('Projects/testmodel.bbmodel'), r);
		await ev(() => { if (Dialog.open) Dialog.open.close(0); });

		// --- File picker (<input type=file>) ---------------------------------------------------
		const bbmodelBuf = Buffer.from(await ev(() => {
			const j = JSON.parse(__mock.text('Projects/testmodel.bbmodel')); j.elements[0].name = 'picked_cube'; return JSON.stringify(j);
		}));
		let chooserP = page.waitForEvent('filechooser', { timeout: 5000 });
		await ev(() => BarItems.open_model.trigger());
		let chooser = await chooserP.catch(() => null);
		r = await ev(() => ({ accept: BBTouch.files.last_input.getAttribute('accept'), multiple: BBTouch.files.last_input.multiple, typeDialog: !!(Dialog.open && Dialog.open.id == 'import_type') }));
		check('Open picker: no accept filter, multiple, no "File Type" pre-dialog', chooser && r.accept === null && r.multiple && !r.typeDialog, r);
		if (chooser) await chooser.setFiles([{ name: 'picked.bbmodel', mimeType: 'application/octet-stream', buffer: bbmodelBuf }]);
		await page.waitForFunction(() => Project && Project.name == 'picked', null, { timeout: 8000 }).catch(() => {});
		r = await ev(() => ({ name: Project.name, els: Outliner.elements.map(e => e.name).join() }));
		check('picked .bbmodel opens', r.name == 'picked' && r.els.startsWith('picked_cube'), r);

		chooserP = page.waitForEvent('filechooser', { timeout: 5000 });
		await ev(() => {
			window.__imported = null;
			Blockbench.import({ extensions: ['glb', 'gltf'], type: 'glTF', readtype: 'buffer', multiple: true }, files => { window.__imported = files.map(f => ({ name: f.name, isBuf: f.content instanceof ArrayBuffer, len: f.content.byteLength, b0: new Uint8Array(f.content)[0] })); });
		});
		chooser = await chooserP.catch(() => null);
		if (chooser) await chooser.setFiles([
			{ name: 'a.glb', mimeType: 'model/gltf-binary', buffer: Buffer.from([0x67, 0x6C, 0x54, 0x46, 2, 0, 0, 0]) },
			{ name: 'b.gltf', mimeType: 'model/gltf+json', buffer: Buffer.from('{"asset":{}}') },
			{ name: 'c.txt', mimeType: 'text/plain', buffer: Buffer.from('nope') },
		]);
		await page.waitForFunction(() => window.__imported, null, { timeout: 5000 }).catch(() => {});
		r = await ev(() => window.__imported);
		check('multi-select binary import reads ArrayBuffers and skips wrong extensions', r && r.length == 2 && r[0].isBuf && r[0].len == 8 && r[0].b0 == 0x67 && r[1].name == 'b.gltf', r);

		chooserP = page.waitForEvent('filechooser', { timeout: 5000 });
		await ev(() => Blockbench.import({ extensions: ['png', 'jpg'], type: 'Image', readtype: 'image' }, () => {}));
		chooser = await chooserP.catch(() => null);
		r = await ev(() => ({ accept: BBTouch.files.last_input.getAttribute('accept'), multiple: BBTouch.files.last_input.multiple }));
		check('image picker uses accept="image/*" (photo library) and single select', chooser && r.accept == 'image/*' && r.multiple === false, r);
		if (chooser) await chooser.setFiles([]);

		// --- OBJ import from the browser (pending-import path) ---------------------------------
		await ev(() => { Formats.free.new(); if (Dialog.open) Dialog.open.confirm(); });
		await sleep(200);
		await ev(() => BBTouch.files.openDocument('Exports/testmodel_obj/testmodel.obj'));
		const objDialog = await waitDialog(() => Dialog.open && Dialog.open.id == 'import_obj');
		r = await ev(() => { const v = Dialog.open.getFormResult(); return { obj: v.obj && v.obj.name, mtl: v.mtl && v.mtl.name }; });
		check('opening an .obj pre-fills upstream OBJ import dialog (obj + mtl)', objDialog && r.obj == 'testmodel.obj' && r.mtl == 'materials.mtl', r);
		await ev(() => Dialog.open.confirm());
		await sleep(400);
		r = await ev(() => ({ meshes: Mesh.all.length, verts: Mesh.all[0] && Object.keys(Mesh.all[0].vertices).length, dialog: Dialog.open && Dialog.open.id }));
		check('opening an .obj from Documents imports it as mesh(es)', r.meshes >= 1 && r.verts >= 8, r);
		await ev(() => { if (Dialog.open) Dialog.open.close(0); });

		// --- Backups ------------------------------------------------------------------------------
		r = await ev(async () => {
			const F = BBTouch.files;
			F.config.backup_keep_per_project = 2;
			const a = await F.backupNow('test');
			const again = await F.backupNow('test');
			const paths = [a];
			for (let i = 0; i < 3; i++) {
				new Cube({ name: 'b' + i }).init();
				await new Promise(r => setTimeout(r, 1100)); // distinct timestamps
				paths.push(await F.backupNow('test'));
			}
			const list = Object.keys(__mock.files).filter(f => f.startsWith('Backups/'));
			return { a, again, paths, list, json: !!JSON.parse(__mock.text(list[0])).meta.backup };
		});
		check('backup written to Documents/Backups, unchanged project skipped', r.a && /^Backups\/.+_\d{8}-\d{6}\.bbmodel$/.test(r.a) && r.again === null && r.json, r);
		check('only the newest N backups are kept', r.list.length == 2 && r.list.includes(r.paths[3]) && r.list.includes(r.paths[2]), r.list);

		// --- "Open in Blockbench Touch" (appUrlOpen) -----------------------------------------------
		await ev(() => {
			const j = JSON.parse(__mock.text('Projects/testmodel.bbmodel')); j.elements[0].name = 'from_mail';
			__mock.put('Imported/mail attachment.bbmodel', JSON.stringify(j));
			__mock.fire('appUrlOpen', { url: 'file:///private/var/mobile/Library/Mail/mail%20attachment.bbmodel' });
		});
		await page.waitForFunction(() => Project && Project.name == 'mail attachment', null, { timeout: 8000 }).catch(() => {});
		r = await ev(() => ({ name: Project.name, doc: Project.bbtouch_doc_path, el: Outliner.elements[0] && Outliner.elements[0].name }));
		check('appUrlOpen with a foreign URL opens the copy in Imported/', r.name == 'mail attachment' && r.doc == 'Imported/mail attachment.bbmodel' && r.el == 'from_mail', r);
		await ev(() => __mock.fire('appUrlOpen', { url: __mock.DOC_URI.replace('/private', '') + '/Projects/other%20model.bbmodel' }));
		await page.waitForFunction(() => Project && Project.name == 'other model', null, { timeout: 8000 }).catch(() => {});
		r = await ev(() => ({ name: Project.name, doc: Project.bbtouch_doc_path }));
		check('appUrlOpen inside Documents opens the file in place', r.doc == 'Projects/other model.bbmodel', r);

		const bad = errors.filter(e => !/service_worker|bad HTTP response code \(404\) was received when fetching the script|blckbn\.ch|Failed to load resource|net::ERR|CORS|favicon/i.test(e));
		check('no unexpected console errors', bad.length === 0, bad.slice(0, 5));
		await context.close();

		// --- plain browser: no mock → upstream behaviour untouched ------------------------------
		const ctx2 = await browser.newContext({ viewport: { width: 1180, height: 820 }, acceptDownloads: true });
		const p2 = await ctx2.newPage();
		await p2.goto(`http://localhost:${port}/`, { waitUntil: 'load' });
		await p2.waitForFunction(() => window.BBTouch && BBTouch.ready && BBTouch.files && window.Formats, null, { timeout: 30000 });
		const plain = await p2.evaluate(() => ({ active: BBTouch.files.isActive(), cap: !!(window.Capacitor && Capacitor.registerPlugin), platform: window.Capacitor && Capacitor.getPlatform(), menu: BarItems.bbtouch_browse_documents && Condition(BarItems.bbtouch_browse_documents.condition) }));
		check('plain browser: Capacitor core loaded, platform web, integration inactive', !plain.active && plain.cap && plain.platform == 'web' && !plain.menu, plain);
		const dl = p2.waitForEvent('download', { timeout: 5000 }).catch(() => null);
		await p2.evaluate(() => { Formats.free.new(); if (Dialog.open) Dialog.open.confirm(); new Cube({ name: 'x' }).init(); Codecs.project.export(); });
		const download = await dl;
		check('plain browser: .bbmodel export still downloads (upstream path)', download && /\.bbmodel$/.test(download.suggestedFilename()), download && download.suggestedFilename());
		await ctx2.close();
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
