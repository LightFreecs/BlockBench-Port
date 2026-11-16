/* Blockbench Touch layer — M5: Quick Export for game engines.
 *
 * One touch dialog: pick one or more formats (GLB, glTF, FBX, OBJ, .bbmodel), scale, embed textures,
 * animations; "Export" writes them all (on iOS into Documents/Exports via touch/files.js, in a
 * browser as downloads) and shows one summary with Share. Choices are remembered
 * (localStorage bbtouch.quick_export, try/catch via BBTouch.store).
 *
 * Upstream codecs do the real work: `codec.export()` runs with `promptExportOptions` temporarily
 * replaced by our remembered options (also stored in Project.export_options[codec.id] so compile()
 * picks them up), and the resulting Blockbench.export / Filesystem.exportFile call is captured to
 * learn where it was written.
 *
 * API: BBTouch.quickExport = { open(), run(formats, opts) → [{format, result}], FORMATS, prefs() }
 */
(function () {
	'use strict';
	const BBT = window.BBTouch;
	const QE = BBT.quickExport = {};

	const FORMATS = QE.FORMATS = [
		{ id: 'glb', label: 'GLB', sub: 'Binary glTF — Unity, Godot, Unreal, Three.js, Roblox', codec: 'gltf', icon: 'icon-gltf' },
		{ id: 'gltf', label: 'glTF', sub: 'Text glTF (.gltf, textures embedded or as PNGs)', codec: 'gltf', icon: 'icon-gltf' },
		{ id: 'fbx', label: 'FBX', sub: 'Autodesk FBX (ASCII) + PNG textures', codec: 'fbx', icon: 'icon-fbx' },
		{ id: 'obj', label: 'OBJ', sub: 'Wavefront OBJ + MTL + PNG (static mesh)', codec: 'obj', icon: 'icon-objects' },
		{ id: 'bbmodel', label: '.bbmodel', sub: 'Blockbench project (keep editing later)', codec: 'project', icon: 'icon-blockbench_file' },
	];
	const DEFAULTS = { formats: ['glb'], scale: 16, embed_textures: true, animations: true, share_after: false };
	QE.prefs = function () {
		const p = Object.assign({}, DEFAULTS, BBT.store.get('quick_export', {}));
		if (!Array.isArray(p.formats) || !p.formats.length) p.formats = DEFAULTS.formats.slice();
		return p;
	};
	function savePrefs(p) { BBT.store.set('quick_export', p); }

	function files() { return BBT.files && BBT.files.isActive && BBT.files.isActive() ? BBT.files : null; }

	// Run fn and resolve with the value returned by the first Blockbench.export / Filesystem.exportFile call.
	function captureExport(fn, timeout = 60000) {
		return new Promise(resolve => {
			const be = Blockbench.export, fe = Filesystem.exportFile;
			let settled = false;
			const restore = () => { Blockbench.export = be; Filesystem.exportFile = fe; };
			const finish = v => { if (settled) return; settled = true; clearTimeout(timer); resolve(v); };
			const hook = orig => function (options, cb) {
				restore();
				let r;
				try { r = orig.call(this, options, cb); } catch (e) { finish({ error: e }); throw e; }
				Promise.resolve(r).then(v => finish(v || { downloaded: true, name: options && options.name }), e => finish({ error: e }));
				return r;
			};
			Blockbench.export = hook(be);
			Filesystem.exportFile = hook(fe);
			const timer = setTimeout(() => { restore(); finish({ error: new Error('export timed out') }); }, timeout);
			Promise.resolve().then(fn).catch(e => { restore(); finish({ error: e }); });
		});
	}

	function codecOptions(fmt, p) {
		if (fmt.codec === 'gltf') {
			return { encoding: fmt.id === 'glb' ? 'binary' : 'ascii', scale: p.scale, embed_textures: !!p.embed_textures, armature: false, merge_armature: false, animations: !!p.animations };
		}
		if (fmt.codec === 'fbx') return { encoding: 'ascii', scale: p.scale, embed_textures: false, include_animations: !!p.animations };
		return {};
	}

	async function exportOne(fmt, p) {
		if (fmt.codec === 'project') {
			return captureExport(() => BarItems.save_project.trigger());
		}
		const codec = Codecs[fmt.codec];
		if (!codec) return { error: new Error('codec missing: ' + fmt.codec) };
		const opts = codecOptions(fmt, p);
		if (Object.keys(opts).length) {
			if (!Project.export_options[codec.id]) Project.export_options[codec.id] = {};
			Object.assign(Project.export_options[codec.id], opts);
		}
		const had_own = Object.prototype.hasOwnProperty.call(codec, 'promptExportOptions');
		const own = codec.promptExportOptions;
		codec.promptExportOptions = async () => Object.assign({}, opts);
		try {
			return await captureExport(() => codec.export());
		} finally {
			if (had_own) codec.promptExportOptions = own; else delete codec.promptExportOptions;
		}
	}

	/** @returns {Promise<Array<{format: string, result: any}>>} */
	QE.run = async function (format_ids, p = QE.prefs()) {
		if (!window.Project) { Blockbench.showQuickMessage('Open or create a model first'); return []; }
		const F = files();
		const out = [];
		if (F) F.quiet = true;
		try {
			for (const id of format_ids) {
				const fmt = FORMATS.find(f => f.id === id);
				if (!fmt) continue;
				let result;
				try { result = await exportOne(fmt, p); } catch (e) { result = { error: e }; }
				if (result && result.error) console.error('[BBTouch export]', id, result.error);
				out.push({ format: id, result });
				await new Promise(r => setTimeout(r, 30));
			}
		} finally {
			if (F) F.quiet = false;
		}
		QE.last = out;
		BBT.emit('quick_export', out);
		return out;
	};

	function summarize(out) {
		const F = files();
		const paths = [];
		const lines = out.map(({ format, result }) => {
			const fmt = FORMATS.find(f => f.id === format);
			if (!result || result.error) return `- ❌ **${fmt.label}** — ${String(result && result.error && (result.error.message || result.error) || 'cancelled')}`;
			if (result.paths) {
				paths.push(...result.paths);
				return `- ✅ **${fmt.label}** → \`${result.folder ? result.folder + '/' : result.paths[0]}\`${result.paths.length > 1 ? ` (${result.paths.length} files)` : ''}`;
			}
			return `- ✅ **${fmt.label}** downloaded`;
		});
		const buttons = F && paths.length ? ['Share', 'dialog.ok'] : ['dialog.ok'];
		Blockbench.showMessageBox({
			id: 'bbtouch_quick_export_done',
			title: 'Quick Export',
			icon: 'ios_share',
			message: lines.join('\n') + (F ? `\n\nFiles › On My iPad/iPhone › ${F.config.app_folder_label}` : ''),
			buttons,
			confirmIndex: buttons.length - 1,
			cancelIndex: buttons.length - 1,
		}, i => { if (buttons[i] === 'Share') F.share(paths, Project && Project.name); });
		return paths;
	}

	QE.open = function () {
		if (!window.Project) { Blockbench.showQuickMessage('Open or create a model first'); return; }
		const p = QE.prefs();
		const tiles = FORMATS.map(f => `<button class="bbt_fmt_tile" data-fmt="${f.id}"><b>${f.label}</b><small>${f.sub}</small></button>`).join('');
		const d = new Dialog({
			id: 'bbtouch_quick_export',
			title: 'Quick Export',
			width: 560,
			lines: [`<div class="bbt_qe">
				<label class="bbt_field_label">Formats (tap to toggle, several at once is fine)</label>
				<div class="bbt_fmt_grid">${tiles}</div>
			</div>`],
			form: {
				scale: { label: 'Scale (units per meter)', type: 'number', value: p.scale, min: 0.0625, step: 1, description: '16 = one Blockbench block is one meter' },
				embed_textures: { label: 'Embed textures (glTF/GLB)', type: 'checkbox', value: p.embed_textures },
				animations: { label: 'Include animations', type: 'checkbox', value: p.animations },
				share_after: { label: 'Open Share sheet afterwards', type: 'checkbox', value: p.share_after, condition: () => !!files() },
			},
			buttons: ['Export', 'dialog.cancel'],
			confirmIndex: 0,
			cancelIndex: 1,
			onConfirm(form) {
				const formats = selected.slice();
				if (!formats.length) { Blockbench.showQuickMessage('Pick at least one format'); return false; }
				const np = Object.assign({}, p, form, { formats });
				savePrefs(np);
				QE.run(formats, np).then(out => {
					const F = files();
					const paths = [];
					out.forEach(o => { if (o.result && o.result.paths) paths.push(...o.result.paths); });
					if (np.share_after && F && paths.length && !out.some(o => !o.result || o.result.error)) F.share(paths, Project && Project.name);
					else summarize(out);
				});
			},
		});
		let selected = p.formats.slice();
		d.show();
		const root = d.object instanceof HTMLElement ? d.object : (d.object && d.object[0]);
		const mark = () => root.querySelectorAll('.bbt_fmt_tile').forEach(b => b.classList.toggle('active', selected.includes(b.dataset.fmt)));
		mark();
		root.querySelectorAll('.bbt_fmt_tile').forEach(b => b.addEventListener('click', () => {
			const id = b.dataset.fmt;
			if (selected.includes(id)) selected = selected.filter(x => x !== id); else selected.push(id);
			mark();
		}));
		return d;
	};

	BBT.onReady(() => {
		try {
			const action = new Action('bbtouch_quick_export', {
				name: 'Quick Export…',
				description: 'Export GLB / glTF / FBX / OBJ / .bbmodel in one go (remembered options)',
				icon: 'ios_share',
				category: 'file',
				condition: () => !!window.Project,
				click: () => QE.open(),
			});
			const file = MenuBar.menus.file;
			const idx = file.structure.findIndex(s => s && s.id === 'export');
			file.addAction(action, idx >= 0 ? String(idx) : '#export');
		} catch (e) { console.error('[BBTouch export] menu', e); }
	});
})();
