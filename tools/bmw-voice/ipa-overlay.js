'use strict';
/**
 * ipa-overlay.js - System-Wide OEM BMW Intelligent Personal Assistant (IPA) Screen Overlay (`bmw-voice`).
 *
 * How it works on BMW MGU iDrive 7 (`1920x720`):
 *   - Connects from `bmw-voice.service` (`uid=0` root) to `/run/mgu-render/render.sock` (MGU Store)
 *     or `/run/mgu-renderd/renderd.sock` (`idrive7-renderd`), speaking the universal GLES2 layer protocol
 *     (`HELLO`, `PLACE`, `SHOW`, `ATLAS`, `FRAME`).
 *   - Because `uid == 0`, `mgu-render`'s foreground gate (`gate_applies`) always permits our Wayland IVI layer
 *     to appear on top of ANY screen — BMW Home, Maps, Settings, Apple CarPlay, and directly over BMW's
 *     native "Nhập bằng giọng nói không khả dụng" popup when pressing the Steering Wheel Mic button!
 *   - Hardware safety & zero touch interference:
 *       1. Never sends `CLAIM` or `GRAB` -> Wayland input region stays empty, so CarPlay/Maps touches work
 *          normally underneath and `nftables` touch diversion is never touched.
 *       2. `mgu-render` automatically hides layer clients whenever Reversing / 360 Camera (`yield_surfaces`) activates.
 *       3. On physical Steering Wheel PTT press, performs clean `SHOW(0)->SHOW(1)` layer re-assertions at
 *          `+240ms` and `+520ms` so `HmiMain3D`'s unsupported-language scene change never buries our IPA UI.
 *       4. Animates at ~11 fps ONLY during the 3-6s voice turn, then sends `SHOW(0)` and stops all timers (`0.0%` idle CPU/GPU).
 *
 * Node 8 (ES2017) compatible, zero external npm dependencies.
 */
const fs = require('fs');
const net = require('net');
const path = require('path');
const zlib = require('zlib');

const DEFAULT_SOCKETS = [
    '/run/mgu-render/render.sock',
    '/run/mgu-renderd/renderd.sock',
];

// Universal mgu-render / idrive7-renderd message types (1..8 & 101..104)
const M = { HELLO: 1, PLACE: 2, SHOW: 3, ATLAS: 4, RAMP: 5, LAYER: 6, FRAME: 7, DROP_LAYER: 8 };
const E = { READY: 101, TICK: 102, ERROR: 103, STATS: 104 };

// Universal GLES2 draw ops (`gfx.c`)
const OP = {
    CLEAR: 1,
    RECT: 2,
    GRAD: 3,
    RRECT: 4,
    RSTROKE: 5,
    CARD: 6,
    ARC: 8,
    LINE: 9,
    GLYPHS: 11,
};

// iDrive 7 content area right of Back/Home column (`x: 84..1920`) and below Status bar (`y: 76..720`)
const OVERLAY_BOX = { x: 84, y: 76, w: 1836, h: 644 };

function packRgba(r, g, b, a) {
    const alpha = a === undefined ? 255 : Math.max(0, Math.min(255, Math.round(a * 255)));
    return (((r & 255) << 24) | ((g & 255) << 16) | ((b & 255) << 8) | alpha) >>> 0;
}

function hexColor(hex, alpha) {
    const s = String(hex || '#0088ff').replace(/^#/, '');
    const n = parseInt(s.length === 3 ? (s[0] + s[0] + s[1] + s[1] + s[2] + s[2]) : s, 16) || 0;
    return packRgba((n >> 16) & 255, (n >> 8) & 255, n & 255, alpha === undefined ? 1 : alpha);
}

function frameMsg(type, payload) {
    const len = payload ? payload.length : 0;
    const pad = (4 - (len & 3)) & 3;
    const out = Buffer.allocUnsafe(8 + len + pad);
    out.writeUInt32LE(type >>> 0, 0);
    out.writeUInt32LE((len + pad) >>> 0, 4);
    if (len) payload.copy(out, 8);
    if (pad) out.fill(0, 8 + len);
    return out;
}

function u32Msg(type, arr) {
    const u = new Uint32Array(arr);
    return frameMsg(type, Buffer.from(u.buffer, u.byteOffset, u.byteLength));
}

function computeAtlasId(familyName, size, cacheKey) {
    let id = 0;
    const k = familyName + '@' + size + (cacheKey ? ('#' + cacheKey) : '');
    for (let i = 0; i < k.length; i++) {
        id = (Math.imul(id, 31) + k.charCodeAt(i)) >>> 0;
    }
    return (id | 1) >>> 0;
}

class FontBank {
    constructor(fontDirs) {
        this.dirs = fontDirs || [];
        this.families = Object.create(null);
    }

    setDirs(dirs) {
        this.dirs = dirs || [];
    }

    loadFamily(name) {
        if (this.families[name] !== undefined) return this.families[name];
        for (let i = 0; i < this.dirs.length; i++) {
            const p = path.join(this.dirs[i], name + '.json');
            if (!fs.existsSync(p)) continue;
            try {
                const j = JSON.parse(fs.readFileSync(p, 'utf8'));
                const fam = (j.sizes || []).map((s) => ({
                    family: name,
                    size: s.size,
                    ascent: s.ascent,
                    descent: s.descent,
                    atlasW: s.atlasW,
                    atlasH: s.atlasH,
                    glyphs: s.glyphs,
                    _alphaB64: s.alpha,
                    alpha: null,
                    atlasId: computeAtlasId(name, s.size, j.cacheKey || ''),
                }));
                this.families[name] = fam;
                return fam;
            } catch (e) {}
        }
        this.families[name] = null;
        return null;
    }

    getFont(bold, wantedSize) {
        const primary = bold ? 'vietnamese-bold' : 'vietnamese';
        const fallback = bold ? 'bold' : 'label';
        const fam = this.loadFamily(primary) || this.loadFamily(fallback);
        if (!fam || !fam.length) return null;
        let best = null;
        for (let i = 0; i < fam.length; i++) {
            const f = fam[i];
            if (f.size >= wantedSize && (!best || f.size < best.size)) best = f;
        }
        if (!best) best = fam[fam.length - 1];
        if (!best.alpha) {
            best.alpha = zlib.inflateSync(Buffer.from(best._alphaB64, 'base64'));
        }
        return best;
    }

    measure(font, text, scale) {
        let w = 0;
        const s = String(text || '');
        for (const ch of s) {
            const cp = ch.codePointAt(0);
            const g = font.glyphs[cp] || font.glyphs[63];
            if (g) w += g[6] * scale;
        }
        return w;
    }
}

class DrawList {
    constructor() {
        this.buf = new ArrayBuffer(32768);
        this.u = new Uint32Array(this.buf);
        this.f = new Float32Array(this.buf);
        this.n = 0;
        this.atlases = [];
    }

    reset() {
        this.n = 0;
        this.atlases.length = 0;
    }

    _grow(k) {
        if (this.n + k <= this.u.length) return;
        let next = this.u.length * 2;
        while (next < this.n + k) next *= 2;
        const nb = new ArrayBuffer(next * 4);
        new Uint32Array(nb).set(this.u.subarray(0, this.n));
        this.buf = nb;
        this.u = new Uint32Array(nb);
        this.f = new Float32Array(nb);
    }

    clear(col) {
        this._grow(2);
        this.u[this.n++] = OP.CLEAR;
        this.u[this.n++] = col >>> 0;
    }

    rect(x, y, w, h, col) {
        if (!(w > 0 && h > 0)) return;
        this._grow(6);
        let i = this.n;
        this.u[i++] = OP.RECT;
        this.f[i++] = x; this.f[i++] = y; this.f[i++] = w; this.f[i++] = h;
        this.u[i++] = col >>> 0;
        this.n = i;
    }

    rrect(x, y, w, h, r, col) {
        if (!(w > 0 && h > 0)) return;
        this._grow(7);
        let i = this.n;
        this.u[i++] = OP.RRECT;
        this.f[i++] = x; this.f[i++] = y; this.f[i++] = w; this.f[i++] = h; this.f[i++] = r;
        this.u[i++] = col >>> 0;
        this.n = i;
    }

    rstroke(x, y, w, h, r, lw, col) {
        if (!(w > 0 && h > 0)) return;
        this._grow(8);
        let i = this.n;
        this.u[i++] = OP.RSTROKE;
        this.f[i++] = x; this.f[i++] = y; this.f[i++] = w; this.f[i++] = h;
        this.f[i++] = r; this.f[i++] = lw;
        this.u[i++] = col >>> 0;
        this.n = i;
    }

    card(x, y, w, h, r, stops) {
        const k = stops.length;
        this._grow(7 + k * 2);
        let i = this.n;
        this.u[i++] = OP.CARD;
        this.f[i++] = x; this.f[i++] = y; this.f[i++] = w; this.f[i++] = h; this.f[i++] = r;
        this.u[i++] = k;
        for (let s = 0; s < k; s++) {
            this.f[i++] = stops[s][0];
            this.u[i++] = stops[s][1] >>> 0;
        }
        this.n = i;
    }

    arc(cx, cy, r0, r1, a0, a1, col, roundCaps) {
        this._grow(12);
        let i = this.n;
        this.u[i++] = OP.ARC;
        this.f[i++] = cx; this.f[i++] = cy;
        this.f[i++] = r0; this.f[i++] = r1;
        this.f[i++] = a0; this.f[i++] = a1;
        this.u[i++] = col >>> 0;
        this.u[i++] = roundCaps ? 1 : 0;
        this.u[i++] = 0;
        this.f[i++] = 0;
        this.f[i++] = 0;
        this.n = i;
    }

    circle(cx, cy, r, col) {
        this.arc(cx, cy, 0, r, 0, 360, col, false);
    }

    fitText(fontBank, str, size, bold, maxWidth) {
        const s = String(str || '');
        if (!s) return '';
        const font = fontBank.getFont(bold, size);
        if (!font) return s;
        const sc = size / font.size;
        if (fontBank.measure(font, s, sc) <= maxWidth) return s;
        let cut = s;
        while (cut.length > 1 && fontBank.measure(font, cut + '…', sc) > maxWidth) {
            cut = cut.slice(0, -1);
        }
        return cut + '…';
    }

    text(fontBank, str, x, y, size, col, opts) {
        const s = String(str || '');
        if (!s) return 0;
        const o = opts || {};
        const font = fontBank.getFont(!!o.bold, size);
        if (!font) return 0;
        const sc = size / font.size;
        const sp = o.spacing || 0;
        const totalW = fontBank.measure(font, s, sc) + sp * Math.max(0, s.length - 1);
        let pen = o.align === 'center' ? (x - totalW / 2) : (o.align === 'right' ? (x - totalW) : x);

        const head = this.n;
        this._grow(4 + s.length * 8);
        let i = head + 4;
        let cnt = 0;
        for (const ch of s) {
            const cp = ch.codePointAt(0);
            const g = font.glyphs[cp] || font.glyphs[63];
            if (!g) continue;
            const gx = g[0], gy = g[1], gw = g[2], gh = g[3];
            if (gw && gh) {
                this.f[i++] = pen + g[4] * sc;
                this.f[i++] = y + g[5] * sc;
                this.f[i++] = gw * sc;
                this.f[i++] = gh * sc;
                this.f[i++] = gx;
                this.f[i++] = gy;
                this.f[i++] = gx + gw;
                this.f[i++] = gy + gh;
                cnt++;
            }
            pen += g[6] * sc + sp;
        }
        if (cnt > 0) {
            this.u[head] = OP.GLYPHS;
            this.u[head + 1] = font.atlasId;
            this.u[head + 2] = col >>> 0;
            this.u[head + 3] = cnt;
            this.n = i;
            if (this.atlases.indexOf(font) < 0) this.atlases.push(font);
        }
        return totalW;
    }

    bytes() {
        const sub = this.u.subarray(0, this.n);
        return Buffer.from(sub.buffer, sub.byteOffset, sub.byteLength);
    }
}

class IpaOverlay {
    constructor(opts) {
        const o = opts || {};
        this.sockets = o.sockets || (process.env.BV_RENDER_SOCKET ? [process.env.BV_RENDER_SOCKET] : DEFAULT_SOCKETS);
        this.box = o.box || OVERLAY_BOX;
        this.onLog = o.onLog || (() => {});
        this.fontBank = new FontBank(this._buildFontDirs(o.extraFontDirs));
        this.drawList = new DrawList();

        this.sock = null;
        this.sockIdx = 0;
        this.connected = false;
        this.ready = false;
        this.placed = false;
        this.visible = false;
        this.closed = false;
        this.inbuf = Buffer.alloc(0);
        this.sentAtlases = new Set();

        this.phase = 'hidden'; // hidden | listening | thinking | result
        this.modeTag = 'ptt';  // ptt | hey_bmw
        this.speakerZone = 'driver';
        this.headline = '';
        this.subline = '';
        this.ok = true;
        this.micDb = -55;
        this.tick = 0;

        this.animTimer = null;
        this.hideTimer = null;
        this.retryTimer = null;
        this.reassertTimers = [];
    }

    _buildFontDirs(extra) {
        const list = [];
        if (process.env.BV_FONTS_DIR) list.push(process.env.BV_FONTS_DIR);
        if (Array.isArray(extra)) extra.forEach((d) => { if (d) list.push(d); });
        list.push(path.join(__dirname, 'fonts'));
        list.push(path.join(__dirname, '..', '..', 'kit', 'localization', 'fonts'));
        list.push(path.join(__dirname, '..', '..', 'kit', 'runtime', 'fonts'));
        return list;
    }

    addFontDir(dir) {
        if (!dir) return;
        const cur = this.fontBank.dirs;
        if (cur.indexOf(dir) < 0) {
            cur.unshift(dir);
            this.fontBank.setDirs(cur);
        }
    }

    hasRendererSocket() {
        for (let i = 0; i < this.sockets.length; i++) {
            try {
                if (fs.statSync(this.sockets[i]).isSocket()) return true;
            } catch (e) {}
        }
        return false;
    }

    start() {
        this.closed = false;
        this._connectNext(0);
    }

    stop() {
        this.closed = true;
        this._clearTimers();
        if (this.retryTimer) {
            clearTimeout(this.retryTimer);
            this.retryTimer = null;
        }
        if (this.sock) {
            try {
                if (this.connected && this.ready) {
                    this.sock.write(u32Msg(M.SHOW, [0]));
                }
                this.sock.destroy();
            } catch (e) {}
            this.sock = null;
        }
        this.connected = false;
        this.ready = false;
        this.placed = false;
        this.visible = false;
    }

    _connectNext(idx) {
        if (this.closed || this.sock) return;
        const available = this.sockets.filter((p) => {
            try { return fs.statSync(p).isSocket(); } catch (e) { return false; }
        });
        if (!available.length) {
            this._scheduleRetry(4000);
            return;
        }
        const target = available[idx % available.length];
        let triedFallback = false;
        const s = net.createConnection(target);
        this.sock = s;

        s.on('connect', () => {
            this.connected = true;
            this.ready = false;
            this.placed = false;
            this.inbuf = Buffer.alloc(0);
            this.sentAtlases.clear();
            if (s.setNoDelay) s.setNoDelay(true);
            this._write(frameMsg(M.HELLO, Buffer.from('bmw_voice_ipa', 'utf8')));
        });

        s.on('data', (chunk) => this._onData(chunk));

        s.on('error', () => {
            if (!this.connected && idx + 1 < available.length) {
                triedFallback = true;
            }
        });

        s.on('close', () => {
            if (this.sock === s) this.sock = null;
            this.connected = false;
            this.ready = false;
            this.placed = false;
            if (this.closed) return;
            if (triedFallback) {
                this._connectNext(idx + 1);
            } else {
                this._scheduleRetry(3500);
            }
        });
    }

    _scheduleRetry(ms) {
        if (this.closed || this.retryTimer) return;
        this.retryTimer = setTimeout(() => {
            this.retryTimer = null;
            if ( this.retryTimer === null && !this.closed ) this._connectNext(0);
        }, ms);
        if (this.retryTimer.unref) this.retryTimer.unref();
    }

    _write(buf) {
        if (!this.sock || !this.connected) return false;
        try { return this.sock.write(buf); } catch (e) { return false; }
    }

    _onData(chunk) {
        this.inbuf = this.inbuf.length ? Buffer.concat([this.inbuf, chunk]) : chunk;
        while (this.inbuf.length >= 8) {
            const type = this.inbuf.readUInt32LE(0);
            const len = this.inbuf.readUInt32LE(4);
            if (this.inbuf.length < 8 + len) break;
            const payload = this.inbuf.slice(8, 8 + len);
            this.inbuf = this.inbuf.slice(8 + len);

            if (type === E.READY) {
                this.ready = true;
                this._sendPlace();
                if (this.phase !== 'hidden') {
                    this._renderAndSend(true);
                }
            } else if (type === E.ERROR) {
                this.onLog('ipa-overlay renderer warn: ' + payload.toString('utf8'));
            }
        }
    }

    _sendPlace() {
        if (!this.ready) return;
        const b = Buffer.alloc(28);
        b.writeInt32LE(this.box.x | 0, 0);
        b.writeInt32LE(this.box.y | 0, 4);
        b.writeInt32LE(this.box.w | 0, 8);
        b.writeInt32LE(this.box.h | 0, 12);
        b.writeFloatLE(1.0, 16);
        b.writeFloatLE(0.0, 20);
        b.writeFloatLE(0.0, 24);
        this.sentAtlases.clear();
        this._write(frameMsg(M.PLACE, b));
        this.placed = true;
    }

    _ensureAtlases(fontsUsed) {
        for (let i = 0; i < fontsUsed.length; i++) {
            const f = fontsUsed[i];
            if (this.sentAtlases.has(f.atlasId) || !f.alpha) continue;
            const head = Buffer.alloc(12);
            head.writeUInt32LE(f.atlasId >>> 0, 0);
            head.writeUInt32LE(f.atlasW >>> 0, 4);
            head.writeUInt32LE(f.atlasH >>> 0, 8);
            this._write(frameMsg(M.ATLAS, Buffer.concat([head, f.alpha])));
            this.sentAtlases.add(f.atlasId);
        }
    }

    _clearTimers() {
        if (this.animTimer) {
            clearInterval(this.animTimer);
            this.animTimer = null;
        }
        if (this.hideTimer) {
            clearTimeout(this.hideTimer);
            this.hideTimer = null;
        }
        while (this.reassertTimers.length) {
            clearTimeout(this.reassertTimers.pop());
        }
    }

    _startAnimLoop() {
        if (this.animTimer) return;
        this.animTimer = setInterval(() => {
            if (this.phase === 'hidden') {
                this.hide();
                return;
            }
            this.tick = (this.tick + 1) & 4095;
            this._renderAndSend(false);
        }, 90);
        if (this.animTimer.unref) this.animTimer.unref();
    }

    _scheduleTopReassertions() {
        while (this.reassertTimers.length) clearTimeout(this.reassertTimers.pop());
        // HmiMain3D pops up its unsupported-language dialog ~80-250ms after physical PTT press and resets
        // Wayland layer order; toggling SHOW(0)->SHOW(1) puts our BMW IPA layer straight back on top!
        [240, 540].forEach((delayMs) => {
            const t = setTimeout(() => {
                if (this.phase === 'hidden' || !this.ready || !this.placed) return;
                this._write(u32Msg(M.SHOW, [0]));
                this.visible = false;
                this._renderAndSend(true);
            }, delayMs);
            if (t.unref) t.unref();
            this.reassertTimers.push(t);
        });
    }

    updateMicLevel(db) {
        if (typeof db === 'number' && isFinite(db)) {
            this.micDb = Math.max(-65, Math.min(0, db));
        }
    }

    showListening(opts) {
        const o = opts || {};
        this._clearTimers();
        if (!this.sock && !this.closed) this._connectNext(0);
        this.phase = 'listening';
        this.modeTag = o.wakeTriggered ? 'hey_bmw' : 'ptt';
        this.speakerZone = o.speakerZone === 'passenger' ? 'passenger' : 'driver';
        this.headline = o.headline || 'Xin chào, tôi đang lắng nghe…';
        this.subline = o.subline || 'Nói câu lệnh Tiếng Việt · Ví dụ: "Điều hoà 22 độ", "Đèn màu cam", "Qua bài"';
        this.ok = true;
        this.micDb = -52;
        this.tick = 0;

        this._renderAndSend(true);
        this._startAnimLoop();
        if (o.reassertTop) {
            this._scheduleTopReassertions();
        }
    }

    showThinking(opts) {
        const o = opts || {};
        if (this.hideTimer) { clearTimeout(this.hideTimer); this.hideTimer = null; }
        this.phase = 'thinking';
        if (o.speakerZone) this.speakerZone = o.speakerZone;
        this.headline = o.headline || 'Đang xử lý yêu cầu…';
        this.subline = o.subline || 'Trợ lý BMW đang giải mã và thực thi trên xe';
        this._renderAndSend(true);
        this._startAnimLoop();
    }

    showResult(turn, holdMs) {
        if (!turn || turn.ignored) return;
        this._clearTimers();
        if (!this.sock && !this.closed) this._connectNext(0);

        this.phase = 'result';
        this.ok = !!turn.ok;
        this.speakerZone = turn.speakerZone === 'passenger' ? 'passenger' : 'driver';
        const prefix = turn.ok ? '✓ ' : '';
        this.headline = prefix + String(turn.replyVi || 'Đã thực thi.');
        this.subline = turn.transcript
            ? ((this.speakerZone === 'passenger' ? '[Ghế phụ] ' : '') + '“' + turn.transcript + '”')
            : 'Trợ lý Giọng nói BMW';

        this._renderAndSend(true);
        this._startAnimLoop();

        const duration = Math.max(1200, Number(holdMs) || 3200);
        this.hideTimer = setTimeout(() => {
            this.hideTimer = null;
            this.hide();
        }, duration);
        if (this.hideTimer.unref) this.hideTimer.unref();
    }

    hide() {
        this._clearTimers();
        this.phase = 'hidden';
        if (this.visible && this.ready) {
            this._write(u32Msg(M.SHOW, [0]));
        }
        this.visible = false;
    }

    _drawScene() {
        const d = this.drawList;
        const W = this.box.w;
        const H = this.box.h;
        d.reset();

        // Full-area deep BMW iDrive 7 obsidian backdrop (`alpha 0.96`) cleanly masks HmiMain3D's
        // "Nhập bằng giọng nói không khả dụng" popup while keeping top status strip & left Home rail visible
        d.clear(packRgba(5, 9, 18, 0.96));

        const isListen = this.phase === 'listening';
        const isThink = this.phase === 'thinking';
        const accentHex = isListen ? '#00d4ff' : (isThink ? '#38bdf8' : (this.ok ? '#2fd27a' : '#ffb020'));

        // Top BMW Intelligent Personal Assistant luminous accent bar
        d.rect(0, 0, W, 3, hexColor(accentHex, 0.92));

        // Central sleek OEM BMW IPA Dialog Card
        const cardW = 1480, cardH = 380;
        const cardX = Math.round((W - cardW) / 2);
        const cardY = Math.round((H - cardH) / 2);

        d.card(cardX, cardY, cardW, cardH, 22, [
            [0.0, packRgba(15, 24, 42, 0.98)],
            [1.0, packRgba(9, 14, 26, 0.98)],
        ]);
        d.rstroke(cardX, cardY, cardW, cardH, 22, 2, hexColor(accentHex, 0.45));
        // BMW M-inspired subtle accent bar on the left edge of the IPA card
        d.rrect(cardX + 2, cardY + 28, 5, cardH - 56, 3, hexColor(accentHex, 0.95));

        // Animated OEM BMW Intelligent Personal Assistant Light Orb (Left of Card)
        const cx = cardX + 195;
        const cy = cardY + Math.round(cardH / 2);
        const dbBoost = isListen ? Math.max(0, Math.min(26, (this.micDb + 52) * 0.85)) : 0;
        const wave = (isListen || isThink) ? (Math.sin(this.tick * 0.42) * 7 + dbBoost) : 0;

        d.circle(cx, cy, 108 + wave * 0.9, hexColor(accentHex, isListen ? 0.13 : 0.07));
        d.circle(cx, cy, 82 + wave * 0.5, hexColor('#0066ff', isListen ? 0.26 : 0.16));
        d.arc(cx, cy, 54, 64, (this.tick * 16) % 360, ((this.tick * 16) % 360) + 250, hexColor(accentHex, 0.95), true);
        d.circle(cx, cy, 48, packRgba(8, 13, 24, 1.0));
        d.circle(cx, cy, 18 + wave * 0.22, isListen ? packRgba(255, 255, 255, 0.96) : hexColor(accentHex, 0.92));

        // Right Text Column inside IPA Card
        const tx = cardX + 365;
        const maxTw = cardW - 415;

        const headerBadge = this.modeTag === 'hey_bmw'
            ? 'HEY BMW · TRỢ LÝ GIỌNG NÓI THÔNG MINH'
            : 'BMW INTELLIGENT PERSONAL ASSISTANT · TIẾNG VIỆT';
        d.text(this.fontBank, headerBadge, tx, cardY + 96, 17, hexColor('#38bdf8', 0.95), { bold: true, spacing: 1.0 });

        // Primary Headline (Listening / Thinking / Verified Hardware Execution Result)
        const fittedMain = d.fitText(this.fontBank, this.headline, 34, true, maxTw);
        const mainCol = isListen || isThink
            ? packRgba(255, 255, 255, 1.0)
            : (this.ok ? hexColor('#4ade80', 1.0) : hexColor('#fcd34d', 1.0));
        d.text(this.fontBank, fittedMain, tx, cardY + 178, 34, mainCol, { bold: true });

        // Secondary Transcript / Voice Hint Line
        const fittedSub = d.fitText(this.fontBank, this.subline, 22, false, maxTw);
        d.text(this.fontBank, fittedSub, tx, cardY + 242, 22, packRgba(186, 206, 232, 0.94), { bold: false });

        // Divider + Footer Status Hint
        d.rect(tx, cardY + 284, maxTw, 1, packRgba(148, 163, 184, 0.18));
        const footerText = isListen
            ? 'Ngừng nói 0.5 giây để tự động thực thi · Nhạc CarPlay giữ nguyên không ngắt'
            : (isThink
                ? 'Đang gửi lệnh trực tiếp xuống mạng thân xe BMW SOME/IP…'
                : 'Tự động đóng màn hình trợ lý sau giây lát');
        d.text(this.fontBank, footerText, tx, cardY + 324, 16, packRgba(148, 163, 184, 0.80), { bold: false });
    }

    _renderAndSend(forceShow) {
        this._drawScene();
        if (!this.ready || !this.placed) return false;
        this._ensureAtlases(this.drawList.atlases);
        this._write(frameMsg(M.FRAME, this.drawList.bytes()));
        if (forceShow || !this.visible) {
            this._write(u32Msg(M.SHOW, [1]));
            this.visible = true;
        }
        return true;
    }
}

module.exports = {
    IpaOverlay,
    OVERLAY_BOX,
    M,
    E,
    OP,
};
