'use strict';
/**
 * car-control.js - Pure OEM BMW Intelligent Personal Assistant (IPA) Hardware Controller for MGU iDrive 7 (SP18 + SP21).
 *
 * Strictly scoped to the 6 in-car domains supported by OEM BMW IPA and verified on real G30/F90 SP18 hardware:
 *   1. `set_climate`          — 2-Zone Temperature, Max AC, Fan 1-5, Defrost, Recirc/Fresh Air, Sync, AC On/Off
 *   2. `set_seat_comfort`     — Driver/Passenger Seat Heating (0-3), Seat Ventilation/Cooling (0-3), Massage, Wheel Heat
 *   3. `set_ambient_light`    — OEM BMW iDrive 7 Ambient Menu Colours (`FARBAUSWAHL_1..11`) + Brightness (10-100%) + On/Off
 *   4. `control_media`        — Master Volume (`MainSink` `sinkID: 1` set / +8% / -8% / Mute) & CarPlay/BT Next/Prev/Play/Pause
 *   5. `control_windows`      — Power Windows (`WindowLifter`) & Sunroof / Sunshade (`SunProtectionRoofWindows` / `ControlRoofsystem`)
 *   6. `query_vehicle_status` — Live Oil °C, Coolant °C, 12V Battery, Fuel % / Range km, ODO km, and Tyre Pressure (`TPMS` read-only)
 *
 * Safety & Stability Invariants:
 *   - Single-pass `IFConfigGenerator.generate(db, ...)` + immediate memory release of unused catalog entries.
 *   - Every C++ `/usr/lib/someip.node` call is serialized through `nativeTick` (`setImmediate` queue).
 *   - `TPMS` is strictly `noSubscribe: true` (read-only on demand, matching BMW's native `x_call`).
 *   - Capacitive steering-wheel touch (`2 = PTT_MINUS_TASTER_BERUEHRT`) is filtered out; real press (`1 = GEDRUECKT`)
 *     triggers PTT and silences BMW's unsupported-language prompt via `Prompter.abortPrompt()`.
 *
 * Node 8 (ES2017) compatible.
 */
const fs = require('fs');
const net = require('net');

const env = (k, d) => (process.env[k] !== undefined && process.env[k] !== '' ? process.env[k] : d);
const CATALOG_PATH = env('BV_CATALOG', '/etc/oap/someip/someip-interfaces.json');
const SOMEIP_PATH = env('BV_SOMEIP', '/usr/lib/someip.node');
const COMFORT_SOCK = env('BV_COMFORT_SOCK', '/run/iteriodev-comfort/ctl.sock');

const APPMGMTS = [
    '/usr/lib/oap-mainapp/src/AppManagement/AppManagement.js',
    '/usr/lib/oap-mainapp21/src/AppManagement/AppManagement.js',
];

// Official BMW iDrive 7 (`ComfortFunctionIuK`) 11-slot Ambient Menu (`FARBAUSWAHL_1..11`)
// 1=Bronze, 2=Bronze/White, 3=Orange, 4=Orange/White, 5=White, 6=Blue, 7=Blue/White, 8=Green, 9=Green/White, 10=Lilac, 11=Lilac/White
const OEM_AMBIENT_COLORS = {
    bronze: { name: 'Đồng Bronze', hex: '#D97706', r: 217, g: 119, b: 6, menuIdx: 1 },
    orange: { name: 'Cam BMW', hex: '#FF5500', r: 254, g: 85, b: 0, menuIdx: 3 },
    white: { name: 'Trắng', hex: '#F1F5F9', r: 241, g: 245, b: 249, menuIdx: 5 },
    blue: { name: 'Xanh BMW', hex: '#0066FF', r: 0, g: 102, b: 254, menuIdx: 6 },
    cyan: { name: 'Xanh băng', hex: '#00D4FF', r: 0, g: 212, b: 254, menuIdx: 7 },
    green: { name: 'Xanh lá', hex: '#22C55E', r: 34, g: 197, b: 94, menuIdx: 8 },
    lilac: { name: 'Tím Lilac', hex: '#A855F7', r: 168, g: 85, b: 247, menuIdx: 10 },
    red: { name: 'Đỏ / Cam thể thao', hex: '#FF2E4C', r: 254, g: 30, b: 56, menuIdx: 3, customRgbOnly: true },
};

const CLIMATE_ZONE = { all: 0, both: 0, sync: 0, driver: 1, passenger: 2 };
const WINDOW_ID_SP18 = { fl: 'DRIVER', fr: 'PASSENGER', rl: 'DRIVER_REAR', rr: 'PASSENGER_REAR' };
const WINDOW_ID_SP21 = { fl: 0, fr: 1, rl: 2, rr: 3 };
const MEDIA_BTN_ENUM = { play: 'PLAY', pause: 'PAUSE', stop: 'STOP', previous: 'ITEM_PREV', next: 'ITEM_NEXT' };
const IPA_LIGHT = { off: 0, center: 1, listenDriver: 2, listenPassenger: 3 };

function resolveAmbientColor(raw) {
    if (!raw) return null;
    const k = String(raw).trim().toLowerCase();
    if (OEM_AMBIENT_COLORS[k]) return Object.assign({ key: k }, OEM_AMBIENT_COLORS[k]);
    if (/đồng|vàng|amber|gold|bronze/.test(k)) return Object.assign({ key: 'bronze' }, OEM_AMBIENT_COLORS.bronze);
    if (/cam|orange/.test(k)) return Object.assign({ key: 'orange' }, OEM_AMBIENT_COLORS.orange);
    if (/đỏ|red/.test(k)) return Object.assign({ key: 'red' }, OEM_AMBIENT_COLORS.red);
    if (/trắng|white/.test(k)) return Object.assign({ key: 'white' }, OEM_AMBIENT_COLORS.white);
    if (/băng|ngọc|cyan|ice/.test(k)) return Object.assign({ key: 'cyan' }, OEM_AMBIENT_COLORS.cyan);
    if (/lá|lục|green|emerald/.test(k)) return Object.assign({ key: 'green' }, OEM_AMBIENT_COLORS.green);
    if (/tím|hồng|purple|lilac|violet|pink/.test(k)) return Object.assign({ key: 'lilac' }, OEM_AMBIENT_COLORS.lilac);
    if (/xanh|blue/.test(k)) return Object.assign({ key: 'blue' }, OEM_AMBIENT_COLORS.blue);
    return null;
}

function enumKeyForValue(enumDef, val) {
    if (!enumDef || !enumDef.items) return val;
    if (typeof val === 'string' && enumDef.items[val] !== undefined) return val;
    const keys = Object.keys(enumDef.items);
    for (let i = 0; i < keys.length; i++) {
        if (enumDef.items[keys[i]] === val) return keys[i];
    }
    if (enumDef.defaultValue !== undefined) {
        for (let j = 0; j < keys.length; j++) {
            if (enumDef.items[keys[j]] === enumDef.defaultValue) return keys[j];
        }
    }
    return keys[0];
}

function coerceByDataRef(datatypes, dataRef, val, depth) {
    if (!datatypes || !dataRef || (depth || 0) > 7) return val;
    const t = datatypes[dataRef];
    if (!t) {
        if (val !== undefined) return val;
        if (dataRef === 'Bool' || dataRef === 'Boolean') return false;
        if (dataRef === 'String') return '';
        return 0;
    }
    if (t.type === 'typedef' && t.dataRef) {
        return coerceByDataRef(datatypes, t.dataRef, val !== undefined ? val : t.defaultValue, (depth || 0) + 1);
    }
    if (t.type === 'enum') {
        return enumKeyForValue(t, val !== undefined ? val : t.defaultValue);
    }
    if (t.type === 'struct' && Array.isArray(t.members)) {
        const out = {};
        const src = (val && typeof val === 'object') ? val : {};
        for (let i = 0; i < t.members.length; i++) {
            const mb = t.members[i];
            const raw = src[mb.name] !== undefined ? src[mb.name] : mb.defaultValue;
            out[mb.name] = coerceByDataRef(datatypes, mb.dataRef, raw, (depth || 0) + 1);
        }
        return out;
    }
    if (t.type === 'array' && t.dataRef) {
        const arr = Array.isArray(val) ? val : [];
        return arr.map((item) => coerceByDataRef(datatypes, t.dataRef, item, (depth || 0) + 1));
    }
    return val !== undefined ? val : (t.defaultValue !== undefined ? t.defaultValue : 0);
}

function snapBmwIhkaTempC(tempC) {
    const raw = +(Math.round((Number(tempC) || 22) * 2) / 2).toFixed(1);
    const clamped = Math.max(16, Math.min(28, raw));
    // Hot-climate BMW G30 IHKA (S823A) steps jump directly from 16.0°C (LOW) to 18.0°C..28.0°C
    if (clamped > 16.0 && clamped < 18.0) {
        return clamped < 16.8 ? 16.0 : 18.0;
    }
    return clamped;
}

function decodeSp18TempByte(raw) {
    if (typeof raw !== 'number' || !isFinite(raw) || raw <= 0 || raw >= 250) return null;
    if (raw >= 30 && raw <= 64) return +(raw * 0.5).toFixed(1);
    if (raw >= 0 && raw <= 28) return +(16 + raw * 0.5).toFixed(1);
    return null;
}

function encodeSp18TempByte(tempC, observedRaw) {
    const snapped = snapBmwIhkaTempC(tempC);
    if (typeof observedRaw === 'number' && observedRaw > 0 && observedRaw <= 28) {
        return Math.max(0, Math.min(28, Math.round((snapped - 16) * 2)));
    }
    return Math.max(32, Math.min(56, Math.round(snapped * 2)));
}

function createInitialState() {
    return {
        liveCar: false,
        availableProxies: [],
        speedKmh: 0,
        rpm: 0,
        gear: 'P',
        engineRunning: false,
        coolantTempC: 86,
        oilTempC: 90,
        battery12v: 12.6,
        fuelPercent: 65,
        rangeKm: 410,
        odometerKm: 0,
        tyresBar: { fl: 2.4, fr: 2.4, rl: 2.5, rr: 2.5 },
        tyresLive: false,
        sunroof: 'closed',
        windows: { fl: 0, fr: 0, rl: 0, rr: 0 },
        climate: {
            on: true,
            tempDriverC: 22.5,
            tempPassengerC: 22.5,
            fanLevel: 2,
            maxAc: false,
            defrost: false,
            freshAir: true,
            sync: false,
            seatHeatDriver: 0,
            seatHeatPassenger: 0,
            seatCoolDriver: 0,
            seatCoolPassenger: 0,
            massageDriver: false,
            massagePassenger: false,
            wheelHeat: false,
        },
        ambient: {
            on: true,
            key: 'orange',
            name: 'Cam BMW',
            hex: '#FF5500',
            brightness: 80,
        },
        media: {
            playing: true,
            source: 'CarPlay / Media',
            volumePercent: 30,
            muted: false,
        },
        callActive: false,
        pttPressed: false,
        updatedAt: Date.now(),
    };
}

function loadIFConfigGenerator() {
    for (let i = 0; i < APPMGMTS.length; i++) {
        if (!fs.existsSync(APPMGMTS[i])) continue;
        const bundleText = fs.readFileSync(APPMGMTS[i], 'utf8');
        const m = /"someip-interfaces-generator\/IFConfigGenerator(?:\.js)?":(\d+)/.exec(bundleText);
        const tail = /,\{\},\[\d+\]\)\s*;?\s*$/;
        if (m && tail.test(bundleText)) {
            const bundleReq = new Function('require', 'return ' + bundleText.replace(tail, ',{},[])'))(require);
            return bundleReq(m[1]);
        }
        const start = bundleText.indexOf('/*** "./node_modules/mgu-IFA/IFConfigGenerator.js":');
        if (start >= 0) {
            const firstFn = bundleText.indexOf('function(', start);
            const end = bundleText.indexOf('\n/***/ }),', firstFn);
            if (firstFn >= 0 && end > firstFn) {
                const mod = { exports: {} };
                const fn = new Function('return (' + bundleText.slice(firstFn, end) + ')')();
                fn(mod, mod.exports, function (id) { return require(id); });
                if (mod.exports && typeof mod.exports.generate === 'function') return mod.exports;
            }
        }
    }
    return null;
}

function sendOptionalComfortRgb(sockPath, payload) {
    return new Promise((resolve) => {
        if (!sockPath || !fs.existsSync(sockPath)) return resolve({ ok: false });
        let done = false;
        const finish = (v) => {
            if (done) return;
            done = true;
            clearTimeout(timer);
            try { sock.destroy(); } catch (e) {}
            resolve(v);
        };
        const sock = net.createConnection(sockPath, () => {
            sock.write(JSON.stringify(payload) + '\n');
            setTimeout(() => finish({ ok: true }), 120);
        });
        const timer = setTimeout(() => finish({ ok: true }), 400);
        sock.on('error', () => finish({ ok: false }));
    });
}

/**
 * Decide whether a BMW / projection telephony state value means a call is in progress.
 * Accepts booleans, numbers, strings and SOME/IP structs (objects / arrays).
 * Only clearly active states count: ringing, dialing, alerting, active, held, connected.
 */
function isCallStateActive(v, depth) {
    const d = depth || 0;
    if (v === null || v === undefined || d > 4) return false;
    if (typeof v === 'boolean') return v;
    if (typeof v === 'number') return v > 1 && v < 32;
    if (typeof v === 'string') {
        const u = v.toUpperCase();
        if (/IDLE|NONE|INACTIVE|DISCONNECT|TERMINAT|ENDED|RELEASED|OFF|INVALID|UNKNOWN|NO_CALL|NOCALL/.test(u)) return false;
        return /RING|DIAL|ALERT|INCOM|OUTGO|ACTIVE|HELD|HOLD|CONNECT|WAIT|CALLING|BUSY/.test(u);
    }
    if (Array.isArray(v)) return v.some((x) => isCallStateActive(x, d + 1) === true);
    if (typeof v === 'object') {
        const keys = ['state', 'callState', 'status', 'value', 'active', 'isActive'];
        for (let i = 0; i < keys.length; i++) {
            if (Object.prototype.hasOwnProperty.call(v, keys[i])) return isCallStateActive(v[keys[i]], d + 1) === true;
        }
        return Object.keys(v).some((k) => isCallStateActive(v[k], d + 1) === true);
    }
    return false;
}

class CarController {
    constructor(opts) {
        this.opts = Object.assign({
            catalogPath: CATALOG_PATH,
            someipPath: SOMEIP_PATH,
            comfortSock: COMFORT_SOCK,
            onStateChange: null,
            onPttEvent: null,
            shouldFireImmediateShortPress: null,
            onLog: () => {},
        }, opts || {});
        this.state = createInitialState();
        this.proxies = {};
        this.proxyIfaceMap = {};
        this.db = null;
        this.observedTempRaw = null;
        this.pttDownAt = 0;
        this.pttLongTimer = null;
        this.pttLongFired = false;
        this.pttImmediateFired = false;
        this.lastPttTapAt = 0;
        this.lastPttDispatchAt = 0;
        this.lastSpeechDialogState = null;
        this.lastRpmEmitAt = 0;
        this.lastSpeedEmitAt = 0;
        this.lastProxyRefreshAt = 0;
        this._nativeChain = Promise.resolve();
        this._overlayChain = Promise.resolve();
        this._duckSavedVol = null;
        this._playerStates = {};
    }

    log(msg) {
        if (this.opts.onLog) this.opts.onLog(msg);
    }

    /** Serialize all C++ `someip.node` operations onto fresh `setImmediate` ticks (prevents C++ futex deadlocks). */
    nativeTick(fn) {
        const step = () => new Promise((resolve, reject) => {
            setImmediate(() => {
                try { Promise.resolve(fn()).then(resolve, reject); } catch (e) { reject(e); }
            });
        });
        const p = this._nativeChain.then(step, step);
        this._nativeChain = p.catch(() => {});
        return p;
    }

    emitState() {
        this.state.updatedAt = Date.now();
        if (this.opts.onStateChange) this.opts.onStateChange(this.state);
    }

    patchState(partial) {
        if (!partial || typeof partial !== 'object') return;
        Object.keys(partial).forEach((k) => {
            const v = partial[k];
            if (v && typeof v === 'object' && !Array.isArray(v) && this.state[k] && typeof this.state[k] === 'object') {
                Object.assign(this.state[k], v);
            } else {
                this.state[k] = v;
            }
        });
        if (typeof partial.rpm === 'number') {
            this.state.engineRunning = partial.rpm >= 400;
        }
        this.emitState();
    }

    handleSteeringPttSignal(pressed) {
        const now = Date.now();
        if (pressed && !this.state.pttPressed) {
            this.state.pttPressed = true;
            this.pttDownAt = now;
            this.pttLongFired = false;
            this.pttImmediateFired = false;
            this.abortNativeSpeechPrompt();
            if (this.opts.shouldFireImmediateShortPress && this.opts.shouldFireImmediateShortPress()) {
                this.pttImmediateFired = true;
                this.lastPttDispatchAt = now;
                this.emitState();
                if (this.opts.onPttEvent) this.opts.onPttEvent({ kind: 'short_press', heldMs: 0 });
                return;
            }
            if (this.pttLongTimer) clearTimeout(this.pttLongTimer);
            this.pttLongTimer = setTimeout(() => {
                if (this.state.pttPressed && !this.pttLongFired) {
                    this.pttLongFired = true;
                    this.lastPttDispatchAt = Date.now();
                    if (this.opts.onPttEvent) this.opts.onPttEvent({ kind: 'long_press', heldMs: Date.now() - this.pttDownAt });
                }
            }, 620);
            this.emitState();
        } else if (!pressed && this.state.pttPressed) {
            this.state.pttPressed = false;
            if (this.pttLongTimer) {
                clearTimeout(this.pttLongTimer);
                this.pttLongTimer = null;
            }
            const heldMs = now - this.pttDownAt;
            const skip = this.pttLongFired || this.pttImmediateFired;
            this.pttImmediateFired = false;
            this.emitState();
            if (skip) return;
            let kind = heldMs >= 620 ? 'long_press' : 'short_press';
            if (kind === 'short_press' && (now - this.lastPttTapAt) < 480) {
                kind = 'double_press';
                this.lastPttTapAt = 0;
            } else {
                this.lastPttTapAt = now;
            }
            this.lastPttDispatchAt = now;
            if (this.opts.onPttEvent) this.opts.onPttEvent({ kind, heldMs });
        }
    }

    abortNativeSpeechPrompt() {
        const fire = () => {
            this.callMethodIfAvailable('speechPrompter', 'abortPrompt', {}).catch(() => {});
            this.callMethodIfAvailable('voicePrompt', 'abort', {}).catch(() => {});
            this.callMethodIfAvailable('speechRecognizer', 'abortRecognition', {}).catch(() => {});
        };
        fire();
        [60, 160, 320, 600].forEach((ms) => {
            const t = setTimeout(fire, ms);
            if (t.unref) t.unref();
        });
    }

    applyTpmsStruct(v) {
        if (!v || typeof v !== 'object') return;
        const barOf = (raw) => (typeof raw === 'number' && isFinite(raw) && raw > 0 && raw < 65000) ? +(raw * 0.1).toFixed(1) : null;
        const fl = barOf(v.actualValuePressureTyreFLH);
        const fr = barOf(v.actualValuePressureTyreFRH);
        const rl = barOf(v.actualValuePressureTyreRLH);
        const rr = barOf(v.actualValuePressureTyreRRH);
        if (fl !== null || fr !== null || rl !== null || rr !== null) {
            if (fl !== null) this.state.tyresBar.fl = fl;
            if (fr !== null) this.state.tyresBar.fr = fr;
            if (rl !== null) this.state.tyresBar.rl = rl;
            if (rr !== null) this.state.tyresBar.rr = rr;
            this.state.tyresLive = true;
        }
    }

    async isProxyAvailable(key) {
        const px = this.proxies[key];
        if (!px) return false;
        if (typeof px.isAvailable !== 'function') return true;
        try { return !!(await this.nativeTick(() => px.isAvailable())); } catch (e) { return false; }
    }

    async refreshAvailableProxies(force) {
        const now = Date.now();
        if (!force && this.lastProxyRefreshAt > 0 && (now - this.lastProxyRefreshAt) < 10000) {
            return this.state.availableProxies;
        }
        this.lastProxyRefreshAt = now;
        const keys = Object.keys(this.proxies);
        const avail = [];
        for (let i = 0; i < keys.length; i++) {
            if (await this.isProxyAvailable(keys[i])) avail.push(keys[i]);
        }
        this.state.availableProxies = avail;
        return avail;
    }

    coerceFieldPayload(proxyKey, fieldName, payload) {
        if (!this.db || !this.db.datatypes || !this.db.interfaces) return payload;
        const ifaceName = this.proxyIfaceMap[proxyKey];
        const iv = ifaceName && this.db.interfaces[ifaceName];
        const fd = iv && iv.fields && iv.fields[fieldName];
        if (!fd || !fd.dataRef) return payload;
        return coerceByDataRef(this.db.datatypes, fd.dataRef, payload, 0);
    }

    coerceMethodArgs(proxyKey, methodName, rawArgs) {
        if (!this.db || !this.db.datatypes || !this.db.interfaces) return rawArgs || {};
        const ifaceName = this.proxyIfaceMap[proxyKey];
        const iv = ifaceName && this.db.interfaces[ifaceName];
        const md = iv && iv.methods && iv.methods[methodName];
        if (!md || !Array.isArray(md.inputs)) return rawArgs || {};
        const src = (rawArgs && typeof rawArgs === 'object') ? rawArgs : {};
        const out = {};
        for (let i = 0; i < md.inputs.length; i++) {
            const inp = md.inputs[i];
            out[inp.name] = coerceByDataRef(this.db.datatypes, inp.dataRef, src[inp.name], 0);
        }
        return out;
    }

    async setFieldIfAvailable(proxyKey, fieldName, payload, timeoutMs) {
        if (!(await this.isProxyAvailable(proxyKey))) return { ok: false, reason: 'unavailable' };
        const px = this.proxies[proxyKey];
        const coerced = this.coerceFieldPayload(proxyKey, fieldName, payload);
        try {
            const res = await this.nativeTick(() => px.setValue(fieldName, coerced, timeoutMs || 2800));
            return { ok: true, response: res };
        } catch (e) {
            this.log('ERR set ' + proxyKey + '.' + fieldName + ': ' + e.message);
            return { ok: false, error: e.message };
        }
    }

    async callMethodIfAvailable(proxyKey, methodName, payload, timeoutMs) {
        if (!(await this.isProxyAvailable(proxyKey))) return { ok: false, reason: 'unavailable' };
        const px = this.proxies[proxyKey];
        const coercedArgs = this.coerceMethodArgs(proxyKey, methodName, payload);
        const ifaceName = this.proxyIfaceMap[proxyKey];
        const iv = this.db && this.db.interfaces && ifaceName && this.db.interfaces[ifaceName];
        const md = iv && iv.methods && iv.methods[methodName];
        const isFireAndForget = !!(md && (md.fireAndForget || md.methodType === 'fireAndForget'));
        try {
            const res = await this.nativeTick(() => px.callMethod(methodName, coercedArgs, timeoutMs || 2800));
            return { ok: true, response: res };
        } catch (e) {
            const msg = (e && e.message) ? String(e.message) : String(e || '');
            const isTimeout = /timeout|timed?\s*out/i.test(msg);
            if (isFireAndForget && isTimeout) {
                return { ok: true, response: null, fireAndForget: true };
            }
            if (proxyKey !== 'speechPrompter' && proxyKey !== 'voicePrompt' && proxyKey !== 'speechRecognizer') {
                this.log('ERR call ' + proxyKey + '.' + methodName + ': ' + msg);
            }
            return { ok: false, error: msg, timedOut: isTimeout };
        }
    }

    async connectAudioRoute(amRoute) {
        if (!amRoute || !(await this.isProxyAvailable('audioCmd'))) return null;
        try {
            const cur = await this.nativeTick(() => this.proxies.audioCmd.getValue('listOfMainConnections', 1200));
            const conns = (cur && cur.mainConnections) || (Array.isArray(cur) ? cur : []);
            for (let i = 0; i < conns.length; i++) {
                const c = conns[i];
                if (c && Number(c.sourceID) === amRoute.sourceID && Number(c.sinkID) === amRoute.sinkID) {
                    return { connId: Number(c.mainConnectionID), created: false };
                }
            }
        } catch (e) {}
        const r = await this.callMethodIfAvailable('audioCmd', 'connect', {
            sourceID: amRoute.sourceID,
            sinkID: amRoute.sinkID,
        }, 2000);
        if (r.ok && r.response && typeof r.response.mainConnectionID === 'number' && r.response.mainConnectionID > 0) {
            return { connId: r.response.mainConnectionID, created: true };
        }
        return null;
    }

    async disconnectAudioRoute(connId) {
        if (!connId || connId <= 0) return;
        await this.callMethodIfAvailable('audioCmd', 'disconnect', { mainConnectionID: connId }, 1500);
    }

    hasActiveMediaPlayer() {
        const keys = Object.keys(this._playerStates);
        for (let i = 0; i < keys.length; i++) {
            const st = String(this._playerStates[keys[i]] || '').toUpperCase();
            if (st && st.indexOf('PLAY') >= 0 && st.indexOf('PAUSE') < 0 && st.indexOf('STOP') < 0) {
                return true;
            }
        }
        return false;
    }

    async getLiveMainSinkInfo() {
        if (!(await this.isProxyAvailable('audioCmd'))) return null;
        try {
            const sinks = await this.callMethodIfAvailable('audioCmd', 'getListMainSinks', {}, 1500);
            const list = (sinks && sinks.ok && sinks.response && sinks.response.listMainSinks) || [];
            for (let i = 0; i < list.length; i++) {
                if (list[i] && Number(list[i].sinkID) === 1 && typeof list[i].volume === 'number') {
                    const muteRaw = String(list[i].muteState || '').toUpperCase();
                    const muted = list[i].muteState === 1 || muteRaw === 'MS_MUTED' || muteRaw === 'MUTED';
                    this.state.media.volumePercent = list[i].volume;
                    this.state.media.muted = muted;
                    return { volume: list[i].volume, muted };
                }
            }
        } catch (e) {}
        return null;
    }

    async getLiveMainVolume() {
        const info = await this.getLiveMainSinkInfo();
        return info ? info.volume : null;
    }

    /**
     * Smoothly duck loud car music (MainSink sinkID 1 -> volume 6) while ceiling mic listens,
     * ONLY when speakers are actually audible and NOT muted/paused (calling setVolume on BMW MGU
     * while paused/muted acts like turning the volume knob and resumes paused music!).
     */
    async duckMusicForListening(opts) {
        const o = opts || {};
        if (!this.state.liveCar || this.state.callActive || this._duckSavedVol !== null) return false;
        const sink = await this.getLiveMainSinkInfo();
        if (!sink || sink.muted || typeof sink.volume !== 'number' || sink.volume <= 10) return false;

        // Guard: NEVER call setVolume when music is paused/silent!
        const audible = o.hasRefChannel ? !!o.speakerPlaying : this.hasActiveMediaPlayer();
        if (!audible) {
            this.log('Audio duck skipped (music paused/silent)');
            return false;
        }

        const target = 6;
        const r = await this.callMethodIfAvailable('audioCmd', 'setVolume', { sinkID: 1, volume: target }, 1200);
        if (r && r.ok) {
            this._duckSavedVol = sink.volume;
            this.log('Audio ducked for mic: ' + sink.volume + ' -> ' + target);
            return true;
        }
        return false;
    }

    async restoreMusicAfterListening() {
        if (this._duckSavedVol === null) return false;
        const orig = this._duckSavedVol;
        this._duckSavedVol = null;
        await this.callMethodIfAvailable('audioCmd', 'setVolume', { sinkID: 1, volume: orig }, 1500).catch(() => {});
        this.state.media.volumePercent = orig;
        this.log('Audio restored: ' + orig);
        return true;
    }

    /**
     * Play a 24 kHz mono WAV voice confirmation / chime over BMW's native `OapGenericOverlay`
     * (`sourceID: 1048 -> sinkID: 1024 MediaSink_Front`, Overlay class 2).
     * Gently ducks CarPlay / Android Auto / Bluetooth music while speaking and restores music cleanly after.
     */
    playOverlayWav(wavPath, durationMs) {
        const task = async () => {
            if (!wavPath || !fs.existsSync(wavPath) || this.state.callActive) return false;
            if (!(await this.isProxyAvailable('audioCmd')) || !(await this.isProxyAvailable('mediaOverlay'))) {
                return false;
            }
            let connId = null;
            let created = false;
            try {
                // Connect OapGenericOverlay (1048) -> MediaSink_Front (1024)
                let connRes = null;
                for (let i = 0; i < 3; i++) {
                    if (i > 0) await new Promise((r) => setTimeout(r, 180));
                    connRes = await this.callMethodIfAvailable('audioCmd', 'connect', {
                        sourceID: 1048,
                        sinkID: 1024,
                    }, 2500);
                    const amErr = connRes && connRes.response && connRes.response.amError;
                    if (connRes && connRes.ok && (amErr === 'E_OK' || amErr === 'E_ALREADY_EXISTS' || amErr === 0)) {
                        connId = connRes.response.mainConnectionID;
                        created = (amErr === 'E_OK' || amErr === 0);
                        break;
                    }
                }
                if (connId === null || connId === undefined) return false;

                const pf = await this.callMethodIfAvailable('mediaOverlay', 'playFile', {
                    path: wavPath,
                    languageCode: 7695972,
                }, 3000);
                if (!pf || !pf.ok || (pf.response && pf.response.EntError && pf.response.EntError !== 'OK' && pf.response.EntError !== 0)) {
                    return false;
                }
                const waitMs = Math.max(250, Math.min(9000, (Number(durationMs) || 2600) + 420));
                await new Promise((r) => setTimeout(r, waitMs));
                return true;
            } catch (e) {
                this.log('overlay TTS warn: ' + e.message);
                return false;
            } finally {
                await this.callMethodIfAvailable('mediaOverlay', 'sendButtonEvent', {
                    button: 'STOP',
                    action: 'PRESS',
                }, 1500).catch(() => {});
                if (created && connId !== null && connId !== undefined && connId > 0) {
                    await this.disconnectAudioRoute(connId).catch(() => {});
                }
            }
        };
        const p = this._overlayChain.then(task, task);
        this._overlayChain = p.catch(() => {});
        return p;
    }

    async pulseIpaLight(mode) {
        const code = IPA_LIGHT[mode] !== undefined ? IPA_LIGHT[mode] : 0;
        await this.callMethodIfAvailable('ipaLight', 'setIpaLightingInterior', {
            consumerID: 16,
            priorityGroup: 6,
            lightingState: code,
        }, 1200);
    }

    async initHardwareBus() {
        if (!fs.existsSync(this.opts.someipPath) || !fs.existsSync(this.opts.catalogPath)) {
            this.log('simulation mode (MGU SOME/IP absent)');
            return false;
        }
        let someip, db, gen;
        try {
            someip = require(this.opts.someipPath);
            db = JSON.parse(fs.readFileSync(this.opts.catalogPath, 'utf8'));
            gen = loadIFConfigGenerator();
        } catch (e) {
            this.log('SOME/IP load warning: ' + e.message);
            return false;
        }
        if (!gen || !db || !db.interfaces) return false;

        const bindings = [];
        const addBinding = (key, ifaceName, fieldNames, methodNames, onField, instanceHint, opts) => {
            bindings.push({ key, ifaceName, fieldNames: fieldNames || [], methodNames: methodNames || [], onField: onField || null, instanceHint, opts: opts || {} });
        };

        // 1. Essential Telemetry (`<= 2 Hz` throttled)
        addBinding('cds', 'de.bmw.infotainment.vehicle.CDS', ['statusEngineSpeed2', 'statusEngineTemperature', 'statusEngineStatus'], [], (f, v) => {
            if (!v) return;
            if (f === 'statusEngineSpeed2' && v.actualValueRPMEngineCrankshaft !== undefined && v.actualValueRPMEngineCrankshaft !== 65535) {
                const rawRpm = v.actualValueRPMEngineCrankshaft * 0.25;
                const nextRpm = rawRpm < 400 ? 0 : Math.round(rawRpm);
                const now = Date.now();
                if (nextRpm === this.state.rpm) return;
                if ((nextRpm === 0) === (this.state.rpm === 0) && Math.abs(nextRpm - this.state.rpm) < 40 && (now - this.lastRpmEmitAt) < 500) return;
                this.lastRpmEmitAt = now;
                this.patchState({ rpm: nextRpm });
            } else if (f === 'statusEngineTemperature') {
                const p = {};
                if (v.temperatureEngineDrive !== undefined && v.temperatureEngineDrive !== 255) p.coolantTempC = v.temperatureEngineDrive - 48;
                if (v.temperatureEngineOilDrive !== undefined && v.temperatureEngineOilDrive !== 255) p.oilTempC = v.temperatureEngineOilDrive - 48;
                if (p.coolantTempC !== undefined || p.oilTempC !== undefined) this.patchState(p);
            } else if (f === 'statusEngineStatus' && v.statusEngineRunDrive !== undefined) {
                const er = v.statusEngineRunDrive;
                const nextRun = (er === 2 || er === 'MOTOR_LAEUFT') ? true : ((er === 0 || er === 'MOTOR_AUS') ? false : null);
                if (nextRun !== null && nextRun !== this.state.engineRunning) this.patchState({ engineRunning: nextRun });
            }
        });

        addBinding('vehicle2', 'de.bmw.infotainment.vehicle.Vehicle2', ['statusCarSpeed2'], [], (f, v) => {
            if (v && f === 'statusCarSpeed2' && v.speedVehicleCentreOfGravity !== undefined && v.speedVehicleCentreOfGravity !== 65535) {
                const nextSpd = +(v.speedVehicleCentreOfGravity * 0.015625).toFixed(1);
                const now = Date.now();
                if (nextSpd === this.state.speedKmh) return;
                if ((nextSpd > 2) === (this.state.speedKmh > 2) && Math.abs(nextSpd - this.state.speedKmh) < 0.8 && (now - this.lastSpeedEmitAt) < 500) return;
                this.lastSpeedEmitAt = now;
                this.patchState({ speedKmh: nextSpd });
            }
        });

        addBinding('vehInfo', 'de.bmw.infrastructure.VehicleInformation', [
            'statusBoardnetVoltage',
            'statusFuelTank',
            'statusRange',
            'DataPowerTrain2',
        ], [], (f, v) => {
            if (!v) return;
            if (f === 'statusBoardnetVoltage' && typeof v.voltage === 'number' && v.voltage > 50 && v.voltage < 200) {
                this.patchState({ battery12v: +(v.voltage * 0.1).toFixed(1) });
            } else if (f === 'statusFuelTank' && typeof v.fuelLevelPercent === 'number' && v.fuelLevelPercent <= 100) {
                this.patchState({ fuelPercent: Math.round(v.fuelLevelPercent) });
            } else if (f === 'statusRange' && typeof v.rangeKm === 'number' && v.rangeKm < 2000) {
                this.patchState({ rangeKm: Math.round(v.rangeKm) });
            } else if (f === 'DataPowerTrain2' && v.statusGearSelectionDrive !== undefined) {
                const g = v.statusGearSelectionDrive;
                const gear = g === 3 || g === 'P' ? 'P' : (g === 2 || g === 'R' ? 'R' : (g === 1 || g === 'N' ? 'N' : 'D'));
                if (gear !== this.state.gear) this.patchState({ gear });
            }
        });

        // TPMS: strictly `noSubscribe: true` (on-demand `getValue` only!)
        addBinding('tpms', 'de.bmw.infotainment.vehicle.TPMS', ['statusTyrePressure'], [], (f, v) => {
            if (f === 'statusTyrePressure') this.applyTpmsStruct(v);
        }, undefined, { noSubscribe: true });

        // 2. Steering Wheel Mic PTT (`statusPTTButton1`) + Native Unsupported-Language Prompt Silencer
        addBinding('steering', 'de.bmw.infotainment.controlelements.SteeringWheelPushButton', ['statusPTTButton1'], [], (f, v) => {
            if (v === null || v === undefined) return;
            let raw = v;
            if (raw && typeof raw === 'object') {
                const keys = Object.keys(raw);
                if (!keys.length) return;
                raw = raw[keys[0]];
            }
            if (raw === null || raw === undefined) return;
            const sRaw = String(raw).toUpperCase();
            // Ignore invalid (3/15/255) and capacitive finger touch (`2 = PTT_MINUS_TASTER_BERUEHRT`)
            if (raw === 3 || raw === 15 || raw === 255 || /UNGUELTIG|UNBEFUELLT|INVALID/.test(sRaw)) return;
            let pressed = false;
            if (typeof raw === 'boolean') {
                pressed = raw;
            } else if (typeof raw === 'number') {
                pressed = (raw === 1);
            } else {
                const isReleased = /NICHT|BERUEHRT|RESERVIERT|LOSGELASSEN|RELEASE|IDLE|AUS|KEINE/.test(sRaw);
                const isActuated = /BETAETIGT|GEDRUECKT|PRESSED|KURZ|LANG|EIN|ACTIVE/.test(sRaw);
                pressed = !isReleased && isActuated;
            }
            this.handleSteeringPttSignal(pressed);
        });

        addBinding('speechDialog', 'de.bmw.infotainment.speech.dialog.Dialog', ['dialogState'],
            ['abortDialog', 'abort', 'cancelDialog', 'stopDialog'], (f, v, isInitialRead) => {
            if (v === null || v === undefined) return;
            const prev = this.lastSpeechDialogState;
            this.lastSpeechDialogState = v;
            if (isInitialRead) return;
            const sVal = String(v).toUpperCase();
            const isIdle = (v === 0 || v === 1 || /^(IDLE|NONE|INACTIVE|ABORTED|STOPPED|OFF|0|1)$/.test(sVal));
            if (!isIdle && prev !== v) {
                this.abortNativeSpeechPrompt();
                const now = Date.now();
                if (!this.state.pttPressed && (now - this.lastPttDispatchAt) > 1200) {
                    this.lastPttDispatchAt = now;
                    if (this.opts.onPttEvent) this.opts.onPttEvent({ kind: 'short_press', heldMs: 100 });
                }
            }
        }, 'HMISpeechHU');
        addBinding('speechPrompter', 'de.bmw.infotainment.speech.prompter.Prompter', [], ['abortPrompt'], null, 'PALSpeechHU');
        addBinding('voicePrompt', 'de.bmw.infotainment.speech.voiceprompt.VoicePrompt', [], ['abort']);
        addBinding('speechRecognizer', 'de.bmw.infotainment.speech.recognizer.Recognizer', [], ['abortRecognition'], null, 'PALSpeechHU');

        // 3. Phone & CarPlay Call Guard
        // Each source is tracked separately; callActive = phone || projected (CarPlay / AA).
        // SOME/IP often delivers the call state as a struct, so never String() it blindly.
        this.callSrc = this.callSrc || { phone: false, projected: false };
        const applyCall = (src, active, raw) => {
            const rawTxt = raw === undefined ? 'undefined' : (function () { try { return JSON.stringify(raw); } catch (e) { return String(raw); } })();
            const prevRaw = this.state.callRaw && this.state.callRaw[src];
            this.callSrc[src] = !!active;
            const next = !!(this.callSrc.phone || this.callSrc.projected);
            const callRaw = Object.assign({}, this.state.callRaw || {});
            callRaw[src] = String(rawTxt).slice(0, 160);
            if (prevRaw !== callRaw[src] && typeof this.log === 'function') this.log('call ' + src + ' -> ' + (active ? 'active' : 'idle') + ' raw=' + callRaw[src]);
            this.patchState({ callRaw: callRaw });
            if (next !== this.state.callActive) this.patchState({ callActive: next });
        };
        addBinding('voiceCall', 'de.bmw.infotainment.connectivity.telephony.VoiceCall', ['state'], [], (f, v) => {
            applyCall('phone', isCallStateActive(v), v);
        });
        addBinding('carplay', 'de.bmw.infotainment.a4a.carplay.CarPlayManager', ['projectedTelephonyActive'], [], (f, v) => {
            if (typeof v === 'boolean') applyCall('projected', v, v);
            else if (v && typeof v === 'object') applyCall('projected', isCallStateActive(v), v);
        });

        // 4. Verified SP18 + SP21 OEM BMW IPA Actuators
        addBinding('sp18Climate2', 'de.bmw.infotainment.climate.Climate2', [
            'operationAirConditioningFront',
            'operationStratificationSeatHeating',
            'statusAirConditionDRStatus',
            'statusAirConditionPSStatus',
        ], [], (f, v) => {
            if (!v) return;
            if (f === 'statusAirConditionDRStatus') {
                let changed = false;
                if (typeof v.temperatureTargetDRIHKA === 'number' && v.temperatureTargetDRIHKA !== 255) {
                    this.observedTempRaw = v.temperatureTargetDRIHKA;
                    const c = decodeSp18TempByte(v.temperatureTargetDRIHKA);
                    if (c !== null && c !== this.state.climate.tempDriverC) { this.state.climate.tempDriverC = c; changed = true; }
                }
                if (typeof v.statusBlowerSettingDR === 'number' && v.statusBlowerSettingDR >= 1 && v.statusBlowerSettingDR <= 9) {
                    const flv = Math.min(5, v.statusBlowerSettingDR);
                    if (flv !== this.state.climate.fanLevel) { this.state.climate.fanLevel = flv; changed = true; }
                }
                if (changed) this.emitState();
            } else if (f === 'statusAirConditionPSStatus') {
                if (typeof v.temperatureTargetPSIHKA === 'number' && v.temperatureTargetPSIHKA !== 255) {
                    const c = decodeSp18TempByte(v.temperatureTargetPSIHKA);
                    if (c !== null && c !== this.state.climate.tempPassengerC) {
                        this.state.climate.tempPassengerC = c;
                        this.emitState();
                    }
                }
            }
        });
        addBinding('sp18Climate1', 'de.bmw.infotainment.climate.Climate', ['acSpecialFunction', 'seatAutoClimateDR', 'seatAutoClimatePS'], []);
        addBinding('sp18Comfort2', 'de.bmw.infotainment.misc.ComfortFunction2', ['seatMassageFL', 'seatMassageFR'], []);
        addBinding('sp18WheelHeat', 'de.bmw.body.steeringwheelcomfort.SteeringWheelClimate', [], ['requestHeating']);
        addBinding('sp18Ambient', 'de.bmw.infotainment.misc.ComfortFunctionIuK', ['ambientLightInteriorColour', 'statusAmbientLightInteriorColour'], []);
        addBinding('windowLifter', 'de.bmw.body.windowmaster.WindowLifter', [], ['moveWindow']);
        addBinding('sp18SunRoof', 'de.bmw.body.doorsandwindows.SunProtectionRoofWindows', ['operationSHDMDS'], []);
        addBinding('sp18RoofSys', 'de.bmw.infrastructure.ControlRoofsystem', ['controlRoofSystem'], []);
        addBinding('ipaLight', 'de.bmw.body.interiorillumination.IpaInteriorLight', [], ['setIpaLightingInterior']);

        addBinding('climateMaster', 'de.bmw.infotainment.climate.climatemaster.ClimateMaster', [], [
            'requestTemperature', 'requestDeltaTemperature', 'requestAirBlowLevel', 'requestAirCondMaxAC',
            'requestClimateSystemOn', 'requestAirQualityFresh',
            'requestSeatClimateSeatHeating', 'requestSeatClimateSeatCooling', 'requestSteeringWheelHeating',
        ]);
        addBinding('windowMaster', 'de.bmw.body.windowmaster.WindowLifterMaster', [], ['moveWindow']);

        // 5. Audio Volume (`MainSink` `sinkID: 1`) & Media Transport (`CarPlay` / `Bluetooth` / `AndroidAuto` / `Generic`)
        const onPlayerState = (key) => (f, v) => {
            if (f !== 'playerState' || v === null || v === undefined) return;
            const raw = (v && typeof v === 'object' && v.state !== undefined) ? v.state : v;
            this._playerStates[key] = String(raw);
            this.state.media.playing = this.hasActiveMediaPlayer();
        };
        addBinding('audioCmd', 'org.genivi.am.commandinterface.CommandControl', ['listOfMainConnections'],
            ['connect', 'disconnect', 'getListMainSinks', 'getVolume', 'setVolume', 'setSinkMuteState'], null, '1');
        addBinding('mediaCarPlay', 'de.bmw.infotainment.entertainment.mediaplayer.MediaPlayer', ['playerState'], ['sendButtonEvent'], onPlayerState('mediaCarPlay'), 'CarPlayMedia');
        addBinding('mediaBtA', 'de.bmw.infotainment.entertainment.mediaplayer.MediaPlayer', ['playerState'], ['sendButtonEvent'], onPlayerState('mediaBtA'), 'ExternalDeviceBtA');
        addBinding('mediaAa', 'de.bmw.infotainment.entertainment.mediaplayer.MediaPlayer', ['playerState'], ['sendButtonEvent'], onPlayerState('mediaAa'), 'AndroidAutoProjected');
        addBinding('mediaPlayer', 'de.bmw.infotainment.entertainment.mediaplayer.MediaPlayer', ['playerState'], ['sendButtonEvent'], onPlayerState('mediaPlayer'), 'OapGenericMedia');
        addBinding('mediaOverlay', 'de.bmw.infotainment.entertainment.mediaplayer.MediaPlayer', ['playerState'], ['playFile', 'sendButtonEvent'], null, 'OapGenericOverlay');

        // Single-pass Franca generation
        const mergedProxies = {};
        const slimInterfaces = {};
        for (let bi = 0; bi < bindings.length; bi++) {
            const b = bindings[bi];
            const iv = db.interfaces[b.ifaceName];
            if (!iv) continue;
            slimInterfaces[b.ifaceName] = iv;
            const entry = mergedProxies[b.ifaceName] || { instances: '*', attributes: {}, methods: [] };
            b.resolvedAttrs = {};
            b.fieldNames.forEach((f) => {
                const fd = iv.fields && iv.fields[f];
                if (!fd) return;
                let fl = '';
                if (fd.getter && fd.getter.id) fl += 'r';
                if (!b.opts.noSubscribe && fd.notifier && fd.notifier.id) fl += 's';
                if (fd.setter && fd.setter.id) fl += 'w';
                if (fl) {
                    b.resolvedAttrs[f] = fl;
                    const prev = entry.attributes[f] || '';
                    let union = prev;
                    for (let ci = 0; ci < fl.length; ci++) {
                        if (union.indexOf(fl.charAt(ci)) < 0) union += fl.charAt(ci);
                    }
                    entry.attributes[f] = union;
                }
            });
            b.methodNames.forEach((m) => {
                if (iv.methods && iv.methods[m] && entry.methods.indexOf(m) < 0) entry.methods.push(m);
            });
            if (Object.keys(entry.attributes).length || entry.methods.length) {
                if (!Object.keys(entry.attributes).length) delete entry.attributes;
                if (!entry.methods.length) delete entry.methods;
                mergedProxies[b.ifaceName] = entry;
            }
        }

        let allGenerated = {};
        try {
            allGenerated = gen.generate(db, { proxies: mergedProxies, services: {} }) || {};
        } catch (e) {
            this.log('generate warning: ' + e.message);
            return false;
        }
        this.db = { datatypes: db.datatypes, interfaces: slimInterfaces };
        db = null;

        for (let i = 0; i < bindings.length; i++) {
            const b = bindings[i];
            const cfg = allGenerated[b.ifaceName];
            if (!cfg) continue;
            const inst = b.instanceHint || Object.keys(cfg.instances || { '1': 1 })[0] || '1';
            if (cfg.instances && !cfg.instances[inst]) continue;
            const px = await this.nativeTick(() =>
                someip.buildProxy(cfg, String(inst))
                    .then((p) => p.init().then(() => p))
                    .catch(() => null)
            );
            if (!px) continue;
            this.proxies[b.key] = px;
            this.proxyIfaceMap[b.key] = b.ifaceName;
            this.state.liveCar = true;
            if (b.onField && b.resolvedAttrs) {
                const attrKeys = Object.keys(b.resolvedAttrs);
                for (let fk = 0; fk < attrKeys.length; fk++) {
                    const fname = attrKeys[fk];
                    const flags = b.resolvedAttrs[fname];
                    if (flags.indexOf('s') >= 0) {
                        await this.nativeTick(() => {
                            try {
                                return px.subscribe({
                                    name: fname,
                                    onReceive: (val) => { try { b.onField(fname, val, false); } catch (e) {} },
                                });
                            } catch (e) { return null; }
                        });
                    }
                    if (flags.indexOf('r') >= 0) {
                        this.nativeTick(() => px.getValue(fname, 2500))
                            .then((val) => { try { b.onField(fname, val, true); } catch (e) {} })
                            .catch(() => {});
                    }
                }
            }
        }

        await new Promise((r) => setTimeout(r, 1000));
        await this.refreshAvailableProxies(true);

        await this.getLiveMainSinkInfo();

        this.log('car-control ready (' + this.state.availableProxies.length + ' proxies)');
        this.emitState();
        return true;
    }

    async executeTool(toolName, rawArgs, speakerZone) {
        const args = (rawArgs && typeof rawArgs === 'object') ? rawArgs : {};
        const zoneDefault = speakerZone === 'passenger' ? 'passenger' : 'driver';
        await this.refreshAvailableProxies(false);

        switch (toolName) {
            case 'set_climate': {
                const targetZone = args.zone || zoneDefault;
                const opZone = CLIMATE_ZONE[targetZone] !== undefined ? CLIMATE_ZONE[targetZone] : 1;
                const sp18Front = {};
                const sp18Spec = {};
                let frontTouched = false;
                let specTouched = false;
                let busOk = !this.state.liveCar;
                const changes = [];

                if (args.systemOn !== undefined) {
                    const on = !!args.systemOn;
                    sp18Front.operationOnDR = on ? 'EIN' : 'AUS';
                    sp18Front.operationOnPS = on ? 'EIN' : 'AUS';
                    frontTouched = true;
                    const r21 = await this.callMethodIfAvailable('climateMaster', 'requestClimateSystemOn', {
                        clientGroupId: 0,
                        climateSystemOn: [{ airConditioningOn: on, operationZone: 0, saveLUM: true }],
                    });
                    if (r21.ok) busOk = true;
                    changes.push(on ? 'bật điều hoà' : 'tắt điều hoà');
                }

                if (args.maxAc !== undefined) {
                    const on = !!args.maxAc;
                    sp18Front.operationMaximumAirCondition = on ? 'EIN' : 'AUS';
                    if (on) {
                        sp18Front.operationOnDR = 'EIN';
                        sp18Front.operationAircon = 'EIN';
                    }
                    frontTouched = true;
                    const r21 = await this.callMethodIfAvailable('climateMaster', 'requestAirCondMaxAC', {
                        clientGroupId: 0,
                        airCondMaxAC: [{ maxAirConditioning: on, operationZone: 1, saveLUM: true }],
                    });
                    if (r21.ok) busOk = true;
                    changes.push(on ? 'bật Max AC lạnh sâu' : 'tắt Max AC');
                }

                if (args.defrost !== undefined) {
                    const on = !!args.defrost;
                    sp18Front.operationDefrost = on ? 'EIN' : 'AUS';
                    frontTouched = true;
                    changes.push(on ? 'bật sấy kính chắn gió' : 'tắt sấy kính chắn gió');
                }

                if (args.tempC !== undefined) {
                    const tVal = snapBmwIhkaTempC(args.tempC);
                    const rawByte = encodeSp18TempByte(tVal, this.observedTempRaw);
                    if (opZone === 0) {
                        sp18Front.operationTemperatureTargetDR = rawByte;
                        sp18Front.operationTemperatureTargetPS = rawByte;
                        changes.push('nhiệt độ 2 vùng ' + tVal + '°C');
                    } else if (opZone === 2) {
                        sp18Front.operationTemperatureTargetPS = rawByte;
                        changes.push('điều hoà ghế phụ ' + tVal + '°C');
                    } else {
                        sp18Front.operationTemperatureTargetDR = rawByte;
                        changes.push('điều hoà ghế tài ' + tVal + '°C');
                    }
                    frontTouched = true;
                    const r21 = await this.callMethodIfAvailable('climateMaster', 'requestTemperature', {
                        clientGroupId: 0,
                        temperatureAbsolute: opZone === 0
                            ? [{ targetTemperature: tVal, operationZone: 1, saveLUM: true }, { targetTemperature: tVal, operationZone: 2, saveLUM: true }]
                            : [{ targetTemperature: tVal, operationZone: opZone, saveLUM: true }],
                    });
                    if (r21.ok) busOk = true;
                    args._resolvedTempC = tVal;
                } else if (args.deltaTempC !== undefined) {
                    const d = Number(args.deltaTempC) || 0;
                    if (opZone === 0) {
                        const nextD = snapBmwIhkaTempC(this.state.climate.tempDriverC + d);
                        const nextP = snapBmwIhkaTempC(this.state.climate.tempPassengerC + d);
                        sp18Front.operationTemperatureTargetDR = encodeSp18TempByte(nextD, this.observedTempRaw);
                        sp18Front.operationTemperatureTargetPS = encodeSp18TempByte(nextP, this.observedTempRaw);
                        args._resolvedTempDriverC = nextD;
                        args._resolvedTempPassengerC = nextP;
                        changes.push('nhiệt độ 2 vùng ' + nextD + '°C');
                    } else if (opZone === 2) {
                        const nextP = snapBmwIhkaTempC(this.state.climate.tempPassengerC + d);
                        sp18Front.operationTemperatureTargetPS = encodeSp18TempByte(nextP, this.observedTempRaw);
                        args._resolvedTempPassengerC = nextP;
                        changes.push('điều hoà ghế phụ ' + nextP + '°C');
                    } else {
                        const nextD = snapBmwIhkaTempC(this.state.climate.tempDriverC + d);
                        sp18Front.operationTemperatureTargetDR = encodeSp18TempByte(nextD, this.observedTempRaw);
                        args._resolvedTempDriverC = nextD;
                        changes.push('điều hoà ghế tài ' + nextD + '°C');
                    }
                    frontTouched = true;
                    const r21 = await this.callMethodIfAvailable('climateMaster', 'requestDeltaTemperature', {
                        clientGroupId: 0,
                        temperatureDelta: [{ deltaTemperature: d, operationZone: opZone === 2 ? 2 : 1, saveLUM: true }],
                    });
                    if (r21.ok) busOk = true;
                }

                if (args.fanLevel !== undefined) {
                    const lv = Math.max(1, Math.min(5, Math.round(Number(args.fanLevel) || 2)));
                    if (opZone === 1 || opZone === 0) {
                        sp18Front.operationIntensityDR = 'KLIMASTIL_' + lv;
                        sp18Front.operationManualBlowerLevelDR = 'STUFE_' + lv;
                    }
                    if (opZone === 2 || opZone === 0) {
                        sp18Front.operationIntensityPS = 'KLIMASTIL_' + lv;
                        sp18Front.operationManualBlowerLevelPS = 'STUFE_' + lv;
                    }
                    frontTouched = true;
                    const r21 = await this.callMethodIfAvailable('climateMaster', 'requestAirBlowLevel', {
                        clientGroupId: 0,
                        airBlowLevel: [{ configuredManLevel: lv, gradientIntensity: 0, operationZone: opZone === 2 ? 2 : 1, saveLUM: true }],
                    });
                    if (r21.ok) busOk = true;
                    args._resolvedFan = lv;
                    changes.push('mức gió ' + lv);
                }

                if (args.freshAir !== undefined) {
                    sp18Spec.operationAUCFront = args.freshAir ? 'FRISCHLUFT_GEWAEHLT' : 'UMLUFT_GEWAEHLT';
                    specTouched = true;
                    const r21 = await this.callMethodIfAvailable('climateMaster', 'requestAirQualityFresh', {
                        clientGroupId: 0,
                        freshAir: args.freshAir ? 0 : 2,
                        saveLUM: true,
                    });
                    if (r21.ok) busOk = true;
                    changes.push(args.freshAir ? 'lấy gió ngoài' : 'lấy gió trong');
                }

                if (args.sync !== undefined) {
                    sp18Spec.operationSync = args.sync ? 'SYNCH_AN' : 'SYNCH_AUS';
                    specTouched = true;
                    changes.push(args.sync ? 'đồng bộ SYNC 2 vùng' : 'tắt đồng bộ SYNC');
                }

                if (frontTouched) {
                    const r18 = await this.setFieldIfAvailable('sp18Climate2', 'operationAirConditioningFront', sp18Front);
                    if (r18.ok) busOk = true;
                }
                if (specTouched) {
                    const rSpec = await this.setFieldIfAvailable('sp18Climate1', 'acSpecialFunction', sp18Spec);
                    if (rSpec.ok) busOk = true;
                }

                if (busOk) {
                    if (args.systemOn !== undefined) this.state.climate.on = !!args.systemOn;
                    if (args.maxAc !== undefined) {
                        this.state.climate.maxAc = !!args.maxAc;
                        if (args.maxAc) {
                            this.state.climate.on = true;
                            this.state.climate.tempDriverC = 16.0;
                            this.state.climate.tempPassengerC = 16.0;
                            this.state.climate.fanLevel = 5;
                        }
                    }
                    if (args.defrost !== undefined) this.state.climate.defrost = !!args.defrost;
                    if (args._resolvedTempC !== undefined) {
                        this.state.climate.on = true;
                        if (opZone === 0 || opZone === 1) this.state.climate.tempDriverC = args._resolvedTempC;
                        if (opZone === 0 || opZone === 2) this.state.climate.tempPassengerC = args._resolvedTempC;
                    }
                    if (args._resolvedTempDriverC !== undefined) this.state.climate.tempDriverC = args._resolvedTempDriverC;
                    if (args._resolvedTempPassengerC !== undefined) this.state.climate.tempPassengerC = args._resolvedTempPassengerC;
                    if (args._resolvedFan !== undefined) this.state.climate.fanLevel = args._resolvedFan;
                    if (args.freshAir !== undefined) this.state.climate.freshAir = !!args.freshAir;
                    if (args.sync !== undefined) this.state.climate.sync = !!args.sync;

                    if (this.state.liveCar && frontTouched && await this.isProxyAvailable('sp18Climate2')) {
                        await new Promise((r) => setTimeout(r, 180));
                        try {
                            const dr = await this.nativeTick(() => this.proxies.sp18Climate2.getValue('statusAirConditionDRStatus', 1200));
                            if (dr && typeof dr.temperatureTargetDRIHKA === 'number' && dr.temperatureTargetDRIHKA !== 255) {
                                this.observedTempRaw = dr.temperatureTargetDRIHKA;
                                const cd = decodeSp18TempByte(dr.temperatureTargetDRIHKA);
                                if (cd !== null) this.state.climate.tempDriverC = cd;
                            }
                            const ps = await this.nativeTick(() => this.proxies.sp18Climate2.getValue('statusAirConditionPSStatus', 1200));
                            if (ps && typeof ps.temperatureTargetPSIHKA === 'number' && ps.temperatureTargetPSIHKA !== 255) {
                                const cpv = decodeSp18TempByte(ps.temperatureTargetPSIHKA);
                                if (cpv !== null) this.state.climate.tempPassengerC = cpv;
                            }
                        } catch (e) {}
                    }
                    this.emitState();
                }

                return {
                    ok: busOk,
                    summaryVi: busOk
                        ? ('Đã chỉnh ' + (changes.join(' · ') || 'điều hoà'))
                        : 'Cổng điều hoà IHKA chưa phản hồi lệnh.',
                };
            }

            case 'set_seat_comfort': {
                const side = args.seat || zoneDefault;
                const zones = side === 'both' ? [1, 2] : [side === 'passenger' ? 2 : 1];
                const label = side === 'passenger' ? 'ghế phụ' : (side === 'both' ? '2 ghế trước' : 'ghế tài');
                const okNotes = [];
                const failNotes = [];

                if (args.heatingLevel !== undefined || args.coolingLevel !== undefined) {
                    const hLv = args.heatingLevel !== undefined ? Math.max(0, Math.min(3, Math.round(Number(args.heatingLevel) || 0))) : 255;
                    const cLv = args.coolingLevel !== undefined ? Math.max(0, Math.min(3, Math.round(Number(args.coolingLevel) || 0))) : 255;
                    const sp18Seats = {};
                    let seatOk = !this.state.liveCar;

                    if (side === 'driver' || side === 'both') {
                        if (hLv !== 255) sp18Seats.oPFunctionStageSeatHeaterAICDriver = 'STUFE_' + hLv;
                        if (cLv !== 255) sp18Seats.oPFunctionStageSeatClimateAICDriver = 'STUFE_' + cLv;
                        const rDr = await this.setFieldIfAvailable('sp18Climate1', 'seatAutoClimateDR', {
                            operationSeatHeaterStageDRS: hLv !== 255 ? ('STUFE_' + hLv) : 'SIGNAL_UNGUELTIG',
                            operationSeatHeaterActivationDRS: hLv !== 255 ? (hLv > 0 ? 'SITZHEIZUNGSFUNKTION_AN' : 'SITZHEIZUNGSFUNKTION_AUS') : 'SIGNAL_UNGUELTIG',
                            operationSeatVentilationStageDRS: cLv !== 255 ? ('STUFE_' + cLv) : 'SIGNAL_UNGUELTIG',
                            operationSeatVentilationActivationDRS: cLv !== 255 ? (cLv > 0 ? 'SITZLUEFTUNGSFUNKTION_AN' : 'SITZLUEFTUNGSFUNKTION_AUS') : 'SIGNAL_UNGUELTIG',
                        });
                        if (rDr.ok) seatOk = true;
                    }
                    if (side === 'passenger' || side === 'both') {
                        if (hLv !== 255) sp18Seats.oPFunctionStageSeatHeaterAICPassenger = 'STUFE_' + hLv;
                        if (cLv !== 255) sp18Seats.oPFunctionStageSeatClimateAICPassenger = 'STUFE_' + cLv;
                        const rPs = await this.setFieldIfAvailable('sp18Climate1', 'seatAutoClimatePS', {
                            operationSeatHeaterStagePSS: hLv !== 255 ? ('STUFE_' + hLv) : 'SIGNAL_UNGUELTIG',
                            operationSeatHeaterActivationPSS: hLv !== 255 ? (hLv > 0 ? 'SITZHEIZUNGSFUNKTION_AN' : 'SITZHEIZUNGSFUNKTION_AUS') : 'SIGNAL_UNGUELTIG',
                            operationSeatVentilationStagePSS: cLv !== 255 ? ('STUFE_' + cLv) : 'SIGNAL_UNGUELTIG',
                            operationSeatVentilationActivationPSS: cLv !== 255 ? (cLv > 0 ? 'SITZLUEFTUNGSFUNKTION_AN' : 'SITZLUEFTUNGSFUNKTION_AUS') : 'SIGNAL_UNGUELTIG',
                        });
                        if (rPs.ok) seatOk = true;
                    }
                    if (Object.keys(sp18Seats).length > 0) {
                        const rSt = await this.setFieldIfAvailable('sp18Climate2', 'operationStratificationSeatHeating', sp18Seats);
                        if (rSt.ok) seatOk = true;
                    }
                    if (hLv !== 255) {
                        const r21 = await this.callMethodIfAvailable('climateMaster', 'requestSeatClimateSeatHeating', {
                            clientGroupId: 0,
                            seatClimateHeating: zones.map((z) => ({ configuredIntensityLevel: hLv, operationZone: z, saveLUM: true })),
                        });
                        if (r21.ok) seatOk = true;
                        if (seatOk) {
                            if (side === 'driver' || side === 'both') this.state.climate.seatHeatDriver = hLv;
                            if (side === 'passenger' || side === 'both') this.state.climate.seatHeatPassenger = hLv;
                            okNotes.push(hLv > 0 ? ('sưởi ' + label + ' mức ' + hLv) : ('tắt sưởi ' + label));
                        } else failNotes.push('xe không phản hồi lệnh sưởi ' + label);
                    }
                    if (cLv !== 255) {
                        const r21 = await this.callMethodIfAvailable('climateMaster', 'requestSeatClimateSeatCooling', {
                            clientGroupId: 0,
                            seatClimateCooling: zones.map((z) => ({ configuredIntensityLevel: cLv, operationZone: z, saveLUM: true })),
                        });
                        if (r21.ok) seatOk = true;
                        if (seatOk) {
                            if (side === 'driver' || side === 'both') this.state.climate.seatCoolDriver = cLv;
                            if (side === 'passenger' || side === 'both') this.state.climate.seatCoolPassenger = cLv;
                            okNotes.push(cLv > 0 ? ('làm mát ' + label + ' mức ' + cLv) : ('tắt làm mát ' + label));
                        } else failNotes.push('xe không phản hồi quạt làm mát ' + label);
                    }
                }

                if (args.massage !== undefined) {
                    const on = !!args.massage;
                    let mOk = !this.state.liveCar;
                    if (side === 'driver' || side === 'both') {
                        const r = await this.setFieldIfAvailable('sp18Comfort2', 'seatMassageFL', {
                            operationMassageFLH: on ? 'MASSAGE_ACTIVE' : 'MASSAGE_INACTIVE',
                            operationPneumaticSeatFLHIntensity: 'STUFE_2',
                            operationPneumaticSeatFLHProgram: 'PROGRAMM_1',
                        });
                        if (!this.state.liveCar || r.ok) { this.state.climate.massageDriver = on; mOk = true; }
                    }
                    if (side === 'passenger' || side === 'both') {
                        const r = await this.setFieldIfAvailable('sp18Comfort2', 'seatMassageFR', {
                            operationMassageFRH: on ? 'MASSAGE_ACTIVE' : 'MASSAGE_INACTIVE',
                            operationPneumaticSeatFRHIntensity: 'STUFE_2',
                            operationPneumaticSeatFRHProgram: 'PROGRAMM_1',
                        });
                        if (!this.state.liveCar || r.ok) { this.state.climate.massagePassenger = on; mOk = true; }
                    }
                    if (mOk) okNotes.push((on ? 'bật massage ' : 'tắt massage ') + label);
                    else failNotes.push('xe không trang bị ghế massage');
                }

                if (args.wheelHeat !== undefined) {
                    const on = !!args.wheelHeat;
                    const r18 = await this.callMethodIfAvailable('sp18WheelHeat', 'requestHeating', { requestor: [0, 0, 0, 0, 1], heating: on });
                    const r21 = await this.callMethodIfAvailable('climateMaster', 'requestSteeringWheelHeating', { clientGroupId: 0, steeringWheelHeating: on ? 3 : 0, saveLUM: true });
                    if (!this.state.liveCar || r18.ok || r21.ok) {
                        this.state.climate.wheelHeat = on;
                        okNotes.push(on ? 'bật sưởi vô-lăng' : 'tắt sưởi vô-lăng');
                    } else failNotes.push('xe không trang bị sưởi vô-lăng');
                }

                this.emitState();
                const allOk = failNotes.length === 0 && okNotes.length > 0;
                const msg = [];
                if (okNotes.length) msg.push('Đã ' + okNotes.join(' · '));
                if (failNotes.length) msg.push('Lưu ý: ' + failNotes.join('; '));
                return { ok: allOk, summaryVi: msg.join(' — ') || 'Không thể chỉnh tiện nghi ghế.' };
            }

            case 'set_ambient_light': {
                const sp18Amb = {};
                const comfortPatch = {};
                let touched = false;
                let hwOk = !this.state.liveCar;
                const notes = [];

                if (args.on !== undefined) {
                    sp18Amb.controlModeAmbientePanoramicRoofInteriorLighting = args.on ? 'EIN' : 'AUS';
                    if (!args.on) sp18Amb.controlMenuAmbientePanoramicRoofInteriorLighting = 'AMBIENTEBELEUCHTUNG_AUS';
                    comfortPatch.on = !!args.on;
                    touched = true;
                }
                if (args.brightness !== undefined) {
                    const b = Math.max(10, Math.min(100, Math.round(Number(args.brightness))));
                    sp18Amb.controlBrightnessValueBrightnessOffsetAmbientePanoramicRoofInteriorLighting = b;
                    comfortPatch.bright = b;
                    args._resolvedBright = b;
                    touched = true;
                } else if (this.state.ambient && typeof this.state.ambient.brightness === 'number') {
                    // Preserve active brightness so coerceByDataRef never zeroes it out on color-only changes
                    sp18Amb.controlBrightnessValueBrightnessOffsetAmbientePanoramicRoofInteriorLighting = Math.max(10, Math.min(100, Math.round(this.state.ambient.brightness)));
                }
                const col = args.color ? resolveAmbientColor(args.color) : null;
                if (col) {
                    sp18Amb.controlModeAmbientePanoramicRoofInteriorLighting = 'EIN';
                    sp18Amb.controlMenuAmbientePanoramicRoofInteriorLighting = 'FARBAUSWAHL_' + col.menuIdx;
                    if (col.customRgbOnly) {
                        comfortPatch.on = true;
                        comfortPatch.rgb = [col.r, col.g, col.b];
                    } else {
                        comfortPatch.on = false; // Let OEM BMW menu colour shine natively
                    }
                    touched = true;
                }

                if (!touched) return { ok: false, summaryVi: 'Chưa rõ màu hoặc độ sáng đèn viền cần chỉnh.' };

                const r18 = await this.setFieldIfAvailable('sp18Ambient', 'ambientLightInteriorColour', sp18Amb);
                if (r18.ok) hwOk = true;
                const rc = await sendOptionalComfortRgb(this.opts.comfortSock, { op: 'ambient', settings: comfortPatch });
                if (rc.ok && (!col || col.customRgbOnly || !this.state.liveCar)) hwOk = true;

                if (hwOk) {
                    if (args.on !== undefined) {
                        this.state.ambient.on = !!args.on;
                        notes.push(args.on ? 'bật đèn viền' : 'tắt đèn viền');
                    }
                    if (col) {
                        this.state.ambient.on = true;
                        this.state.ambient.key = col.key;
                        this.state.ambient.name = (col.customRgbOnly && !rc.ok && this.state.liveCar) ? 'Cam BMW' : col.name;
                        this.state.ambient.hex = col.hex;
                        notes.push('đổi đèn viền sang ' + this.state.ambient.name);
                    }
                    if (args._resolvedBright !== undefined) {
                        this.state.ambient.brightness = args._resolvedBright;
                        notes.push('độ sáng ' + args._resolvedBright + '%');
                    }
                    this.emitState();
                    return { ok: true, summaryVi: 'Đã ' + notes.join(' · ') };
                }
                return { ok: false, summaryVi: 'Cổng đèn viền nội thất không phản hồi.' };
            }

            case 'control_media': {
                const act = String(args.action || 'volume').toLowerCase();
                let anyOk = !this.state.liveCar;

                if (act === 'volume_up' || act === 'volume_down' || args.volumePercent !== undefined) {
                    let targetVol = args.volumePercent;
                    if (targetVol === undefined) {
                        await this.getLiveMainSinkInfo();
                        const delta = act === 'volume_up' ? 8 : -8;
                        targetVol = Math.max(0, Math.min(100, this.state.media.volumePercent + delta));
                    } else {
                        targetVol = Math.max(0, Math.min(100, Math.round(Number(targetVol))));
                    }
                    const rv = await this.callMethodIfAvailable('audioCmd', 'setVolume', { sinkID: 1, volume: targetVol });
                    if (!this.state.liveCar || (rv.ok && rv.response && (rv.response.amError === 'E_OK' || rv.response.amError === 0))) {
                        this.state.media.volumePercent = targetVol;
                        this.state.media.muted = targetVol === 0;
                        anyOk = true;
                    }
                    if (act === 'volume' || act === 'volume_up' || act === 'volume_down') {
                        this.emitState();
                        return {
                            ok: anyOk,
                            summaryVi: anyOk ? ('Đã chỉnh âm lượng loa ' + targetVol + '%') : 'Không chỉnh được âm lượng loa.',
                        };
                    }
                }

                if (act === 'mute' || act === 'unmute') {
                    const rm = await this.callMethodIfAvailable('audioCmd', 'setSinkMuteState', {
                        sinkID: 1,
                        muteState: act === 'mute' ? 'MS_MUTED' : 'MS_UNMUTED',
                    });
                    const ok = !this.state.liveCar || (rm.ok && rm.response && (rm.response.amError === 'E_OK' || rm.response.amError === 0));
                    if (ok) this.state.media.muted = act === 'mute';
                    this.emitState();
                    return {
                        ok,
                        summaryVi: ok ? (act === 'mute' ? 'Đã tắt tiếng loa' : 'Đã bật lại tiếng loa') : 'Không tắt/bật tiếng loa được.',
                    };
                }

                const btnEnum = MEDIA_BTN_ENUM[act] || 'PLAY';
                const players = ['mediaCarPlay', 'mediaBtA', 'mediaAa', 'mediaPlayer'];
                for (let i = 0; i < players.length; i++) {
                    const rp = await this.callMethodIfAvailable(players[i], 'sendButtonEvent', { button: btnEnum, action: 'PRESS' });
                    await this.callMethodIfAvailable(players[i], 'sendButtonEvent', { button: btnEnum, action: 'RELEASE' });
                    if (rp.ok) anyOk = true;
                }
                if (anyOk) {
                    this.state.media.playing = (act !== 'pause' && act !== 'stop');
                }
                this.emitState();
                const labelMap = {
                    next: 'Đã chuyển sang bài tiếp theo',
                    previous: 'Đã lùi về bài trước',
                    pause: 'Đã tạm dừng nhạc',
                    stop: 'Đã dừng nhạc',
                    play: 'Đã tiếp tục phát nhạc',
                };
                return {
                    ok: anyOk,
                    summaryVi: anyOk ? (labelMap[act] || 'Đã gửi lệnh nhạc') : 'Không tìm thấy nguồn nhạc đang kết nối.',
                };
            }

            case 'control_windows': {
                const target = String(args.target || 'driver').toLowerCase();
                const action = String(args.action || 'vent').toLowerCase();
                let anyOk = !this.state.liveCar;

                if (target === 'sunroof' || target === 'sunshade') {
                    if (target === 'sunshade') {
                        const open = action !== 'close';
                        const rShade = await this.setFieldIfAvailable('sp18RoofSys', 'controlRoofSystem', {
                            controlFrontESH2: open ? 'PANORAMA_OPEN' : 'POSITION',
                            controlFrontESH1: open ? 100 : 0,
                        });
                        if (rShade.ok) anyOk = true;
                        return {
                            ok: anyOk,
                            summaryVi: anyOk ? (open ? 'Đã mở rèm cửa sổ trời' : 'Đã đóng rèm cửa sổ trời') : 'Xe không hỗ trợ điều khiển rèm trần qua màn hình.',
                        };
                    }
                    const shdEnum = action === 'open' ? 'MAUT_AUF__S__AUF_2' : (action === 'vent' || action === 'tilt' ? 'HEBEN' : 'MAUT_ZU__S__ZU_2');
                    const r1 = await this.setFieldIfAvailable('sp18SunRoof', 'operationSHDMDS', { operationSwitchSHDMDS: shdEnum });
                    const r2 = await this.setFieldIfAvailable('sp18RoofSys', 'controlRoofSystem', {
                        controlSHD2: action === 'open' ? 'KOMFORT_POSITION' : (action === 'vent' || action === 'tilt' ? 'TILT_POSITION' : 'POSITION'),
                        controlSHD1: action === 'open' ? 100 : (action === 'vent' || action === 'tilt' ? 20 : 0),
                    });
                    if (r1.ok || r2.ok) anyOk = true;
                    if (anyOk) {
                        this.state.sunroof = action === 'open' ? 'open' : (action === 'close' ? 'closed' : 'tilt');
                        this.emitState();
                    }
                    return {
                        ok: anyOk,
                        summaryVi: anyOk
                            ? (action === 'open' ? 'Đã mở cửa sổ trời' : (action === 'close' ? 'Đã đóng cửa sổ trời' : 'Đã hé nghiêng cửa sổ trời'))
                            : 'Xe không trang bị hoặc không mở cổng cửa sổ trời qua màn hình.',
                    };
                }

                // Safety cap: while driving > 50 km/h, limit full-open request to safe 20% vent
                let pct = action === 'close' ? 0 : (action === 'vent' ? 20 : 100);
                let capped = false;
                if (pct > 25 && this.state.speedKmh > 50) {
                    pct = 20;
                    capped = true;
                }

                const keys = (target === 'driver' || target === 'fl') ? ['fl']
                    : (target === 'passenger' || target === 'fr') ? ['fr']
                        : (target === 'rear') ? ['rl', 'rr']
                            : ['fl', 'fr', 'rl', 'rr'];

                // On BMW G30 SP18, `WindowLifter.moveWindow` executes on BDC immediately while the reply
                // either times out after full glass travel OR throws `windowPosition: Enum value N not found`
                // because BMW's `someip-interfaces.json` mistakenly defines output `windowPosition` as an enum
                // with only `WINDOW_POSITION: 100` while BDC returns the actual % (0..99). Treat both as OK!
                const winOk = (res) => !!(res && (res.ok || res.timedOut || /Enum value \d+ not found/i.test(String(res.error || ''))));
                let sp18AllSent = false;
                if (keys.length === 4) {
                    const rAll = await this.callMethodIfAvailable('windowLifter', 'moveWindow', { windowId: 'ALL_WINDOWS', windowControl: pct }, 5500);
                    if (winOk(rAll)) { anyOk = true; sp18AllSent = true; }
                }
                for (let i = 0; i < keys.length; i++) {
                    const k = keys[i];
                    if (!sp18AllSent) {
                        const r18 = await this.callMethodIfAvailable('windowLifter', 'moveWindow', { windowId: WINDOW_ID_SP18[k], windowControl: pct }, 5500);
                        if (winOk(r18)) anyOk = true;
                    }
                    const r21 = await this.callMethodIfAvailable('windowMaster', 'moveWindow', {
                        priorityGroup: 6,
                        consumerId: 16,
                        windowControl: { windowId: WINDOW_ID_SP21[k], windowPosition: pct },
                        windowKeySearch: 0,
                    }, 5500);
                    if (winOk(r21)) anyOk = true;
                }
                if (anyOk) {
                    for (let j = 0; j < keys.length; j++) this.state.windows[keys[j]] = pct;
                    this.emitState();
                }
                const targetLabel = keys.length === 4 ? '4 kính cửa' : (target === 'passenger' ? 'kính ghế phụ' : (target === 'rear' ? '2 kính sau' : 'kính ghế tài'));
                return {
                    ok: anyOk,
                    summaryVi: anyOk
                        ? ('Đã ' + (pct === 0 ? 'đóng ' : (capped ? 'hé an toàn 20% (đang chạy nhanh) ' : ('hạ ' + pct + '% '))) + targetLabel)
                        : 'Hộp BDC từ chối lệnh nâng/hạ kính qua màn hình.',
                };
            }

            case 'query_vehicle_status': {
                if (await this.isProxyAvailable('tpms')) {
                    try {
                        const tv = await this.nativeTick(() => this.proxies.tpms.getValue('statusTyrePressure', 1500));
                        this.applyTpmsStruct(tv);
                    } catch (e) {}
                }
                const t = this.state;
                const parts = [
                    'Dầu máy ' + t.oilTempC + '°C',
                    'Nước mát ' + t.coolantTempC + '°C',
                    'Bình ' + t.battery12v + 'V',
                    'Xăng ' + t.fuelPercent + '% (' + t.rangeKm + ' km)',
                ];
                if (!t.liveCar || t.tyresLive) {
                    parts.push('Lốp ' + t.tyresBar.fl + '/' + t.tyresBar.fr + '/' + t.tyresBar.rl + '/' + t.tyresBar.rr + ' bar');
                }
                return {
                    ok: true,
                    summaryVi: parts.join(' · '),
                };
            }

            default:
                return { ok: false, summaryVi: 'Trợ lý BMW chưa hỗ trợ thao tác này.' };
        }
    }
}

module.exports = {
    isCallStateActive,
    OEM_AMBIENT_COLORS,
    resolveAmbientColor,
    coerceByDataRef,
    snapBmwIhkaTempC,
    decodeSp18TempByte,
    encodeSp18TempByte,
    createInitialState,
    CarController,
};
