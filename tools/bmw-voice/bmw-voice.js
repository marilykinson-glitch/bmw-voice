'use strict';
/**
 * bmw-voice.js - Minimalist OEM-Style Vietnamese Voice Assistant Daemon for BMW MGU iDrive 7 (`v1.0.0`).
 *
 * Design philosophy:
 *   - Do ONE thing with OEM BMW precision: press Steering Wheel Mic (or tap Screen Orb) -> capture ceiling mic
 *     with 0.50s end-of-speech auto-stop -> execute verified SP18 car command immediately -> show crisp confirmation
 *     on the iDrive 7 screen without ever interrupting or ducking CarPlay / Bluetooth music.
 *   - Zero background ALSA loops, zero boot race, zero unhandled crashes.
 *
 * Node 8 (ES2017) compatible.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const net = require('net');
const http = require('http');
const urlMod = require('url');
const crypto = require('crypto');
const cp = require('child_process');

const Up = require('./uplink');
const CarControl = require('./car-control');
const MicCapture = require('./mic-capture');
const NluBrain = require('./nlu-brain');

const VERSION = '1.0.0';
const FW_TAG = 'bmw-voice';
const APP_RE = /^bmw_voice\d*$/;

const env = (k, d) => (process.env[k] !== undefined && process.env[k] !== '' ? process.env[k] : d);

function createDaemonConfig(over) {
    return Object.assign({
        run: env('BV_RUN', '/run/bmw-voice'),
        state: env('BV_STATE', '/var/opt/bmw-voice'),
        oap: env('BV_OAP', '/var/opt/public/oap'),
        proc: env('BV_PROC', '/proc'),
        port: Number(env('BV_PORT', 8145)),
        host: env('BV_HOST', '0.0.0.0'),
        nft: env('BV_NFT', 'nft'),
        route: env('BV_ROUTE', '/proc/net/route'),
        ips: env('BV_IPS', ''),
        simMode: env('BV_SIM', '') === '1',
        noNft: env('BV_NO_NFT', '') === '1',
        geminiBaseUrl: env('BV_GEMINI_BASE', ''),
    }, over || {});
}

const mkdirp = (d) => {
    if (fs.existsSync(d)) return;
    mkdirp(path.dirname(d));
    try { fs.mkdirSync(d); } catch (e) { if (e.code !== 'EEXIST') throw e; }
};

const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return null; } };

function writeAtomic(file, data, mode) {
    mkdirp(path.dirname(file));
    const tmp = file + '.tmp.' + process.pid + '.' + Math.floor(Math.random() * 10000);
    fs.writeFileSync(tmp, data, { mode: mode || 0o644 });
    fs.renameSync(tmp, file);
}

function defaultSettings() {
    return {
        apiKey: '',
        model: 'gemini-3-flash-preview',
        pttTrigger: 'short_press', // short_press | long_press | double_press | disabled
        swapMicChannels: false,
    };
}

function normalizeModelName(raw, fallback) {
    const m = typeof raw === 'string' ? raw.trim() : '';
    if (!m) return fallback;
    if (/^gemini-(?:1\.5|2\.0|2\.5)-flash(?:-lite)?$/i.test(m)) return 'gemini-3-flash-preview';
    return m;
}

function normalizeSettings(raw) {
    const d = defaultSettings();
    const r = (raw && typeof raw === 'object') ? raw : {};
    const ptt = String(r.pttTrigger || d.pttTrigger);
    return {
        apiKey: typeof r.apiKey === 'string' ? r.apiKey.trim() : d.apiKey,
        model: normalizeModelName(r.model, d.model),
        pttTrigger: (ptt === 'short_press' || ptt === 'long_press' || ptt === 'double_press' || ptt === 'disabled') ? ptt : d.pttTrigger,
        swapMicChannels: !!r.swapMicChannels,
    };
}

function discoverLanAddresses(cfg) {
    if (cfg.ips) return cfg.ips.split(',').filter(Boolean);
    if (cfg.simMode) return ['127.0.0.1'];
    let via = '';
    try {
        const rows = fs.readFileSync(cfg.route, 'utf8').split('\n').slice(1)
            .map((l) => l.trim().split(/\s+/)).filter((c) => c.length > 7 && c[1] === '00000000' && c[7] === '00000000');
        rows.sort((x, y) => Number(x[6]) - Number(y[6]));
        via = rows.length ? rows[0][0] : '';
    } catch (e) { via = ''; }
    const out = [];
    const nets = os.networkInterfaces();
    Object.keys(nets).forEach((name) => (nets[name] || []).forEach((a) => {
        if (a.internal || (a.family !== 'IPv4' && a.family !== 4) || /^169\.254\./.test(a.address)) return;
        const range = /^192\.168\./.test(a.address) ? 0 : /^172\.(1[6-9]|2\d|3[01])\./.test(a.address) ? 1 : /^10\./.test(a.address) ? 2 : 3;
        out.push({ ip: a.address, rank: (name === via ? 0 : /^(wl|ml|uap|ap|wifi)/i.test(name) ? 10 : 20) + range });
    }));
    const sorted = out.sort((a, b) => a.rank - b.rank).map((a) => a.ip);
    return sorted.length ? sorted : ['127.0.0.1'];
}

function execNft(nftBin, args) {
    return new Promise((resolve, reject) => cp.execFile(nftBin, args, { timeout: 6000, maxBuffer: 1 << 20 }, (err, out, stderr) => {
        if (!err) return resolve(out);
        const e = new Error('nft: ' + (String(stderr || '').trim() || err.message));
        e.absent = err.code === 'ENOENT' || /No such file or directory/.test(String(stderr));
        reject(e);
    }));
}

async function fwClose(nftBin) {
    let out;
    try { out = await execNft(nftBin, ['-a', 'list', 'chain', 'ip', 'filter', 'input']); } catch (e) {
        return e.absent ? 'absent' : 'skip';
    }
    const lines = out.split('\n').filter((l) => l.indexOf('comment "' + FW_TAG + '"') >= 0);
    for (let i = 0; i < lines.length; i++) {
        const m = /# handle (\d+)\s*$/.exec(lines[i]);
        if (m) await execNft(nftBin, ['delete', 'rule', 'ip', 'filter', 'input', 'handle', m[1]]).catch(() => {});
    }
    return 'closed';
}

async function fwOpen(nftBin, port) {
    await fwClose(nftBin);
    try {
        await execNft(nftBin, ['insert', 'rule', 'ip', 'filter', 'input', 'tcp', 'dport', String(port), 'accept', 'comment', '"' + FW_TAG + '"']);
        return 'opened';
    } catch (e) { return 'skip'; }
}

function findInstalledApp(oapRoot) {
    let dirs = [];
    try { dirs = fs.readdirSync(oapRoot).filter((d) => /^oap_\d+$/.test(d)); } catch (e) { return null; }
    for (let i = 0; i < dirs.length; i++) {
        const rels = ['source/javascript/kit/app-spec.json', 'javascript/kit/app-spec.json'];
        for (let k = 0; k < rels.length; k++) {
            const spec = readJson(path.join(oapRoot, dirs[i], rels[k]));
            if (spec && typeof spec.id === 'string' && APP_RE.test(spec.id)) {
                return { id: spec.id, root: path.join(oapRoot, dirs[i]) };
            }
        }
    }
    return null;
}

class BmwVoiceDaemon {
    constructor(overCfg) {
        this.cfg = createDaemonConfig(overCfg);
        mkdirp(this.cfg.run);
        mkdirp(path.join(this.cfg.run, 'app'));
        mkdirp(this.cfg.state);

        this.settingsFile = path.join(this.cfg.state, 'settings.json');
        this.settings = normalizeSettings(readJson(this.settingsFile) || {
            apiKey: env('GEMINI_API_KEY', ''),
        });
        this.pin = this.cfg.simMode ? '0000' : String(crypto.randomBytes(2).readUInt16BE(0) % 9000 + 1000);
        this.ipIdx = 0;
        this.logs = [];
        this.assistantState = 'idle'; // idle | listening | thinking
        this.micLevels = { leftDb: -60, rightDb: -60 };
        this.audioProbe = MicCapture.probeSmartxStack(this.cfg.micOpts);
        this.lastTurn = {
            at: Date.now(),
            ok: true,
            idle: true,
            speakerZone: 'driver',
            transcript: '',
            replyVi: 'Bấm nút Mic trên vô-lăng hoặc chạm biểu tượng Mic để nói lệnh Tiếng Việt.',
            actions: [],
        };
        this.seenCmdIds = [];
        this.turnBusy = false;
        this.statusTimer = null;
        this.busInitTimer = null;
        this.lastHmiSig = '';
        this.lastWriteAt = 0;
        this.statusWriteCount = 0;

        this.uplinkOpts = Up.options({
            stateDir: path.join(this.cfg.state, 'state'),
            noSetuid: this.cfg.simMode,
            baseUrl: this.cfg.geminiBaseUrl || '',
            log: (m) => this.log(m),
        });

        this.car = new CarControl.CarController({
            onStateChange: () => this.scheduleStatusWrite(),
            onPttEvent: (ev) => this.onSteeringWheelPtt(ev),
            onLog: (m) => this.log(m),
        });
    }

    log(msg) {
        const line = new Date().toISOString() + ' ' + msg;
        this.logs.push(line);
        if (this.logs.length > 120) this.logs.shift();
        if (!this.cfg.quiet) process.stdout.write('[bmw-voice] ' + msg + '\n');
    }

    markCmdSeen(id) {
        if (!id) return true;
        if (this.seenCmdIds.indexOf(id) >= 0) return false;
        this.seenCmdIds.push(id);
        if (this.seenCmdIds.length > 48) this.seenCmdIds.shift();
        return true;
    }

    publicSettings() {
        return {
            hasApiKey: !!this.settings.apiKey,
            apiKeyMasked: this.settings.apiKey
                ? (this.settings.apiKey.slice(0, 6) + '••••' + this.settings.apiKey.slice(-4))
                : '',
            model: this.settings.model,
            pttTrigger: this.settings.pttTrigger,
            swapMicChannels: this.settings.swapMicChannels,
        };
    }

    saveSettings(patch) {
        this.settings = normalizeSettings(Object.assign({}, this.settings, patch || {}));
        writeAtomic(this.settingsFile, JSON.stringify(this.settings, null, 2) + '\n', 0o600);
        this.writeStatusFile(true);
        return this.publicSettings();
    }

    portalUrl() {
        const ips = discoverLanAddresses(this.cfg);
        const ip = ips[this.ipIdx % ips.length] || '127.0.0.1';
        return {
            url: 'http://' + ip + ':' + this.cfg.port + '/?pin=' + this.pin,
            ips,
            ip,
        };
    }

    buildHmiState() {
        const netInfo = this.portalUrl();
        const st = this.car.state;
        return {
            at: Date.now(),
            version: VERSION,
            simMode: !!this.cfg.simMode,
            url: netInfo.url,
            ips: netInfo.ips,
            pin: this.pin,
            assistantState: this.assistantState,
            micLevels: this.micLevels,
            settings: this.publicSettings(),
            car: {
                liveCar: !!st.liveCar,
                proxyCount: (st.availableProxies && st.availableProxies.length) || 0,
                climate: st.climate,
                ambient: st.ambient,
                media: st.media,
                oilTempC: st.oilTempC,
                coolantTempC: st.coolantTempC,
                battery12v: st.battery12v,
                fuelPercent: st.fuelPercent,
                rangeKm: st.rangeKm,
                callActive: !!st.callActive,
            },
            audio: {
                hasAlsaCapture: !!this.audioProbe.hasAlsaCapture,
                device: this.audioProbe.recommendedDevice || '',
            },
            lastTurn: this.lastTurn,
        };
    }

    scheduleStatusWrite() {
        if (this.statusTimer) return;
        this.statusTimer = setTimeout(() => {
            this.statusTimer = null;
            this.flushStatus(false);
        }, 380);
    }

    flushStatus(force) {
        try {
            const hmi = this.buildHmiState();
            const sig = JSON.stringify(Object.assign({}, hmi, { at: 0 }));
            const now = hmi.at;
            if (!force && sig === this.lastHmiSig && (now - this.lastWriteAt) < 3500) return;
            this.lastHmiSig = sig;
            this.lastWriteAt = now;
            this.statusWriteCount++;
            writeAtomic(path.join(this.cfg.run, 'hmi.json'), JSON.stringify(hmi), 0o644);
        } catch (e) {}
    }

    writeStatusFile(immediate) {
        if (immediate === false) {
            this.scheduleStatusWrite();
            return;
        }
        if (this.statusTimer) {
            clearTimeout(this.statusTimer);
            this.statusTimer = null;
        }
        this.flushStatus(true);
    }

    onSteeringWheelPtt(ev) {
        if (this.settings.pttTrigger === 'disabled') return;
        if (this.settings.pttTrigger === 'double_press' && ev.kind !== 'double_press') return;
        if (this.settings.pttTrigger === 'long_press' && ev.kind !== 'long_press') return;
        this.log('PTT (' + ev.kind + ', ' + ev.heldMs + 'ms) -> capture ceiling mic');
        this.captureAndExecute().catch((e) => this.log('PTT error: ' + e.message));
    }

    async captureAndExecute() {
        if (this.turnBusy || this.assistantState !== 'idle') {
            return { ok: false, error: 'Đang xử lý lệnh trước' };
        }
        if (this.car.state.callActive) {
            this.lastTurn = {
                at: Date.now(),
                ok: false,
                speakerZone: 'driver',
                transcript: '',
                replyVi: 'Đang có cuộc gọi điện thoại — tạm nhường Mic xe.',
                actions: [],
            };
            this.writeStatusFile(true);
            return { ok: false, turn: this.lastTurn };
        }

        this.audioProbe = MicCapture.probeSmartxStack(this.cfg.micOpts);
        if (!this.audioProbe.hasAlsaCapture) {
            this.lastTurn = {
                at: Date.now(),
                ok: false,
                speakerZone: 'driver',
                transcript: '',
                replyVi: 'Chế độ mô phỏng: nhập lệnh thử trong trang Cài đặt QR.',
                actions: [],
            };
            this.writeStatusFile(true);
            return { ok: false, turn: this.lastTurn };
        }

        const hasKey = !!this.settings.apiKey;
        if (!hasKey) {
            this.lastTurn = {
                at: Date.now(),
                ok: false,
                speakerZone: 'driver',
                transcript: '',
                replyVi: 'Bấm "Cài đặt QR" để quét mã và dán Gemini API Key trước khi dùng giọng nói.',
                actions: [],
            };
            this.writeStatusFile(true);
            return { ok: false, turn: this.lastTurn };
        }

        // Pre-warm TLS 1.3 socket in parallel while user speaks into ceiling mic
        if (!this.cfg.simMode) {
            Up.warmup(this.uplinkOpts).catch(() => {});
        }

        this.turnBusy = true;
        this.assistantState = 'listening';
        this.writeStatusFile(true);
        this.car.pulseIpaLight('listenDriver').catch(() => {});

        try {
            const cap = await MicCapture.captureCeilingMic(Object.assign({
                maxDurationSec: 4.2,
                outFile: path.join(this.cfg.run, 'capture.wav'),
                swapChannels: this.settings.swapMicChannels,
                connectAmRoute: (r) => this.car.connectAudioRoute(r),
                disconnectAmRoute: (cid) => this.car.disconnectAudioRoute(cid),
                isCallActive: () => !!this.car.state.callActive,
                onLog: (m) => this.log(m),
            }, this.cfg.micOpts || {}));

            this.micLevels = { leftDb: cap.analysis.leftDb, rightDb: cap.analysis.rightDb };
            const zone = cap.analysis.speakerZone === 'passenger' ? 'passenger' : 'driver';

            this.assistantState = 'thinking';
            this.writeStatusFile(true);

            const turn = await NluBrain.processVoiceOrText({
                audioWavBase64: cap.wavBuffer.toString('base64'),
                audioMimeType: 'audio/wav',
                speakerZone: zone,
                apiKey: this.settings.apiKey,
                model: this.settings.model,
                carController: this.car,
                uplinkOpts: this.uplinkOpts,
            });
            this.lastTurn = turn;
            this.assistantState = 'idle';
            this.car.pulseIpaLight('off').catch(() => {});
            this.writeStatusFile(true);
            return { ok: turn.ok, turn };
        } catch (e) {
            this.assistantState = 'idle';
            this.car.pulseIpaLight('off').catch(() => {});
            this.lastTurn = {
                at: Date.now(),
                ok: false,
                speakerZone: 'driver',
                transcript: '',
                replyVi: 'Không thu được Mic trần (' + e.message.slice(0, 90) + ').',
                actions: [],
            };
            this.writeStatusFile(true);
            return { ok: false, error: e.message, turn: this.lastTurn };
        } finally {
            this.turnBusy = false;
        }
    }

    async handleTurn(input) {
        const req = input || {};
        this.turnBusy = true;
        try {
            let zone = req.speakerZone === 'passenger' ? 'passenger' : 'driver';
            if (req.audioWavBase64) {
                try {
                    const ana = MicCapture.analyzeWavBuffer(Buffer.from(req.audioWavBase64, 'base64'), {
                        swapChannels: this.settings.swapMicChannels,
                    });
                    if (ana.valid && ana.channels >= 2 && ana.confidence >= 0.55) {
                        zone = ana.speakerZone;
                        this.micLevels = { leftDb: ana.leftDb, rightDb: ana.rightDb };
                    }
                } catch (e) {}
            }
            this.assistantState = 'thinking';
            this.writeStatusFile(true);
            const turn = await NluBrain.processVoiceOrText({
                text: req.text || '',
                audioWavBase64: req.audioWavBase64 || '',
                audioMimeType: req.audioMimeType || 'audio/wav',
                speakerZone: zone,
                apiKey: this.settings.apiKey,
                model: this.settings.model,
                carController: this.car,
                uplinkOpts: this.uplinkOpts,
            });
            this.lastTurn = turn;
            this.assistantState = 'idle';
            this.writeStatusFile(true);
            return turn;
        } finally {
            this.assistantState = 'idle';
            this.turnBusy = false;
        }
    }

    async executeHmiCommand(cmd, arg) {
        if (cmd === 'ptt_trigger') return this.captureAndExecute();
        if (cmd === 'ask_text' && arg && arg.text) {
            return this.handleTurn({ text: String(arg.text), speakerZone: arg.speakerZone || 'driver' });
        }
        if (cmd === 'next_ip') {
            this.ipIdx++;
            this.writeStatusFile(true);
            return { ok: true };
        }
        return { ok: false };
    }

    pollFallbackAppCommand() {
        const candidates = [path.join(this.cfg.run, 'app', 'command.json')];
        if (this.installedApp && this.installedApp.root) {
            candidates.push(path.join(this.installedApp.root, 'data', 'command.json'));
        }
        for (let i = 0; i < candidates.length; i++) {
            const c = readJson(candidates[i]);
            if (!c || !c.cmd) continue;
            try { fs.unlinkSync(candidates[i]); } catch (e) {}
            if (!this.markCmdSeen(c.id)) continue;
            this.executeHmiCommand(c.cmd, c.arg || {}).catch((e) => this.log('cmd error: ' + e.message));
        }
    }

    checkAuth(req, parsedUrl) {
        if (this.cfg.simMode) return true;
        const qPin = parsedUrl.query && parsedUrl.query.pin;
        const hPin = req.headers['x-bmw-pin'];
        return String(qPin || hPin || '') === this.pin;
    }

    readBodyJson(req) {
        return new Promise((resolve, reject) => {
            const chunks = [];
            let size = 0;
            req.on('data', (c) => {
                size += c.length;
                if (size > 6e6) { req.destroy(); reject(new Error('payload too large')); return; }
                chunks.push(c);
            });
            req.on('end', () => {
                const raw = Buffer.concat(chunks).toString('utf8');
                if (!raw) return resolve({});
                try { resolve(JSON.parse(raw)); } catch (e) { reject(new Error('invalid JSON')); }
            });
            req.on('error', reject);
        });
    }

    async handleHttp(req, res) {
        const parsed = urlMod.parse(req.url || '/', true);
        const pathname = parsed.pathname || '/';
        const sendJson = (code, obj) => {
            const body = Buffer.from(JSON.stringify(obj), 'utf8');
            res.writeHead(code, {
                'Content-Type': 'application/json; charset=utf-8',
                'Cache-Control': 'no-store',
                'Content-Length': body.length,
            });
            res.end(body);
        };

        if (pathname === '/' && req.method === 'GET') {
            if (!this.checkAuth(req, parsed)) {
                res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
                res.end('Sai mã PIN — vui lòng quét lại mã QR trong mục Cài đặt QR trên màn hình BMW.');
                return;
            }
            const htmlPath = path.join(__dirname, 'page.html');
            const html = fs.existsSync(htmlPath) ? fs.readFileSync(htmlPath, 'utf8') : '<h1>BMW Voice</h1>';
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
            res.end(html);
            return;
        }

        if (!this.checkAuth(req, parsed)) {
            return sendJson(403, { ok: false, error: 'PIN không hợp lệ' });
        }

        if (pathname === '/api/state' && req.method === 'GET') {
            return sendJson(200, { ok: true, state: this.buildHmiState() });
        }

        if (pathname === '/api/settings' && req.method === 'POST') {
            try {
                const body = await this.readBodyJson(req);
                const saved = this.saveSettings(body);
                return sendJson(200, { ok: true, settings: saved, state: this.buildHmiState() });
            } catch (e) {
                return sendJson(400, { ok: false, error: e.message });
            }
        }

        if (pathname === '/api/ask' && req.method === 'POST') {
            try {
                const body = await this.readBodyJson(req);
                const turn = await this.handleTurn({
                    text: body.text || '',
                    audioWavBase64: body.audioWavBase64 || '',
                    audioMimeType: body.audioMimeType || 'audio/wav',
                    speakerZone: body.speakerZone || 'driver',
                });
                return sendJson(200, { ok: true, turn, state: this.buildHmiState() });
            } catch (e) {
                return sendJson(500, { ok: false, error: e.message });
            }
        }

        if (pathname === '/api/ptt' && req.method === 'POST') {
            const r = await this.captureAndExecute();
            return sendJson(200, Object.assign({}, r, { state: this.buildHmiState() }));
        }

        return sendJson(404, { ok: false, error: 'Not found' });
    }

    startCtlSocket() {
        const sockPath = path.join(this.cfg.run, 'ctl.sock');
        try { fs.chmodSync(this.cfg.run, 0o755); } catch (e) {}
        try { if (fs.existsSync(sockPath)) fs.unlinkSync(sockPath); } catch (e) {}
        return new Promise((resolve) => {
            const srv = net.createServer((client) => {
                let buf = '';
                client.setEncoding('utf8');
                client.on('data', (chunk) => {
                    buf += chunk;
                    let idx;
                    while ((idx = buf.indexOf('\n')) >= 0) {
                        const line = buf.slice(0, idx).trim();
                        buf = buf.slice(idx + 1);
                        if (!line) continue;
                        try {
                            const c = JSON.parse(line);
                            if (c && c.cmd && this.markCmdSeen(c.id)) {
                                this.executeHmiCommand(c.cmd, c.arg || {}).catch((e) => this.log('ctl.sock error: ' + e.message));
                            }
                        } catch (e) {}
                    }
                });
                client.on('error', () => {});
            });
            srv.on('error', () => resolve(null));
            srv.listen(sockPath, () => {
                try { fs.chmodSync(sockPath, 0o666); } catch (e) {}
                this.ctlServer = srv;
                resolve(srv);
            });
        });
    }

    async start() {
        this.installedApp = findInstalledApp(this.cfg.oap);
        try { fs.chmodSync(path.join(this.cfg.run, 'app'), 0o777); } catch (e) {}
        await this.startCtlSocket();

        if (!this.cfg.noNft && !this.cfg.simMode) {
            await fwOpen(this.cfg.nft, this.cfg.port);
        }

        this.server = http.createServer((req, res) => {
            this.handleHttp(req, res).catch((err) => {
                try {
                    res.writeHead(500, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ ok: false, error: err.message }));
                } catch (e) {}
            });
        });

        await new Promise((resolve, reject) => {
            this.server.once('error', reject);
            this.server.listen(this.cfg.port, this.cfg.host, resolve);
        });
        const addr = this.server.address();
        if (addr && addr.port) this.cfg.port = addr.port;

        this.writeStatusFile(true);

        if (!this.cfg.simMode && os.uptime() < 45) {
            this.busInitTimer = setTimeout(() => {
                this.busInitTimer = null;
                this.car.initHardwareBus()
                    .then(() => this.writeStatusFile(true))
                    .catch((e) => this.log('delayed bus warning: ' + e.message));
            }, 10000);
        } else {
            try {
                await this.car.initHardwareBus();
                this.writeStatusFile(true);
            } catch (e) {
                this.log('bus init warning: ' + e.message);
            }
        }

        let tick = 0;
        this.pollTimer = setInterval(() => {
            tick++;
            if (tick % 10 === 1) this.installedApp = findInstalledApp(this.cfg.oap);
            this.pollFallbackAppCommand();
            if (tick % 5 === 0) this.flushStatus(false);
        }, 350);

        this.log('listening on ' + this.portalUrl().url);
        return this;
    }

    async stop() {
        if (this.pollTimer) { clearInterval(this.pollTimer); this.pollTimer = null; }
        if (this.busInitTimer) { clearTimeout(this.busInitTimer); this.busInitTimer = null; }
        if (this.statusTimer) { clearTimeout(this.statusTimer); this.statusTimer = null; }
        Up.close(this.uplinkOpts);
        if (this.ctlServer) {
            await new Promise((r) => this.ctlServer.close(r));
            this.ctlServer = null;
            try { fs.unlinkSync(path.join(this.cfg.run, 'ctl.sock')); } catch (e) {}
        }
        if (this.server) {
            await new Promise((r) => this.server.close(r));
            this.server = null;
        }
        if (!this.cfg.noNft && !this.cfg.simMode) {
            await fwClose(this.cfg.nft);
        }
    }
}

if (require.main === module) {
    const sub = process.argv[2] || 'run';
    if (sub === 'fwclose') {
        const cfg = createDaemonConfig();
        fwClose(cfg.nft).then(() => process.exit(0), () => process.exit(0));
    } else {
        const daemon = new BmwVoiceDaemon();
        process.on('uncaughtException', (err) => {
            daemon.log('uncaughtException (contained): ' + (err && err.message ? err.message : String(err)));
        });
        process.on('unhandledRejection', (reason) => {
            daemon.log('unhandledRejection (contained): ' + (reason && reason.message ? reason.message : String(reason)));
        });
        daemon.start().catch((err) => {
            daemon.log('startup warning: ' + (err && err.message ? err.message : String(err)));
        });
        const cleanExit = () => daemon.stop().then(() => process.exit(0), () => process.exit(0));
        process.on('SIGTERM', cleanExit);
        process.on('SIGINT', cleanExit);
    }
}

module.exports = {
    VERSION,
    createDaemonConfig,
    defaultSettings,
    normalizeSettings,
    BmwVoiceDaemon,
};
