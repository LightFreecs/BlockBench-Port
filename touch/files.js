/* Blockbench Touch — iOS Files app integration (milestone 4).
 *
 * Only active on a native Capacitor platform (window.Capacitor.isNativePlatform()).
 * In a plain browser every hook falls through to upstream behaviour, so the web
 * build keeps working (and tests can inject a fake window.Capacitor).
 *
 * What it does on iOS:
 *  - Blockbench.export / Filesystem.exportFile → writes into the app's Documents
 *    directory (visible in Files › On My iPhone/iPad › Blockbench Touch):
 *      .bbmodel → Projects/, images → Textures/ (screenshots → Screenshots/),
 *      everything else → Exports/. Upstream's web "assets.zip" bundles (OBJ+MTL+PNG,
 *      FBX+PNG, DAE+PNG) and glTF/GLB with external textures are unpacked into a
 *      sub-folder Exports/<name>_<ext>/. Afterwards a dialog offers the share sheet.
 *  - Project save remembers the Documents path per project (Project.bbtouch_doc_path),
 *    so Ctrl+S / Save overwrites in place; "Save As" asks for a new name.
 *  - Blockbench.import / Filesystem.importFile → <input type=file> without the
 *    `accept` filter that makes iOS grey out .bbmodel/.obj/.gltf/.glb/.fbx, proper
 *    `multiple`, and files are filtered by extension after picking.
 *  - "Browse Documents" dialog (File menu + start screen): list/open/import/
 *    rename/delete/share, plus a "Recent" list.
 *  - Periodic backups of the open project to Documents/Backups (last N kept).
 *  - "Open in Blockbench Touch" from other apps (appUrlOpen from @capacitor/app;
 *    native code copies security-scoped files into Documents/Imported first).
 *
 * The Capacitor layer is reached only through BBTouch.files.cap, so it can be mocked.
 */
(function () {
	'use strict';
	const BBT = window.BBTouch;
	if (!BBT) return;

	const F = BBT.files = BBT.files || {};
	const DOCS = 'DOCUMENTS';
	const FOLDERS = { projects: 'Projects', exports: 'Exports', textures: 'Textures', screenshots: 'Screenshots', backups: 'Backups', imported: 'Imported' };
	F.FOLDERS = FOLDERS;
	F.config = Object.assign({
		backup_interval_s: 180,   // periodic backup of the open project
		backup_keep_per_project: 5,
		backup_keep_total: 40,
		app_folder_label: 'Blockbench Touch',
	}, F.config || {});

	// ---------------------------------------------------------------------------
	// Capacitor adapter (the only place that touches window.Capacitor)
	// ---------------------------------------------------------------------------
	const plugin_cache = {};
	F.cap = {
		get() { return window.Capacitor; },
		isNative() {
			const c = window.Capacitor;
			try { return !!(c && typeof c.isNativePlatform == 'function' && c.isNativePlatform()); } catch (e) { return false; }
		},
		// NB: never return a plugin proxy from an async function / resolve a promise with it:
		// Capacitor's proxy answers `.then`, so awaiting it would call a native "then" method.
		plugin(name) {
			if (plugin_cache[name]) return plugin_cache[name];
			const c = window.Capacitor;
			if (!c) return null;
			let p = c.Plugins && c.Plugins[name];
			if (!p && typeof c.registerPlugin == 'function') {
				try { p = c.registerPlugin(name); } catch (e) { p = null; }
			}
			if (p) plugin_cache[name] = p;
			return p || null;
		},
	};
	F.isActive = () => F.cap.isNative();
	const FS = () => F.cap.plugin('Filesystem');

	// ---------------------------------------------------------------------------
	// Helpers
	// ---------------------------------------------------------------------------
	const IMAGE_EXT = ['png', 'jpg', 'jpeg', 'gif', 'bmp', 'webp', 'tga', 'tif', 'tiff', 'heic'];
	const MIME = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', bmp: 'image/bmp', webp: 'image/webp', tga: 'image/x-tga', tif: 'image/tiff', tiff: 'image/tiff' };
	function extOf(name) { const m = /\.([^./\\]+)$/.exec(name || ''); return m ? m[1].toLowerCase() : ''; }
	function baseName(path) { return String(path || '').split(/[\\/]/).pop(); }
	function stripExt(name) { return name.replace(/\.[^./\\]+$/, ''); }
	function dirName(path) { const a = String(path || '').split('/'); a.pop(); return a.join('/'); }
	function join() { return [].slice.call(arguments).filter(s => s !== '' && s != null).join('/').replace(/\/+/g, '/'); }
	function sanitize(name, fallback) {
		let n = String(name || '').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').replace(/^\.+/, '').trim();
		return n || fallback || 'model';
	}
	F.util = { extOf, baseName, stripExt, dirName, join, sanitize };

	function bytesToBase64(bytes) {
		if (bytes instanceof ArrayBuffer) bytes = new Uint8Array(bytes);
		let out = '';
		const CH = 0x8000;
		for (let i = 0; i < bytes.length; i += CH) out += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
		return btoa(out);
	}
	function base64ToBytes(b64) {
		const bin = atob(b64);
		const out = new Uint8Array(bin.length);
		for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
		return out;
	}
	function blobToBase64(blob) {
		return new Promise((resolve, reject) => {
			const r = new FileReader();
			r.onload = () => resolve(String(r.result).replace(/^data:[^,]*,/, ''));
			r.onerror = () => reject(r.error);
			r.readAsDataURL(blob);
		});
	}
	F.util.bytesToBase64 = bytesToBase64;
	F.util.base64ToBytes = base64ToBytes;

	function tl_(key, fallback) {
		try { const t = window.tl && window.tl(key); if (t && t !== key) return t; } catch (e) { /* */ }
		return fallback;
	}
	function quick(msg, ms) { try { Blockbench.showQuickMessage(msg, ms || 1800); } catch (e) { console.log('[BBTouch files]', msg); } }
	function errorBox(title, err) {
		console.error('[BBTouch files]', title, err);
		try {
			Blockbench.showMessageBox({ title, icon: 'error', message: String((err && err.message) || err || 'Unknown error') });
		} catch (e) { /* */ }
	}
	function fmtSize(n) {
		if (!(n >= 0)) return '';
		if (n < 1024) return n + ' B';
		if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
		return (n / 1024 / 1024).toFixed(1) + ' MB';
	}
	function fmtDate(ms) {
		if (!ms) return '';
		const d = new Date(ms);
		const p = n => String(n).padStart(2, '0');
		return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
	}

	// ---------------------------------------------------------------------------
	// Documents API (paths are relative to the app's Documents directory)
	// ---------------------------------------------------------------------------
	const docs = F.docs = {
		/** data: string (text), {base64}, ArrayBuffer/Uint8Array, Blob */
		async write(path, data) {
			const opts = { path, directory: DOCS, recursive: true };
			if (typeof data == 'string') { opts.data = data; opts.encoding = 'utf8'; }
			else if (data && typeof data.base64 == 'string') opts.data = data.base64;
			else if (data instanceof Blob) opts.data = await blobToBase64(data);
			else if (data instanceof ArrayBuffer || ArrayBuffer.isView(data)) {
				opts.data = bytesToBase64(data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
			}
			else throw new Error('Unsupported data for ' + path);
			await FS().writeFile(opts);
			return path;
		},
		async readText(path) {
			const r = await FS().readFile({ path, directory: DOCS, encoding: 'utf8' });
			let s = typeof r.data == 'string' ? r.data : await r.data.text();
			if (s.charCodeAt(0) === 0xFEFF) s = s.substring(1);
			return s;
		},
		async readBase64(path) {
			const r = await FS().readFile({ path, directory: DOCS });
			return typeof r.data == 'string' ? r.data : await blobToBase64(r.data);
		},
		async readBuffer(path) { return base64ToBytes(await docs.readBase64(path)).buffer; },
		async list(path) {
			const r = await FS().readdir({ path: path || '', directory: DOCS });
			return (r.files || []).map(f => (typeof f == 'string' ? { name: f, type: 'file' } : f))
				.filter(f => f.name && !f.name.startsWith('.'))
				.map(f => ({ name: f.name, type: f.type == 'directory' ? 'directory' : 'file', size: f.size, mtime: f.mtime, path: join(path || '', f.name) }))
				.sort((a, b) => (a.type == b.type ? a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }) : (a.type == 'directory' ? -1 : 1)));
		},
		async stat(path) {
			try { return await FS().stat({ path, directory: DOCS }); } catch (e) { return null; }
		},
		async exists(path) { return !!(await docs.stat(path)); },
		async mkdir(path) {
			try { await FS().mkdir({ path, directory: DOCS, recursive: true }); } catch (e) { if (!(await docs.exists(path))) throw e; }
		},
		async remove(path, is_dir) {
			if (is_dir) await FS().rmdir({ path, directory: DOCS, recursive: true });
			else await FS().deleteFile({ path, directory: DOCS });
		},
		async rename(from, to) { await FS().rename({ from, to, directory: DOCS, toDirectory: DOCS }); },
		async uri(path) { return (await FS().getUri({ path, directory: DOCS })).uri; },
		/** Returns a path that doesn't exist yet: name.ext, name_2.ext, ... */
		async uniquePath(folder, file_name) {
			const ext = extOf(file_name), stem = ext ? file_name.slice(0, -(ext.length + 1)) : file_name;
			let candidate = join(folder, file_name);
			for (let i = 2; i < 500 && await docs.exists(candidate); i++) candidate = join(folder, `${stem}_${i}${ext ? '.' + ext : ''}`);
			return candidate;
		},
	};

	// ---------------------------------------------------------------------------
	// Share sheet + "Saved" dialog
	// ---------------------------------------------------------------------------
	F.share = async function (paths, title) {
		const Share = F.cap.plugin('Share');
		if (!Share) return quick('Share sheet not available');
		try {
			const files = [];
			for (const p of [].concat(paths)) files.push(await docs.uri(p));
			await Share.share({ title: title || baseName(paths[0] || ''), files });
		} catch (err) {
			if (/cancel/i.test(String(err && (err.message || err)))) return;
			errorBox('Share failed', err);
		}
	};
	F.shareBlob = async function (blob, file_name) {
		// Temporary copy in Documents/.share (hidden from the browser) so Share gets a file URL.
		const path = join('.share', sanitize(file_name, 'file'));
		await docs.write(path, blob);
		await F.share([path], file_name);
	};

	/** result: {paths: [...], folder?, label, zip?: Blob, zip_name?} */
	F.showSavedDialog = function (result) {
		const where = result.folder ? result.folder + '/' : (result.paths[0] || '');
		const label = `${F.config.app_folder_label}/${where}`;
		const list = result.folder && result.paths.length > 1
			? '\n\n' + result.paths.map(p => '- `' + baseName(p) + '`').join('\n')
			: '';
		const buttons = ['Share', 'dialog.ok'];
		if (result.zip) buttons.splice(1, 0, 'Share .zip');
		F.last_saved = result;
		BBT.emit('files_saved', result);
		return new Promise(resolve => {
			Blockbench.showMessageBox({
				id: 'bbtouch_saved',
				title: result.title || 'Saved',
				icon: 'check_circle',
				message: `Saved to **${label.replace(/[*_`]/g, m => '\\' + m)}**${list}\n\nOpen the Files app › On My iPad/iPhone › ${F.config.app_folder_label} to find it, or share it (Save to Files, AirDrop, …).`,
				buttons,
				confirmIndex: buttons.length - 1,
				cancelIndex: buttons.length - 1,
			}, (index) => {
				const b = buttons[index];
				if (b == 'Share') F.share(result.paths, result.title);
				else if (b == 'Share .zip') F.shareBlob(result.zip, result.zip_name || 'export.zip');
				resolve(b);
			});
		});
	};

	// ---------------------------------------------------------------------------
	// Recent files
	// ---------------------------------------------------------------------------
	F.recent = {
		list() { return BBT.store.get('files.recent', []); },
		add(path, kind) {
			let l = F.recent.list().filter(e => e.path != path);
			l.unshift({ path, name: baseName(path), time: Date.now(), kind: kind || extOf(path) });
			BBT.store.set('files.recent', l.slice(0, 20));
		},
		remove(path) { BBT.store.set('files.recent', F.recent.list().filter(e => e.path != path)); },
		rename(from, to) {
			BBT.store.set('files.recent', F.recent.list().map(e => (e.path == from ? Object.assign({}, e, { path: to, name: baseName(to) }) : e)));
		},
	};

	// ---------------------------------------------------------------------------
	// Export / save interception
	// ---------------------------------------------------------------------------
	const orig = {};
	let save_as_flag = false;

	function folderFor(options, ext) {
		if (ext == 'bbmodel') return FOLDERS.projects;
		if (IMAGE_EXT.includes(ext)) return options.resource_id == 'screenshot' ? FOLDERS.screenshots : FOLDERS.textures;
		return FOLDERS.exports;
	}
	function isProjectSave(options, ext) {
		const codec = window.Codecs && Codecs.project;
		return ext == 'bbmodel' && window.Project && codec && options.type == codec.name && !codec.context;
	}
	function textureForUri(uri) {
		const n = String(uri).replace(/\.png$/i, '');
		return (window.Texture && Texture.all || []).find(t => !t.error && String(t.name).replace(/\.png$/i, '') == n);
	}
	function textureBase64(tex) {
		try { return tex.getBase64(); } catch (e) { return String(tex.source || '').replace(/^data:[^,]*,/, ''); }
	}
	/** glTF / GLB JSON: images with external (non-data) URIs → [{uri, base64}] */
	function externalImages(json) {
		const out = [];
		(json && json.images || []).forEach(img => {
			if (!img.uri || /^data:/.test(img.uri)) return;
			const tex = textureForUri(img.uri);
			if (tex) out.push({ uri: img.uri, base64: textureBase64(tex) });
		});
		return out;
	}
	function glbJSON(buffer) {
		try {
			const dv = new DataView(buffer);
			if (dv.getUint32(0, true) != 0x46546C67) return null; // 'glTF'
			const len = dv.getUint32(12, true);
			if (dv.getUint32(16, true) != 0x4E4F534A) return null; // 'JSON'
			return JSON.parse(new TextDecoder().decode(new Uint8Array(buffer, 20, len)));
		} catch (e) { return null; }
	}

	/** Core of the export hook. Returns {paths, folder?, zip?} */
	async function writeExport(options, file_name) {
		const ext = extOf(file_name);
		const savetype = typeof options.savetype == 'function' ? options.savetype(file_name) : options.savetype;
		let content = options.content;
		if (content && typeof content.then == 'function') content = await content;
		const folder = folderFor(options, ext);

		// 1) Upstream web bundles (OBJ/FBX/DAE + textures) → unpack into a folder
		if (savetype == 'zip' && content instanceof Blob && options.name == 'assets' && window.JSZip) {
			const zip = await JSZip.loadAsync(content);
			const names = Object.keys(zip.files).filter(n => !zip.files[n].dir);
			const main = names.find(n => !IMAGE_EXT.includes(extOf(n)) && extOf(n) != 'mtl') || names[0] || 'model';
			const dir = join(FOLDERS.exports, sanitize(stripExt(baseName(main))) + '_' + (extOf(main) || 'export'));
			const paths = [];
			for (const n of names) {
				const p = join(dir, sanitize(baseName(n), 'file'));
				const b64 = await zip.files[n].async('base64');
				await docs.write(p, { base64: b64 });
				paths.push(p);
			}
			return { paths, folder: dir, zip: content, zip_name: stripExt(baseName(main)) + '.zip', type: (extOf(main) || 'zip').toUpperCase() };
		}

		// 2) glTF/GLB that reference textures as external files → folder with the textures
		if (ext == 'gltf' || ext == 'glb') {
			let json = null;
			if (ext == 'gltf' && typeof content == 'string') { try { json = JSON.parse(content); } catch (e) { /* */ } }
			if (ext == 'glb' && content instanceof ArrayBuffer) json = glbJSON(content);
			const images = externalImages(json);
			if (images.length) {
				const dir = join(FOLDERS.exports, sanitize(stripExt(file_name)) + '_' + ext);
				const paths = [await docs.write(join(dir, file_name), content)];
				for (const img of images) paths.push(await docs.write(join(dir, sanitize(img.uri, 'texture.png')), { base64: img.base64 }));
				return { paths, folder: dir };
			}
		}

		// 3) Single file
		let data;
		if (typeof content == 'string' && (savetype == 'image' || /^data:[^,]*;base64,/.test(content) && IMAGE_EXT.includes(ext))) {
			if (/^data:/.test(content)) data = { base64: content.replace(/^data:[^,]*,/, '') };
			else data = await (await fetch(content)).arrayBuffer(); // blob:/http URL of an image
		} else if (content == null) {
			data = '';
		} else {
			data = content;
		}
		let path;
		if (isProjectSave(options, ext)) {
			path = Project.bbtouch_doc_path;
			if (!path || save_as_flag) {
				path = await docs.uniquePath(folder, file_name);
			}
		} else {
			path = join(folder, file_name);
		}
		await docs.write(path, data);
		return { paths: [path] };
	}

	async function promptName(title, value) {
		return new Promise(resolve => {
			let done = false;
			Blockbench.textPrompt(title, value, (text) => { done = true; resolve(text); });
			// textPrompt has no cancel callback: detect the dialog closing without confirm
			const check = setInterval(() => {
				if (done) return clearInterval(check);
				if (!Dialog.open || Dialog.open.id != 'text_input') { clearInterval(check); setTimeout(() => { if (!done) resolve(null); }, 50); }
			}, 250);
		});
	}

	F.exportFile = async function (options, callback) {
		if (!F.isActive() || !options || options.custom_writer) return orig.exportFile.call(this, options, callback);
		let file_name = options.name || 'file';
		const exts = options.extensions instanceof Array ? options.extensions : [];
		if (exts[0] && !exts.includes(extOf(file_name))) file_name += '.' + exts[0];
		file_name = sanitize(file_name, 'file');
		let ext = extOf(file_name);
		const project_save = isProjectSave(options, ext);
		const in_place = project_save && Project.bbtouch_doc_path && !save_as_flag;

		try {
			if (project_save && save_as_flag) {
				const name = await promptName('Save project as', stripExt(baseName(Project.bbtouch_doc_path || file_name)));
				if (!name) { save_as_flag = false; return; }
				file_name = sanitize(stripExt(name)) + '.bbmodel';
				Project.bbtouch_doc_path = null;
				Project.name = stripExt(file_name);
				options = Object.assign({}, options, { content: Codecs.project.compile() });
			}
			const result = await writeExport(options, file_name);
			result.title = project_save ? 'Project saved' : 'Exported ' + (result.type || options.type || ext.toUpperCase());
			if (project_save) {
				Project.bbtouch_doc_path = result.paths[0];
				Project.saved = true;
				F.recent.add(result.paths[0], 'project');
			} else {
				F.recent.add(result.paths[0], 'export');
			}
			F.last_export = { options, file_name, result };
			if (typeof callback == 'function') {
				// upstream callbacks (codec.afterDownload/afterSave) show "Saved as …" — we show our own
				// message / dialog, so mute quick messages while the (synchronous) callback runs
				const qm = Blockbench.showQuickMessage;
				Blockbench.showQuickMessage = function () {};
				try { callback(baseName(result.paths[0])); } catch (e) { console.error(e); } finally { Blockbench.showQuickMessage = qm; }
			}
			if (in_place) quick(`Saved ${result.paths[0]}`);
			else if (F.quiet) { F.last_saved = result; BBT.emit('files_saved', result); } // M5 Quick Export batches: own summary
			else F.showSavedDialog(result);
			return result;
		} catch (err) {
			errorBox('Could not save ' + file_name, err);
		} finally {
			save_as_flag = false;
		}
	};

	// ---------------------------------------------------------------------------
	// Import (file picker) interception
	// ---------------------------------------------------------------------------
	const COMMON_IMAGES = ['png', 'jpg', 'jpeg', 'gif', 'bmp', 'webp'];
	/** iOS turns `accept=".bbmodel,.obj"` into UTIs and greys out unknown types; drop it unless images-only. */
	F.acceptFor = function (extensions) {
		const exts = (extensions || []).map(e => String(e).toLowerCase().replace(/^\./, ''));
		if (!exts.length) return '';
		if (exts.every(e => e == 'image/*' || COMMON_IMAGES.includes(e))) return 'image/*';
		return '';
	};
	F.importFile = function (options, callback) {
		if (!F.isActive() || isApp) return orig.importFile.call(this, options, callback);
		options = options || {};
		const exts = (options.extensions || []).map(e => String(e).toLowerCase());
		const input = document.createElement('input');
		input.type = 'file';
		input.className = 'bbtouch_file_input';
		const accept = F.acceptFor(exts);
		if (accept) input.accept = accept;
		input.multiple = options.multiple === true;
		input.style.cssText = 'position:fixed;left:-1000px;top:0;width:1px;height:1px;opacity:0;';
		document.body.appendChild(input);
		input.addEventListener('change', () => {
			let files = [...(input.files || [])];
			input.remove();
			if (!files.length) return;
			const allow_all = !exts.length || exts.includes('image/*') && files.every(f => /^image\//.test(f.type) || IMAGE_EXT.includes(extOf(f.name)));
			if (!allow_all) {
				const rejected = files.filter(f => !exts.some(e => f.name.toLowerCase().endsWith('.' + e)));
				files = files.filter(f => !rejected.includes(f));
				if (rejected.length) quick(`Skipped ${rejected.map(f => f.name).join(', ')} (expected .${exts.join(', .')})`, 3500);
			}
			if (files.length) Filesystem.readFile(files, options, callback);
		}, { once: true });
		input.click();
		F.last_input = input;
	};

	// ---------------------------------------------------------------------------
	// Opening files from Documents
	// ---------------------------------------------------------------------------
	function modelExtensions() {
		try { return Codec.getAllExtensions().map(e => e.toLowerCase()); } catch (e) { return ['bbmodel', 'json']; }
	}
	function imageExtensions() {
		try { return Texture.getAllExtensions().map(e => e.toLowerCase()); } catch (e) { return COMMON_IMAGES; }
	}
	F.kindOf = function (name) {
		const ext = extOf(name);
		if (ext == 'bbmodel') return 'project';
		if (imageExtensions().includes(ext)) return 'image';
		if (ext == 'obj' || ext == 'mtl') return 'obj';
		if (modelExtensions().includes(ext)) return 'model';
		if (['gltf', 'glb', 'fbx', 'dae', 'stl', 'zip'].includes(ext)) return 'export';
		return 'other';
	};
	async function readAsFileResult(path, as) {
		const name = baseName(path);
		let content;
		if (as == 'image') {
			const ext = extOf(name);
			content = `data:${MIME[ext] || 'application/octet-stream'};base64,` + await docs.readBase64(path);
		} else if (as == 'buffer') {
			content = await docs.readBuffer(path);
		} else {
			content = await docs.readText(path);
		}
		return { name, path: name, content, bbtouch_doc_path: path };
	}
	F.readAsFileResult = readAsFileResult;

	/** Open (or import) a Documents-relative file. Returns true if something was opened. */
	F.openDocument = async function (path) {
		const kind = F.kindOf(path);
		try {
			if (kind == 'project') {
				const existing = (window.ModelProject && ModelProject.all || []).find(p => p.bbtouch_doc_path == path);
				if (existing) { existing.select(); return true; }
				const file = await readAsFileResult(path, 'text');
				const before = window.Project;
				loadModelFile(file);
				if (window.Project && window.Project != before) {
					Project.bbtouch_doc_path = path;
					Project.saved = true;
				}
				F.recent.add(path, 'project');
				return true;
			}
			if (kind == 'image') {
				const file = await readAsFileResult(path, 'image');
				loadImages([file]);
				F.recent.add(path, 'image');
				return true;
			}
			if (kind == 'obj') {
				if (!window.Project || !Format.meshes || !BarItems.import_obj) {
					Blockbench.showMessageBox({ title: 'Import OBJ', icon: 'info', message: 'OBJ files are imported into a project that supports meshes. Create or open a **Generic Model** project first, then open the OBJ again.' });
					return false;
				}
				let obj_path = path;
				if (extOf(path) == 'mtl') obj_path = stripExt(path) + '.obj';
				const values = { obj: await readAsFileResult(obj_path, 'text') };
				// sibling .mtl (same name first, else the only/first one in the folder)
				try {
					const mtls = (await docs.list(dirName(obj_path))).filter(e => extOf(e.name) == 'mtl');
					const mtl = mtls.find(e => stripExt(e.name) == stripExt(baseName(obj_path))) || mtls[0];
					if (mtl) values.mtl = await readAsFileResult(mtl.path, 'text');
				} catch (e) { /* */ }
				// upstream's import dialog (scale etc.) with the file fields pre-filled
				BarItems.import_obj.trigger();
				if (Dialog.open && Dialog.open.id == 'import_obj') Dialog.open.setFormValues(values);
				F.recent.add(obj_path, 'obj');
				return true;
			}
			if (kind == 'model') {
				const file = await readAsFileResult(path, 'text');
				loadModelFile(file);
				F.recent.add(path, 'model');
				return true;
			}
			Blockbench.showMessageBox({
				title: 'Cannot open file', icon: 'info',
				message: `Blockbench can't open \`${baseName(path)}\` directly. You can share it to another app instead.`,
				buttons: ['Share', 'dialog.close'],
			}, i => { if (i == 0) F.share([path]); });
			return false;
		} catch (err) {
			errorBox('Could not open ' + baseName(path), err);
			return false;
		}
	};

	// ---------------------------------------------------------------------------
	// Browse Documents dialog
	// ---------------------------------------------------------------------------
	const KIND_ICON = { directory: 'folder', project: 'icon-blockbench_file', image: 'image', obj: 'fa-gem', model: 'view_in_ar', export: 'deployed_code', other: 'draft' };
	function iconFor(entry) { return entry.type == 'directory' ? 'folder' : (KIND_ICON[F.kindOf(entry.name)] || 'draft'); }

	F.browser = { dialog: null };
	F.openBrowser = function (start_path) {
		if (!F.isActive()) {
			return Blockbench.showQuickMessage('The Documents browser is only available in the iOS app');
		}
		if (F.browser.dialog) { try { F.browser.dialog.delete(); } catch (e) { /* */ } }
		const dialog = new Dialog({
			id: 'bbtouch_documents',
			title: 'Documents',
			width: 720,
			singleButton: true,
			buttons: ['dialog.close'],
			component: {
				data() {
					return {
						path: start_path || BBT.store.get('files.browser_path', ''),
						tab: 'files',
						entries: [],
						recent: F.recent.list(),
						loading: false,
						error: '',
						root_label: F.config.app_folder_label,
					};
				},
				computed: {
					crumbs() {
						const parts = this.path ? this.path.split('/') : [];
						return parts.map((name, i) => ({ name, path: parts.slice(0, i + 1).join('/') }));
					},
				},
				methods: {
					iconClass(e) {
						const i = iconFor(e);
						if (i.startsWith('icon-')) return 'icon ' + i;
						if (i.startsWith('fa-')) return 'icon fa ' + i;
						return 'material-icons icon';
					},
					iconText(e) { const i = iconFor(e); return (i.startsWith('icon-') || i.startsWith('fa-')) ? '' : i; },
					showRecent() { this.tab = 'recent'; this.recent = F.recent.list(); },
					size: fmtSize,
					date: fmtDate,
					async refresh() {
						this.loading = true; this.error = '';
						try {
							if (!this.path) await ensureFolders();
							this.entries = await docs.list(this.path);
						} catch (err) {
							this.entries = [];
							if (this.path) { this.path = ''; return this.refresh(); }
							this.error = String(err && err.message || err);
						}
						this.recent = F.recent.list();
						this.loading = false;
						BBT.store.set('files.browser_path', this.path);
					},
					go(path) { this.tab = 'files'; this.path = path; this.refresh(); },
					up() { this.go(dirName(this.path)); },
					async activate(entry) {
						if (entry.type == 'directory') return this.go(entry.path);
						const ok = await F.openDocument(entry.path);
						if (ok && F.kindOf(entry.name) != 'other') dialog.close();
					},
					async openRecent(entry) {
						if (!(await docs.exists(entry.path))) {
							F.recent.remove(entry.path); this.recent = F.recent.list();
							return quick('File no longer exists');
						}
						const ok = await F.openDocument(entry.path);
						if (ok) dialog.close();
					},
					more(entry, event) {
						const vm = this;
						const items = [];
						if (entry.type != 'directory') {
							items.push({ name: 'Open', icon: 'file_open', click: () => vm.activate(entry) });
							items.push({ name: 'Share', icon: 'ios_share', click: () => F.share([entry.path]) });
						} else {
							items.push({ name: 'Share all files', icon: 'ios_share', click: async () => {
								const files = (await docs.list(entry.path)).filter(e => e.type == 'file').map(e => e.path);
								if (files.length) F.share(files, entry.name); else quick('Folder is empty');
							} });
						}
						items.push({ name: 'Rename', icon: 'edit', click: () => vm.rename(entry) });
						items.push({ name: 'Delete', icon: 'delete', click: () => vm.remove(entry) });
						new Menu(items).open(event && event.currentTarget ? event.currentTarget : event);
					},
					async rename(entry) {
						const name = await promptName('Rename', entry.name);
						if (!name || name == entry.name) return;
						const to = join(dirName(entry.path), sanitize(name, entry.name));
						if (await docs.exists(to)) return quick('A file with that name already exists');
						try {
							await docs.rename(entry.path, to);
							F.recent.rename(entry.path, to);
							(window.ModelProject && ModelProject.all || []).forEach(p => {
								if (p.bbtouch_doc_path == entry.path) { p.bbtouch_doc_path = to; }
								else if (p.bbtouch_doc_path && p.bbtouch_doc_path.startsWith(entry.path + '/')) p.bbtouch_doc_path = to + p.bbtouch_doc_path.substring(entry.path.length);
							});
						} catch (err) { errorBox('Rename failed', err); }
						this.refresh();
					},
					remove(entry) {
						Blockbench.showMessageBox({
							title: 'Delete', icon: 'delete',
							message: `Delete \`${entry.name}\`${entry.type == 'directory' ? ' and everything in it' : ''}? This cannot be undone.`,
							buttons: ["Delete", "dialog.cancel"], confirmIndex: 0, cancelIndex: 1,
						}, async (i) => {
							if (i != 0) return;
							try {
								await docs.remove(entry.path, entry.type == 'directory');
								F.recent.remove(entry.path);
								(window.ModelProject && ModelProject.all || []).forEach(p => { if (p.bbtouch_doc_path == entry.path) p.bbtouch_doc_path = null; });
							} catch (err) { errorBox('Delete failed', err); }
							this.refresh();
						});
					},
					async newFolder() {
						const name = await promptName('New folder', 'New Folder');
						if (!name) return;
						try { await docs.mkdir(await docs.uniquePath(this.path, sanitize(name, 'New Folder'))); } catch (err) { errorBox('Could not create folder', err); }
						this.refresh();
					},
					importFromFiles() {
						dialog.close();
						BarItems.open_model.trigger();
					},
				},
				mounted() { this.refresh(); F.browser.vm = this; },
				template: `
					<div class="bbtouch_browser">
						<div class="bbtouch_browser_bar">
							<div class="bbtouch_browser_tabs">
								<button :class="{selected: tab=='files'}" @click="tab='files'; refresh()"><i class="material-icons">folder</i>Files</button>
								<button :class="{selected: tab=='recent'}" @click="showRecent()"><i class="material-icons">history</i>Recent</button>
							</div>
							<div class="bbtouch_browser_actions">
								<button title="New folder" @click="newFolder()"><i class="material-icons">create_new_folder</i></button>
								<button title="Refresh" @click="refresh()"><i class="material-icons">refresh</i></button>
								<button title="Import from Files…" @click="importFromFiles()"><i class="material-icons">file_open</i></button>
							</div>
						</div>
						<div class="bbtouch_browser_crumbs" v-if="tab=='files'">
							<button v-if="path" class="bbtouch_up" @click="up()"><i class="material-icons">arrow_upward</i></button>
							<span class="bbtouch_crumb" @click="go('')">{{ root_label }}</span>
							<template v-for="c in crumbs"><span class="bbtouch_crumb_sep">›</span><span class="bbtouch_crumb" @click="go(c.path)">{{ c.name }}</span></template>
						</div>
						<ul class="bbtouch_browser_list" v-if="tab=='files'">
							<li v-if="loading && !entries.length" class="bbtouch_browser_empty">Loading…</li>
							<li v-else-if="error" class="bbtouch_browser_empty">{{ error }}</li>
							<li v-else-if="!entries.length" class="bbtouch_browser_empty">This folder is empty</li>
							<li v-for="e in entries" :key="e.path" class="bbtouch_browser_entry" :data-path="e.path" @click="activate(e)">
								<i :class="iconClass(e)">{{ iconText(e) }}</i>
								<div class="bbtouch_browser_name">{{ e.name }}</div>
								<div class="bbtouch_browser_meta">{{ e.type == 'directory' ? '' : size(e.size) }} {{ date(e.mtime) }}</div>
								<button class="bbtouch_browser_more" @click.stop="more(e, $event)"><i class="material-icons">more_horiz</i></button>
							</li>
						</ul>
						<ul class="bbtouch_browser_list" v-else>
							<li v-if="!recent.length" class="bbtouch_browser_empty">No recent files</li>
							<li v-for="e in recent" :key="e.path" class="bbtouch_browser_entry" :data-path="e.path" @click="openRecent(e)">
								<i class="material-icons">history</i>
								<div class="bbtouch_browser_name">{{ e.name }}</div>
								<div class="bbtouch_browser_meta">{{ e.path }} · {{ date(e.time) }}</div>
							</li>
						</ul>
					</div>`,
			},
		});
		F.browser.dialog = dialog;
		dialog.show();
		return dialog;
	};

	async function ensureFolders() {
		for (const f of [FOLDERS.projects, FOLDERS.exports, FOLDERS.textures]) {
			if (!(await docs.exists(f))) { try { await docs.mkdir(f); } catch (e) { /* */ } }
		}
	}
	F.ensureFolders = ensureFolders;

	// ---------------------------------------------------------------------------
	// Backups → Documents/Backups
	// ---------------------------------------------------------------------------
	const last_backup = {}; // uuid → json string
	F.backupNow = async function (reason) {
		if (!F.isActive() || !window.Project || !window.Codecs) return null;
		if (!(Outliner.root.length || (Project.textures && Project.textures.length))) return null;
		let json;
		try { json = Codecs.project.compile({ compressed: false, backup: true }); } catch (e) { console.error(e); return null; }
		if (typeof json != 'string') json = JSON.stringify(json);
		if (last_backup[Project.uuid] == json) return null;
		const d = new Date(), p = n => String(n).padStart(2, '0');
		const stamp = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
		const prefix = `${sanitize(Project.name || 'unnamed')}_${String(Project.uuid).substring(0, 8)}_`;
		const path = join(FOLDERS.backups, prefix + stamp + '.bbmodel');
		try {
			await docs.write(path, json);
			last_backup[Project.uuid] = json;
			await pruneBackups(prefix);
			BBT.emit('files_backup', { path, reason });
			return path;
		} catch (err) {
			console.error('[BBTouch files] backup failed', err);
			return null;
		}
	};
	async function pruneBackups(prefix) {
		let list;
		try { list = (await docs.list(FOLDERS.backups)).filter(e => e.type == 'file' && extOf(e.name) == 'bbmodel'); } catch (e) { return; }
		// names end in a sortable timestamp; newest first
		const byStamp = (a, b) => b.name.slice(-23).localeCompare(a.name.slice(-23));
		const doomed = new Set();
		list.filter(e => e.name.startsWith(prefix)).sort(byStamp).slice(F.config.backup_keep_per_project).forEach(e => doomed.add(e.path));
		list.filter(e => !doomed.has(e.path)).sort(byStamp).slice(F.config.backup_keep_total).forEach(e => doomed.add(e.path));
		for (const path of doomed) { try { await docs.remove(path); } catch (e) { /* */ } }
	}
	function startBackupLoop() {
		setInterval(() => { if (window.Project && !Project.saved) F.backupNow('interval'); }, F.config.backup_interval_s * 1000);
		document.addEventListener('visibilitychange', () => { if (document.hidden) F.backupNow('hidden'); });
		const App = F.cap.plugin('App');
		if (App) { try { App.addListener('pause', () => F.backupNow('pause')); } catch (e) { /* */ } }
	}

	// ---------------------------------------------------------------------------
	// "Open in Blockbench Touch" (appUrlOpen)
	// ---------------------------------------------------------------------------
	let docs_root = null;
	function normFilePath(u) {
		let s = String(u || '');
		try { s = decodeURIComponent(s); } catch (e) { /* */ }
		s = s.replace(/^file:\/\//, '').replace(/^\/private\//, '/').replace(/\/+$/, '');
		return s;
	}
	/** Map a file:// URL to a Documents-relative path (native copies foreign files into Imported/). */
	F.docPathForUrl = async function (url) {
		if (!/^file:/i.test(url)) return null;
		if (!docs_root) { try { docs_root = normFilePath(await docs.uri('')); } catch (e) { docs_root = ''; } }
		const p = normFilePath(url);
		if (docs_root && p.startsWith(docs_root + '/')) return p.substring(docs_root.length + 1);
		return join(FOLDERS.imported, baseName(p));
	};
	const recent_urls = {};
	F.handleOpenUrl = async function (url) {
		if (!url) return false;
		if (recent_urls[url] && Date.now() - recent_urls[url] < 4000) return false;
		recent_urls[url] = Date.now();
		const path = await F.docPathForUrl(url);
		if (!path) return false;
		// The copy may still be settling right after launch
		for (let i = 0; i < 10 && !(await docs.exists(path)); i++) await new Promise(r => setTimeout(r, 300));
		BBT.emit('files_open_url', { url, path });
		return F.openDocument(path);
	};
	function setupUrlOpen() {
		const App = F.cap.plugin('App');
		if (!App) return;
		try {
			App.addListener('appUrlOpen', (data) => F.handleOpenUrl(data && data.url));
			App.getLaunchUrl().then(r => { if (r && r.url) F.handleOpenUrl(r.url); }).catch(() => {});
		} catch (e) { console.error('[BBTouch files] appUrlOpen', e); }
	}

	// ---------------------------------------------------------------------------
	// Install
	// ---------------------------------------------------------------------------
	function patch() {
		orig.exportFile = Filesystem.exportFile;
		orig.importFile = Filesystem.importFile;
		const exp = function (options, cb) { return F.exportFile.call(this, options, cb); };
		const imp = function (options, cb) { return F.importFile.call(this, options, cb); };
		Filesystem.exportFile = exp;
		Filesystem.importFile = imp;
		Blockbench.export = Blockbench.exportFile = exp;
		Blockbench.import = Blockbench.importFile = imp;

		suppressTextureSaves('save_project', false);
		suppressTextureSaves('save_project_as', false);
		suppressTextureSaves('export_over', true);
		// "Save As" forces a new name
		const sa = BarItems.save_project_as;
		if (sa && sa.onClick) {
			const orig_click = sa.onClick;
			sa.onClick = function () {
				if (F.isActive()) save_as_flag = true;
				try { return orig_click.apply(this, arguments); } finally { setTimeout(() => { if (!pending_save_as_dialog()) save_as_flag = false; }, 0); }
			};
		}
	}
	/** Project saves embed textures in the .bbmodel; on iOS don't also "download" every unsaved texture. */
	function suppressTextureSaves(action_id, only_project_codec) {
		const action = BarItems[action_id];
		if (!action || !action.onClick) return;
		const orig_click = action.onClick;
		action.onClick = function () {
			if (F.isActive() && window.Texture && (!only_project_codec || (window.Format && Format.codec == Codecs.project))) {
				Texture.all.forEach(t => { if (!t.saved) t.saved = true; });
			}
			return orig_click.apply(this, arguments);
		};
	}
	function pending_save_as_dialog() { return Dialog.open && Dialog.open.id == 'text_input'; }

	function addUi() {
		const action = new Action('bbtouch_browse_documents', {
			name: 'Browse Documents…',
			description: 'Open, rename, delete and share files in the app\'s Documents folder (Files app › Blockbench Touch)',
			icon: 'folder_open',
			category: 'file',
			condition: () => F.isActive(),
			click: () => F.openBrowser(),
		});
		const backup = new Action('bbtouch_backup_now', {
			name: 'Back Up Project to Documents',
			icon: 'backup',
			category: 'file',
			condition: () => F.isActive() && !!window.Project,
			click: async () => {
				delete last_backup[Project.uuid];
				const p = await F.backupNow('manual');
				quick(p ? 'Backup saved to ' + p : 'Nothing to back up');
			},
		});
		try {
			const file = MenuBar.menus.file;
			const idx = file.structure.indexOf('open_model');
			file.addAction(action, idx >= 0 ? String(idx + 1) : '');
			file.addAction(backup, '#import_export');
		} catch (e) { console.error('[BBTouch files] menu', e); }

		// Start screen entry
		try {
			if (F.isActive() && typeof window.addStartScreenSection == 'function') {
				window.addStartScreenSection('bbtouch_documents', {
					graphic: { type: 'icon', icon: 'folder_open' },
					insert_before: 'start_files',
					text: [
						{ type: 'h3', text: 'Your files' },
						{ type: 'p', text: `Projects and exports are stored in Files › ${F.config.app_folder_label}.` },
						{ type: 'button', text: 'Browse Documents', click: () => F.openBrowser() },
					],
				});
			}
		} catch (e) { console.error('[BBTouch files] start screen', e); }
	}

	BBT.onReady(() => {
		if (!window.Filesystem || !window.Blockbench) return;
		patch();
		addUi();
		if (!F.isActive()) return;
		document.documentElement.classList.add('bb-touch-native');
		ensureFolders().catch(e => console.error('[BBTouch files]', e));
		startBackupLoop();
		setupUrlOpen();
		console.log('[BBTouch] files: native Documents integration active');
	});
})();
