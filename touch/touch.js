/* Blockbench Touch layer — entry point.
 * Loaded as a classic script from www/index.html before the Blockbench bundle.
 * Later milestones add gestures, modifier toolbar, file bridge, Pencil support.
 */
(function () {
	'use strict';
	document.documentElement.classList.add('bb-touch');
	window.BBTouch = window.BBTouch || { version: '0.1.0' };
	console.log('Blockbench Touch layer loaded');
})();
