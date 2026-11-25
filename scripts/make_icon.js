'use strict';
/**
 * make_icon.js - Generates the 140x140 MGU Store tile icon (`apps/bmw_voice/icon.png`):
 * Clean OEM BMW Intelligent Personal Assistant glowing blue/cyan voice ring.
 */
const fs = require('fs');
const path = require('path');
const { Canvas } = require(path.join(__dirname, '..', 'kit', 'runtime', 'canvas'));

const c = new Canvas(140, 140);

// Outer OEM BMW IPA luminous ring
c.arc(70, 70, 48, 56, 0, 360, '#0088ff');
c.arc(70, 70, 49, 55, -75, 75, '#00e5ff');

// Inner dark core ring + crisp voice bars
c.arc(70, 70, 34, 38, 0, 360, '#38bdf8');
const bars = [
    [54, 18, '#38bdf8'],
    [65, 32, '#ffffff'],
    [75, 26, '#00e5ff'],
    [86, 16, '#38bdf8'],
];
bars.forEach((b) => {
    c.roundRect(b[0] - 3, 70 - Math.floor(b[1] / 2), 6, b[1], 3, b[2]);
});

const out = path.join(__dirname, '..', 'apps', 'bmw_voice', 'icon.png');
fs.writeFileSync(out, c.png());
console.log('wrote ' + out);
