'use strict';
/**
 * check_node8.js - Verify every JS file deployed to BMW MGU parses cleanly as ES2017 (Node 8.16).
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const FILES = [
    'apps/bmw_voice/main.js',
    'apps/bmw_voice/ui.js',
    'tools/bmw-voice/bmw-voice.js',
    'tools/bmw-voice/car-control.js',
    'tools/bmw-voice/nlu-brain.js',
    'tools/bmw-voice/mic-capture.js',
    'tools/bmw-voice/uplink.js',
];

const NEWER = [
    /\.finally\(/, /\.flat\(/, /\.flatMap\(/, /Object\.fromEntries/, /recursive:\s*true/,
    /\.matchAll\(/, /\.trimStart\(|\.trimEnd\(/, /globalThis/, /\bBigInt\b/, /\.allSettled\(/,
    /\.replaceAll\(/, /\.at\(-?\d/, /fs\.promises|require\(['"]fs\/promises['"]\)/, /\.rmSync\(/,
    /queueMicrotask/, /TextDecoder|TextEncoder/, /new URL\(/, /worker_threads/, /\.description\b/,
];

let bad = 0;
FILES.forEach((f) => {
    const full = path.join(ROOT, f);
    if (!fs.existsSync(full)) { console.log(f + ': missing'); bad++; return; }
    const src = fs.readFileSync(full, 'utf8');
    try { new vm.Script(src, { filename: f }); } catch (e) {
        console.log(f + ': syntax error: ' + e.message); bad++;
    }
    if (/catch\s*\{/.test(src) || /\?\./.test(src) || /\?\?/.test(src)) {
        console.log(f + ': contains post-ES2017 syntax (catch {}, ?., or ??)'); bad++;
    }
    src.split('\n').forEach((line, i) => NEWER.forEach((re) => {
        if (re.test(line.replace(/\/\/.*$/, ''))) {
            console.log(f + ':' + (i + 1) + ': newer than Node 8: ' + line.trim().slice(0, 100));
            bad++;
        }
    }));
});
console.log(bad ? 'check_node8: ' + bad + ' problem(s)' : 'check_node8: ' + FILES.length + ' files ok for Node 8');
process.exit(bad ? 1 : 0);
