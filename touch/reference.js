/* Blockbench Touch layer — Reference images ("blueprints"), Blender-style.
 *
 * Put a character sheet / concept image behind the model in an orthographic view
 * (Front / Back / Left / Right / Top) and trace over it. Built on upstream's
 * ReferenceImage system (blockbench/js/preview/reference_images.ts), which already
 * stores images in the project (.bbmodel) and pins "blueprint" images to an ortho
 * view. This file adds the touch workflow on top:
 *
 *  - "Reference" tab in the Mesh Tools bar (touch/mesh-tools.js): add a blueprint for a
 *    side in one tap (switches to that view, opens the image picker, places the image
 *    centred and semi-transparent), jump between Front / Side / Top / 3D views,
 *    Edit (move/resize) mode, opacity, show/hide, delete.
 *  - While editing: 1 finger drags the image (upstream), the corner handles resize
 *    (upstream), and 2 fingers pinch-resize + move it (here; upstream has no pinch).
 *  - Outside Edit mode the image sits behind the model and ignores touches, so the
 *    normal viewport gestures (orbit/pan/zoom) keep working — it is effectively locked.
 *
 * "Front" follows the format's forward direction (Generic Model: -Z), like Blender's
 * front view; Right = +X, Left = -X.
 *
 * API: BBTouch.reference = { SIDES, presetFor(side), setView(side), addBlueprint(side, files?),
 *      edit(on?), editing(), list(), selected(), setOpacity(v, refs?), openOpacity(),
 *      toggleAll(), removeSelected(), stats }
 */
(function () {
	'use strict';
	const BBT = window.BBTouch;
	if (!BBT) return;
	const REF = BBT.reference = {};
	REF.stats = { pinch: 0 };

	REF.SIDES = {
		front: { label: 'Front', icon: 'person' },
		back: { label: 'Back', icon: 'person_outline' },
		right: { label: 'Right', icon: 'east' },
		left: { label: 'Left', icon: 'west' },
		top: { label: 'Top', icon: 'north' },
	};
	const DEFAULT_OPACITY = 0.6;
	const IMAGE_EXTENSIONS = ['png', 'jpg', 'jpeg', 'webp', 'bmp', 'gif', 'tif', 'tiff'];

	function available() {
		return !!(window.ReferenceImage && window.Format && !Format.image_editor && window.Preview && Preview.selected);
	}

	/** Upstream camera preset id (south/north/east/west/top) for a side. */
	REF.presetFor = function (side) {
		if (side === 'top') return 'top';
		if (side === 'right') return 'east';
		if (side === 'left') return 'west';
		const fwd = (window.Format && Format.forward_direction) || '-z';
		const front = { '-z': 'north', '+z': 'south', '+x': 'east', '-x': 'west' }[fwd] || 'north';
		const opposite = { north: 'south', south: 'north', east: 'west', west: 'east' };
		return side === 'back' ? opposite[front] : front;
	};

	/** Switch the active viewport to a side's ortho view, or 'perspective' for the 3D view. */
	REF.setView = function (side) {
		if (!window.Preview || !Preview.selected || !window.DefaultCameraPresets) return false;
		const id = side === 'perspective' ? 'initial' : REF.presetFor(side);
		const preset = DefaultCameraPresets.find(p => p.id === id);
		if (!preset) return false;
		Preview.selected.loadAnglePreset(preset);
		if (window.ReferenceImage) ReferenceImage.updateAll();
		return true;
	};

	REF.list = () => (window.ReferenceImage && ReferenceImage.current_project) ? ReferenceImage.current_project.slice() : [];
	REF.selected = () => (window.ReferenceImage && ReferenceImage.selected) || null;
	REF.editing = () => !!(window.ReferenceImageMode && ReferenceImageMode.active);

	REF.edit = function (on) {
		if (!window.ReferenceImageMode) return false;
		const want = on === undefined ? !ReferenceImageMode.active : !!on;
		if (want && !ReferenceImageMode.active) ReferenceImageMode.activate();
		if (!want && ReferenceImageMode.active) ReferenceImageMode.deactivate();
		return ReferenceImageMode.active;
	};

	/** Image-only picker. `accept="image/*"` makes iOS offer Photo Library / Take Photo / Files directly
	 *  (upstream asks for a "File Type" first on touch devices when several extensions are allowed). */
	function pickImages() {
		if (window.isApp) {
			return new Promise(resolve => Blockbench.import({
				resource_id: 'reference_image', extensions: IMAGE_EXTENSIONS, type: 'Image', readtype: 'image',
			}, files => resolve(files || [])));
		}
		return new Promise(resolve => {
			const input = document.createElement('input');
			input.type = 'file';
			input.accept = 'image/*';
			input.className = 'bbtouch_file_input';
			input.style.cssText = 'position:fixed;left:-1000px;top:0;width:1px;height:1px;opacity:0;';
			document.body.appendChild(input);
			input.addEventListener('change', () => {
				const files = [...(input.files || [])];
				input.remove();
				if (!files.length) return resolve([]);
				Filesystem.readFile(files, { readtype: 'image' }, results => resolve(results || []));
			}, { once: true });
			input.click();
		});
	}

	/**
	 * Add an image as a blueprint behind the model for one side.
	 * @param {string} side front|back|left|right|top
	 * @param {{content: string, name?: string}[]} [files] skip the picker (tests / "Open in")
	 */
	REF.addBlueprint = async function (side = 'front', files) {
		if (!available()) {
			Blockbench.showQuickMessage('Open or create a model first', 1600);
			return null;
		}
		REF.setView(side);
		if (!files) files = await pickImages();
		const file = files && files[0];
		if (!file || !file.content) return null;
		// the picker may have taken a while; make sure the view is still the requested side
		if (Preview.selected.angle !== REF.presetFor(side)) REF.setView(side);
		const ref = new ReferenceImage({
			source: file.content,
			name: (file.name || REF.SIDES[side].label).replace(/\.[a-z0-9]+$/i, ''),
			layer: 'background',
			view_mode: 'flat_image',
		});
		ref.opacity = DEFAULT_OPACITY;
		ref.addAsReference(true);
		ref.enableBlueprintMode();
		ref.update().save();
		REF.edit(true);
		ref.select();
		Blockbench.showQuickMessage('Drag to move · pinch or corners to resize · tap Done', 2600);
		BBT.emit('reference_added', { side, ref });
		return ref;
	};

	/** Set opacity (0..1) on the given refs, or the selected one, or all in the project. */
	REF.setOpacity = function (v, refs) {
		const value = Math.min(Math.max(Number(v) || 0, 0), 1);
		refs = refs || (REF.selected() ? [REF.selected()] : REF.list());
		refs.forEach(r => { r.opacity = value; r.visibility = true; r.update().save(); });
		return refs.length;
	};

	REF.openOpacity = function () {
		const refs = REF.selected() ? [REF.selected()] : REF.list();
		if (!refs.length) { Blockbench.showQuickMessage('Add a reference image first', 1600); return; }
		new Dialog({
			id: 'bbtouch_reference_opacity',
			title: refs.length === 1 ? `Opacity: ${refs[0].name}` : 'Opacity: all references',
			form: {
				opacity: { type: 'range', label: 'Opacity', min: 5, max: 100, step: 1, editable_range_label: true, value: Math.round(refs[0].opacity * 100) },
			},
			onFormChange(r) { REF.setOpacity(r.opacity / 100, refs); },
			onConfirm(r) { REF.setOpacity(r.opacity / 100, refs); },
		}).show();
	};

	REF.toggleAll = function () {
		const b = window.BarItems && BarItems.toggle_all_reference_images;
		if (b && REF.list().length) b.click();
	};

	REF.removeSelected = function () {
		const ref = REF.selected();
		if (!ref) { Blockbench.showQuickMessage('Tap Edit, then tap an image to select it', 1800); return; }
		ref.delete();
	};

	// --- 2-finger pinch: resize + move the selected reference while editing ----------------
	function setupPinch() {
		let start = null;
		const metrics = t => ({
			cx: (t[0].clientX + t[1].clientX) / 2,
			cy: (t[0].clientY + t[1].clientY) / 2,
			dist: Math.max(Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY), 1),
		});
		const inViewport = e => !!(e.target && e.target.closest && e.target.closest('#preview, .preview'));
		window.addEventListener('touchstart', e => {
			const ref = REF.selected();
			if (e.touches.length !== 2 || !REF.editing() || !ref || ref.view_mode === 'plane' || !inViewport(e)) return;
			start = Object.assign(metrics(e.touches), { ref, size: ref.size.slice(), pos: ref.position.slice(), zoom: ref.getZoomLevel() || 1 });
			e.preventDefault();
			e.stopImmediatePropagation();
		}, { capture: true, passive: false });
		window.addEventListener('touchmove', e => {
			if (!start) return;
			if (e.touches.length < 2) { start = null; return; }
			e.preventDefault();
			e.stopImmediatePropagation();
			const m = metrics(e.touches);
			const { ref } = start;
			const k = m.dist / start.dist;
			const min = [32 / start.zoom, 24 / start.zoom];
			ref.size[0] = Math.max(start.size[0] * k, min[0]);
			ref.size[1] = Math.max(start.size[1] * k, min[1]);
			ref.position[0] = start.pos[0] + (m.cx - start.cx) / start.zoom;
			ref.position[1] = start.pos[1] + (m.cy - start.cy) / start.zoom;
			if (ref.view_mode !== 'plane' && ref.getClampedPosition) ref.position.replace(ref.getClampedPosition());
			ref.update();
		}, { capture: true, passive: false });
		const end = e => {
			if (!start || e.touches.length >= 2) return;
			start.ref.save();
			REF.stats.pinch++;
			start = null;
		};
		window.addEventListener('touchend', end, { capture: true });
		window.addEventListener('touchcancel', end, { capture: true });
	}

	// Upstream ends reference editing (and unselects the image) on any press outside the image
	// (unselectInterface, a bubbling document listener). Presses on our Mesh Tools bar — Done,
	// Opacity, Delete, views — must not count, so stop them at <body> while editing.
	function shieldMeshBar() {
		const stop = e => {
			if (REF.editing() && e.target && e.target.closest && e.target.closest('#bbt_meshbar')) e.stopPropagation();
		};
		document.body.addEventListener('touchstart', stop, { passive: true });
		document.body.addEventListener('mousedown', stop);
	}

	BBT.onReady(() => {
		setupPinch();
		shieldMeshBar();
		// Leaving the project (or switching modes) closes reference editing, so the image goes
		// back behind the model and stops catching touches.
		Blockbench.on('select_mode', () => { if (REF.editing()) REF.edit(false); });
		Blockbench.on('unselect_project', () => { if (REF.editing()) REF.edit(false); });
	});
})();
