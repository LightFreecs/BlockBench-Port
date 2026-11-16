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
  - injects `<link href="touch/touch.css">` and `<script>` tags for `touch/touch.js`, `modifiers.js`, `gestures.js`,
    `toolbar.js`, `files.js`, `longpress.js`, `inputs.js`, `ui.js`, `mesh-tools.js`, `generic.js`, `export.js` (in that order) before `</head>`, preceded by
    `touch/vendor/capacitor.js` (copied from `node_modules/@capacitor/core/dist/capacitor.js`) and followed by
    `<link href="touch/files.css">`, `<link href="touch/ui.css">` and `<link href="touch/generic.css">` (M5)
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
