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
  - injects `<link href="touch/touch.css">` and `<script src="touch/touch.js">` before `</head>`
  - replaces the viewport meta with `maximum-scale=1, user-scalable=no, viewport-fit=cover`
