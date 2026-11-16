/* Blockbench Touch layer — M5: Generic Model ("free" format) quick start + workflow helpers.
 *
 *  - New projects use Blockbench's own "Generic Model" entry on the start screen / File › New
 *    (our duplicate quick-start card, File menu item and toolbar button were removed).
 *    `BBTouch.generic.newModel(preset)` stays as a scripting/test helper (presets: blank, cube,
 *    sphere, cylinder, icosphere, humanoid); the Humanoid base is also in Mesh Tools › Add.
 *  - Mode tabs: tap targets for Edit / Paint / Animate are enlarged in CSS (touch/generic.css).
 *  - UV editor: `showUVEditor()` reveals the UV panel (opens the left sidebar / mobile sheet, unfolds).
 *  - Timeline: 2-finger pinch = zoom time axis, 2-finger drag = scroll (upstream only has wheel zoom).
 *
 * API: BBTouch.generic = { newModel(preset, opts), PRESETS, TEXTURE_SIZES,
 *      showUVEditor(), uvVisible(), buildHumanoid() }
 */
(function () {
	'use strict';
	const BBT = window.BBTouch;
	const GEN = BBT.generic = {};

	GEN.TEXTURE_SIZES = [16, 32, 64, 128, 256, 512, 1024];
	GEN.PRESETS = [
		{ id: 'blank', label: 'Blank', icon: 'add', desc: 'Empty scene' },
		{ id: 'cube', label: 'Cube', icon: 'check_box_outline_blank', desc: 'Mesh cube 16³' },
		{ id: 'sphere', label: 'Sphere', icon: 'circle', desc: 'Low-poly UV sphere' },
		{ id: 'cylinder', label: 'Cylinder', icon: 'view_column', desc: '8-sided cylinder' },
		{ id: 'icosphere', label: 'Ico Sphere', icon: 'language', desc: 'Faceted rock / gem' },
		{ id: 'humanoid', label: 'Humanoid', icon: 'accessibility_new', desc: 'Rigged base: bones + meshes' },
	];
	const defaults = { name: '', texture_size: 64, preset: 'cube' };
	function prefs() { return Object.assign({}, defaults, BBT.store.get('generic_new', {})); }
	function savePrefs(p) { BBT.store.set('generic_new', p); }

	function wait(ms) { return new Promise(r => setTimeout(r, ms)); }

	// --- humanoid base ----------------------------------------------------------
	function boxMesh(name, from, to, color) {
		const mesh = new Mesh({ name, color });
		// upstream default mesh is a 4³ cube spanning [-2,2]×[0,4]×[-2,2]; remap it to from/to
		for (const k in mesh.vertices) {
			const v = mesh.vertices[k];
			v[0] = from[0] + (v[0] + 2) / 4 * (to[0] - from[0]);
			v[1] = from[1] + v[1] / 4 * (to[1] - from[1]);
			v[2] = from[2] + (v[2] + 2) / 4 * (to[2] - from[2]);
		}
		return mesh;
	}
	GEN.buildHumanoid = function () {
		const parts = [
			// name, bone pivot, from, to
			['body', [0, 12, 0], [-4, 12, -2], [4, 24, 2]],
			['head', [0, 24, 0], [-4, 24, -4], [4, 32, 4]],
			['arm_right', [-5, 22, 0], [-8, 12, -2], [-4, 24, 2]],
			['arm_left', [5, 22, 0], [4, 12, -2], [8, 24, 2]],
			['leg_right', [-2, 12, 0], [-4, 0, -2], [0, 12, 2]],
			['leg_left', [2, 12, 0], [0, 0, -2], [4, 12, 2]],
		];
		const elements = [], groups = [];
		Undo.initEdit({ elements, outliner: true, selection: true });
		let body_group = null;
		parts.forEach(([name, origin, from, to], i) => {
			const group = new Group({ name, origin }).init();
			if (name !== 'body' && body_group && name !== 'leg_left' && name !== 'leg_right') group.addTo(body_group);
			if (name === 'body') body_group = group;
			groups.push(group);
			// mesh vertices are relative to the mesh origin (= bone pivot)
			const mesh = boxMesh(name, from.map((v, a) => v - origin[a]), to.map((v, a) => v - origin[a]), i % 8);
			mesh.origin = origin.slice();
			mesh.addTo(group).init();
			elements.push(mesh);
		});
		elements.forEach(m => {
			unselectAllElements();
			m.select();
			UVEditor.setAutoSize(null, true, Object.keys(m.faces));
		});
		unselectAllElements();
		Canvas.updateAll();
		Undo.finishEdit('Add humanoid base');
		return { elements, groups };
	};

	// --- new project --------------------------------------------------------------
	/**
	 * @param {string} preset blank|cube|sphere|cylinder|icosphere|humanoid
	 * @param {{name?: string, texture_size?: number}} opts
	 */
	GEN.newModel = async function (preset = 'cube', opts = {}) {
		const p = Object.assign(prefs(), opts, { preset });
		savePrefs({ texture_size: p.texture_size, preset: p.preset });
		const size = Number(p.texture_size) || 64;
		// newProject() (not Format.new()) skips upstream's project-settings dialog; our dialog covers it
		newProject(Formats.free);
		if (window.Dialog && Dialog.open && Dialog.open.id === 'project') Dialog.open.close(0);
		Project.name = (p.name || '').trim() || (preset === 'blank' ? 'model' : preset);
		Project.texture_width = size;
		Project.texture_height = size;
		Project.box_uv = false;
		if (window.UVEditor && UVEditor.vue) { UVEditor.vue.box_uv = false; }
		if (!Modes.edit) Modes.options.edit.select();
		const MT = BBT.meshTools;
		switch (preset) {
			case 'cube': MT.addPrimitive('cuboid', { diameter: 16, height: 16 }); break;
			case 'sphere': MT.addPrimitive('sphere', { diameter: 16, sides: 12 }); break;
			case 'cylinder': MT.addPrimitive('cylinder', { diameter: 16, height: 16, sides: 8 }); break;
			case 'icosphere': MT.addPrimitive('icosphere', { diameter: 16, detail: 1 }); break;
			case 'humanoid': GEN.buildHumanoid(); break;
		}
		if (window.Undo) Undo.closeAmendEditMenu && Undo.closeAmendEditMenu();
		Project.saved = true;
		if (window.updateInterface) updateInterface();
		setTimeout(() => { try { BBT.gestures && BBT.gestures.frameAll(); } catch (e) { /* ignore */ } }, 60);
		if (BBT.meshTools) {
			BBT.meshTools.setCategory(preset === 'blank' ? 'add' : 'mesh');
			BBT.meshTools.refresh();
		}
		BBT.emit('generic_new', { preset, project: Project });
		return Project;
	};

	// --- floating toolbar button ----------------------------------------------------------
	function addToolbarButton() {
		const tb = BBT.toolbar && BBT.toolbar.element;
		const body = tb && tb.querySelector('.bbt_body');
		if (!body || body.querySelector('[data-id="quick_export"]')) return !!body;
		const exp = document.createElement('button');
		exp.className = 'bbt_btn';
		exp.dataset.id = 'quick_export';
		exp.title = 'Quick Export (GLB / glTF / OBJ / FBX)';
		exp.innerHTML = '<i class="material-icons">ios_share</i>';
		exp.addEventListener('pointerup', e => { e.preventDefault(); e.stopPropagation(); if (BBT.quickExport) BBT.quickExport.open(); });
		const qa = body.querySelector('[data-id="quick_actions"]');
		body.insertBefore(exp, qa || null);
		return true;
	}

	// --- UV editor -----------------------------------------------------------------------------
	GEN.uvVisible = function () {
		const p = window.Panels && Panels.uv;
		if (!p || !p.node) return false;
		const r = p.node.getBoundingClientRect();
		return r.width > 40 && r.height > 80 && !p.folded && p.node.isConnected && p.node.offsetParent !== null;
	};
	GEN.showUVEditor = function () {
		const p = window.Panels && Panels.uv;
		if (!p) return false;
		if (Blockbench.isMobile && Interface.PanelSelectorVue) {
			Interface.PanelSelectorVue.select(p);
		} else {
			if (p.slot === 'left_bar' && !Prop.show_left_bar) { Prop.show_left_bar = true; updateInterface(); }
			if (p.slot === 'right_bar' && !Prop.show_right_bar) { Prop.show_right_bar = true; updateInterface(); }
			if (p.slot === 'hidden' || !Condition(p.condition)) { p.moveTo('left_bar'); }
		}
		if (p.folded) p.fold(false);
		if (window.UVEditor) { UVEditor.loadData(); }
		if (BBT.ui && BBT.ui.refreshEdges) BBT.ui.refreshEdges();
		return GEN.uvVisible();
	};

	// --- timeline pinch zoom ---------------------------------------------------------------------
	function setupTimelinePinch() {
		const body = document.getElementById('timeline_body');
		if (!body || body.__bbt_pinch) return !!body;
		body.__bbt_pinch = true;
		let start = null;
		const metrics = t => ({ cx: (t[0].clientX + t[1].clientX) / 2, cy: (t[0].clientY + t[1].clientY) / 2, dist: Math.max(Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY), 1) });
		body.addEventListener('touchstart', e => {
			if (e.touches.length === 2) {
				start = Object.assign(metrics(e.touches), { size: Timeline.vue._data.size, sl: body.scrollLeft, st: body.scrollTop });
				e.preventDefault();
			}
		}, { capture: true, passive: false });
		body.addEventListener('touchmove', e => {
			if (!start || e.touches.length < 2) return;
			e.preventDefault();
			e.stopPropagation();
			const m = metrics(e.touches);
			const head = Timeline.vue._data.head_width || 0;
			const rect = body.getBoundingClientRect();
			const new_size = Math.min(Math.max(start.size * m.dist / start.dist, 10), 1000);
			// keep the time under the pinch centre fixed
			const x_in = start.cx - rect.left - head + start.sl;
			const t = x_in / start.size;
			Timeline.vue._data.size = new_size;
			body.scrollLeft = t * new_size - (m.cx - rect.left - head);
			if (!Timeline.vue.graph_editor_open) body.scrollTop = start.st - (m.cy - start.cy);
			Timeline.updateSize();
			GEN.stats.timeline_zoom++;
		}, { capture: true, passive: false });
		const end = e => { if (start && e.touches.length < 2) start = null; };
		body.addEventListener('touchend', end, { capture: true });
		body.addEventListener('touchcancel', end, { capture: true });
		return true;
	}
	GEN.stats = { timeline_zoom: 0 };

	// --- setup -------------------------------------------------------------------------------
	BBT.onReady(() => {
		let tries = 0;
		const t = setInterval(() => { if (addToolbarButton() || ++tries > 50) clearInterval(t); }, 200);
		const tl = setInterval(() => { if (window.Timeline && Timeline.vue && setupTimelinePinch()) clearInterval(tl); }, 500);
		Blockbench.on('select_mode', ({ mode }) => {
			if (mode && mode.id === 'animate') setupTimelinePinch();
		});
	});
})();
