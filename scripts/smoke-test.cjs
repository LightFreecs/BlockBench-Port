#!/usr/bin/env node
// Headless smoke test of the assembled www/ on an emulated iPad (touch).
// Usage: node scripts/smoke-test.cjs [--screenshot docs/screenshots/m1.png]
const { chromium } = require('playwright');
const path = require('path');
const { spawn } = require('child_process');

const root = path.resolve(__dirname, '..');
const port = 8765 + Math.floor(Math.random() * 100);
const shotArg = process.argv.indexOf('--screenshot');
const shot = shotArg > -1 ? path.resolve(root, process.argv[shotArg + 1]) : null;

(async () => {
	const server = spawn(process.execPath, [path.join(root, 'scripts/serve.mjs'), String(port)], { stdio: 'ignore' });
	await new Promise(r => setTimeout(r, 500));
	const browser = await chromium.launch();
	let failed = false;
	try {
		const context = await browser.newContext({
			viewport: { width: 1180, height: 820 }, deviceScaleFactor: 1, hasTouch: true, isMobile: true,
		});
		const page = await context.newPage();
		const logs = [], errors = [];
		page.on('console', m => { logs.push(`[${m.type()}] ${m.text()}`); if (m.type() === 'error') errors.push(m.text()); });
		page.on('pageerror', e => errors.push('pageerror: ' + e.message));

		await page.goto(`http://localhost:${port}/`, { waitUntil: 'load' });
		await page.waitForFunction(() => window.Formats && window.Formats.free && window.Blockbench && document.getElementById('start_screen'), null, { timeout: 30000 });
		await page.waitForTimeout(1000);

		const touchLoaded = logs.some(l => l.includes('Blockbench Touch layer loaded'));
		const hasClass = await page.evaluate(() => document.documentElement.classList.contains('bb-touch'));
		const result = await page.evaluate(() => {
			Formats.free.new();
			if (window.Dialog && Dialog.open) Dialog.open.confirm();
			const cube = new Cube({ name: 'test_cube', from: [-4, 0, -4], to: [4, 8, 4] }).init();
			Canvas.updateAll();
			return { format: Format && Format.id, projects: ModelProject.all.length, cubes: Cube.all.length, version: Blockbench.version };
		});
		await page.waitForTimeout(800);
		if (shot) await page.screenshot({ path: shot });

		// Ignore benign network errors (no internet / service worker absence).
		const fatal = errors.filter(e => !/Failed to load resource|service_worker|net::ERR|blckbn\.ch|favicon|bad HTTP response code \(404\) was received when fetching the script/i.test(e));
		console.log({ touchLoaded, hasClass, ...result, consoleErrors: errors, fatalErrors: fatal });
		failed = !touchLoaded || !hasClass || result.format !== 'free' || result.cubes !== 1 || fatal.length > 0;
	} catch (e) {
		console.error(e); failed = true;
	} finally {
		await browser.close();
		server.kill();
	}
	console.log(failed ? 'SMOKE TEST FAILED' : 'SMOKE TEST PASSED');
	process.exit(failed ? 1 : 0);
})();
