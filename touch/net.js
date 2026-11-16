/* Blockbench Touch layer — privacy / offline network guard (M8).
 *
 * Loaded first (before touch.js and the upstream bundle). Blocks upstream's
 * telemetry, update checks and remote start-screen news so the app sends nothing
 * on its own and behaves identically offline:
 *   - blckbn.ch/api/event/*   (new_installation, recurring_user, successful_update, install_plugin)
 *   - blckbn.ch/api/stats/*   (plugin download stats)
 *   - web.blockbench.net/content/news.json (remote start-screen news) is redirected to the
 *     bundled ./content/news.json (upstream's Promise.all on it has no .catch → it must not fail)
 *   - api.github.com/repos/JannisX11/blockbench/releases (About dialog update check)
 * Blocked XHRs (jQuery) fail asynchronously with a normal `error` event, blocked fetches
 * resolve with an empty 503 response, so upstream's error paths run quietly.
 *
 * Still allowed (user-initiated or graceful when offline): plugin store / theme store,
 * model sharing, Sketchfab upload, Minecraft skin lookup, links. The upstream boot-time
 * theme update check (`fetch(...blockbench-themes...)` without .catch) is converted to an
 * empty 503 response when the network is unreachable instead of an unhandled rejection.
 *
 * BBTouch.net.blocked lists what was blocked (for tests / debugging).
 */
(function () {
	'use strict';
	const BLOCK = [
		/^https?:\/\/(www\.)?blckbn\.ch\/api\/(event|stats)\//i,
		/^https?:\/\/api\.github\.com\/repos\/JannisX11\/blockbench\/releases/i,
	];
	// remote GETs that upstream issues at boot without handling a network failure
	const SOFT_FAIL = [
		/^https?:\/\/cdn\.jsdelivr\.net\/gh\/JannisX11\/blockbench-themes\//i,
	];
	// remote → bundled local copy
	const REDIRECT = [
		[/^https?:\/\/web\.blockbench\.net\/content\/news\.json/i, './content/news.json'],
	];
	const net = { blocked: [], redirected: [], soft_failed: [], rules: BLOCK };
	(window.BBTouch = window.BBTouch || {}).net = net; // touch.js keeps the existing object

	function abs(url) {
		try { return new URL(String(url), location.href).href; } catch (e) { return String(url); }
	}
	const isBlocked = url => BLOCK.some(r => r.test(url));
	function redirect(url) {
		const a = abs(url);
		for (const [r, to] of REDIRECT) if (r.test(a)) { net.redirected.push(a); return to; }
		return url;
	}
	net.isBlocked = url => isBlocked(abs(url));

	// --- XMLHttpRequest (jQuery.ajax) ---------------------------------------------
	const XHR = window.XMLHttpRequest;
	if (XHR && XHR.prototype) {
		const open = XHR.prototype.open, send = XHR.prototype.send;
		XHR.prototype.open = function (method, url) {
			this.__bbt_blocked = isBlocked(abs(url)) ? abs(url) : null;
			const args = [...arguments];
			args[1] = redirect(url);
			return open.apply(this, args);
		};
		XHR.prototype.send = function () {
			if (!this.__bbt_blocked) return send.apply(this, arguments);
			const xhr = this;
			net.blocked.push(xhr.__bbt_blocked);
			setTimeout(() => {
				try {
					xhr.dispatchEvent(new ProgressEvent('error'));
					xhr.dispatchEvent(new ProgressEvent('loadend'));
				} catch (e) { /* ignore */ }
			}, 0);
		};
	}

	// --- fetch ------------------------------------------------------------------------
	const origFetch = window.fetch;
	if (origFetch) {
		const empty = () => new Response('', { status: 503, statusText: 'Offline' });
		window.fetch = function (input, init) {
			const url = abs(typeof input === 'string' || input instanceof URL ? input : (input && input.url));
			if (isBlocked(url)) { net.blocked.push(url); return Promise.resolve(empty()); }
			const p = origFetch.apply(this, arguments);
			if (SOFT_FAIL.some(r => r.test(url))) return p.catch(() => { net.soft_failed.push(url); return empty(); });
			return p;
		};
	}

	// --- service worker ----------------------------------------------------------------
	// upstream registers ./service_worker.js in web mode; we don't ship one (and WKWebView's
	// capacitor:// scheme doesn't support them) → skip the request + 404 log
	try {
		if (navigator.serviceWorker && navigator.serviceWorker.register) {
			navigator.serviceWorker.register = function (url) {
				net.blocked.push(abs(url));
				return Promise.reject(new Error('Service workers are not used in Blockbench Touch'));
			};
		}
	} catch (e) { /* ignore */ }

	// --- navigator.sendBeacon -------------------------------------------------------------
	if (navigator.sendBeacon) {
		const beacon = navigator.sendBeacon.bind(navigator);
		navigator.sendBeacon = function (url) {
			if (isBlocked(abs(url))) { net.blocked.push(abs(url)); return true; }
			return beacon.apply(null, arguments);
		};
	}
})();
