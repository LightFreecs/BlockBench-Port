# Upstream patches

Upstream: https://github.com/JannisX11/blockbench — vendored into `blockbench/` with
`git subtree add --prefix=blockbench https://github.com/JannisX11/blockbench.git master --squash`.

| Field | Value |
|-------|-------|
| Upstream version | 5.2.2 |
| Upstream commit | `ec0b2827104d0799c153bfb5f867579c0c44652f` |
| Subtree squash commit | `b0b6f120` |

To update later: `git subtree pull --prefix=blockbench https://github.com/JannisX11/blockbench.git master --squash`,
then re-check every patch below.

## Edits to files under `blockbench/`

_None._ All customization lives outside the subtree:

- `scripts/build-web.mjs` copies upstream build output into `www/` and post-processes
  `www/index.html` only (the copy, never the upstream file):
  - injects `<script src="touch/net.js">` first (M8, privacy/offline guard), then `<link href="touch/touch.css">` and `<script>` tags for `touch/touch.js`, `pencil.js` (M7), `modifiers.js`, `gestures.js`,
    `toolbar.js`, `files.js`, `longpress.js`, `inputs.js`, `ui.js`, `mesh-tools.js`, `generic.js`, `export.js` (in that order) before `</head>`, preceded by
    `touch/vendor/capacitor.js` (copied from `node_modules/@capacitor/core/dist/capacitor.js`) and followed by
    `<link href="touch/files.css">`, `<link href="touch/ui.css">`, `<link href="touch/generic.css">` (M5) and `<link href="touch/pencil.css">` (M7)
  - replaces the viewport meta with `maximum-scale=1, user-scalable=no, viewport-fit=cover`

## Runtime hooks (no source edits, applied from `touch/*.js` after Blockbench boots)

Re-check these after an upstream update:

| Hook | Where | Why |
|------|-------|-----|
| `preview.controls.isEnabled` wrapped | `touch/gestures.js` | disables OrbitControls' touch handling while the last input was touch |
| `Transformer.getScale` wrapped | `touch/gestures.js` | ×1.5 gizmo in touch mode |
| `Blockbench.on('update_camera_position')` | `touch/gestures.js` | raycaster point/line thresholds ×1.5 |
| `Pressing.overrides.{shift,ctrl,alt}` written | `touch/modifiers.js` | sticky modifiers |
| relies on `preview.click(event)`, `preview.raycast()`, `preview.rclick_cooldown`, `controls.hasMoved`, `controls.rotateLeft/rotateUp/panLeft/panUp/dollyIn`, `Transformer.dispatchPointerHover` / `hoverAxis`, `preview.occupyTransformer()` | `touch/gestures.js` | gesture integration |
| `Filesystem.exportFile`/`importFile` and `Blockbench.export/exportFile/import/importFile` replaced by wrappers (fall through to the originals unless native; `custom_writer` exports always fall through) | `touch/files.js` | iOS Documents save/export + file picker fixes |
| `BarItems.save_project`, `save_project_as`, `export_over` `.onClick` wrapped | `touch/files.js` | Save As flag; mark textures saved before project save on iOS |
| relies on `Codecs.project.compile/name/context`, `Codecs.gltf/obj/fbx` web export paths (zip named `assets`, `savetype: 'zip'`; glTF `images[].uri` = texture name when not embedded), `loadModelFile`, `loadImages`, `BarItems.import_obj` dialog form ids `obj`/`mtl`, `MenuBar.menus.file.addAction`, `addStartScreenSection`, `Blockbench.textPrompt` (dialog id `text_input`) | `touch/files.js` | Files integration |
| `preview.showContextMenu(fakeTouchendEvent)` called while holding (static_rclick / rclick_cooldown = true) | `touch/gestures.js` | M6: viewport context menu opens during the long press |
| synthetic `contextmenu` MouseEvent dispatched on long press; trusted touch `contextmenu` suppressed; removes `#outliner_drag_helper` | `touch/longpress.js` | M6: long-press = right click (relies on upstream `@contextmenu` handlers) |
| `.nslide` touch/compat-mouse events stopped in capture phase; uses `NumSlider.getInterval/change/update/onBefore/onAfter/stopInput/startInput`, `jq_inner`, `last_value`, `sliding`, `NumSlider.MolangParser` | `touch/inputs.js` | M6: touch scrub + keypad |
| `MenuBar.update` wrapped (re-adds the "Actions" item), compat `mouseenter/mouseover` on `.menu_bar_point` / `ul.contextMenu li` blocked after touch, `Menu.open.hover(li, e, true)` on tap | `touch/ui.js` | M6: tap semantics for menus |
| `Prop.show_left_bar/show_right_bar` + `updateInterface()`, `ActionControl.select()` | `touch/ui.js` | M6: sidebar edge toggles, Quick Actions |
| `BBTouch.gestures.dragHook/dragHookCancel` (extension point in our own `gestures.js`) → `preview.startSelRect(fakeMouseEvent)`, then upstream's document `mousemove/touchmove/mouseup/touchend` sel-rect listeners are removed and `moveSelRect/stopSelRect` are driven from pointer events; relies on `preview.selection.{sr_move_f,sr_stop_f,click_target}` | `touch/mesh-tools.js` | M5: touch box select ("Drag = Box Select") |
| `BarItems.add_mesh.trigger()` + `Dialog.open` (id `add_primitive`) `setFormValues({shape,…})` + `confirm()` | `touch/mesh-tools.js`, `touch/generic.js` | M5: one-tap primitives / presets |
| `BarItems.selection_mode.change(v)`, `BarItems.slider_pos_{x,y,z}.change/onBefore/onAfter`, `Condition(BarItem.condition)`, `new Action('bbtouch_subdivide' / 'bbtouch_move_by' / 'bbtouch_new_generic' / 'bbtouch_quick_export')`, `MenuBar.menus.{file,mesh,transform}.addAction` | `touch/mesh-tools.js`, `touch/generic.js`, `touch/export.js` | M5: Mesh Tools bar, menu entries |
| Mesh internals for Subdivide: `mesh.vertices/faces`, `addVertices/addFaces`, `new MeshFace(mesh,{vertices,uv,texture})`, `face.getSortedVertices()`, `getSelectedFaces/Vertices/Edges(true)`, `Canvas.updateView`, `Undo.initEdit/finishEdit` | `touch/mesh-tools.js` | M5: Subdivide (upstream has none) |
| `newProject(Formats.free)` (skips the project dialog), `Project.texture_width/height/box_uv`, `#start_screen > content` (card prepended) | `touch/generic.js` | M5: quick start |
| `Timeline.vue._data.size/head_width`, `Timeline.updateSize()`, `#timeline_body` touch listeners | `touch/generic.js` | M5: timeline pinch zoom |
| `Panels.uv` (`slot`, `fold`, `moveTo`), `Interface.PanelSelectorVue.select`, `Prop.show_left_bar` | `touch/generic.js` | M5: "UV Editor" button |
| `codec.promptExportOptions` temporarily replaced by an own property (restored afterwards), `Project.export_options[codec.id]`, `codec.export()`; first `Blockbench.export`/`Filesystem.exportFile` call captured; `BarItems.save_project`; `BBTouch.files.quiet` suppresses the M4 "Saved" dialog | `touch/export.js` | M5: Quick Export |
| `Painter.useBrush` wrapped (pen events: temporarily overrides `BarItems.slider_brush_size/slider_brush_opacity.get`, sets `settings.brush_size_modifier/brush_opacity_modifier.value = 'none'`, writes `Painter.current.dynamic_brush_size`) | `touch/pencil.js` | M7: pressure/tilt curve |
| calls `Painter.movePaintToolCanvas(ev)` / `UVEditor.movePaintTool(ev)` with coalesced events; `Painter.stopPaintToolCanvas`, `UVEditor.stopBrush`, `Undo.cancelEdit(true)`, `Painter.brushChanges`, `Painter.paint_stroke_canceled`, `Undo.current_save` | `touch/pencil.js` | M7: coalesced strokes, stroke → navigation |
| `UVEditor.vue.$refs.viewport` scroll, `UVEditor.setZoom`, `vue.getFrameMargin/updateTextureCanvas/mouse_coords`, `UVEditor.updateUVNavigator` | `touch/pencil.js` | M7: UV finger pan/pinch while painting |
| `ColorPanel.get/set/palette/panel.vue._data.history`, `Panels.color`, `Tool.select()`, `settings.paint_with_stylus_only` | `touch/pencil.js` | M7: brush bar / colour popover |
| `XMLHttpRequest.prototype.open/send`, `window.fetch`, `navigator.sendBeacon`, `navigator.serviceWorker.register` wrapped before the bundle loads: `blckbn.ch/api/event|stats/*` and `api.github.com/repos/JannisX11/blockbench/releases` blocked (XHR fails with an `error` event, fetch → empty 503), `web.blockbench.net/content/news.json` redirected to the bundled `./content/news.json` (upstream `Promise.all([news_call, …])` has no `.catch`), boot-time theme update `fetch` (`cdn.jsdelivr.net/gh/JannisX11/blockbench-themes/`) turned into an empty 503 when offline, service worker never registered. Re-check the URLs in `js/boot_loader.js`, `js/interface/start_screen.ts`, `js/interface/about.ts`, `js/plugin_loader.ts`, `js/interface/themes.ts` | `touch/net.js` | M8: privacy / offline |
| window capture `touchstart`/`mousedown` on `#menu_bar .menu_bar_point.opened` stop propagation (keeps upstream `unselectInterface` from closing the menu when `:hover` lags; the label's own `click` then toggles it) | `touch/ui.js` | M8: flaky tap-to-close menu |
| `#outliner_drag_helper` is hidden (not removed) when the long-press menu opens; moving on > 18 px hides `Menu.open` and lets upstream's armed outliner/collection drag continue | `touch/longpress.js` | M8: hold, then drag |
| `Blockbench.showQuickMessage` replaced by a no-op while the export `callback` (`codec.afterDownload/afterSave`) runs | `touch/files.js` | M8: no duplicate "Saved as" message |

| relies on `ReferenceImage` (`addAsReference`, `enableBlueprintMode`, `select`, `update`, `save`, `delete`, `size`/`position` = centre-based, `getZoomLevel`, `getClampedPosition`, `attached_side` default `north`), `ReferenceImageMode.activate/deactivate/active`, `DefaultCameraPresets` ids `initial/north/south/east/west/top`, `Preview.loadAnglePreset`, `Format.forward_direction`, `BarItems.toggle_all_reference_images`, `Filesystem.readFile(files, {readtype:'image'})` | `touch/reference.js` | Reference images / blueprints by touch |
| `<body>` bubbling `touchstart`/`mousedown` stopped for presses inside `#bbt_meshbar` while `ReferenceImageMode.active` (upstream `unselectInterface` would end reference editing / unselect the image before Done / Opacity / Delete run); window capture `touchstart`/`touchmove` with 2 touches in the viewport while editing a selected reference = pinch-resize (stops propagation) | `touch/reference.js` | Reference images |
| `gestures.js` pointerdown returns early while a reference image is being edited and selected (fingers act on the image, not the camera) | `touch/gestures.js` | Reference images |
