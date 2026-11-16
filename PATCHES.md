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
    `toolbar.js` (in that order) before `</head>`
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
