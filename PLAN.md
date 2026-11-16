# Blockbench iOS Port — Master Plan

Goal: a private-use iOS app (unsigned IPA, sideloaded) of Blockbench (upstream https://github.com/JannisX11/blockbench, GPL-3.0, v5.2.2 at commit ec0b2827) with much better touch support. **Main feature: the "Generic Model" format** for making game assets (mesh + cube modeling, UV/texturing, animation, export glTF/GLB/OBJ/FBX).

## Architecture
- `blockbench/` — upstream source vendored via `git subtree --squash` (pinned). Built with its own `npm run build-web` (esbuild, target=web). Keep upstream edits minimal; list every upstream edit in `PATCHES.md`.
- `touch/` — our own JS/CSS modules (touch gestures, modifier toolbar, iOS file bridge, UI tweaks, Pencil). Injected into the web build (e.g. via a post-build step that adds `<script>`/`<link>` tags to the built `index.html`, or an import from upstream's entry if needed).
- `ios/` — Capacitor iOS project (`@capacitor/ios`), `webDir` = assembled web output (e.g. `www/`).
- `scripts/` — build scripts: build blockbench web → assemble `www/` with touch layer → `npx cap sync ios`.
- `.github/workflows/build-ipa.yml` — macOS runner: build web, cap sync, `xcodebuild` unsigned (CODE_SIGNING_ALLOWED=NO), package `Payload/App.app` into `BlockbenchTouch.ipa`, upload artifact.

## Milestones
1. Scaffold: subtree, Capacitor project, build scripts, web build verified in headless Chromium.
2. GitHub Actions macOS workflow producing an unsigned IPA artifact.
3. Touch viewport gestures (1-finger orbit, 2-finger pan, pinch zoom, double-tap focus) + floating modifier toolbar (Shift/Ctrl/Alt toggles, undo/redo).
4. Files app open/save/export via Capacitor plugins (Filesystem/Share/file picker) replacing web download/upload paths.
5. MAIN FEATURE — Generic Model workflow fully usable on touch: quick-start button, mesh/cube tools, vertex/edge/face select, extrude, subdivide etc., UV/texture, animation, export glTF/GLB/OBJ (FBX if available) to Files. E2E test in headless Chromium.
6. UI touch improvements: long-press context menus, bigger hit targets, collapsible panels, numeric scrub/keypad.
7. Apple Pencil pressure + palm rejection for texture paint.
8. Polish, README (sideload via AltStore/Sideloadly/TrollStore) + Generic Model quick guide, final review.

## Rules for every session
- Branch: `claude/affectionate-mayer-nlj62q`. `git fetch origin claude/affectionate-mayer-nlj62q && git merge --no-edit FETCH_HEAD` before starting and before pushing. Never force-push. No PRs.
- Update `PROGRESS.md` (status, what was done, how to test, known issues, next steps) at the end of each milestone, commit, push.
- Cannot build iOS locally (Linux). Verify web parts with headless Chromium (Playwright preinstalled; `require('playwright')`, use touch emulation `hasTouch: true`, iPad viewport).
- Don't commit `node_modules`, build outputs (`www/`, `blockbench/dist` etc.) — add to `.gitignore`.
