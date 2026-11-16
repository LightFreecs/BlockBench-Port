#!/usr/bin/env node
// Headless touch-UI test (M6): long-press context menus, slider scrub, keypad, sidebars,
// menus, tooltips, quick actions — on an emulated iPad (1180x820) and iPhone (844x390 landscape).
// Uses CDP Input.dispatchTouchEvent (real touch → touch + pointer + compat mouse events).
// Usage: node scripts/test-ui.cjs [--screenshots] [--light] [--only ipad|iphone]
//   --screenshots  writes docs/screenshots/m6-ipad.png and m6-iphone.png
const { chromium } = require('playwright');
const path = require('path');
const { spawn } = require('child_process');

const root = path.resolve(__dirname, '..');
const port = 8965 + Math.floor(Math.random() * 100);
const argv = process.argv.slice(2);
const want_shots = argv.includes('--screenshots');
const light = argv.includes('--light');
const only = argv.includes('--only') ? argv[argv.indexOf('--only') + 1] : null;

const results = [];
function check(name, ok, info) {
	results.push({ name, ok: !!ok });
	console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${info !== undefined ? '  ' + JSON.stringify(info) : ''}`);
}

async function setupPage(browser, device) {
	const context = await browser.newContext({
		viewport: { width: device.w, height: device.h }, deviceScaleFactor: device.shot ? 2 : 1, hasTouch: true, isMobile: true,
	});
	const page = await context.newPage();
	const errors = [];
	page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
	page.on('pageerror', e => errors.push('pageerror: ' + e.message));
	const cdp = await context.newCDPSession(page);
	const sleep = ms => page.waitForTimeout(ms);
	const touch = (type, points) => cdp.send('Input.dispatchTouchEvent', {
		type, touchPoints: points.map((p, i) => ({ x: p[0], y: p[1], id: p[2] ?? i, radiusX: 5, radiusY: 5, force: 1 })),
	});
	async function tap(x, y, hold = 50) {
		await touch('touchStart', [[x, y]]);
		await sleep(hold);
		await touch('touchEnd', []);
		await sleep(120);
	}
	async function longPress(x, y, hold = 650) {
		await touch('touchStart', [[x, y]]);
		await sleep(hold);
		const during = await page.evaluate(() => !!(window.Menu && Menu.open));
		await touch('touchEnd', []);
		await sleep(150);
		return during;
	}
	async function drag(from, to, steps = 15, hold = 0, stepDelay = 16) {
		await touch('touchStart', [from]);
		if (hold) await sleep(hold);
		for (let s = 1; s <= steps; s++) {
			const k = s / steps;
			await touch('touchMove', [[from[0] + (to[0] - from[0]) * k, from[1] + (to[1] - from[1]) * k]]);
			await sleep(stepDelay);
		}
		await touch('touchEnd', []);
		await sleep(120);
	}
	const rect = sel => page.evaluate(sel => {
		const el = typeof sel === 'string' ? document.querySelector(sel) : null;
		if (!el) return null;
		const r = el.getBoundingClientRect();
		return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height, left: r.left, top: r.top };
	}, sel);
	const closeMenus = () => page.evaluate(() => { if (Menu.open) Menu.open.hide(); if (BBTouch.inputs.keypad.isOpen()) BBTouch.inputs.keypad.close(); });

	await page.goto(`http://localhost:${port}/`, { waitUntil: 'load' });
	await page.waitForFunction(() => window.BBTouch && BBTouch.ready && BBTouch.ui && window.Formats && Formats.free, null, { timeout: 30000 });
	await sleep(400);
	await page.evaluate(light => {
		if (light && window.CustomTheme) {
			const t = CustomTheme.themes.find(t => t.id === 'default_light');
			if (t) CustomTheme.loadTheme(t);
		}
		Formats.free.new();
		if (window.Dialog && Dialog.open) Dialog.open.confirm();
		const names = ['body', 'head', 'arm_left', 'arm_right', 'leg_left', 'leg_right'];
		names.forEach((name, i) => new Cube({ name, from: [-4 + i * 10, 0, -4], to: [4 + i * 10, 8, 4], color: i }).init());
		Canvas.updateAll();
		unselectAllElements();
	}, light);
	await sleep(1200);
	return { page, context, cdp, errors, sleep, touch, tap, longPress, drag, rect, closeMenus };
}

async function runIPad(browser) {
	console.log('\n=== iPad 1180x820 ===');
	const T = await setupPage(browser, { w: 1180, h: 820, shot: want_shots });
	const { page, sleep, tap, longPress, drag, rect, closeMenus, errors } = T;

	const env = await page.evaluate(() => ({ touch: BBTouch.enabled, mobile: Blockbench.isMobile, l: Prop.show_left_bar, r: Prop.show_right_bar }));
	check('ipad: touch mode on, wide layout', env.touch && !env.mobile && env.l && env.r, env);

	// 1. long-press on an outliner row → upstream context menu, opened while holding
	const row = await page.evaluate(() => {
		const el = document.getElementById(Outliner.elements.find(e => e.name === 'arm_left').uuid).querySelector('.outliner_object');
		const r = el.getBoundingClientRect();
		return { x: r.left + 80, y: r.top + r.height / 2, h: r.height };
	});
	check('ipad: outliner row ≥ 36px', row.h >= 36, row.h);
	const open_during = await longPress(row.x, row.y);
	let st = await page.evaluate(() => ({
		open: !!Menu.open, items: Menu.open ? [...Menu.open.node.querySelectorAll(':scope > li')].length : 0,
		sel: Outliner.selected.map(e => e.name), helper: !!document.getElementById('outliner_drag_helper'),
		li_h: Menu.open ? Menu.open.node.querySelector(':scope > li:not(.menu_separator)').getBoundingClientRect().height : 0,
		fired: BBTouch.longpress.fired_count,
	}));
	check('ipad: long-press outliner opens context menu while holding', open_during && st.open && st.items > 3, st);
	check('ipad: …and it stays open after lift (no click-through)', st.open);
	check('ipad: …selects the pressed element', st.sel.includes('arm_left'), st.sel);
	check('ipad: …no leftover outliner drag helper', !st.helper);
	check('ipad: context menu rows ≥ 44px', st.li_h >= 44, st.li_h);
	// tapping a menu entry works (rename → opens text input; use "Duplicate" instead – safe & checkable)
	const dup = await page.evaluate(() => {
		const li = Menu.open && [...Menu.open.node.querySelectorAll('li')].find(li => li.getAttribute('menu_item') === 'duplicate');
		if (!li) return null;
		const r = li.getBoundingClientRect();
		return { x: r.left + 40, y: r.top + r.height / 2 };
	});
	if (dup) {
		const n0 = await page.evaluate(() => Outliner.elements.length);
		await tap(dup.x, dup.y);
		const n1 = await page.evaluate(() => Outliner.elements.length);
		check('ipad: tap on context menu entry runs it (duplicate)', n1 === n0 + 1, { n0, n1 });
		await page.evaluate(() => Undo.undo());
	} else check('ipad: context menu has a duplicate entry', false);
	await closeMenus();

	// short tap on outliner row = select, no menu
	console.log('      before tap:', JSON.stringify(await page.evaluate(([x, y]) => ({ sel: Outliner.selected.map(e => e.name), el: document.elementFromPoint(x, y).className, menu: !!Menu.open, kp: BBTouch.inputs.keypad.isOpen() }), [row.x, row.y + row.h])));
	await tap(row.x, row.y + row.h);
	st = await page.evaluate(() => ({ open: !!Menu.open, sel: Outliner.selected.map(e => e.name) }));
	check('ipad: short tap on outliner selects, no menu', !st.open && st.sel.length === 1 && st.sel[0] !== 'arm_left', st);

	// long-press on the textures panel / empty outliner area and on a project tab
	const tex = await rect('#panel_textures .panel_vue_wrapper, #panel_textures');
	if (tex) {
		await longPress(tex.x, tex.top + tex.h * 0.7);
		st = await page.evaluate(() => !!Menu.open);
		check('ipad: long-press textures panel opens its context menu', st);
		await closeMenus();
	}
	const tab = await rect('#tab_bar .project_tab');
	if (tab) {
		await longPress(tab.x, tab.y);
		st = await page.evaluate(() => !!Menu.open);
		check('ipad: long-press project tab opens tab menu', st);
		await closeMenus();
	}

	// 2. slider scrub (Element panel position X)
	await page.evaluate(() => { const c = Outliner.elements.find(e => e.name === 'body'); c.select(); updateSelection(); });
	await sleep(300);
	const sl = await rect('#panel_element .nslide_tool[toolbar_item="slider_pos_x"] .nslide, .nslide[n-action="slider_pos_x"]');
	check('ipad: position slider visible', !!sl, sl);
	if (sl) {
		const v0 = await page.evaluate(() => BarItems.slider_pos_x.get());
		await drag([sl.x, sl.y], [sl.x + 120, sl.y + 3], 15);
		const v1 = await page.evaluate(() => BarItems.slider_pos_x.get());
		check('ipad: horizontal drag on slider scrubs value', v1 - v0 >= 5, { v0, v1 });
		await page.evaluate(() => Undo.undo());
		const v1u = await page.evaluate(() => BarItems.slider_pos_x.get());
		check('ipad: scrub is one undo step', v1u === v0, { v0, v1u });
		// precision: hold first, then drag the same distance → ~10× smaller change
		await drag([sl.x, sl.y], [sl.x + 120, sl.y + 3], 15, 520);
		const v2 = await page.evaluate(() => BarItems.slider_pos_x.get());
		check('ipad: hold-then-drag = precision scrub (≈0.1×)', v2 - v0 > 0.4 && v2 - v0 <= 1.5 && Math.abs(v2 * 10 - Math.round(v2 * 10)) < 1e-6, { v0, v2 });
		await page.evaluate(() => Undo.undo());
		// vertical drag must not change the value
		await drag([sl.x, sl.y], [sl.x + 4, sl.y + 90], 12);
		const v3 = await page.evaluate(() => BarItems.slider_pos_x.get());
		check('ipad: vertical drag over slider does not scrub', v3 === v0, { v0, v3 });
		// tap → keypad, no contenteditable / keyboard
		await tap(sl.x, sl.y);
		st = await page.evaluate(() => ({
			kp: BBTouch.inputs.keypad.isOpen(), editing: !!document.querySelector('.nslide.editing'),
			focus: document.activeElement && document.activeElement.className,
		}));
		check('ipad: tap on slider opens keypad (no text editing)', st.kp && !st.editing, st);
		const press = async k => {
			const b = await page.evaluate(k => {
				const el = [...document.querySelectorAll('.bbt_keypad .bbt_kp_btn')].find(b => b.dataset.k === k);
				const r = el.getBoundingClientRect();
				return { x: r.left + r.width / 2, y: r.top + r.height / 2, h: r.height };
			}, k);
			await tap(b.x, b.y, 30);
			return b;
		};
		st = await page.evaluate(() => document.querySelector('.bbt_keypad .bbt_kp_title').textContent);
		console.log('      keypad title:', st);
		const b7 = await press('1');
		check('ipad: keypad keys ≥ 44px', b7.h >= 44, b7.h);
		await press('2'); await press('.'); await press('5');
		console.log('      keypad text:', await page.evaluate(() => BBTouch.inputs.keypad.text));
		await press('ok');
		const v4 = await page.evaluate(() => ({ v: BarItems.slider_pos_x.get(), kp: BBTouch.inputs.keypad.isOpen() }));
		check('ipad: keypad entry sets value (12.5)', v4.v === 12.5 && !v4.kp, v4);
		// expression: "+" on a fresh display extends the value → 12.5+2×3 = 18.5
		await tap(sl.x, sl.y);
		await press('+'); await press('2'); await press('×'); await press('3'); await press('ok');
		const v5 = await page.evaluate(() => BarItems.slider_pos_x.get());
		check('ipad: keypad math expression (12.5+2×3)', v5 === 18.5, v5);
		// nudge
		await tap(sl.x, sl.y);
		await press('nudge+');
		await press('cancel');
		const v6 = await page.evaluate(() => BarItems.slider_pos_x.get());
		check('ipad: keypad nudge +step applies immediately', v6 === 19.5, v6);
		// hold-and-lift on slider = upstream slider context menu
		await longPress(sl.x, sl.y, 600);
		st = await page.evaluate(() => !!Menu.open && !!Menu.open.node.querySelector('li[menu_item="round"]'));
		check('ipad: long-press slider (no move) opens slider menu', st);
		await closeMenus();
		await page.evaluate(() => { Undo.undo(); Undo.undo(); Undo.undo(); });
	}

	// 3. sidebars: edge buttons hide/show
	const edgeL = await rect('.bbt_edge_left.visible');
	const edgeR = await rect('.bbt_edge_right.visible');
	check('ipad: sidebar edge buttons visible', !!edgeL && !!edgeR);
	if (edgeL && edgeR) {
		const w0 = await page.evaluate(() => Preview.selected.canvas.clientWidth);
		await tap(edgeL.x, edgeL.y);
		await tap(edgeR.x, edgeR.y);
		await sleep(200);
		st = await page.evaluate(() => ({ l: Prop.show_left_bar, r: Prop.show_right_bar, w: Preview.selected.canvas.clientWidth,
			lw: document.getElementById('left_bar').offsetWidth }));
		check('ipad: edge buttons hide both sidebars, viewport grows', !st.l && !st.r && st.w > w0 + 400, { w0, ...st });
		const eL = await rect('.bbt_edge_left.visible');
		const eR = await rect('.bbt_edge_right.visible');
		await tap(eL.x, eL.y);
		await tap(eR.x, eR.y);
		await sleep(200);
		st = await page.evaluate(() => ({ l: Prop.show_left_bar, r: Prop.show_right_bar, w: Preview.selected.canvas.clientWidth }));
		check('ipad: edge buttons show sidebars again', st.l && st.r && Math.abs(st.w - w0) < 4, st);
	}

	// 4. sidebar resize via touch (upstream ResizeLine uses pointer events)
	const rz = await rect('#resizer_right');
	if (rz) {
		const w0 = await page.evaluate(() => Interface.right_bar_width);
		await drag([rz.x, rz.top + 120], [rz.x - 60, rz.top + 120], 10);
		const w1 = await page.evaluate(() => Interface.right_bar_width);
		check('ipad: right sidebar resizable by touch drag', w1 - w0 >= 40, { w0, w1 });
	} else check('ipad: right resizer present', false);

	// 5. menu bar: tap opens, tap again closes, tap another switches, submenu opens on tap
	const mFile = await rect('#menu_bar li.menu_bar_point');
	await tap(mFile.x, mFile.y);
	st = await page.evaluate(() => ({ open: !!(Menu.open && MenuBar.open), id: MenuBar.open && MenuBar.open.id }));
	check('ipad: tap on menu bar opens menu', st.open, st);
	const mEdit = await page.evaluate(() => { const r = document.querySelectorAll('#menu_bar li.menu_bar_point')[1].getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; });
	await tap(mEdit.x, mEdit.y);
	st = await page.evaluate(() => ({ open: !!Menu.open, id: MenuBar.open && MenuBar.open.id }));
	check('ipad: tap on another menu switches (no open/close flicker)', st.open && st.id === 'edit', st);
	await tap(mEdit.x, mEdit.y);
	st = await page.evaluate(() => !!Menu.open);
	check('ipad: tap on open menu closes it', !st);
	// submenu: File → Recent / New / Export (first li.parent)
	await tap(mFile.x, mFile.y);
	const par = await page.evaluate(() => {
		const li = Menu.open.node.querySelector(':scope > li.parent');
		const r = li.getBoundingClientRect();
		return { x: r.left + 40, y: r.top + r.height / 2, id: li.getAttribute('menu_item') };
	});
	await tap(par.x, par.y);
	st = await page.evaluate(() => {
		const li = Menu.open && Menu.open.node.querySelector(':scope > li.parent');
		const sub = li && li.querySelector(':scope > ul.contextMenu.sub');
		return { open: !!Menu.open, sub_visible: !!sub && getComputedStyle(sub).display !== 'none' };
	});
	check('ipad: submenu opens on tap (menu stays open)', st.open && st.sub_visible, { ...st, id: par.id });
	if (want_shots) {
		await page.screenshot({ path: path.join(root, 'docs/screenshots/m6-ipad-menu.png') });
	}
	await closeMenus();

	// 6. toolbar tooltip on long-press (not on hover)
	const tool = await page.evaluate(() => {
		const t = [...document.querySelectorAll('.toolbar .tool')].find(t => t.querySelector(':scope > .tooltip') && t.offsetWidth && t.getAttribute('toolbar_item') === 'move_tool');
		if (!t) return null;
		const r = t.getBoundingClientRect();
		return { x: r.left + r.width / 2, y: r.top + r.height / 2, h: r.height };
	});
	if (tool) {
		check('ipad: toolbar buttons ≥ 36px', tool.h >= 36, tool.h);
		await tap(tool.x, tool.y);
		st = await page.evaluate(() => ({ sel: Toolbox.selected.id, vis: [...document.querySelectorAll('.tool > .tooltip')].some(t => getComputedStyle(t).visibility === 'visible') }));
		check('ipad: tap on tool selects it, no sticky hover tooltip', st.sel === 'move_tool' && !st.vis, st);
		await T.touch('touchStart', [[tool.x, tool.y]]);
		await sleep(560);
		st = await page.evaluate(() => [...document.querySelectorAll('.tool > .tooltip')].some(t => getComputedStyle(t).visibility === 'visible'));
		await T.touch('touchEnd', []);
		await sleep(100);
		check('ipad: long-press on tool shows its tooltip', st);
		await closeMenus();
		await page.evaluate(() => BBTouch.longpress.hideTooltip());
	}

	// 7. quick actions
	const qa = await rect('#bbt_quick_actions_menu');
	check('ipad: quick actions button in menu bar', !!qa);
	if (qa) {
		await tap(qa.x, qa.y);
		await sleep(150);
		st = await page.evaluate(() => ({ open: ActionControl.open, n: document.querySelectorAll('#action_selector_list li').length,
			focus: document.activeElement && document.activeElement.tagName }));
		check('ipad: quick actions opens action search without keyboard', st.open && st.n > 0 && st.focus !== 'INPUT', st);
		if (want_shots) await page.screenshot({ path: path.join(root, 'docs/screenshots/m6-ipad-actions.png') });
		await page.evaluate(() => ActionControl.hide());
	}
	const tbqa = await rect('#bbt_toolbar [data-id="quick_actions"]');
	check('ipad: quick actions button in floating toolbar', !!tbqa);

	// 8. dialog number input → keypad
	await page.evaluate(() => {
		new Dialog('bbt_test_dialog', { title: 'Test', form: { n: { label: 'Number', type: 'number', value: 3 } }, onConfirm(r) { window.__bbt_dialog = r; } }).show();
	});
	await sleep(300);
	const ni = await rect('#bbt_test_dialog .numeric_input input, dialog#bbt_test_dialog .numeric_input input');
	if (ni) {
		await tap(ni.x, ni.y);
		st = await page.evaluate(() => ({ kp: BBTouch.inputs.keypad.isOpen(), focus: document.activeElement && document.activeElement.tagName }));
		check('ipad: tap on dialog number input opens keypad, no keyboard', st.kp && st.focus !== 'INPUT', st);
		await page.evaluate(() => { const K = BBTouch.inputs.keypad; ['4', '2'].forEach(k => K.press(k)); K.apply(); Dialog.open.confirm(); });
		const r = await page.evaluate(() => window.__bbt_dialog);
		check('ipad: keypad value reaches the dialog form', r && r.n === 42, r);
	} else {
		check('ipad: dialog number input found', false);
		await page.evaluate(() => Dialog.open && Dialog.open.cancel());
	}

	// 9. M3 viewport long-press still opens the element menu, now while holding
	const vp = await page.evaluate(() => {
		const c = Outliner.elements.find(e => e.name === 'head');
		const p = Preview.selected;
		const v = new THREE.Vector3(); c.mesh.getWorldPosition(v);
		const box = new THREE.Box3().setFromObject(c.mesh); box.getCenter(v);
		const s = p.vectorToScreenPosition(v); const r = p.canvas.getBoundingClientRect();
		const pt = { x: r.left + s.x, y: r.top + s.y };
		const hit = p.raycast({ clientX: pt.x, clientY: pt.y });
		pt.expect = hit && hit.element && hit.element.name;
		return pt;
	});
	await page.evaluate(() => unselectAllElements());
	const during = await longPress(vp.x, vp.y, 600);
	st = await page.evaluate(() => ({ open: !!Menu.open, sel: Outliner.selected.map(e => e.name) }));
	check('ipad: viewport long-press opens element menu while holding (M3 path)', during && st.open && vp.expect && st.sel.includes(vp.expect), { during, expect: vp.expect, ...st });
	await closeMenus();

	if (want_shots) {
		await page.evaluate(() => { Outliner.elements.find(e => e.name === 'arm_left').select(); updateSelection(); BBTouch.gestures.frameAll(); });
		await sleep(700);
		await page.screenshot({ path: path.join(root, light ? 'docs/screenshots/m6-ipad-light.png' : 'docs/screenshots/m6-ipad.png') });
	}
	const bad = T.errors.filter(e => !/service_worker|blckbn\.ch|ERR_FAILED|404|CORS/i.test(e));
	check('ipad: no page errors', bad.length === 0, bad.slice(0, 5));
	await T.context.close();
}

async function runIPhone(browser) {
	console.log('\n=== iPhone 844x390 landscape ===');
	const T = await setupPage(browser, { w: 844, h: 390, shot: want_shots });
	const { page, sleep, tap, longPress, drag, rect, closeMenus } = T;
	let st = await page.evaluate(() => ({ mobile: Blockbench.isMobile, compact: document.documentElement.classList.contains('bbt_compact'),
		toolbar_h: document.getElementById('bbt_toolbar').classList.contains('horizontal') }));
	check('iphone: compact (upstream mobile) layout, horizontal toolbar', st.mobile && st.compact && st.toolbar_h, st);

	// open the outliner sheet from the panel selector
	const sel = await page.evaluate(() => {
		const el = [...document.querySelectorAll('#panel_selector_bar .panel_selector')].find(e => (e.getAttribute('title') || e.textContent || '').match(/outliner/i)) ||
			document.querySelectorAll('#panel_selector_bar .panel_selector')[1];
		const r = el.getBoundingClientRect();
		return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height };
	});
	check('iphone: panel selector targets ≥ 44px', sel.w >= 44 && sel.h >= 44, sel);
	await tap(sel.x, sel.y);
	await sleep(300);
	const row = await page.evaluate(() => {
		const node = document.getElementById(Outliner.elements.find(e => e.name === 'head').uuid);
		const el = node && node.querySelector('.outliner_object');
		if (!el || !el.offsetParent) return null;
		const r = el.getBoundingClientRect();
		return { x: r.left + 70, y: r.top + r.height / 2 };
	});
	check('iphone: outliner sheet opens from panel selector', !!row);
	if (row) {
		const during = await longPress(row.x, row.y);
		st = await page.evaluate(() => ({ open: !!Menu.open, sel: Outliner.selected.map(e => e.name) }));
		check('iphone: long-press outliner opens context menu', during && st.open && st.sel.includes('head'), st);
		if (want_shots) await page.screenshot({ path: path.join(root, 'docs/screenshots/m6-iphone-menu.png') });
		await closeMenus();
	}
	// element sheet slider
	await page.evaluate(() => { Outliner.elements.find(e => e.name === 'body').select(); updateSelection(); });
	const sel2 = await page.evaluate(() => {
		const el = [...document.querySelectorAll('#panel_selector_bar .panel_selector')].find(e => (e.getAttribute('title') || '').match(/element|transform/i));
		if (!el) return null;
		const r = el.getBoundingClientRect();
		return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
	});
	if (sel2) {
		await tap(sel2.x, sel2.y);
		await sleep(300);
	}
	const sl = await page.evaluate(() => {
		const el = [...document.querySelectorAll('.nslide[n-action="slider_pos_x"]')].find(e => e.offsetParent);
		if (!el) return null;
		const r = el.getBoundingClientRect();
		return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
	});
	check('iphone: element sheet with position slider', !!sl);
	if (sl) {
		const v0 = await page.evaluate(() => BarItems.slider_pos_x.get());
		await drag([sl.x, sl.y], [Math.min(sl.x + 100, 800), sl.y + 2], 12);
		const v1 = await page.evaluate(() => BarItems.slider_pos_x.get());
		check('iphone: slider scrub works', v1 > v0, { v0, v1 });
		await tap(sl.x, sl.y);
		st = await page.evaluate(() => {
			const el = BBTouch.inputs.keypad.element; const r = el.getBoundingClientRect();
			return { kp: BBTouch.inputs.keypad.isOpen(), inside: r.top >= 0 && r.bottom <= innerHeight && r.left >= 0 && r.right <= innerWidth, r: r.toJSON() };
		});
		check('iphone: keypad opens and fits on screen', st.kp && st.inside, st);
		if (want_shots) await page.screenshot({ path: path.join(root, 'docs/screenshots/m6-iphone-keypad.png') });
		await closeMenus();
	}
	// menu (hamburger) opens on tap
	const burger = await rect('header .tool[toolbar_item="mobile_menu"], #mobile_menu_button, header .tool');
	if (burger) {
		await tap(burger.x, burger.y);
		st = await page.evaluate(() => !!Menu.open);
		check('iphone: header menu opens on tap', st);
		await closeMenus();
	}
	if (want_shots) {
		await page.evaluate(() => BBTouch.gestures.frameAll());
		await sleep(500);
		await page.screenshot({ path: path.join(root, 'docs/screenshots/m6-iphone.png') });
	}
	const bad = T.errors.filter(e => !/service_worker|blckbn\.ch|ERR_FAILED|404|CORS/i.test(e));
	check('iphone: no page errors', bad.length === 0, bad.slice(0, 5));
	await T.context.close();
}

(async () => {
	const server = spawn(process.execPath, [path.join(root, 'scripts/serve.mjs'), String(port)], { stdio: 'ignore' });
	await new Promise(r => setTimeout(r, 500));
	const browser = await chromium.launch();
	try {
		if (!only || only === 'ipad') await runIPad(browser);
		if (!only || only === 'iphone') await runIPhone(browser);
	} catch (e) {
		console.error(e);
		results.push({ name: 'exception', ok: false });
	} finally {
		await browser.close();
		server.kill();
	}
	const failed = results.filter(r => !r.ok);
	console.log(`\n${results.length - failed.length}/${results.length} passed`);
	process.exit(failed.length ? 1 : 0);
})();
