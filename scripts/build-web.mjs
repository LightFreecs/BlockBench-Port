#!/usr/bin/env node
// Builds upstream Blockbench (web target) and assembles a self-contained www/
// folder for Capacitor, then injects the touch layer (touch/*) into index.html.
//
// Usage: node scripts/build-web.mjs [--skip-upstream] [--sourcemap]
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const bb = path.join(root, 'blockbench');
const www = path.join(root, 'www');
const args = new Set(process.argv.slice(2));

function run(cmd, cwd) {
	console.log(`$ ${cmd}  (in ${path.relative(root, cwd) || '.'})`);
	execSync(cmd, { cwd, stdio: 'inherit' });
}

// 1. Upstream build
if (!args.has('--skip-upstream')) {
	if (!fs.existsSync(path.join(bb, 'node_modules'))) run('npm ci', bb);
	run('npm run build-web', bb);
}
if (!fs.existsSync(path.join(bb, 'dist/bundle.js'))) {
	throw new Error('blockbench/dist/bundle.js missing – upstream build failed?');
}

// 2. Assemble www/
fs.rmSync(www, { recursive: true, force: true });
fs.mkdirSync(www, { recursive: true });

// Runtime files referenced by index.html / the bundle. lang/*.json, themes and
// keymaps are bundled into dist/bundle.js by esbuild, so they are not copied.
const copyList = [
	'index.html',
	'dist/bundle.js',
	'css',
	'font',
	'assets',
	'lib',        // gif.worker.js (loaded at runtime)
	'content',    // news.json + start screen images
	'favicon.png',
	'icon.png',
	'icon_full.png',
	'icon_maskable.png',
	'manifest.webmanifest',
];
if (args.has('--sourcemap')) copyList.push('dist/bundle.js.map');

for (const rel of copyList) {
	const src = path.join(bb, rel);
	if (!fs.existsSync(src)) { console.warn(`warn: missing ${rel}`); continue; }
	fs.cpSync(src, path.join(www, rel), { recursive: true });
}

// 3. Touch layer
fs.cpSync(path.join(root, 'touch'), path.join(www, 'touch'), { recursive: true });

const indexPath = path.join(www, 'index.html');
let html = fs.readFileSync(indexPath, 'utf8');
const head = '\t<link rel="stylesheet" href="touch/touch.css" id="bb_touch_stylesheet">\n'
	+ '\t<link rel="stylesheet" href="touch/files.css">\n'
	+ '\t<link rel="stylesheet" href="touch/ui.css" id="bb_touch_ui_stylesheet">\n'
	+ '\t<link rel="stylesheet" href="touch/pencil.css">\n';
// Capacitor core runtime (window.Capacitor.registerPlugin etc.). The iOS native bridge only
// injects the low-level bridge, plugins are reached through this. Harmless in a browser.
const capJs = path.join(root, 'node_modules/@capacitor/core/dist/capacitor.js');
if (!fs.existsSync(capJs)) throw new Error('node_modules/@capacitor/core missing – run npm ci in the repo root');
fs.mkdirSync(path.join(www, 'touch/vendor'), { recursive: true });
fs.copyFileSync(capJs, path.join(www, 'touch/vendor/capacitor.js'));
// Classic (non-module) script runs before the deferred module bundle, so the
// touch layer can set up globals/hooks before Blockbench boots.
// touch.js (core) must come first; the others register on window.BBTouch.
// M6 (UI): longpress.js must come before inputs.js (shared touch listeners order).
const touchScripts = ['touch.js', 'pencil.js', 'modifiers.js', 'gestures.js', 'toolbar.js', 'files.js', 'longpress.js', 'inputs.js', 'ui.js'];
for (const f of touchScripts) {
	if (!fs.existsSync(path.join(root, 'touch', f))) throw new Error(`touch/${f} missing`);
}
const script = '\t<script src="touch/vendor/capacitor.js"></script>\n' + touchScripts
	.map((f, i) => `\t<script src="touch/${f}"${i === 0 ? ' id="bb_touch_script"' : ''}></script>\n`)
	.join('');
if (!html.includes('</head>')) throw new Error('index.html has no </head>');
html = html.replace('</head>', head + script + '</head>');
// Viewport: disable page zoom so pinch gestures go to the editor.
html = html.replace(
	/<meta name="viewport"[^>]*>/,
	'<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover">'
);
fs.writeFileSync(indexPath, html);

const size = execSync(`du -sh "${www}"`).toString().split('\t')[0];
console.log(`www/ assembled (${size})`);
