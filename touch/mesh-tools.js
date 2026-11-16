/* Blockbench Touch layer — M5: contextual "Mesh Tools" / "Animate" touch bar for the
 * Generic Model workflow, Subdivide, box selection by touch-drag, numeric "Move by…".
 *
 * The bar docks to the bottom of the 3D viewport (#preview) and adapts to the mode:
 *   Edit mode    → row 1: selection mode Object/Face/Edge/Vertex, Drag = Orbit/Box select,
 *                         category tabs (Add / Mesh / Transform / UV & Texture)
 *                  row 2: big buttons of the chosen category (upstream BarItems)
 *   Animate mode → play/pause, frame stepping, add animation, add keyframe, graph editor…
 * Buttons trigger upstream actions (BarItems[id].trigger()), are disabled when the upstream
 * condition fails, and toggles show their state. Everything is a no-op without touch mode
 * unless the bar is opened explicitly (it's useful with a mouse too).
 *
 * API: BBTouch.meshTools = { bar, refresh(), setCategory(id), setDragSelect(bool), subdivide(),
 *      addPrimitive(shape, opts), moveBy([x,y,z]), visible }
 */
(function () {
	'use strict';
	const BBT = window.BBTouch;
	const MT = BBT.meshTools = {
		drag_select: false,
		category: BBT.store.get('meshbar_category', 'add'),
		collapsed: BBT.store.get('meshbar_collapsed', false),
		stats: { box_selects: 0 },
	};

	// ---------------------------------------------------------------------------
	// Primitives (upstream add_mesh dialog "add_primitive", confirmed programmatically
	// so the upstream amend panel still lets the user tweak diameter/sides afterwards)
	const PRIMITIVES = [
		{ shape: 'cuboid', label: 'Cube', icon: 'check_box_outline_blank' },
		{ shape: 'cylinder', label: 'Cylinder', icon: 'view_column' },
		{ shape: 'sphere', label: 'Sphere', icon: 'circle' },
		{ shape: 'icosphere', label: 'Ico Sphere', icon: 'language' },
		{ shape: 'plane', label: 'Plane', icon: 'crop_square' },
		{ shape: 'circle', label: 'Circle', icon: 'radio_button_unchecked' },
		{ shape: 'cone', label: 'Cone', icon: 'change_history' },
		{ shape: 'pyramid', label: 'Pyramid', icon: 'details' },
		{ shape: 'torus', label: 'Torus', icon: 'donut_large' },
		{ shape: 'tube', label: 'Tube', icon: 'trip_origin' },
		{ shape: 'beveled_cuboid', label: 'Rounded Cube', icon: 'crop_din' },
		{ shape: 'octahedron', label: 'Octahedron', icon: 'diamond' },
		{ shape: 'dodecahedron', label: 'Dodecahedron', icon: 'hexagon' },
	];
	MT.PRIMITIVES = PRIMITIVES;

	MT.addPrimitive = function (shape, opts) {
		const action = window.BarItems && BarItems.add_mesh;
		if (!action) return null;
		if (window.Modes && !Modes.edit && Modes.options.edit) Modes.options.edit.select();
		action.trigger();
		const d = window.Dialog && Dialog.open;
		if (!d || d.id !== 'add_primitive') return null;
		d.setFormValues(Object.assign({ shape }, opts || {}));
		d.confirm();
		return window.Mesh && Mesh.selected[0];
	};

	// ---------------------------------------------------------------------------
	// Subdivide (upstream has no subdivide; loop cut is per-loop). Splits selected faces
	// (all faces of the selected meshes when no faces are selected / object mode):
	//   quad → 4 quads, tri → 4 tris, n-gon → n quads around the centre.
	// Edge midpoints are shared, so neighbouring subdivided faces stay connected.
	// Unselected neighbours with one split edge are re-triangulated (no T-junction cracks).
	function mid(a, b) { return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2]; }
	function avg(list) {
		const n = list.length, out = [0, 0, 0];
		list.forEach(v => { out[0] += v[0] / n; out[1] += v[1] / n; out[2] += v[2] / n; });
		return out;
	}
	function uvMid(a, b) { return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]; }
	function uvAvg(list) { const n = list.length; return [list.reduce((s, v) => s + v[0], 0) / n, list.reduce((s, v) => s + v[1], 0) / n]; }
	function edgeKey(a, b) { return a < b ? a + '|' + b : b + '|' + a; }

	function subdivideMesh(mesh, face_keys) {
		const midpoints = {}; // edgeKey → vertex key
		const new_faces = [];
		const getMid = (a, b) => {
			const k = edgeKey(a, b);
			if (!midpoints[k]) midpoints[k] = mesh.addVertices(mid(mesh.vertices[a], mesh.vertices[b]))[0];
			return midpoints[k];
		};
		const makeFace = (src, verts, uvs) => {
			const uv = {};
			verts.forEach((v, i) => { uv[v] = uvs[i]; });
			const face = new MeshFace(mesh, { vertices: verts, uv, texture: src.texture });
			new_faces.push(mesh.addFaces(face)[0]);
		};
		face_keys.forEach(fkey => {
			const face = mesh.faces[fkey];
			if (!face || face.vertices.length < 3) return;
			const sv = face.getSortedVertices().slice();
			const n = sv.length;
			const uv = k => (face.uv && face.uv[k] ? face.uv[k].slice() : [0, 0]);
			const m = sv.map((v, i) => getMid(v, sv[(i + 1) % n]));
			const muv = sv.map((v, i) => uvMid(uv(v), uv(sv[(i + 1) % n])));
			if (n === 3) {
				makeFace(face, [sv[0], m[0], m[2]], [uv(sv[0]), muv[0], muv[2]]);
				makeFace(face, [m[0], sv[1], m[1]], [muv[0], uv(sv[1]), muv[1]]);
				makeFace(face, [m[2], m[1], sv[2]], [muv[2], muv[1], uv(sv[2])]);
				makeFace(face, [m[0], m[1], m[2]], [muv[0], muv[1], muv[2]]);
			} else {
				const c = mesh.addVertices(avg(sv.map(v => mesh.vertices[v])))[0];
				const cuv = uvAvg(sv.map(uv));
				for (let i = 0; i < n; i++) {
					const prev = (i + n - 1) % n;
					makeFace(face, [sv[i], m[i], c, m[prev]], [uv(sv[i]), muv[i], cuv, muv[prev]]);
				}
			}
			delete mesh.faces[fkey];
		});
		// Fix neighbours that share exactly one split edge (avoid T-junctions)
		const done = new Set(new_faces);
		for (const fkey of Object.keys(mesh.faces)) {
			if (done.has(fkey)) continue;
			const face = mesh.faces[fkey];
			const sv = face.getSortedVertices().slice();
			const n = sv.length;
			const split = [];
			for (let i = 0; i < n; i++) {
				const k = edgeKey(sv[i], sv[(i + 1) % n]);
				if (midpoints[k]) split.push(i);
			}
			if (split.length !== 1 || n > 4) continue;
			const i = split[0];
			const mk = midpoints[edgeKey(sv[i], sv[(i + 1) % n])];
			const uv = k => (face.uv && face.uv[k] ? face.uv[k].slice() : [0, 0]);
			const muv = uvMid(uv(sv[i]), uv(sv[(i + 1) % n]));
			const a = sv[i], b = sv[(i + 1) % n], c = sv[(i + 2) % n];
			const add = (verts, uvs) => {
				const u = {}; verts.forEach((v, j) => { u[v] = uvs[j]; });
				mesh.addFaces(new MeshFace(mesh, { vertices: verts, uv: u, texture: face.texture }));
			};
			if (n === 3) {
				add([a, mk, c], [uv(a), muv, uv(c)]);
				add([mk, b, c], [muv, uv(b), uv(c)]);
			} else {
				const d = sv[(i + 3) % n];
				add([a, mk, d], [uv(a), muv, uv(d)]);
				add([mk, b, c], [muv, uv(b), uv(c)]);
				add([mk, c, d], [muv, uv(c), uv(d)]);
			}
			delete mesh.faces[fkey];
		}
		return new_faces;
	}

	MT.subdivide = function () {
		const meshes = (window.Mesh && Mesh.selected) || [];
		if (!meshes.length) { Blockbench.showQuickMessage('Select a mesh first'); return false; }
		Undo.initEdit({ elements: meshes, selection: true });
		let count = 0;
		meshes.forEach(mesh => {
			let keys = BarItems.selection_mode.value === 'object' ? [] : mesh.getSelectedFaces().slice();
			const whole = !keys.length;
			if (whole) keys = Object.keys(mesh.faces);
			const created = subdivideMesh(mesh, keys);
			count += created.length;
			if (!whole) {
				const faces = mesh.getSelectedFaces(true);
				faces.splice(0, faces.length, ...created);
				const verts = mesh.getSelectedVertices(true);
				const vs = new Set();
				created.forEach(f => mesh.faces[f].vertices.forEach(v => vs.add(v)));
				verts.splice(0, verts.length, ...vs);
				const edges = mesh.getSelectedEdges && mesh.getSelectedEdges(true);
				if (edges) edges.splice(0, edges.length);
			}
		});
		Canvas.updateView({ elements: meshes, element_aspects: { geometry: true, uv: true, faces: true }, selection: true });
		if (window.UVEditor) UVEditor.loadData();
		Undo.finishEdit('Subdivide');
		return count;
	};

	// ---------------------------------------------------------------------------
	// Numeric precision: move selection (elements or mesh components) by an exact offset
	MT.moveBy = function (offset) {
		const ids = ['slider_pos_x', 'slider_pos_y', 'slider_pos_z'];
		let any = false;
		ids.forEach((id, axis) => {
			const s = BarItems[id];
			const v = Number(offset[axis]) || 0;
			if (!s || !v || !Condition(s.condition)) return;
			any = true;
			s.onBefore && s.onBefore();
			s.change(n => n + v);
			s.onAfter && s.onAfter();
			s.update && s.update();
		});
		if (any && window.Transformer) Transformer.update();
		return any;
	};
	MT.openMoveBy = function () {
		const last = BBT.store.get('move_by', [0, 0, 0]);
		new Dialog({
			id: 'bbtouch_move_by',
			title: 'Move selection by…',
			width: 360,
			form: {
				info: { type: 'info', text: 'Exact offset in pixels/units. Works on elements and on selected vertices / edges / faces. Tap a field for the keypad.' },
				x: { label: 'X', type: 'number', value: last[0], step: 0.5 },
				y: { label: 'Y', type: 'number', value: last[1], step: 0.5 },
				z: { label: 'Z', type: 'number', value: last[2], step: 0.5 },
			},
			onConfirm(r) {
				const off = [r.x, r.y, r.z];
				BBT.store.set('move_by', off);
				MT.moveBy(off);
			},
		}).show();
	};

	// ---------------------------------------------------------------------------
	// Box select by touch drag (gestures.js dragHook → upstream Preview.startSelRect)
	function boxSelectAllowed(p) {
		if (!MT.drag_select || !BBT.enabled || !window.Modes || !Modes.edit) return false;
		if (!window.Toolbox || !Toolbox.selected || Toolbox.selected.selectElements === false) return false;
		return !!(p && p.startSelRect);
	}
	let active_box = null;
	BBT.onReady(() => {
		const G = BBT.gestures;
		if (!G) return;
		G.dragHook = function (p, down) {
			if (!boxSelectAllowed(p)) return false;
			const fake = {
				type: 'mousedown', pointerType: 'mouse', which: 1, button: 0, target: p.canvas,
				offsetX: down.offsetX, offsetY: down.offsetY, clientX: down.clientX, clientY: down.clientY,
				pageX: down.pageX, pageY: down.pageY,
				shiftKey: down.shiftKey || !!Pressing.overrides.shift, ctrlKey: down.ctrlKey || !!Pressing.overrides.ctrl,
				ctrlOrCmd: down.ctrlKey || down.metaKey || !!Pressing.overrides.ctrl, altKey: down.altKey, metaKey: down.metaKey,
				preventDefault() {}, stopPropagation() {},
			};
			p.selection.click_target = null;
			p.startSelRect(fake);
			// Drive the rectangle with pointer events ourselves: upstream's document touchmove listener is
			// passive (preventDefault warnings) and reads only the first touch.
			const sel = p.selection;
			if (sel.sr_move_f) {
				['mousemove', 'touchmove'].forEach(t => document.removeEventListener(t, sel.sr_move_f));
				['mouseup', 'touchend'].forEach(t => document.removeEventListener(t, sel.sr_stop_f));
			}
			const id = down.pointerId;
			const move = e => {
				if (e.pointerId !== id) return;
				p.moveSelRect(Object.assign({}, fake, { clientX: e.clientX, clientY: e.clientY, type: 'mousemove' }));
			};
			const end = e => {
				if (e.pointerId !== id) return;
				cleanup();
				if (sel.sr_stop_f) p.stopSelRect(e);
			};
			const cleanup = () => {
				window.removeEventListener('pointermove', move, true);
				window.removeEventListener('pointerup', end, true);
				window.removeEventListener('pointercancel', end, true);
				active_box = null;
			};
			window.addEventListener('pointermove', move, true);
			window.addEventListener('pointerup', end, true);
			window.addEventListener('pointercancel', end, true);
			active_box = cleanup;
			MT.stats.box_selects++;
			return true;
		};
		G.dragHookCancel = function (p) {
			if (active_box) active_box();
			if (p && p.selection && p.selection.sr_stop_f) p.stopSelRect();
		};
	});
	MT.setDragSelect = function (v) {
		MT.drag_select = !!v;
		document.documentElement.classList.toggle('bbt-drag-select', MT.drag_select);
		MT.refresh();
	};

	// ---------------------------------------------------------------------------
	// Bar definition
	const SEL_MODES = [
		{ value: 'object', label: 'Object', icon: 'far.fa-gem' },
		{ value: 'face', label: 'Face', icon: 'far.fa-square' },
		{ value: 'edge', label: 'Edge', icon: 'pen_size_3' },
		{ value: 'vertex', label: 'Vertex', icon: 'fiber_manual_record' },
	];
	// item: {id: BarItem id, label} or {run, label, icon, enabled(), active()}
	const CATEGORIES = {
		add: { label: 'Add', icon: 'add_box', items: [
			{ id: 'add_cube', label: 'Block' },
			{ label: 'Mesh…', icon: 'fa-gem', bid: 'bbtouch_add_mesh', run: () => openPrimitivePicker(), enabled: () => !!(window.Format && Format.meshes) },
			...PRIMITIVES.slice(0, 5).map(p => ({ label: p.label, icon: p.icon, run: () => MT.addPrimitive(p.shape), enabled: () => !!(window.Format && Format.meshes), prim: p.shape })),
			{ label: 'Humanoid', icon: 'accessibility_new', bid: 'bbtouch_add_humanoid',
				run: () => { if (BBT.generic) { BBT.generic.buildHumanoid(); BBT.gestures && BBT.gestures.frameAll && BBT.gestures.frameAll(); } },
				enabled: () => !!(window.Format && Format.meshes && Format.bone_rig && BBT.generic) },
			{ id: 'group_elements', label: 'Bone' },
			{ id: 'add_group', label: 'Group' },
			{ id: 'add_locator', label: 'Locator' },
			{ id: 'convert_to_mesh', label: 'To Mesh' },
		] },
		mesh: { label: 'Mesh', icon: 'fa-gem', items: [
			{ id: 'extrude_mesh_selection', label: 'Extrude' },
			{ id: 'inset_mesh_selection', label: 'Inset' },
			{ label: 'Subdivide', icon: 'grid_on', run: () => MT.subdivide(), enabled: () => !!(window.Mesh && Mesh.selected.length), bid: 'bbtouch_subdivide' },
			{ id: 'loop_cut', label: 'Loop Cut' },
			{ id: 'knife_tool', label: 'Knife' },
			{ id: 'merge_vertices', label: 'Merge' },
			{ id: 'split_mesh', label: 'Split' },
			{ id: 'merge_meshes', label: 'Join' },
			{ id: 'create_face', label: 'Fill Face' },
			{ id: 'invert_face', label: 'Flip Normals' },
			{ id: 'dissolve_edges', label: 'Dissolve' },
			{ id: 'solidify_mesh_selection', label: 'Solidify' },
			{ id: 'switch_face_crease', label: 'Crease' },
		] },
		transform: { label: 'Transform', short: 'Move', icon: 'open_with', items: [
			{ id: 'move_tool', label: 'Move' },
			{ id: 'rotate_tool', label: 'Rotate' },
			{ id: 'resize_tool', label: 'Scale' },
			{ id: 'pivot_tool', label: 'Pivot' },
			{ label: 'Move by…', icon: 'pin', bid: 'bbtouch_move_by', run: () => MT.openMoveBy(), enabled: () => !!(window.Outliner && Outliner.selected.length) },
			{ id: 'mirror_modeling', label: 'Mirror' },
			{ id: 'proportional_editing', label: 'Soft Sel.' },
			{ id: 'vertex_snap_tool', label: 'Snap' },
			{ id: 'toggle_all_grids', label: 'Grid' },
			{ id: 'origin_to_geometry', label: 'Origin→Geo' },
			{ id: 'flip_x', label: 'Flip X' },
			{ id: 'apply_mesh_rotation', label: 'Apply Rot.' },
		] },
		// Reference images / blueprints (touch/reference.js): trace a character sheet behind the model
		ref: { label: 'Reference', short: 'Ref', icon: 'wallpaper', items: [
			...['front', 'right', 'back', 'left', 'top'].map(side => ({
				label: '+ ' + ({ front: 'Front', right: 'Right', back: 'Back', left: 'Left', top: 'Top' })[side],
				icon: 'add_photo_alternate', bid: 'bbtouch_ref_add_' + side,
				run: () => BBT.reference.addBlueprint(side),
				enabled: () => !!(BBT.reference && window.Format && !Format.image_editor),
			})),
			{ sep: true },
			...['front', 'right', 'top'].map(side => ({
				label: ({ front: 'Front View', right: 'Side View', top: 'Top View' })[side],
				icon: ({ front: 'crop_portrait', right: 'crop_landscape', top: 'crop_square' })[side], bid: 'bbtouch_ref_view_' + side,
				run: () => BBT.reference.setView(side),
				active: () => !!(window.Preview && Preview.selected && BBT.reference && Preview.selected.angle === BBT.reference.presetFor(side)),
			})),
			{ label: '3D View', icon: '3d_rotation', bid: 'bbtouch_ref_view_3d', run: () => BBT.reference.setView('perspective'),
				active: () => !!(window.Preview && Preview.selected && !Preview.selected.isOrtho) },
			{ sep: true },
			{ label: 'Edit', icon: 'open_with', bid: 'bbtouch_ref_edit',
				dynamic_label: () => (BBT.reference && BBT.reference.editing()) ? 'Done' : 'Edit',
				dynamic_icon: () => (BBT.reference && BBT.reference.editing()) ? 'check' : 'open_with',
				run: () => BBT.reference.edit(), active: () => !!(BBT.reference && BBT.reference.editing()),
				enabled: () => !!(BBT.reference && BBT.reference.list().length) },
			{ label: 'Opacity', icon: 'opacity', bid: 'bbtouch_ref_opacity', run: () => BBT.reference.openOpacity(),
				enabled: () => !!(BBT.reference && BBT.reference.list().length) },
			{ label: 'Show/Hide', icon: 'hide_image', bid: 'bbtouch_ref_toggle', run: () => BBT.reference.toggleAll(),
				enabled: () => !!(BBT.reference && BBT.reference.list().length) },
			{ label: 'Delete', icon: 'delete', bid: 'bbtouch_ref_delete', run: () => BBT.reference.removeSelected(),
				enabled: () => !!(BBT.reference && BBT.reference.selected()) },
		] },
		uv: { label: 'UV & Texture', short: 'UV/Tex', icon: 'image', items: [
			{ id: 'create_texture', label: 'New Texture' },
			{ id: 'import_texture', label: 'Import' },
			{ label: 'UV Editor', icon: 'grid_4x4', bid: 'bbtouch_uv_editor', run: () => BBT.generic && BBT.generic.showUVEditor(), active: () => !!(BBT.generic && BBT.generic.uvVisible()) },
			{ id: 'uv_project_from_view', label: 'Project View' },
			{ id: 'uv_auto', label: 'Auto UV' },
			{ id: 'uv_maximize', label: 'Maximize' },
			{ id: 'uv_turn_mapping', label: 'Turn' },
			{ id: 'uv_mirror_x', label: 'Mirror U' },
			{ id: 'uv_mirror_y', label: 'Mirror V' },
			{ id: 'merge_uv_vertices', label: 'Merge UV' },
			{ id: 'connect_uv_faces', label: 'Connect UV' },
			{ id: 'snap_uv_to_pixels', label: 'Snap UV' },
			{ id: 'apply_texture_to_elements', label: 'Apply Tex.' },
			{ id: 'seam_tool', label: 'Seams' },
		] },
	};
	const ANIMATE_ITEMS = [
		{ id: 'jump_to_timeline_start', label: 'Start' },
		{ id: 'timeline_frame_back', label: '−1 Frame' },
		{ label: 'Play', icon: 'play_arrow', run: () => BarItems.play_animation && BarItems.play_animation.trigger(),
			active: () => !!(window.Timeline && Timeline.playing), dynamic_icon: () => (window.Timeline && Timeline.playing ? 'pause' : 'play_arrow'),
			dynamic_label: () => (window.Timeline && Timeline.playing ? 'Pause' : 'Play'), enabled: () => !!(window.Animation && Animation.selected), bid: 'bbtouch_play' },
		{ id: 'timeline_frame_forth', label: '+1 Frame' },
		{ id: 'jump_to_timeline_end', label: 'End' },
		{ sep: true },
		{ id: 'add_animation', label: 'Animation' },
		{ id: 'add_keyframe', label: 'Keyframe' },
		{ id: 'previous_keyframe', label: 'Prev Key' },
		{ id: 'next_keyframe', label: 'Next Key' },
		{ id: 'looped_animation_playback', label: 'Loop' },
		{ id: 'timeline_graph_editor', label: 'Graph' },
		{ id: 'set_animation_end', label: 'Set End' },
		{ id: 'animation_onion_skin', label: 'Onion' },
		{ sep: true },
		{ label: 'Export…', icon: 'ios_share', bid: 'bbtouch_quick_export', run: () => BBT.quickExport && BBT.quickExport.open() },
	];

	let bar, row1, row2, picker;

	function iconNode(icon) {
		try { return Blockbench.getIconNode(icon); } catch (e) { const i = document.createElement('i'); i.className = 'material-icons'; i.textContent = icon; return i; }
	}
	function itemIcon(item) {
		if (item.dynamic_icon) return item.dynamic_icon();
		if (item.icon) return item.icon;
		const b = item.id && BarItems[item.id];
		return (b && b.icon) || 'help_outline';
	}
	function itemEnabled(item) {
		if (item.enabled) return !!item.enabled();
		if (item.run) return true;
		const b = item.id && BarItems[item.id];
		if (!b) return false;
		try { return Condition(b.condition); } catch (e) { return false; }
	}
	function itemActive(item) {
		if (item.active) return !!item.active();
		const b = item.id && BarItems[item.id];
		if (!b) return false;
		if (b instanceof Toggle) return !!b.value;
		if (b instanceof Tool) return Toolbox.selected === b;
		return false;
	}
	function makeButton(item) {
		if (item.sep) { const s = document.createElement('div'); s.className = 'bbt_mb_sep'; return s; }
		const btn = document.createElement('button');
		btn.className = 'bbt_mb_btn';
		btn.dataset.bid = item.id || item.bid || ('prim_' + (item.prim || item.label));
		const b = item.id && BarItems[item.id];
		btn.title = (b && b.name) || item.label;
		btn.append(iconNode(itemIcon(item)));
		const l = document.createElement('span');
		l.className = 'bbt_mb_label';
		l.textContent = item.dynamic_label ? item.dynamic_label() : item.label;
		btn.append(l);
		btn._bbt_item = item;
		return btn;
	}
	function runItem(item, btn) {
		if (!itemEnabled(item)) {
			const b = item.id && BarItems[item.id];
			Blockbench.showQuickMessage((b ? b.name : item.label) + ': ' + hintFor(item), 1600);
			return;
		}
		// actions act on the 3D viewport context (delete/duplicate depend on the active panel)
		if (window.Prop) Prop.active_panel = 'preview';
		if (item.run) item.run(btn);
		else BarItems[item.id].trigger({ type: 'bbtouch', target: btn, ctrlOrCmd: false, shiftKey: false });
		setTimeout(MT.refresh, 30);
	}
	function hintFor(item) {
		const id = item.id || '';
		if (/mesh_selection|loop_cut|merge_vertices|dissolve|create_face|invert_face|split_mesh|crease/.test(id)) return 'select vertices / edges / faces of a mesh first';
		if (/uv_/.test(id)) return 'select elements / faces first';
		if (id === 'add_keyframe') return 'select a group/bone and an animation first';
		if (/keyframe|timeline|animation/.test(id)) return 'add/select an animation first';
		return 'not available right now';
	}

	function build() {
		bar = document.createElement('div');
		bar.id = 'bbt_meshbar';
		bar.innerHTML = '<div class="bbt_mb_row bbt_mb_row1"></div><div class="bbt_mb_row bbt_mb_row2"></div>';
		row1 = bar.querySelector('.bbt_mb_row1');
		row2 = bar.querySelector('.bbt_mb_row2');
		if (window.ResizeObserver) new ResizeObserver(() => updateInset()).observe(bar);
		bar.addEventListener('pointerdown', e => { e.stopPropagation(); if (e.pointerType !== 'mouse') e.preventDefault(); });
		bar.addEventListener('contextmenu', e => { e.preventDefault(); e.stopPropagation(); });
		bar.addEventListener('click', e => {
			const btn = e.target.closest('button');
			if (!btn || !bar.contains(btn)) return;
			e.preventDefault(); e.stopPropagation();
			if (btn.dataset.sel) {
				setSelectionMode(btn.dataset.sel);
			} else if (btn.dataset.cat) {
				MT.setCategory(btn.dataset.cat);
			} else if (btn.dataset.ctl === 'drag') {
				MT.setDragSelect(!MT.drag_select);
				Blockbench.showQuickMessage(MT.drag_select ? 'Drag = box select (2 fingers still orbit/zoom)' : 'Drag = orbit', 1400);
			} else if (btn.dataset.ctl === 'collapse') {
				MT.collapsed = !MT.collapsed;
				BBT.store.set('meshbar_collapsed', MT.collapsed);
				render(); // rebuild: the collapsed class + chevron are set in build()
			} else if (btn._bbt_item) {
				runItem(btn._bbt_item, btn);
			}
		});
		// horizontal swipe scrolls row 2 (touch-action pan-x in CSS)
		const host = document.getElementById('preview') || document.body;
		host.append(bar);
		MT.bar = bar;
		render();
	}

	function setSelectionMode(v) {
		const s = BarItems.selection_mode;
		if (!s) return;
		if (!Condition(s.condition)) {
			Blockbench.showQuickMessage('Select a mesh first (tap it in Object mode)', 1600);
			return;
		}
		s.change(v);
		if (window.Toolbox && Toolbox.selected && ['knife_tool', 'seam_tool'].includes(Toolbox.selected.id)) BarItems.move_tool.select();
		MT.refresh();
	}

	MT.setCategory = function (id) {
		if (!CATEGORIES[id]) return;
		MT.category = id;
		BBT.store.set('meshbar_category', id);
		if (MT.collapsed) { MT.collapsed = false; BBT.store.set('meshbar_collapsed', false); }
		render();
	};

	/** --bbt-meshbar-h = space the bar takes at the bottom of the viewport (0 when hidden), so other
	 *  viewport overlays (upstream's vertical tool column on iPhone) can stay above it. */
	let last_inset = -1;
	function updateInset() {
		let h = 0;
		if (bar && bar.classList.contains('visible')) {
			const host = bar.offsetParent || bar.parentElement;
			const hr = host && host.getBoundingClientRect(), br = bar.getBoundingClientRect();
			if (hr && br.height) h = Math.max(0, Math.round(hr.bottom - br.top + 6));
		}
		if (h === last_inset) return;
		last_inset = h;
		document.documentElement.style.setProperty('--bbt-meshbar-h', h + 'px');
	}
	MT.updateInset = updateInset;

	function render() {
		if (!bar) return;
		const animate = !!(window.Modes && Modes.animate);
		bar.classList.toggle('animate', animate);
		bar.classList.toggle('collapsed', !!MT.collapsed);
		row1.innerHTML = '';
		row2.innerHTML = '';
		const collapse = document.createElement('button');
		collapse.className = 'bbt_mb_btn bbt_mb_small';
		collapse.dataset.ctl = 'collapse';
		collapse.title = MT.collapsed ? 'Show tools' : 'Hide tools';
		collapse.append(iconNode(MT.collapsed ? 'expand_less' : 'expand_more'));
		if (animate) {
			row1.append(collapse);
			const t = document.createElement('span');
			t.className = 'bbt_mb_title';
			t.textContent = 'Animate';
			row1.append(t);
			row2.append(collapse.cloneNode(true));
			ANIMATE_ITEMS.forEach(it => row2.append(makeButton(it)));
		} else {
			const seg = document.createElement('div');
			seg.className = 'bbt_mb_seg';
			SEL_MODES.forEach(m => {
				const b = document.createElement('button');
				b.className = 'bbt_mb_btn bbt_mb_segbtn';
				b.dataset.sel = m.value;
				b.title = m.label + ' select mode';
				b.append(iconNode(m.icon));
				const l = document.createElement('span'); l.className = 'bbt_mb_label'; l.textContent = m.label; b.append(l);
				seg.append(b);
			});
			row1.append(collapse, seg);
			const drag = document.createElement('button');
			drag.className = 'bbt_mb_btn bbt_mb_drag';
			drag.dataset.ctl = 'drag';
			drag.append(iconNode('highlight_alt'));
			const dl = document.createElement('span'); dl.className = 'bbt_mb_label'; drag.append(dl);
			row1.append(drag);
			const cats = document.createElement('div');
			cats.className = 'bbt_mb_cats';
			for (const id in CATEGORIES) {
				const c = CATEGORIES[id];
				const b = document.createElement('button');
				b.className = 'bbt_mb_cat';
				b.dataset.cat = id;
				b.title = c.label;
				b.append(iconNode(c.icon));
				const cl = document.createElement('span'); cl.textContent = c.short || c.label; b.append(cl);
				cats.append(b);
			}
			row1.append(cats);
			CATEGORIES[MT.category].items.forEach(it => {
				if (it.id && !BarItems[it.id]) return;
				row2.append(makeButton(it));
			});
		}
		MT.refresh();
	}

	MT.refresh = function () {
		if (!bar) return;
		const show = !!(window.Project && window.Modes && (Modes.edit || Modes.animate) && BBT.enabled !== false &&
			!(window.Blockbench && Blockbench.isMobile && false));
		const want_animate = !!(window.Modes && Modes.animate);
		if (want_animate !== bar.classList.contains('animate')) return render();
		bar.classList.toggle('visible', show);
		document.documentElement.classList.toggle('bbt-meshbar-visible', show && !MT.collapsed);
		MT.visible = show;
		updateInset();
		if (!show) return;
		const s = BarItems.selection_mode;
		const sel_enabled = !!(s && Condition(s.condition));
		bar.querySelectorAll('[data-sel]').forEach(b => {
			b.classList.toggle('active', !!s && s.value === b.dataset.sel && sel_enabled);
			b.classList.toggle('disabled', !sel_enabled);
		});
		const drag = bar.querySelector('[data-ctl="drag"]');
		if (drag) {
			drag.classList.toggle('active', MT.drag_select);
			drag.querySelector('.bbt_mb_label').textContent = MT.drag_select ? 'Box Select' : 'Orbit';
			drag.title = 'One-finger drag in the viewport: ' + (MT.drag_select ? 'box select' : 'orbit') + ' (tap to switch)';
			drag.querySelector('i, .icon') && drag.replaceChild(iconNode(MT.drag_select ? 'highlight_alt' : '3d_rotation'), drag.firstChild);
		}
		bar.querySelectorAll('[data-cat]').forEach(b => b.classList.toggle('active', b.dataset.cat === MT.category));
		bar.querySelectorAll('.bbt_mb_row2 .bbt_mb_btn').forEach(btn => {
			const it = btn._bbt_item;
			if (!it) return;
			btn.classList.toggle('disabled', !itemEnabled(it));
			btn.classList.toggle('active', itemActive(it));
			if (it.dynamic_icon) {
				const ic = itemIcon(it);
				if (btn.dataset.icon !== ic) { btn.dataset.icon = ic; btn.replaceChild(iconNode(ic), btn.firstChild); }
			}
			if (it.dynamic_label) btn.querySelector('.bbt_mb_label').textContent = it.dynamic_label();
		});
	};

	// ---------------------------------------------------------------------------
	// Primitive picker (big tiles)
	function openPrimitivePicker() {
		const html = PRIMITIVES.map(p => `<button class="bbt_prim_tile" data-shape="${p.shape}"><i class="material-icons">${p.icon}</i><span>${p.label}</span></button>`).join('');
		const d = new Dialog({
			id: 'bbtouch_add_mesh',
			title: 'Add Mesh',
			width: 520,
			lines: [`<div class="bbt_prim_grid">${html}</div><p class="bbt_hint">Adjust size / sides afterwards in the panel at the bottom of the viewport.</p>`],
			buttons: ['dialog.cancel'],
			cancelIndex: 0,
		});
		d.show();
		const node = d.object || (d.node);
		(node instanceof HTMLElement ? node : node[0]).querySelectorAll('.bbt_prim_tile').forEach(b => {
			b.addEventListener('click', () => { d.close(0); MT.addPrimitive(b.dataset.shape); });
		});
		picker = d;
	}
	MT.openPrimitivePicker = openPrimitivePicker;

	// ---------------------------------------------------------------------------
	BBT.onReady(() => {
		try {
			new Action('bbtouch_subdivide', {
				name: 'Subdivide',
				description: 'Split the selected faces (or the whole mesh) into 4 (touch layer)',
				icon: 'grid_on',
				category: 'edit',
				condition: { modes: ['edit'], features: ['meshes'], method: () => Mesh.selected.length > 0 },
				click: () => MT.subdivide(),
			});
			new Action('bbtouch_move_by', {
				name: 'Move Selection By…',
				icon: 'pin',
				category: 'transform',
				condition: () => Outliner.selected.length > 0,
				click: () => MT.openMoveBy(),
			});
			const mesh_menu = MenuBar.menus.mesh;
			if (mesh_menu) mesh_menu.addAction(BarItems.bbtouch_subdivide);
			const tf = MenuBar.menus.transform;
			if (tf) tf.addAction(BarItems.bbtouch_move_by);
		} catch (e) { console.error('[BBTouch mesh-tools] actions', e); }
		build();
		const upd = () => MT.refresh();
		['update_selection', 'select_mode', 'select_project', 'unselect_project', 'select_format', 'finished_edit', 'undo', 'redo', 'select_animation', 'timeline_play', 'timeline_pause', 'add_animation'].forEach(ev => {
			try { Blockbench.on(ev, upd); } catch (e) { /* unknown event */ }
		});
		BBT.on('touch_mode', upd);
		// tools / toggles changed elsewhere (keyboard, menus)
		setInterval(() => { if (bar && bar.classList.contains('visible') && !document.hidden) MT.refresh(); }, 700);
	});
})();
