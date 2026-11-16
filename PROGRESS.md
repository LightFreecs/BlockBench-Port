# Progress

| # | Milestone | Status |
|---|-----------|--------|
| 1 | Scaffold | done |
| 2 | IPA CI workflow | done |
| 3 | Touch viewport + modifier toolbar | done |
| 4 | Files app integration | done |
| 5 | Generic Model workflow (main feature) | done |
| 6 | UI touch improvements | done |
| 7 | Apple Pencil | done |
| 8 | Polish + README | pending |

## Log

### M7 — Apple Pencil + painting (done)

**Features** (`touch/pencil.js`, `touch/pencil.css`; small hooks in `gestures.js`, `longpress.js`, `toolbar.js`; native double-tap in `ios/App/App/SceneDelegate.swift`)
- **Pencil = precise pointer.** `pointerType 'pen'` never enters finger-gesture logic (gestures.js ignores it, OrbitControls
  stays off for it): with a paint tool it paints immediately (3D viewport and 2D UV/texture editor), otherwise it is a
  mouse-like click/drag (select, gizmo — the gizmo hover is computed on pen-down since most iPads have no hover).
- **Pressure → size / opacity** with a curve (Soft / Linear / Firm), min size %, min opacity %, optional **tilt → size**.
  The brush-size slider is the size at full pressure. Implemented by wrapping `Painter.useBrush` (temporarily overrides
  `slider_brush_size/opacity.get` and disables upstream's own pressure modifiers, which cap the size at 20 px).
- **Coalesced events:** intermediate `getCoalescedEvents()` samples of the stroke pointer are fed to
  `Painter.movePaintToolCanvas` / `UVEditor.movePaintTool` → fast strokes follow the real 240 Hz pen path.
- **Palm rejection:** touches on the viewport / UV editor are ignored while a pen is down and for 300 ms after it lifts;
  touches with a contact diameter > 56 px (pointer `width/height`) are always ignored; a touch that started ≤ 600 ms
  before the pen lands (palm first) is cancelled and its orbit/pan reverted; while a pen stroke runs no other pointer
  reaches upstream's stroke handlers. Apple Pencil never triggers the M6 long-press menu.
- **"Pencil only draws"** (Auto = switches on after the first Pencil use with a toast, On, Off; upstream's
  `paint_with_stylus_only` also forces it): fingers never paint. 3D: 1-finger orbit, 2-finger pan/pinch, taps don't paint
  dots, 2-/3-finger tap undo/redo. **UV editor (new):** 1-finger pan, 2-finger pan + pinch zoom (anchored, upstream wheel
  maths), 2-/3-finger tap undo/redo.
- **Finger painting** (no Pencil used yet, or mode Off): a finger paints; a second finger turns the stroke into navigation
  and reverts it if it was younger than 450 ms (`Undo.cancelEdit(true)`), so a 2-finger tap is a clean undo of the
  previous action instead of undoing a stray dot. Works in 3D and in the UV editor.
- **Brush bar** (floating, bottom of the viewport, paint mode + paint tool + touch mode): brush, eraser toggle, fill,
  eyedropper (one pick, then back to the previous tool), size + opacity sliders (one undo step), colour swatch → colour
  popover (iOS system colour picker via `<input type=color>`, recent colours, palette, swap, eyedropper, "show Color panel"),
  undo/redo, ✎ settings (green dot = Pencil-only active).
- **Pencil settings popover** (✎ in the brush bar and in the floating toolbar): all options above + pressure test pad,
  palm rejection toggle, double-tap action, haptics, brush bar toggle. Persisted in `bbtouch.pencil`.
- **Haptics:** `@capacitor/haptics` added (Package.swift updated by `cap sync`). `BBTouch.haptic(style)` — tool switches
  (selection), undo/redo from the bar (light), M6 long press now goes through it (medium); `navigator.vibrate` fallback.
- **Apple Pencil double-tap (Pencil 2 / Pro):** `BBBridgeViewController` (subclass of `CAPBridgeViewController`, in
  SceneDelegate.swift, no project-file changes) adds a `UIPencilInteraction` and sends window event `bbtouchPencilTap`
  with the user's system preference (`switchEraser` / `switchPrevious` / `showColorPalette` / `ignore`). JS maps it
  (setting "System") or uses a fixed action: eraser toggle, last tool, colour popover, off.

**How to test**
```
npm run build:fast
npm run test:pencil        # 42 checks, iPad 1180x820; pen = CDP Input.dispatchMouseEvent pointerType 'pen' + force
node scripts/test-pencil.cjs --screenshot docs/screenshots/m7.png
npm test                   # smoke + touch + files + ui + pencil
```
Covers: finger paints before Pencil use; pen paints; pressure → size (light vs firm, ramp inside one stroke), pressure →
opacity; auto Pencil-only after first use; finger drag orbits / tap doesn't paint / 2-finger nav in paint mode; touch
during pen stroke rejected (no paint, no camera move); touch right after pen lift ignored; large-radius palm ignored;
palm-first orbit reverted when the pen lands; finger mode 2-finger tap = clean undo; coalesced samples painted
(synthetic `coalescedEvents`); brush bar size/eraser/eyedropper/undo/colour popover; toolbar ✎ settings, persistence,
test pad, outside-tap close; double-tap event toggles eraser; UV editor: pen paints, pinch zoom + 1-finger pan in
Pencil-only, finger paints + 2-finger pinch without paint in finger mode; edit mode: pen tap selects without gestures.

**CI:** Build IPA run #8 (merge of M5 + M7, commit `8dcb53d`) green: web job + unsigned IPA (xcodebuild compiled
`BBBridgeViewController`, SPM resolved `CapacitorHaptics`).

**Known issues / not verified**
- Headless Chromium only; real Apple Pencil pressure range in WKWebView (`force / maximumPossibleForce`, normal writing
  ≈ 0.2–0.4) → the default "Soft" curve; tune on device. Pointer `width/height` for palms in WKWebView should reflect the
  touch radius — verify the 56 px threshold on device.
- The double-tap Swift code compiles in CI but is untested on hardware. iOS 17.5+ squeeze (Pencil Pro) is not handled.
- Pressure modifies size/opacity per dab; `draw_shape_tool`/`gradient_tool`/fill ignore pressure (upstream behaviour).
- Palm rejection is limited to the 3D viewport and the UV editor; panels elsewhere get normal touch.

### M5 — Generic Model workflow by touch (done)

**Features** (new files `touch/mesh-tools.js`, `touch/generic.js`, `touch/export.js`, `touch/generic.css`; small hooks in
`touch/gestures.js` (dragHook) and `touch/files.js` (`quiet`); no upstream edits)
- **Quick start**: "New Generic Model" card at the top of the start screen with preset tiles (Blank, Cube, Sphere, Cylinder,
  Ico Sphere, **Humanoid** = 6 box meshes in 6 bones with pivots), *Options…* dialog (name, texture/UV size 16–1024, remembered),
  File › New Generic Model…, ➕ in the floating toolbar. Uses `newProject(Formats.free)` (no upstream project dialog), box UV off,
  Edit mode, camera framed.
- **Mesh Tools bar** (bottom of the viewport, Edit mode): big Object/Face/Edge/Vertex toggles, **Orbit ⇄ Box Select** drag toggle,
  categories Add (block, 13 primitives via one tap/picker, bone wrap, group, locator, to mesh) / Mesh (extrude, inset, subdivide,
  loop cut, knife, merge, split, join, fill face, flip normals, dissolve, solidify, crease) / Move (tools, **Move by…** numeric dialog,
  mirror modeling, soft selection, vertex snap, grid, origin→geometry, flip, apply rotation) / UV & Texture (new texture, import,
  UV editor, project from view, auto UV, maximize, turn, mirror, merge/connect UV, snap, apply texture, seams). Disabled buttons
  explain what to select. Toggles/tools show state. Collapsible; compact sizes on iPhone. Upstream's amend panel is lifted above it.
- **Animate bar** (Animate mode): Start, ±1 frame, Play/Pause, End, Animation, Keyframe, prev/next key, Loop, Graph editor, Set End,
  Onion skin, Export…. Animate tab enlarged.
- **Subdivide** (new action `bbtouch_subdivide`, also in the Mesh menu): quad→4, tri→4, n-gon→n quads; shared midpoints, UVs
  interpolated, unselected neighbours with one split edge re-triangulated (mesh stays closed).
- **Box select by touch drag** through upstream's selection rectangle (`startSelRect`/`moveSelRect`/`stopSelRect`, driven by pointer
  events); 2 fingers still navigate; sticky Shift/Ctrl extend.
- **UV editor**: "UV Editor" button reveals the panel (sidebar / mobile sheet). Upstream already supports pinch/pan and 1-finger UV drag
  — verified by test.
- **Timeline**: 2-finger pinch zooms the time axis around the fingers, 2-finger drag scrolls; ruler drag scrubs (upstream).
- **Quick Export** (`File › Quick Export…`, toolbar ⤴, bar Export…): multi-select GLB / glTF / FBX / OBJ / .bbmodel, scale, embed
  textures, animations, "share afterwards"; remembered in `bbtouch.quick_export`. Runs upstream codecs with the dialog bypassed,
  writes via M4 (Exports/, sub-folders for multi-file), one summary dialog with Share-all.
- `docs/GENERIC_MODEL_GUIDE.md`: illustrated user guide incl. Unity/Godot/Unreal/Roblox import, scale and axis notes.

**How to test**
```
npm run build:fast
npm run test:generic                      # 48 checks, iPad 1180x820, CDP touch, mocked Capacitor (installMock from test-files.cjs)
node scripts/test-generic.cjs --screenshots   # docs/screenshots/m5-*.png
npm test                                  # all suites (smoke, touch, files, ui, generic)
```
Covers: start card visible on top, menu/toolbar entries, options dialog (size remembered), blank project defaults, add cube by bar,
face mode, tap-select face, sticky Shift multi-select, extrude (+4v/+4f), amend panel above bar, subdivide (closed mesh, 4 selected),
Move by…, box select by drag (no orbit) and back to orbit, Create Texture (template) applied, UV editor visible, UV pinch zoom,
UV face drag, bone wrap, Animate tab ≥34 px, add animation, keyframe button, ruler scrub, timeline pinch, start/play/pause, graph editor,
Quick Export of 4 formats (GLB magic `glTF`, glTF meshes+animations+embedded image, OBJ v/vt/f + mtllib + MTL + PNG, FBX header/
geometry/AnimationStack), options remembered, Share all, .bbmodel save + reopen (mesh/texture/bone/animation), Humanoid preset.
CI web job now also runs `scripts/test-generic.cjs`. CI: Build IPA run #6 green (web + generic test, unsigned IPA) —
https://github.com/LightFreecs/BlockBench-Port/actions/runs/43838151311

**Known issues**
- No lasso select (upstream has none); box select only.
- Subdivide is simple midpoint subdivision (no smoothing); neighbours with ≥2 split edges keep T-junctions.
- The transform gizmo can sit on top of the face you want to tap (same as desktop) — tap off-centre or orbit a bit.
- FBX export is upstream ASCII; binary FBX ("experimental" upstream) isn't offered in Quick Export.
- Bar labels are English only.
- Headless Chromium only; device check needed for the bar's horizontal swipe vs. button taps in WKWebView.

### M6 — Touch-friendly UI (done)

**Features** (all in `touch/`, no upstream edits; active when touch mode is on, `html.bb-touch-mode`)
- `touch/longpress.js` — **long press (450 ms, 10 px slop) = right click everywhere** outside the 3D viewport: dispatches a
  synthetic `contextmenu` at the element under the finger, so every upstream context menu works (outliner, textures, UV
  editor, timeline/keyframes, animations, tabs, panels, sliders…). Growing accent ring under the finger + haptic
  (Capacitor Haptics if ever installed, `navigator.vibrate` otherwise). After it fires the rest of the touch is swallowed
  (no scroll, no outliner drag, no click on the menu that opened under the finger). Chromium's own touch `contextmenu`
  is suppressed (no double menus). On toolbar buttons the long press first shows the **tooltip**; keep holding ~0.65 s
  more for the context menu. Excludes editable inputs, resizers, our own UI.
- `touch/gestures.js` (M3) — the viewport long press now opens the element/canvas menu **while holding** (iOS style).
- `touch/inputs.js` — **NumSliders** (`.nslide`): horizontal drag = scrub (12 px/step, upstream interval incl. sticky
  Shift/Ctrl), value bubble above the finger, one undo step; vertical drag = native panel scroll (never scrubs);
  **precision**: hold ~400 ms then drag, or move the finger >70 px above/below the slider → 0.1× steps ("fine" badge);
  hold + lift = upstream slider menu (copy/paste/round/reset); **tap = keypad popover** (digits, `.`, `±`, `⌫`, `C`,
  `+ − × ÷ ( )`, nudge −/+ step (applied live), ⌨ = fall back to the iOS keyboard, ✓). Values go through upstream's
  own input path (`stopInput`: MolangParser, `+5`/`*2` relative, `val`, `%`). No contenteditable → no keyboard popping up.
  Dialog/form number fields (`.numeric_input input`, `input[type=number]`) also get the keypad on tap. Short screens
  (height < 520) use a side-by-side keypad layout so it fits on iPhone landscape.
- `touch/ui.js` — **sidebar edge buttons** (wide layouts): tabs on the left/right edge of the viewport hide/show the
  sidebars (persisted in `bbtouch.sidebars`). **Quick Actions**: "⚡ Actions" in the menu bar + ⚡ button in the floating
  toolbar open upstream's action search (command palette) *without* popping the keyboard (tap the field to type).
  **Menus**: compat `mouseenter/mouseover` after a touch are blocked for menu-bar items and menu entries, so a tap on
  another menu switches instead of open→close flicker; submenus open on tap. **Keyboard**: document scroll is locked
  when the iOS keyboard opens; a focused field inside a dialog that would be covered lifts the dialog (visualViewport).
- `touch/ui.css` — bigger targets in touch mode: menu entries ≥44 px, toolbar tools 36–40 px, outliner rows 36 px +
  bigger toggles, panel headers/menu buttons 34–36 px, tabs, sliders, numeric inputs, checkboxes 22 px, dialog buttons
  ≥42 px, color pickers, range thumbs, wider scrollbars, 14 px resize lines (`touch-action: none`, so the sidebar
  resize drag works by touch), `overscroll-behavior: contain` + momentum on panel scroll areas; hover tooltips and
  hover-only slider arrows disabled. All colours from upstream theme variables (checked in dark and light themes).
- `touch/toolbar.js` (M3) — ⚡ Quick Actions button; default position is re-applied after the layout settles (it used to
  land over the left sidebar) and clears the edge toggle; **compact layouts** (upstream mobile layout, i.e. iPhone /
  height ≤ 500): horizontal, collapsed by default, bottom-left of the viewport.
- Compact layout (iPhone): upstream's own mobile layout already presents panels as slide-over sheets from the panel
  selector bar; we enlarge its targets and keep our toolbar out of the way rather than inventing a second drawer system.

**How to test**
```
npm run build:fast
npm run test:ui                       # 49 checks, iPad 1180x820 + iPhone 844x390 (CDP Input.dispatchTouchEvent)
node scripts/test-ui.cjs --screenshots            # docs/screenshots/m6-ipad.png, m6-ipad-menu.png, m6-ipad-actions.png,
                                                  # m6-iphone.png, m6-iphone-menu.png, m6-iphone-keypad.png
node scripts/test-ui.cjs --only ipad --light --screenshots   # m6-ipad-light.png (+ menu, then rename) in the light theme
npm test                              # smoke + touch (M3) + files (M4) + ui (M6)
```
Covers: long-press outliner → menu while holding, stays open, selects, no drag helper, ≥44 px rows, tap entry runs it;
short tap selects; long press textures panel / project tab; slider scrub, one undo step, precision scrub, vertical drag
doesn't scrub, tap → keypad (no editing/keyboard), keypad entry, expression, nudge, slider hold menu; edge buttons
hide/show sidebars; sidebar resize by touch; menu bar open/switch/close, submenu on tap; tool tap without sticky tooltip,
long-press tooltip; Quick Actions (menu bar + toolbar) without keyboard; dialog number input via keypad; viewport hold
menu; iPhone: compact layout, panel selector ≥44 px, outliner sheet long press, slider scrub, keypad fits on screen.
`scripts/test-touch.cjs` now pins the floating toolbar to the far left (it is now really placed inside the viewport and
would sit under the pinch fingers).

**Known issues / not verified**
- Headless Chromium only. iOS WKWebView compat-mouse/click behaviour after `preventDefault` on `touchend` should match,
  but a device check is needed (esp. the iOS "hover content change swallows the click" heuristic on menus — mitigated by
  blocking compat mouseover).
- No real haptics: `@capacitor/haptics` isn't installed (`navigator.vibrate` doesn't exist on iOS). Add the plugin later
  and longpress.js uses it automatically.
- The outliner still starts its upstream drag at 320 ms; if you move between 320 and 450 ms it's a re-order drag
  (intended), holding still gives the menu.
- Keyboard lifting only handles inputs inside dialogs / action search; inputs in panels rely on WKWebView's own scrolling
  (document scroll is locked to 0 so the layout doesn't jump).
- Wider `::-webkit-scrollbar` has no effect where iOS uses overlay scrollbars.
- Long-press tooltips only for `.tool` elements with an upstream `.tooltip` child (toolbars); other elements use `title`.

### M4 — iOS Files app integration (done)

**Features** (`touch/files.js` + `touch/files.css`; active only when `Capacitor.isNativePlatform()`, upstream web behaviour otherwise)
- **Export / save** (`Blockbench.export` = `Filesystem.exportFile` wrapped) → app Documents dir (Files › On My iPad/iPhone › Blockbench Touch):
  `.bbmodel` → `Projects/`, images → `Textures/` (screenshots → `Screenshots/`), everything else → `Exports/` (overwrites same name).
  Text is written as utf8, binary (GLB, PNG, ArrayBuffer/Blob/data URL) as base64.
  Multi-file outputs go into a sub-folder: upstream's web `assets.zip` bundles (OBJ+MTL+PNG, FBX+PNG, DAE+PNG) are unpacked to
  `Exports/<name>_<ext>/`; glTF/GLB with *embed textures* off → `Exports/<name>_gltf|glb/` + the referenced PNGs.
  Afterwards a "Saved to Blockbench Touch/…" dialog with **Share** (share sheet: Save to Files / AirDrop, all files of a folder) /
  **Share .zip** (multi-file) / **OK**. Calls with a `custom_writer` (desktop-only paths, form "save" fields) fall through to upstream.
- **Save in place**: the Documents path is remembered per project (`Project.bbtouch_doc_path`, also set when opening from Documents).
  Ctrl+S / Save / Smart Save overwrite silently (quick message); first save picks a unique name from the project name;
  **Save As** asks for a new name. Project saves on iOS don't also "download" each unsaved texture (they're embedded in the .bbmodel).
- **Import** (`Blockbench.import` = `Filesystem.importFile` wrapped): `<input type=file>` attached to the DOM, *no* `accept` filter
  (iOS greys out .bbmodel/.obj/.gltf/.glb/.fbx when it can't map them to UTIs) except `image/*` for image-only imports (gives the
  photo library), real `multiple` (upstream sets `multiple="false"`, which HTML treats as true), no upstream "File Type" pre-dialog;
  picked files are filtered by extension afterwards (quick message for skipped ones), then read by upstream `Filesystem.readFile`
  (text/ArrayBuffer/data URL as requested).
- **Browse Documents** dialog (File menu after *Open Model*, and a "Your files" section on the start screen): Files/Recent tabs,
  breadcrumbs, 52 px rows, tap = open; `⋯` = Open / Share / Rename / Delete (folders: Share all files / Rename / Delete); new folder,
  refresh, "Import from Files…" (= Open Model picker). Opening: `.bbmodel` → new tab (or selects the tab already holding that path),
  images → `loadImages`, other model formats → `loadModelFile`, `.obj`/`.mtl` → upstream *Import OBJ* dialog pre-filled with the obj
  + sibling mtl (needs a mesh-capable project, e.g. Generic Model), anything else → offer Share.
- **Backups**: every 3 min (if unsaved changes), when the app is hidden/paused (`visibilitychange`, App `pause`) and via
  *File › Back Up Project to Documents*: `Backups/<name>_<uuid8>_<yyyymmdd-hhmmss>.bbmodel`, skipped if unchanged, keeps the newest 5
  per project / 40 total. Upstream IndexedDB autosave keeps working in WKWebView (unchanged).
- **Open in Blockbench Touch**: `Info.plist` gets `CFBundleDocumentTypes` (bbmodel = Owner; glTF/GLB/OBJ/FBX/3D content, PNG/JPEG/images,
  JSON = Alternate), `UTExportedTypeDeclarations` (`com.lightfreecs.blockbenchtouch.bbmodel`, conforms to public.json) and
  `UTImportedTypeDeclarations` (gltf, glb, obj, fbx). `SceneDelegate.swift` copies opened file URLs that are outside our Documents
  folder (security-scoped, `NSFileCoordinator`) to `Documents/Imported/<name>` *before* forwarding to Capacitor; JS (`@capacitor/app`
  `appUrlOpen` + `getLaunchUrl`) maps the URL to `Imported/<name>` or, for files already in Documents, opens them in place.
- `@capacitor/app` added (Package.swift regenerated by `cap sync`). `scripts/build-web.mjs` now ships
  `node_modules/@capacitor/core/dist/capacitor.js` as `www/touch/vendor/capacitor.js` (loaded first): the iOS bridge only injects the
  low-level bridge, `Capacitor.registerPlugin()` comes from core. In a browser it just reports platform `web`.

**API** (`BBTouch.files`): `cap` (adapter: `isNative()`, `plugin(name)` — the only place touching `window.Capacitor`), `docs`
(`write/readText/readBase64/readBuffer/list/stat/exists/mkdir/remove/rename/uri/uniquePath`, Documents-relative), `share(paths)`,
`showSavedDialog`, `openBrowser(path)`, `openDocument(path)`, `backupNow()`, `handleOpenUrl(url)`, `recent`, `config`, `last_export`.

**How to test**
```
npm run build:fast
npm run test:files     # 45 checks, mocked window.Capacitor (in-memory Filesystem, Share, App)
npm test               # smoke + touch + files
```
`scripts/test-files.cjs` blocks `touch/vendor/capacitor.js` (it would replace the mock's `isNativePlatform`) and injects the mock with
`addInitScript`. Covers: folders, menu/start screen entries, first save/dialog/Share, in-place Ctrl+S, Save As, glTF (embedded),
glTF (external textures → folder), GLB (binary magic, base64), OBJ → folder + Share all, FBX → folder, texture save → Textures/,
browser listing / open .bbmodel / save in place / rename / delete / Recent, file picker (no accept, multiple, binary multi-read,
extension filter, image/* for images), OBJ open → pre-filled import dialog → mesh, backups + pruning, appUrlOpen (foreign URL →
Imported/, Documents URL → in place), no console errors, and that a plain browser still downloads via upstream.
Also run in CI (web job, screenshot artifact `test-results/files.png`). Screenshot: `docs/screenshots/m4.png`.

**Known issues / not verified on device**
- Native code paths (Swift copy, real Filesystem/Share/App plugins, iOS document picker, share sheet) are only compile-checked in CI;
  the JS is tested against a mock with the plugin semantics (base64 vs utf8, `recursive`, `readdir` shape). Check on device:
  "Open in" from Files/Mail, Share › Save to Files, picker with .bbmodel/.glb, large exports (base64 over the bridge ~1.33× size).
- Files opened from another location are copied into `Imported/`, so Save writes the copy, not the original (no in-place editing of
  iCloud/other-provider files). `Imported/` files with the same name are overwritten by the next import.
- Exports overwrite an existing file of the same name in `Exports/` (like re-exporting on desktop); only project saves uniquify.
- Backups cover the *current* project only (other open tabs are backed up when they become current and change).
- The share sheet needs a source rect on iPad; the Share plugin anchors it itself — verify it doesn't appear off-screen.
- `Documents/.share/` (hidden) keeps the last shared .zip; harmless.
- Upstream still shows its own "Saved as …" quick message after exports in addition to our dialog.

**Notes for M5 (Generic Model export flow)**
- Generic Model exports already land in `Exports/`: `Codecs.gltf.export()` (asks encoding/embed/scale/animations), `Codecs.obj.export()`,
  `Codecs.fbx.export()`; each shows the Saved dialog with Share. A quick-export button can call these directly; `BBTouch.files.last_export`
  holds `{file_name, result:{paths, folder}}` and `BBTouch.on('files_saved', r => …)` fires after every write.
- To share right after exporting without the dialog: `BBTouch.files.share(BBTouch.files.last_export.result.paths)`.
- E2E tests for M5 can reuse the mock from `scripts/test-files.cjs` (`installMock`).

### M2 — IPA CI workflow (done)

**Workflow** `.github/workflows/build-ipa.yml` ("Build IPA"); triggers: push to `main` / `claude/**`, manual `workflow_dispatch`.
Concurrency cancels superseded runs on the same ref.
- Job `web` (ubuntu-latest, ~1 min): Node 22 → `npm ci` → `npm run build` → installs `playwright@1.63.0` with `--no-save`
  (it is not in package.json, so the global Playwright in dev containers keeps working) + `npx playwright install --with-deps chromium`
  → smoke test with screenshot → artifact `web-smoke-screenshot` (7 days).
- Job `ipa` (macos-15, ~3 min): `maxim-lobanov/setup-xcode` latest-stable (it resolved to **Xcode 26.3**) → Node 22 → `npm ci` → `npm run sync` →
  `xcodebuild -project ios/App/App.xcodeproj -scheme App -configuration Release -sdk iphoneos -destination generic/platform=iOS
  -derivedDataPath build -clonedSourcePackagesDirPath build/SourcePackages CODE_SIGNING_ALLOWED=NO CODE_SIGNING_REQUIRED=NO CODE_SIGN_IDENTITY="" DEVELOPMENT_TEAM=""`
  (the full log goes to `build/xcodebuild.log`; only errors are shown, plus the last 150 lines if the build fails; the log is uploaded as `xcodebuild-log` on failure)
  → `Payload/App.app` → `BlockbenchTouch.ipa` (the step checks that `public/index.html` is inside) → artifact **`BlockbenchTouch-ipa`** (30 days, stored uncompressed).
- Caches: npm (setup-node, both lockfiles), `blockbench/node_modules` (keyed on its lockfile + OS), SPM (`build/SourcePackages` + `~/Library/Caches/org.swift.swiftpm`).
- The Xcode project needed no changes: the Capacitor template has no script phases (so user-script sandboxing doesn't matter), uses automatic signing with no team, bundle id
  `com.lightfreecs.blockbenchtouch`, and iOS 15. It has no shared scheme, but xcodebuild auto-creates the `App` scheme.

**Result**: first run passed. https://github.com/LightFreecs/BlockBench-Port/actions/runs/43827374819 (IPA 6.1 MB, artifact id 14207038077).

**Downloading the IPA**: GitHub → Actions → "Build IPA" → latest green run → Artifacts → `BlockbenchTouch-ipa` (a zip that contains `BlockbenchTouch.ipa`).
Unzip it, then sideload with AltStore / Sideloadly / TrollStore; these re-sign the app with your Apple ID. Needs a GitHub login.

**Known issues**
- Runner warning: the v4 actions (checkout/setup-node/cache/upload-artifact) target Node 20 and are forced to run on Node 24. Harmless; bump the major versions later.
- `latest-stable` Xcode can change under us. If a future Xcode breaks the build, pin `xcode-version` (e.g. `'26.3'`).
- The app has not been run on a device yet; a launch check comes with M3/M4 testing.

### M1 — Scaffold (done)

**Built**
- `blockbench/` — upstream v5.2.2 (`ec0b2827`) via `git subtree --squash`. No upstream edits (see `PATCHES.md`).
- `scripts/build-web.mjs` — runs `npm ci` (if needed) + `npm run build-web` in `blockbench/`, then assembles `www/`:
  `index.html`, `dist/bundle.js` (esbuild output, ~8.6 MB; lang/themes/keymaps are bundled into it),
  `css/`, `font/`, `assets/`, `lib/` (gif.worker.js), `content/`, icons, manifest. ~14 MB total.
  Copies `touch/` and injects `touch/touch.css` + `touch/touch.js` (classic script, runs before the module bundle) into `www/index.html`;
  also sets viewport `user-scalable=no, viewport-fit=cover`. `--skip-upstream` reuses an existing build, `--sourcemap` ships the .map.
- `touch/touch.js` / `touch/touch.css` — stub: logs `Blockbench Touch layer loaded`, adds `bb-touch` class to `<html>`, exposes `window.BBTouch`.
- Capacitor 8.6 (`@capacitor/core`, `cli`, `ios`, `filesystem`, `share`, `preferences`). `capacitor.config.json`:
  appId `com.lightfreecs.blockbenchtouch`, appName `Blockbench Touch`, webDir `www`, `contentInset: never`, `scrollEnabled: false`,
  `preferredContentMode: desktop`, web inspector enabled.
- `ios/` — generated by `npx cap add ios`. **Uses Swift Package Manager** (`ios/App/CapApp-SPM/Package.swift`), no CocoaPods/Podfile.
  Info.plist: `UIFileSharingEnabled`, `LSSupportsOpeningDocumentsInPlace`, `UIRequiresFullScreen`, `UIStatusBarHidden`,
  all 4 iPad orientations, `arm64` capability. Deployment target iOS 15, device family iPhone+iPad.
- `scripts/serve.mjs` — dependency-free static server for `www/`.
- `scripts/smoke-test.cjs` — Playwright headless Chromium, iPad 1180x820, `hasTouch`/`isMobile`; checks touch layer log + class,
  creates a Generic Model project (`Formats.free.new()`) + a cube, fails on non-benign console errors. Screenshot: `docs/screenshots/m1.png`.

**How to build/test**
```
npm ci                 # root (Capacitor)
npm run build          # upstream web build + assemble www/
npm run serve          # http://localhost:8080
npm run test:web       # headless smoke test (needs www/ built)
npm run sync           # build + npx cap sync ios (copies www/ into ios/App/App/public, regenerates Package.swift)
```

**Gotchas**
- Upstream registers `./service_worker.js` in web mode; we don't ship one → harmless 404 caught by upstream
  (service workers don't work on the `capacitor://` scheme anyway). Smoke test whitelists it.
- Upstream calls `blckbn.ch` stats APIs → CORS errors on localhost; benign. May want to stub these later (privacy/offline).
- `ios/App/App/public`, `ios/App/App/capacitor.config.json`, `config.xml` are generated by `cap sync` and gitignored.
  `ios/capacitor-cordova-ios-plugins` is also gitignored (Capacitor default) — `cap sync` recreates it.
- `Package.swift` references `../../../node_modules/@capacitor/*` → root `npm ci` must run before `xcodebuild`.

**Notes for M2 (CI)**
- macOS runner with Xcode 16+ (Capacitor 8 requires it; iOS 15 deployment target). Node 22.
- Steps: `npm ci` (root) → `npm run sync` (does blockbench `npm ci` + build) →
  `xcodebuild -project ios/App/App.xcodeproj -scheme App -configuration Release -sdk iphoneos -destination 'generic/platform=iOS' -derivedDataPath build CODE_SIGNING_ALLOWED=NO CODE_SIGNING_REQUIRED=NO CODE_SIGN_IDENTITY=""`
  (SPM resolves `capacitor-swift-pm` from GitHub — no CocoaPods needed) →
  `mkdir Payload && cp -r build/Build/Products/Release-iphoneos/App.app Payload/ && zip -r BlockbenchTouch.ipa Payload`.
- Cache `~/.npm`, `blockbench/node_modules`, and SPM (`build/SourcePackages`).

### M3 — Touch viewport + modifier toolbar (done)

**Features** (all in `touch/`, no upstream edits)
- `touch/touch.js` — core: `window.BBTouch` namespace, `BBTouch.store` (localStorage, try/catch), event bus, `BBTouch.onReady`
  (polls until `Preview`, `Transformer`, `BarItems`, `Pressing`, `THREE` exist), touch-mode flag (`BBTouch.setEnabled`, persisted,
  `html.bb-touch-mode`), tunables in `BBTouch.config`, suppresses iOS `gesturestart/change/end`.
- `touch/gestures.js` — 3D viewport gestures via window **capture-phase** pointer listeners (run before upstream's canvas listeners):
  - 1 finger drag = orbit (also when starting on an element — the touch-down no longer selects), drag on gizmo = upstream transform,
    tap = upstream select (the held-back `pointerdown` is replayed into `preview.click()` on lift), long press (≥420 ms) = upstream
    context menu on lift, double-tap element = `focus_on_selection` (zoom variant), double-tap empty = frame all elements
    (`camera_initial` if empty), 2 fingers = pan + pinch-zoom simultaneously (zoom anchored at the pinch centre),
    2-finger tap = undo, 3-finger tap = redo.
  - Upstream OrbitControls touch handling is disabled per instance by wrapping `controls.isEnabled` while the last input was touch
    (mouse unaffected). This also fixes an upstream bug where every touch-orbit ended in "unselect all" (OrbitControls reset
    `hasMoved` before `preview.mouseup`).
  - Paint tools / brushes / knife / weight brush keep upstream 1-finger behaviour; 2-finger navigation still works there.
  - `touchstart`/`touchmove` on preview canvases are `preventDefault`ed; CSS `touch-action: none` on `.preview` and its canvas.
  - Gizmo ×1.5 in touch mode (wraps `Transformer.getScale`); raycaster point/line thresholds ×1.5 extra (on `update_camera_position`).
- `touch/modifiers.js` — sticky Shift/Ctrl(⌘)/Alt driving upstream's own `Pressing.overrides` (read by Keybind.isTriggered,
  additionalModifierTriggered, snapping, selection, outliner, UV…), plus patches `shiftKey/ctrlKey/metaKey/altKey` onto
  pointer/mouse/touch events (capture phase) for code that only reads the event. States off/once/lock; one-shot modifiers are
  cleared ~80 ms after the next non-navigation pointer sequence outside the toolbar. Syncs with upstream's status-bar modifier menu.
- `touch/toolbar.js` + `touch/touch.css` — floating toolbar: Shift, Ctrl/⌘, Alt, Undo, Redo, Focus (frame all if nothing selected),
  Duplicate, Delete, touch-mode toggle; 46 px buttons, grip to drag, collapse button; position/collapsed state in localStorage
  (`bbtouch.toolbar`); themed with Blockbench CSS variables (`--color-ui`, `--color-button`, `--color-accent`, …); z-index 19
  (below menus/dialogs). Default position: top-left inside the 3D viewport. `BBTouch.toolbar.resetPosition()`.
- `scripts/build-web.mjs` injects `touch.js, modifiers.js, gestures.js, toolbar.js` (in that order) + `touch.css`.

Note on upstream semantics: in the viewport **Ctrl = multi-select (toggle)**, **Shift = group select** (for root-level elements it
behaves like multi-select), **Alt = loop select** (mesh edges). In the outliner Shift = range select.

**How to test**
```
npm run build          # or npm run build:fast after editing touch/*
npm run test:touch     # 31 checks: orbit, pinch, pan, pinch+pan, tap select, double-tap focus/frame, modifiers, undo/redo
                       # gestures + toolbar, duplicate/delete, gizmo size + gizmo drag, toolbar drag/collapse, touch-mode toggle
npm test               # smoke + touch
node scripts/test-touch.cjs --screenshot docs/screenshots/m3.png
```
Uses CDP `Input.dispatchTouchEvent` (real multi-touch → touch + pointer events) on an emulated iPad 1180x820.

**Known issues / not verified**
- Only tested in headless Chromium; WKWebView pointer-event ordering should match but needs a device check (esp. pencil = `pen`).
- Long-press context menu still opens on finger lift (upstream behaviour); an iOS-style "open while holding" belongs to M6.
- Zoom-to-pinch-centre assumes the target is near the focal plane; fine in practice.
- Toolbar is ~600 px tall expanded — on iPhone landscape collapse it (or M6 could add a horizontal layout).
- Selection by tap is replayed on lift, so tools that need a press-and-drag on elements with 1 finger (other than gizmo, paint,
  knife, weight brush) won't get it; add their ids to `passthroughTool()` in `gestures.js` if found (e.g. vertex snap is click-based
  and works).
- Orbit gizmo (top-right axis widget) is hidden by upstream on `isMobile` only; on iPad it's visible and has its own touch drag.

**Notes for later milestones**
- M5/M6: `BBTouch.config` holds tunables (slop, double-tap time, gizmo scale, pick tolerance) – a settings dialog could expose them.
- M7 (Pencil): paint mode currently passes all 1-finger/pen input to upstream; palm rejection should hook into
  `passthroughTool()`/`pointerdown` capture in `gestures.js` (finger in paint mode → orbit, pen → paint).
- `BBTouch.gestures.focusSelection()` / `frameAll()` are reusable from other UI.
