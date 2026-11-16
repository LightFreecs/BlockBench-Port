#!/usr/bin/env node
// Minimal static server for www/ (no deps). Usage: node scripts/serve.mjs [port]
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..', 'www');
const port = Number(process.argv[2] || process.env.PORT || 8080);
const types = {
	'.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript',
	'.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml',
	'.webp': 'image/webp', '.jpg': 'image/jpeg', '.ttf': 'font/ttf', '.woff': 'font/woff',
	'.woff2': 'font/woff2', '.webmanifest': 'application/manifest+json', '.map': 'application/json',
};

if (!fs.existsSync(root)) { console.error('www/ not found — run `npm run build` first'); process.exit(1); }

const server = http.createServer((req, res) => {
	let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
	if (p.endsWith('/')) p += 'index.html';
	const file = path.join(root, path.normalize(p));
	if (!file.startsWith(root)) { res.writeHead(403); return res.end(); }
	fs.stat(file, (err, st) => {
		if (err || !st.isFile()) { res.writeHead(404); return res.end('Not found'); }
		res.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
		fs.createReadStream(file).pipe(res);
	});
});
server.listen(port, () => console.log(`Serving www/ at http://localhost:${port}/`));
