'use strict';
/**
 * bmw-voice.js - OEM-Style Vietnamese Voice Assistant Replacement for BMW MGU iDrive 7 (`v1.1.1`).
 *
 * Experience:
 *   1. Hands-Free `"Hey BMW"`:
 *      - 1-shot ("Hey BMW chỉnh điều hoà 22 độ") -> executes immediately & glides OEM BMW IPA overlay onto screen.
 *      - 2-step ("Hey BMW") -> opens BMW Assistant screen / IPA overlay ("Xin chào, tôi đang lắng nghe…") & listens.
 *      - Cabin chatter without "Hey BMW" is silently ignored (zero popups).
 *   2. Steering Wheel Mic Button (`PTT`):
 *      - Fires immediately on physical button press (`0ms` release wait), silences BMW's unsupported-language prompt,
 *        pushes `{ event: 'voice_ui', action: 'open' }` over `/run/bmw-voice/ctl.sock` so `bmw_voice` natively replaces
 *        BMW's `"Nhập bằng giọng nói không khả dụng"` screen in `HmiMain3D` (and auto-closes 3.2s after execution!),
 *        while `IpaOverlay` covers Wayland IVI layers seamlessly whenever `bmw_voice` is not yet in front.
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
const OfflineAi = require('./offline-ai');
const { IpaOverlay } = require('./ipa-overlay');

const VERSION = '1.2.2';
const FW_TAG = 'bmw-voice';
const APP_RE = /^bmw_voice\d*$/;

const env = (k, d) => (process.env[k] !== undefined && process.env[k] !== '' ? process.env[k] : d);

function createDaemonConfig(over) {
    return Object.assign({
        run: env('BV_RUN', '/run/bmw-voice'),
        state: env('BV_STATE', '/var/opt/bmw-voice'),
        oap: env('BV_OAP', '/var/opt/public/oap'),
        proc: env('BV_PROC', '/proc'),
        offlineDir: env('BV_OFFLINE_DIR', OfflineAi.DEFAULT_OFFLINE_DIR),
        port: Number(env('BV_PORT', 8145)),
        host: env('BV_HOST', '0.0.0.0'),
        nft: env('BV_NFT', 'nft'),
        route: env('BV_ROUTE', '/proc/net/route'),
        ips: env('BV_IPS', ''),
        simMode: env('BV_SIM', '') === '1',
        noNft: env('BV_NO_NFT', '') === '1',
        noOverlay: env('BV_NO_OVERLAY', '') === '1',
        noWakeStream: env('BV_NO_WAKE_STREAM', '') === '1',
        renderSockets: null,
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
        model: 'gemini-3.5-flash-lite',
        pttTrigger: 'short_press', // short_press | long_press | double_press | disabled
        handsFreeWake: true,       // "Hey BMW" hands-free wake word enabled by default
        voiceReply: true,          // Speak Vietnamese confirmation over BMW OapGenericOverlay (ducks music)
        swapMicChannels: false,
    };
}

function normalizeModelName(raw, fallback) {
    const m = typeof raw === 'string' ? raw.trim() : '';
    if (!m) return fallback;
    // Legacy Gemini 1.5 / 2.0 / 2.5 and 3-flash-preview models return HTTP 404 or 429 on new keys
    if (/^gemini-(?:1\.5|2\.0|2\.5)-/i.test(m) || /^gemini-3-flash-preview$/i.test(m)) return 'gemini-3.5-flash-lite';
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
        handsFreeWake: r.handsFreeWake !== undefined ? !!r.handsFreeWake : d.handsFreeWake,
        voiceReply: r.voiceReply !== undefined ? !!r.voiceReply : d.voiceReply,
        swapMicChannels: !!r.swapMicChannels,
    };
}

function buildWakeChimeWav() {
    // Pleasant 220ms two-tone OEM BMW ascending chime (D5 -> A5, 24 kHz 16-bit mono PCM)
    const sr = 24000;
    const total = Math.round(sr * 0.22);
    const pcm = Buffer.alloc(total * 2);
    for (let i = 0; i < total; i++) {
        const t = i / sr;
        const f = t < 0.10 ? 587.33 : 880.0;
        const localT = t < 0.10 ? t : (t - 0.10);
        const dur = t < 0.10 ? 0.10 : 0.12;
        const env = Math.sin(Math.PI * Math.min(1, localT / dur));
        const s = Math.sin(2 * Math.PI * f * t) * 0.28 * env;
        pcm.writeInt16LE(Math.max(-32767, Math.min(32767, Math.round(s * 32767))), i * 2);
    }
    const hdr = Buffer.alloc(44);
    hdr.write('RIFF', 0);
    hdr.writeUInt32LE(36 + pcm.length, 4);
    hdr.write('WAVE', 8);
    hdr.write('fmt ', 12);
    hdr.writeUInt32LE(16, 16);
    hdr.writeUInt16LE(1, 20);
    hdr.writeUInt16LE(1, 22);
    hdr.writeUInt32LE(sr, 24);
    hdr.writeUInt32LE(sr * 2, 28);
    hdr.writeUInt16LE(2, 32);
    hdr.writeUInt16LE(16, 34);
    hdr.write('data', 36);
    hdr.writeUInt32LE(pcm.length, 40);
    return Buffer.concat([hdr, pcm]);
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
        if (a.internal || (a.family !== 'IPv4' && a.family !== 4) || /^(?:169\.254\.|160\.48\.)/.test(a.address)) return;
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
        this.wakeStatus = 'off';      // off | paused | armed
        this.micLevels = { leftDb: -60, rightDb: -60 };
        this.audioProbe = MicCapture.probeSmartxStack(this.cfg.micOpts);
        this.offlineProbe = OfflineAi.probeOfflineAi(this.cfg.offlineDir);
        this.offlineWorker = new OfflineAi.OfflineWorkerClient({
            offlineDir: this.cfg.offlineDir,
            workDir: this.cfg.run,
            mguPython: (this.cfg.micOpts && this.cfg.micOpts.mguPython) || undefined,
            onLog: (m) => this.log(m),
            onReadyChange: (st) => {
                this.scheduleStatusWrite();
                if (st && st.ttsReady) this.scheduleTtsPrewarm();
            },
        });
        this.prewarmTimer = null;
        this.lastTurn = {
            at: Date.now(),
            ok: true,
            idle: true,
            speakerZone: 'driver',
            transcript: '',
            replyVi: 'Nói "Hey BMW" hoặc bấm nút Mic trên vô-lăng để ra lệnh Tiếng Việt.',
            actions: [],
        };
        this.seenCmdIds = [];
        this.hmiClients = [];
        this.hmiAppVisible = false;
        this.turnBusy = false;
        this.wakeCheckBusy = false;
        this.wakeEpoch = 0;
        this.listenStartedAt = 0;
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

        this.overlay = new IpaOverlay({
            sockets: this.cfg.renderSockets || undefined,
            onLog: (m) => this.log(m),
        });

        this.car = new CarControl.CarController({
            onStateChange: (st) => {
                if (st && (st.callActive || st.gear === 'R')) {
                    this.overlay.hide();
                }
                this.scheduleStatusWrite();
            },
            shouldFireImmediateShortPress: () => this.settings.pttTrigger === 'short_press',
            onPttEvent: (ev) => this.onSteeringWheelPtt(ev),
            onLog: (m) => this.log(m),
        });

        this.micStream = new MicCapture.MicStreamEngine(Object.assign({
            workDir: this.cfg.run,
            offlineDir: this.cfg.offlineDir,
            swapChannels: this.settings.swapMicChannels,
            connectAmRoute: (r) => this.car.connectAudioRoute(r),
            disconnectAmRoute: (cid) => this.car.disconnectAudioRoute(cid),
            shouldPause: () => !this.settings.handsFreeWake || !this.canHandleVoice() || !!this.car.state.callActive,
            onSpeechHint: () => {
                if (!this.cfg.simMode && this.settings.apiKey && !(this.offlineProbe && this.offlineProbe.hasStt)) {
                    Up.warmup(this.uplinkOpts).catch(() => {});
                }
            },
            onMicLevel: (db) => {
                this.overlay.updateMicLevel(db);
            },
            onLocalWake: (ev) => {
                this.onLocalWakeDetected(ev).catch((e) => this.log('Local wake err: ' + e.message));
            },
            onWakeUtterance: (utt) => {
                this.onHeyBmwCandidate(utt).catch((e) => this.log('Hey BMW err: ' + e.message));
            },
            onStatusChange: (next) => {
                this.wakeStatus = next;
                this.scheduleStatusWrite();
            },
            onLog: (m) => this.log(m),
        }, this.cfg.micOpts || {}));
    }

    canHandleVoice() {
        return !!this.settings.apiKey || !!(this.offlineProbe && this.offlineProbe.hasStt);
    }

    scheduleTtsPrewarm() {
        if (this.cfg.simMode || this.prewarmTimer || !this.offlineWorker || !this.offlineWorker.ttsReady) return;
        const phrases = [
            'Xin chào, tôi đang lắng nghe',
            'Xin lỗi, tôi chưa hiểu lệnh này.',
            'Đã tăng âm lượng loa',
            'Đã giảm âm lượng loa',
            'Đã tắt tiếng loa',
            'Đã bật lại tiếng loa',
            'Đã chuyển sang bài tiếp theo',
            'Đã lùi về bài trước',
            'Đã tạm dừng nhạc',
            'Đã tiếp tục phát nhạc',
            'Đã đổi đèn viền sang Trắng',
            'Đã đổi đèn viền sang Cam B M W',
            'Đã bật sấy kính chắn gió',
            'Đã bật Max điều hòa lạnh sâu',
        ];
        const cacheDir = path.join(this.cfg.state, 'tts-cache');
        mkdirp(cacheDir);
        let idx = 0;
        const step = () => {
            this.prewarmTimer = null;
            if (!this.offlineWorker || !this.offlineWorker.running || !this.offlineWorker.ttsReady) return;
            while (idx < phrases.length) {
                const rawPhrase = phrases[idx++];
                const text = NluBrain.formatOfflineSpeechTextVi(rawPhrase);
                if (!text) continue;
                // Same key and pause compression as speakReply(), so prewarmed phrases are actually reused.
                const hash = crypto.createHash('sha1').update('v5:piper:' + text).digest('hex').slice(0, 16);
                const file = path.join(cacheDir, hash + '.wav');
                if (fs.existsSync(file)) continue;
                if (this.turnBusy || this.assistantState !== 'idle' || this.car.state.speedKmh > 2) {
                    idx--;
                    this.prewarmTimer = setTimeout(step, 8000);
                    if (this.prewarmTimer.unref) this.prewarmTimer.unref();
                    return;
                }
                this.offlineWorker.synthesize({ text, timeoutMs: 22000 }).then((tts) => {
                    if (tts && tts.wavBuffer) {
                        try { writeAtomic(file, this.compressPauses(tts.wavBuffer), 0o644); } catch (e) {}
                    }
                    this.prewarmTimer = setTimeout(step, 6000);
                    if (this.prewarmTimer.unref) this.prewarmTimer.unref();
                }).catch(() => {});
                return;
            }
        };
        this.prewarmTimer = setTimeout(step, 3500);
        if (this.prewarmTimer.unref) this.prewarmTimer.unref();
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

    pushHmiEvent(action, extra, prebuiltState) {
        if (!this.hmiClients.length) return;
        const payload = JSON.stringify(Object.assign({
            event: 'voice_ui',
            action: action || 'state',
            state: prebuiltState || this.buildHmiState(),
        }, extra || {})) + '\n';
        for (let i = this.hmiClients.length - 1; i >= 0; i--) {
            const c = this.hmiClients[i];
            if (!c || c.destroyed) {
                this.hmiClients.splice(i, 1);
                continue;
            }
            try { c.write(payload); } catch (e) { this.hmiClients.splice(i, 1); }
        }
    }

    shouldShowOverlay() {
        return !this.cfg.noOverlay && !this.hmiAppVisible && this.car.state.gear !== 'R' && !this.car.state.callActive;
    }

    publicSettings() {
        return {
            hasApiKey: !!this.settings.apiKey,
            apiKeyMasked: this.settings.apiKey
                ? (this.settings.apiKey.slice(0, 6) + '****' + this.settings.apiKey.slice(-4))
                : '',
            model: this.settings.model,
            pttTrigger: this.settings.pttTrigger,
            handsFreeWake: !!this.settings.handsFreeWake,
            voiceReply: !!this.settings.voiceReply,
            swapMicChannels: this.settings.swapMicChannels,
        };
    }

    async playWakeChime() {
        if (this.cfg.simMode || !this.settings.voiceReply || this.car.state.callActive) return false;
        const chimePath = path.join(this.cfg.run, 'chime.wav');
        try {
            if (!fs.existsSync(chimePath)) {
                writeAtomic(chimePath, buildWakeChimeWav(), 0o644);
            }
            this.micStream.holdCooldown(500);
            return await this.car.playOverlayWav(chimePath, 240);
        } catch (e) {
            return false;
        }
    }

    /* Natural Gemini voice for next time: after a Piper fallback, fetch it in the background and cache it. */
    fillGeminiTts(spoken, gemFile) {
        if (this._ttsFillBusy || !this.settings.apiKey || fs.existsSync(gemFile)) return;
        this._ttsFillBusy = true;
        NluBrain.synthesizeVietnameseTts({
            text: spoken,
            apiKey: this.settings.apiKey,
            uplinkOpts: this.uplinkOpts,
            timeoutMs: 25000,
            log: (m) => this.log(m),
        }).then((g) => {
            if (g && g.wavBuffer) {
                try { writeAtomic(gemFile, g.wavBuffer, 0o644); this.log('TTS cache filled (' + g.model + '): "' + spoken + '"'); } catch (e) {}
            }
        }).catch(() => {}).then(() => { this._ttsFillBusy = false; });
    }

    /* Piper reads Vietnamese syllable by syllable; shorten the inner gaps to <= 30 ms (PCM16 mono only). */
    compressPauses(buf) {
        try {
            if (!buf || buf.length < 1000 || buf.toString('ascii', 0, 4) !== 'RIFF') return buf;
            let off = 12, fmt = null, dOff = -1, dLen = 0;
            while (off + 8 <= buf.length) {
                const id = buf.toString('ascii', off, off + 4);
                const len = buf.readUInt32LE(off + 4);
                if (id === 'fmt ') fmt = { ch: buf.readUInt16LE(off + 10), sr: buf.readUInt32LE(off + 12), bits: buf.readUInt16LE(off + 22) };
                if (id === 'data') { dOff = off + 8; dLen = Math.min(len, buf.length - dOff); break; }
                off += 8 + len + (len & 1);
            }
            if (!fmt || fmt.ch !== 1 || fmt.bits !== 16 || dOff < 0) return buf;
            const n = dLen >> 1;
            const win = Math.max(1, Math.round(fmt.sr * 0.005));
            let peak = 0;
            for (let i = 0; i < n; i++) { const v = Math.abs(buf.readInt16LE(dOff + 2 * i)); if (v > peak) peak = v; }
            if (!peak) return buf;
            const th = peak * 0.04;
            const keepWins = 6;
            const nw = Math.ceil(n / win);
            const loud = new Array(nw);
            for (let w = 0; w < nw; w++) {
                let m = 0;
                for (let i = w * win; i < Math.min(n, (w + 1) * win); i++) { const v = Math.abs(buf.readInt16LE(dOff + 2 * i)); if (v > m) m = v; }
                loud[w] = m >= th;
            }
            const first = loud.indexOf(true), last = loud.lastIndexOf(true);
            if (first < 0) return buf;
            const parts = [];
            let quiet = 0;
            for (let w = 0; w < nw; w++) {
                if (w > first && w < last && !loud[w]) { quiet++; if (quiet > keepWins) continue; } else quiet = 0;
                parts.push(buf.slice(dOff + 2 * w * win, dOff + 2 * Math.min(n, (w + 1) * win)));
            }
            const pcm = Buffer.concat(parts);
            const hdr = Buffer.alloc(44);
            hdr.write('RIFF', 0); hdr.writeUInt32LE(36 + pcm.length, 4); hdr.write('WAVE', 8); hdr.write('fmt ', 12);
            hdr.writeUInt32LE(16, 16); hdr.writeUInt16LE(1, 20); hdr.writeUInt16LE(1, 22); hdr.writeUInt32LE(fmt.sr, 24);
            hdr.writeUInt32LE(fmt.sr * 2, 28); hdr.writeUInt16LE(2, 32); hdr.writeUInt16LE(16, 34); hdr.write('data', 36); hdr.writeUInt32LE(pcm.length, 40);
            return Buffer.concat([hdr, pcm]);
        } catch (e) {
            return buf;
        }
    }

    async speakReply(rawText) {
        const hasOfflineTts = !!(this.offlineProbe && this.offlineProbe.hasTts);
        if (this.cfg.simMode || !this.settings.voiceReply || this.car.state.callActive || (!hasOfflineTts && !this.settings.apiKey)) {
            return false;
        }
        const spoken = /^Chưa nhận diện được lệnh điều khiển xe/.test(String(rawText || ''))
            ? 'Xin lỗi, tôi chưa hiểu lệnh này.'
            : NluBrain.formatSpeechTextVi(rawText);
        if (!spoken) return false;
        try {
            const cacheDir = path.join(this.cfg.state, 'tts-cache');
            mkdirp(cacheDir);
            const offlineSpoken = NluBrain.formatOfflineSpeechTextVi(spoken);
            const hasKey = !!this.settings.apiKey;
            const gemFile = path.join(cacheDir, crypto.createHash('sha1').update('v4:gem:' + spoken).digest('hex').slice(0, 16) + '.wav');
            const piperFile = path.join(cacheDir, crypto.createHash('sha1').update('v5:piper:' + offlineSpoken).digest('hex').slice(0, 16) + '.wav');
            let cacheFile = hasKey ? gemFile : piperFile;
            let wavBuf = null;
            let durMs = 2400;

            if (hasKey && fs.existsSync(gemFile)) {
                wavBuf = fs.readFileSync(gemFile);
                const hdrInfo = OfflineAi.readWavHeaderInfo(wavBuf);
                durMs = hdrInfo.durationMs || Math.round((Math.max(0, wavBuf.length - 44) / 48000) * 1000);
                this.log('TTS cache hit (gem, ' + durMs + 'ms): "' + spoken + '"');
            } else {
                let tts = null;
                if (hasKey) {
                    tts = await NluBrain.synthesizeVietnameseTts({
                        text: spoken,
                        apiKey: this.settings.apiKey,
                        uplinkOpts: this.uplinkOpts,
                        timeoutMs: 8000,
                        log: (m) => this.log(m),
                    });
                    if (tts && tts.wavBuffer) cacheFile = gemFile;
                }
                if (!tts && hasOfflineTts && fs.existsSync(piperFile)) {
                    wavBuf = fs.readFileSync(piperFile);
                    const hdrInfo = OfflineAi.readWavHeaderInfo(wavBuf);
                    durMs = hdrInfo.durationMs || Math.round((Math.max(0, wavBuf.length - 44) / 44100) * 1000);
                    this.log('TTS cache hit (piper, ' + durMs + 'ms): "' + offlineSpoken + '"');
                    if (hasKey) this.fillGeminiTts(spoken, gemFile);
                } else if (!tts && hasOfflineTts && this.offlineWorker && this.offlineWorker.ttsReady) {
                    tts = await OfflineAi.synthesizeOfflineViTts({
                        text: offlineSpoken,
                        offlineDir: this.cfg.offlineDir,
                        workDir: this.cfg.run,
                        worker: this.offlineWorker,
                    });
                    if (tts && tts.wavBuffer) cacheFile = piperFile;
                }
                if (!wavBuf && tts && tts.wavBuffer) {
                    wavBuf = /^piper/.test(String(tts.model || '')) ? this.compressPauses(tts.wavBuffer) : tts.wavBuffer;
                    durMs = tts.durationMs || 2600;
                    this.log('TTS generated (' + tts.model + ', ' + durMs + 'ms' + (tts.elapsedMs ? (', gen=' + tts.elapsedMs + 'ms') : '') + '): "' + (tts.spoken || spoken) + '"');
                    try {
                        writeAtomic(cacheFile, wavBuf, 0o644);
                        if (hasKey && cacheFile !== gemFile) this.fillGeminiTts(spoken, gemFile);
                        // Prune oldest cached WAVs if > 48 entries (~6 MB cap)
                        const files = fs.readdirSync(cacheDir).filter((f) => /\.wav$/.test(f));
                        if (files.length > 48) {
                            const stats = files.map((f) => {
                                const p = path.join(cacheDir, f);
                                try { return { p, mt: fs.statSync(p).mtimeMs }; } catch (e) { return { p, mt: 0 }; }
                            }).sort((a, b) => a.mt - b.mt);
                            for (let i = 0; i < stats.length - 40; i++) {
                                try { fs.unlinkSync(stats[i].p); } catch (e) {}
                            }
                        }
                    } catch (e) {}
                }
                if (!wavBuf) return false;
            }

            if (this.car.state.callActive || this.assistantState === 'listening') return false;
            const outWav = path.join(this.cfg.run, 'reply_tts.wav');
            writeAtomic(outWav, wavBuf, 0o644);
            // Prevent the ceiling mic from hearing our own TTS reply and re-triggering "Hey BMW"
            this.micStream.holdCooldown(durMs + 1100);
            if (this.overlay.phase === 'result' && this.shouldShowOverlay()) {
                this.overlay.extendHide(durMs + 900);
            }
            return await this.car.playOverlayWav(outWav, durMs);
        } catch (e) {
            this.log('TTS speak warn: ' + e.message);
            return false;
        }
    }

    saveSettings(patch) {
        this.settings = normalizeSettings(Object.assign({}, this.settings, patch || {}));
        writeAtomic(this.settingsFile, JSON.stringify(this.settings, null, 2) + '\n', 0o600);
        this.micStream.setSwapChannels(this.settings.swapMicChannels);
        if (!this.cfg.noWakeStream) {
            this.micStream.tick().catch(() => {});
        }
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
            wakeStatus: this.wakeStatus,
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
                callRaw: st.callRaw || null,
            },
            audio: {
                hasAlsaCapture: !!this.audioProbe.hasAlsaCapture,
                device: this.micStream.activeDevice || this.audioProbe.recommendedDevice || '',
            },
            offline: {
                kws: !!(this.offlineProbe && this.offlineProbe.hasKws),
                stt: !!(this.offlineProbe && this.offlineProbe.hasStt),
                sttWarm: !!(this.offlineWorker && this.offlineWorker.sttReady),
                tts: !!(this.offlineProbe && this.offlineProbe.hasTts),
                ttsWarm: !!(this.offlineWorker && this.offlineWorker.ttsReady),
                kwsMode: this.micStream.kwsMode || 'cloud_vad',
            },
            hasVoiceReady: this.canHandleVoice(),
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
            this.pushHmiEvent('state', null, hmi);
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

        // If already listening for >650ms, pressing PTT again finishes recording early (just like OEM BMW)
        if (this.turnBusy && this.assistantState === 'listening' && (Date.now() - this.listenStartedAt) > 650) {
            this.micStream._sendCmd({ cmd: 'ptt_stop' });
            return;
        }

        this.log('PTT (' + ev.kind + ', ' + ev.heldMs + 'ms) -> BMW screen + instant mic');
        this.captureAndExecute({ fromSteeringWheel: true }).catch((e) => this.log('PTT error: ' + e.message));
    }

    async onLocalWakeDetected(ev) {
        if (this.turnBusy || this.assistantState !== 'idle') return;
        if (!this.settings.handsFreeWake || !this.canHandleVoice() || this.car.state.callActive) return;

        this.wakeEpoch++;
        this.turnBusy = true;
        const zone = (ev && ev.speakerZone === 'passenger') ? 'passenger' : 'driver';
        this.micLevels = {
            leftDb: (ev && typeof ev.leftDb === 'number') ? ev.leftDb : -30,
            rightDb: (ev && typeof ev.rightDb === 'number') ? ev.rightDb : -30,
        };

        try {
            this.log('Offline KWS wake (' + ((ev && ev.keyword) || 'HEY_BMW') + ', ' + zone + ') -> instant assistant');
            this.assistantState = 'listening';
            this.listenStartedAt = Date.now();
            this.lastTurn = {
                at: Date.now(),
                ok: true,
                idle: false,
                speakerZone: zone,
                transcript: 'Hey BMW',
                replyVi: 'Xin chào, tôi đang lắng nghe…',
                actions: [],
            };
            // Paint full-screen IPA overlay IMMEDIATELY (<5ms after keyword detected)
            if (this.shouldShowOverlay()) {
                this.overlay.showListening({
                    wakeTriggered: true,
                    speakerZone: zone,
                    headline: 'Xin chào, tôi đang lắng nghe…',
                    subline: 'Mời nói câu lệnh Tiếng Việt · Ví dụ: "Điều hòa 22 độ", "Đèn màu cam", "Qua bài"',
                });
            }
            this.car.pulseIpaLight(zone === 'passenger' ? 'listenPassenger' : 'listenDriver').catch(() => {});
            this.writeStatusFile(true);
            if (this.car.state.gear !== 'R') {
                this.pushHmiEvent('open', { reason: 'hey_bmw' });
            }

            await this.car.duckMusicForListening({
                hasRefChannel: this.micStream.hasRefChannel,
                speakerPlaying: this.micStream.speakerPlaying,
            });
            await this.playWakeChime();

            let followCap;
            try {
                followCap = await this.micStream.capturePtt({
                    maxDurationSec: 5.0,
                    noPreroll: true,
                    outFile: path.join(this.cfg.run, 'capture.wav'),
                });
            } finally {
                await this.car.restoreMusicAfterListening();
            }
            try { fs.writeFileSync(path.join(this.cfg.run, 'last_ptt.wav'), followCap.wavBuffer); } catch (e) {}
            this.log('Wake follow-up clip: dur=' + followCap.analysis.durationMs + 'ms ch=' + followCap.analysis.channels
                + ' L=' + followCap.analysis.leftDb + 'dB R=' + followCap.analysis.rightDb + 'dB snr=' + followCap.snrDb
                + ' voiced=' + followCap.voicedChunks);
            const followZone = (followCap.analysis && followCap.analysis.speakerZone === 'passenger') ? 'passenger' : zone;
            this.micLevels = {
                leftDb: followCap.analysis.leftDb,
                rightDb: followCap.analysis.rightDb,
            };
            this.assistantState = 'thinking';
            this.writeStatusFile(true);
            if (this.shouldShowOverlay()) {
                this.overlay.showThinking({ speakerZone: followZone });
            }

            const followTurn = (followCap.voicedChunks === 0 && typeof followCap.snrDb === 'number' && followCap.snrDb < 2.8)
                ? {
                    at: Date.now(),
                    ok: false,
                    speakerZone: followZone,
                    transcript: '',
                    replyVi: 'Chưa nghe thấy câu lệnh - mời gọi "Hey BMW" rồi nói rõ lệnh điều khiển.',
                    actions: [],
                }
                : await NluBrain.processVoiceOrText({
                    audioWavBase64: followCap.wavBuffer.toString('base64'),
                    audioMimeType: 'audio/wav',
                    speakerZone: followZone,
                    wakeMode: false,
                    apiKey: this.settings.apiKey,
                    model: this.settings.model,
                    offlineDir: this.cfg.offlineDir,
                    offlineWorker: this.offlineWorker,
                    workDir: this.cfg.run,
                    carController: this.car,
                    uplinkOpts: this.uplinkOpts,
                });

            this.log('Wake result (' + (followTurn.engine || '') + '): ok=' + !!followTurn.ok
                + ' tr="' + (followTurn.transcript || '') + '" -> "' + (followTurn.replyVi || '') + '"');
            this.lastTurn = followTurn;
            this.assistantState = 'idle';
            this.car.pulseIpaLight('off').catch(() => {});
            this.writeStatusFile(true);
            this.pushHmiEvent('finish', { holdMs: 3600 });
            if (this.shouldShowOverlay()) {
                this.overlay.showResult(followTurn, 3600);
            }
            this.speakReply(followTurn.replyVi).catch(() => {});
        } catch (e) {
            this.assistantState = 'idle';
            this.overlay.hide();
            this.car.pulseIpaLight('off').catch(() => {});
            this.pushHmiEvent('finish', { holdMs: 2200 });
            this.log('Local wake follow-up warn: ' + e.message);
        } finally {
            this.assistantState = 'idle';
            this.turnBusy = false;
        }
    }

    async onHeyBmwCandidate(utt) {
        if (this.turnBusy || this.wakeCheckBusy || this.assistantState !== 'idle') return;
        if (!this.settings.handsFreeWake || !this.canHandleVoice() || this.car.state.callActive) return;

        const myEpoch = ++this.wakeEpoch;
        this.wakeCheckBusy = true;
        let turn = null;
        const zone = (utt.analysis && utt.analysis.speakerZone === 'passenger') ? 'passenger' : 'driver';
        const isShortWakeClip = !!(utt && typeof utt.durationMs === 'number' && utt.durationMs > 0 && utt.durationMs <= 1950);
        try {
            turn = await NluBrain.processVoiceOrText({
                audioWavBase64: utt.wavBuffer.toString('base64'),
                audioMimeType: 'audio/wav',
                speakerZone: zone,
                wakeMode: true,
                fastWakeOnly: isShortWakeClip,
                apiKey: this.settings.apiKey,
                model: this.settings.model,
                offlineDir: this.cfg.offlineDir,
                offlineWorker: this.offlineWorker,
                workDir: this.cfg.run,
                carController: this.car,
                uplinkOpts: this.uplinkOpts,
            });
        } finally {
            this.wakeCheckBusy = false;
        }

        if (turn && turn.netError) {
            this.log('Hey BMW network warn: ' + turn.netError);
            if (turn.httpStatus === 429 || /\b429\b/.test(turn.netError)) {
                this.micStream.holdCooldown(35000);
            }
        }

        // Preempted by physical Steering Wheel Mic button or manual UI Mic button while wake check was in flight!
        if (myEpoch !== this.wakeEpoch || this.turnBusy || this.assistantState !== 'idle') {
            return;
        }

        // 1. Cabin chatter without "Hey BMW" -> silently ignore (zero UI popups, zero status churn)
        if (!turn || turn.ignored) {
            this.log('Wake clip ignored: dur=' + (utt.durationMs || 0) + 'ms snr=' + (utt.snrDb || 0)
                + ' tr="' + ((turn && turn.transcript) || '') + '"');
            return;
        }

        this.turnBusy = true;
        try {
            this.micLevels = {
                leftDb: utt.analysis ? utt.analysis.leftDb : -30,
                rightDb: utt.analysis ? utt.analysis.rightDb : -30,
            };

            // 2. 2-Step "Hey BMW" -> Open BMW Assistant screen / IPA Overlay & immediately listen for command!
            if (turn.wakeOnly) {
                this.log('Hey BMW wake detected (' + zone + ') -> opening assistant for follow-up');
                this.assistantState = 'listening';
                this.listenStartedAt = Date.now();
                this.lastTurn = {
                    at: Date.now(),
                    ok: true,
                    idle: false,
                    speakerZone: zone,
                    transcript: 'Hey BMW',
                    replyVi: 'Xin chào, tôi đang lắng nghe…',
                    actions: [],
                };
                if (this.shouldShowOverlay()) {
                    this.overlay.showListening({
                        wakeTriggered: true,
                        speakerZone: zone,
                        headline: 'Xin chào, tôi đang lắng nghe…',
                        subline: 'Mời nói câu lệnh Tiếng Việt · Ví dụ: "Điều hòa 22 độ", "Đèn màu cam", "Qua bài"',
                    });
                }
                this.writeStatusFile(true);
                if (this.car.state.gear !== 'R') {
                    this.pushHmiEvent('open', { reason: 'hey_bmw' });
                }
                this.car.pulseIpaLight(zone === 'passenger' ? 'listenPassenger' : 'listenDriver').catch(() => {});
                await this.car.duckMusicForListening({
                hasRefChannel: this.micStream.hasRefChannel,
                speakerPlaying: this.micStream.speakerPlaying,
            });
                await this.playWakeChime();

                let followCap;
                try {
                    followCap = await this.micStream.capturePtt({
                        maxDurationSec: 5.0,
                        noPreroll: true,
                        outFile: path.join(this.cfg.run, 'capture.wav'),
                    });
                } finally {
                    await this.car.restoreMusicAfterListening();
                }
                try { fs.writeFileSync(path.join(this.cfg.run, 'last_ptt.wav'), followCap.wavBuffer); } catch (e) {}
                this.log('Follow-up clip: dur=' + followCap.analysis.durationMs + 'ms ch=' + followCap.analysis.channels
                    + ' L=' + followCap.analysis.leftDb + 'dB R=' + followCap.analysis.rightDb + 'dB snr=' + followCap.snrDb
                    + ' voiced=' + followCap.voicedChunks);
                const followZone = (followCap.analysis && followCap.analysis.speakerZone === 'passenger') ? 'passenger' : zone;
                this.micLevels = {
                    leftDb: followCap.analysis.leftDb,
                    rightDb: followCap.analysis.rightDb,
                };
                this.assistantState = 'thinking';
                this.writeStatusFile(true);
                if (this.shouldShowOverlay()) {
                    this.overlay.showThinking({ speakerZone: followZone });
                }

                const followTurn = (followCap.voicedChunks === 0 && typeof followCap.snrDb === 'number' && followCap.snrDb < 2.8)
                    ? {
                        at: Date.now(),
                        ok: false,
                        speakerZone: followZone,
                        transcript: '',
                        replyVi: 'Chưa nghe thấy câu lệnh - mời gọi "Hey BMW" rồi nói rõ lệnh điều khiển.',
                        actions: [],
                    }
                    : await NluBrain.processVoiceOrText({
                        audioWavBase64: followCap.wavBuffer.toString('base64'),
                        audioMimeType: 'audio/wav',
                        speakerZone: followZone,
                        wakeMode: false,
                        apiKey: this.settings.apiKey,
                        model: this.settings.model,
                        offlineDir: this.cfg.offlineDir,
                        offlineWorker: this.offlineWorker,
                        workDir: this.cfg.run,
                        carController: this.car,
                        uplinkOpts: this.uplinkOpts,
                    });

                this.log('Follow-up result (' + (followTurn.engine || '') + '): ok=' + !!followTurn.ok
                    + ' tr="' + (followTurn.transcript || '') + '" -> "' + (followTurn.replyVi || '') + '"');
                this.lastTurn = followTurn;
                this.assistantState = 'idle';
                this.car.pulseIpaLight('off').catch(() => {});
                this.writeStatusFile(true);
                this.pushHmiEvent('finish', { holdMs: 3600 });
                if (this.shouldShowOverlay()) {
                    this.overlay.showResult(followTurn, 3600);
                }
                this.speakReply(followTurn.replyVi).catch(() => {});
                return;
            }

            // 3. 1-Shot "Hey BMW + command" -> Command already executed! Show OEM BMW IPA confirmation!
            this.log('Hey BMW 1-shot executed: ' + (turn.transcript || '') + ' -> ' + (turn.replyVi || ''));
            this.lastTurn = turn;
            this.car.pulseIpaLight('center').catch(() => {});
            setTimeout(() => this.car.pulseIpaLight('off').catch(() => {}), 1400);
            this.writeStatusFile(true);
            if (this.shouldShowOverlay() && this.overlay.ready) {
                this.overlay.showResult(turn, 3800);
            } else if (!this.hmiAppVisible && this.car.state.gear !== 'R') {
                this.pushHmiEvent('open_result', { holdMs: 3600 });
            }
            this.speakReply(turn.replyVi).catch(() => {});
        } catch (e) {
            this.assistantState = 'idle';
            this.overlay.hide();
            this.car.pulseIpaLight('off').catch(() => {});
            this.pushHmiEvent('finish', { holdMs: 2200 });
            this.log('Hey BMW follow-up warn: ' + e.message);
        } finally {
            this.assistantState = 'idle';
            this.turnBusy = false;
        }
    }

    async captureAndExecute(opts) {
        const o = opts || {};
        // Always preempt any background Hey BMW check so Steering Wheel PTT responds 100% of the time!
        this.wakeEpoch++;
        if (this.turnBusy || this.assistantState !== 'idle') {
            return { ok: false, error: 'Đang xử lý lệnh trước' };
        }
        if (this.car.state.callActive) {
            this.lastTurn = {
                at: Date.now(),
                ok: false,
                speakerZone: 'driver',
                transcript: '',
                replyVi: 'Đang có cuộc gọi điện thoại - tạm nhường Mic xe.',
                actions: [],
            };
            this.writeStatusFile(true);
            return { ok: false, turn: this.lastTurn };
        }

        // Physical Steering Wheel Mic press ALWAYS triggers HmiMain3D's native Speech scene transition (~100-300ms later),
        // even if `Trợ lý BMW` was already open on screen! Reset `hmiAppVisible = false` up front so `IpaOverlay` (`uid=0`)
        // shields the screen immediately at t=0ms until `apps/bmw_voice` reclaims `ROOT_APP` in `HmiMain3D`!
        if (o.fromSteeringWheel) {
            this.hmiAppVisible = false;
        }

        const canVoice = this.canHandleVoice();
        if (!canVoice) {
            this.lastTurn = {
                at: Date.now(),
                ok: false,
                speakerZone: 'driver',
                transcript: '',
                replyVi: 'Bấm "Cài đặt QR" bên dưới để quét mã dán Gemini API Key lần đầu.',
                actions: [],
            };
            this.writeStatusFile(true);
            if (o.fromSteeringWheel && this.car.state.gear !== 'R') {
                this.pushHmiEvent('open_result', { holdMs: 6500 });
            }
            if (this.shouldShowOverlay()) {
                this.overlay.showResult(this.lastTurn, 4200);
                if (o.fromSteeringWheel) this.overlay._scheduleTopReassertions();
            }
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

        // Pre-warm TLS 1.3 socket in parallel when Gemini cloud is active or offline STT is still warming up
        if (!this.cfg.simMode && this.settings.apiKey && !(this.offlineWorker && this.offlineWorker.sttReady)) {
            Up.warmup(this.uplinkOpts).catch(() => {});
        }

        this.turnBusy = true;
        this.listenStartedAt = Date.now();
        this.assistantState = 'listening';
        this.lastTurn = {
            at: Date.now(),
            ok: true,
            idle: false,
            speakerZone: 'driver',
            transcript: '',
            replyVi: 'Xin chào, tôi đang lắng nghe…',
            actions: [],
        };

        // Paint Wayland IPA overlay FIRST (before any synchronous status file I/O) so it covers
        // HmiMain3D's native "Nhập bằng giọng nói không khả dụng" popup within ~2ms!
        if (this.shouldShowOverlay()) {
            this.overlay.showListening({
                reassertTop: !!o.fromSteeringWheel,
                wakeTriggered: false,
                speakerZone: 'driver',
            });
        }
        this.car.pulseIpaLight('listenDriver').catch(() => {});
        this.writeStatusFile(true);
        if (o.fromSteeringWheel && this.car.state.gear !== 'R') {
            this.pushHmiEvent('open', { reason: 'ptt' });
        }

        try {
            await this.car.duckMusicForListening({
                hasRefChannel: this.micStream.hasRefChannel,
                speakerPlaying: this.micStream.speakerPlaying,
            });
            let cap;
            try {
                cap = await this.micStream.capturePtt({
                    maxDurationSec: 5.0,
                    noPreroll: false,
                    outFile: path.join(this.cfg.run, 'capture.wav'),
                });
            } finally {
                await this.car.restoreMusicAfterListening();
            }
            try { fs.writeFileSync(path.join(this.cfg.run, 'last_ptt.wav'), cap.wavBuffer); } catch (e) {}

            this.micLevels = { leftDb: cap.analysis.leftDb, rightDb: cap.analysis.rightDb };
            let zone = cap.analysis.speakerZone === 'passenger' ? 'passenger' : 'driver';
            this.log('PTT clip: dur=' + cap.analysis.durationMs + 'ms ch=' + cap.analysis.channels
                + ' L=' + cap.analysis.leftDb + 'dB R=' + cap.analysis.rightDb + 'dB snr=' + cap.snrDb
                + ' voiced=' + cap.voicedChunks);

            // Reject pure silence/road-hum clips locally without wasting a Gemini roundtrip or risking hallucinations
            if (cap.voicedChunks === 0 && typeof cap.snrDb === 'number' && cap.snrDb < 2.8) {
                const quietTurn = {
                    at: Date.now(),
                    ok: false,
                    speakerZone: zone,
                    transcript: '',
                    replyVi: 'Chưa nghe thấy giọng nói - mời đọc lệnh gần Mic trần hơn.',
                    actions: [],
                };
                this.lastTurn = quietTurn;
                this.assistantState = 'idle';
                this.car.pulseIpaLight('off').catch(() => {});
                this.writeStatusFile(true);
                this.pushHmiEvent('finish', { holdMs: 2800 });
                if (this.shouldShowOverlay()) {
                    this.overlay.showResult(quietTurn, 2800);
                }
                return { ok: false, turn: quietTurn };
            }

            this.assistantState = 'thinking';
            this.writeStatusFile(true);
            if (this.shouldShowOverlay()) {
                this.overlay.showThinking({ speakerZone: zone });
            }

            let turn = await NluBrain.processVoiceOrText({
                audioWavBase64: cap.wavBuffer.toString('base64'),
                audioMimeType: 'audio/wav',
                speakerZone: zone,
                wakeMode: false,
                apiKey: this.settings.apiKey,
                model: this.settings.model,
                offlineDir: this.cfg.offlineDir,
                offlineWorker: this.offlineWorker,
                workDir: this.cfg.run,
                carController: this.car,
                uplinkOpts: this.uplinkOpts,
            });

            // If user pressed PTT and still said "Hey BMW" first, seamlessly record follow-up command!
            if (turn && turn.wakeOnly) {
                this.assistantState = 'listening';
                this.listenStartedAt = Date.now();
                this.log('PTT result (' + (turn.engine || '') + '): ok=' + !!turn.ok
                + ' tr="' + (turn.transcript || '') + '" -> "' + (turn.replyVi || '') + '"');
            this.lastTurn = turn;
                this.writeStatusFile(true);
                if (this.shouldShowOverlay()) {
                    this.overlay.showListening({
                        wakeTriggered: true,
                        speakerZone: zone,
                        headline: 'Xin chào, mời nói câu lệnh tiếp theo…',
                    });
                }
                await this.car.duckMusicForListening({
                    hasRefChannel: this.micStream.hasRefChannel,
                    speakerPlaying: this.micStream.speakerPlaying,
                });
                await this.playWakeChime();
                try {
                    cap = await this.micStream.capturePtt({
                        maxDurationSec: 4.2,
                        noPreroll: true,
                        outFile: path.join(this.cfg.run, 'capture.wav'),
                    });
                } finally {
                    await this.car.restoreMusicAfterListening();
                }
                zone = cap.analysis.speakerZone === 'passenger' ? 'passenger' : zone;
                this.assistantState = 'thinking';
                this.writeStatusFile(true);
                if (this.shouldShowOverlay()) this.overlay.showThinking({ speakerZone: zone });
                turn = await NluBrain.processVoiceOrText({
                    audioWavBase64: cap.wavBuffer.toString('base64'),
                    audioMimeType: 'audio/wav',
                    speakerZone: zone,
                    wakeMode: false,
                    apiKey: this.settings.apiKey,
                    model: this.settings.model,
                    offlineDir: this.cfg.offlineDir,
                    offlineWorker: this.offlineWorker,
                    workDir: this.cfg.run,
                    carController: this.car,
                    uplinkOpts: this.uplinkOpts,
                });
            }

            this.log('PTT result (' + (turn.engine || '') + '): ok=' + !!turn.ok
                + ' tr="' + (turn.transcript || '') + '" -> "' + (turn.replyVi || '') + '"');
            this.lastTurn = turn;
            this.assistantState = 'idle';
            this.car.pulseIpaLight('off').catch(() => {});
            this.writeStatusFile(true);
            this.pushHmiEvent('finish', { holdMs: 3600 });
            if (this.shouldShowOverlay()) {
                this.overlay.showResult(turn, 3600);
            }
            this.speakReply(turn.replyVi).catch(() => {});
            return { ok: turn.ok, turn };
        } catch (e) {
            this.assistantState = 'idle';
            this.car.pulseIpaLight('off').catch(() => {});
            this.lastTurn = {
                at: Date.now(),
                ok: false,
                speakerZone: 'driver',
                transcript: '',
                replyVi: 'Không thu được Mic trần (' + NluBrain.sanitizePlainQuotes(e.message).slice(0, 85) + ').',
                actions: [],
            };
            this.writeStatusFile(true);
            this.pushHmiEvent('finish', { holdMs: 3200 });
            if (this.shouldShowOverlay()) {
                this.overlay.showResult(this.lastTurn, 3200);
            }
            return { ok: false, error: e.message, turn: this.lastTurn };
        } finally {
            this.assistantState = 'idle';
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
            if (!req.wakeMode) {
                this.assistantState = 'thinking';
                this.writeStatusFile(true);
            }
            const turn = await NluBrain.processVoiceOrText({
                text: req.text || '',
                audioWavBase64: req.audioWavBase64 || '',
                audioMimeType: req.audioMimeType || 'audio/wav',
                speakerZone: zone,
                wakeMode: !!req.wakeMode,
                apiKey: this.settings.apiKey,
                model: this.settings.model,
                offlineDir: this.cfg.offlineDir,
                offlineWorker: this.offlineWorker,
                workDir: this.cfg.run,
                carController: this.car,
                uplinkOpts: this.uplinkOpts,
            });
            if (!turn.ignored && !turn.wakeOnly) {
                this.log('PTT result (' + (turn.engine || '') + '): ok=' + !!turn.ok
                + ' tr="' + (turn.transcript || '') + '" -> "' + (turn.replyVi || '') + '"');
            this.lastTurn = turn;
                this.assistantState = 'idle';
                this.writeStatusFile(true);
                if (this.shouldShowOverlay()) {
                    this.overlay.showResult(turn, 2800);
                }
            }
            return turn;
        } finally {
            this.assistantState = 'idle';
            this.turnBusy = false;
        }
    }

    async executeHmiCommand(cmd, arg, clientSock) {
        if (cmd === 'subscribe_hmi') {
            if (clientSock && this.hmiClients.indexOf(clientSock) < 0) {
                this.hmiClients.push(clientSock);
            }
            if (arg && typeof arg.visible === 'boolean') {
                this.hmiAppVisible = arg.visible;
                if (this.hmiAppVisible) this.overlay.hide();
            }
            if (clientSock && !clientSock.destroyed) {
                try {
                    clientSock.write(JSON.stringify({
                        event: 'voice_ui',
                        action: 'state',
                        state: this.buildHmiState(),
                    }) + '\n');
                } catch (e) {}
            }
            return { ok: true };
        }
        if (cmd === 'app_visible') {
            const nextVis = !!(arg && arg.visible);
            this.hmiAppVisible = nextVis;
            if (nextVis) {
                this.overlay.hide();
            } else if (this.shouldShowOverlay()) {
                // If an HMI popup ("Không khả dụng") temporarily stole focus from MAIN, immediately cover it with IpaOverlay!
                if (this.assistantState === 'listening') {
                    this.overlay.showListening({ reassertTop: true, speakerZone: this.lastTurn.speakerZone || 'driver' });
                } else if (this.assistantState === 'thinking') {
                    this.overlay.showThinking({ speakerZone: this.lastTurn.speakerZone || 'driver' });
                }
            }
            return { ok: true };
        }
        if (cmd === 'ptt_trigger') return this.captureAndExecute({ fromSteeringWheel: false });
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
            this.executeHmiCommand(c.cmd, c.arg || {}, null).catch((e) => this.log('cmd error: ' + e.message));
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
                    wakeMode: !!body.wakeMode,
                });
                return sendJson(200, { ok: true, turn, state: this.buildHmiState() });
            } catch (e) {
                return sendJson(500, { ok: false, error: e.message });
            }
        }

        if (pathname === '/api/ptt' && req.method === 'POST') {
            const r = await this.captureAndExecute({ fromSteeringWheel: false });
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
                const dropClient = () => {
                    const idx = this.hmiClients.indexOf(client);
                    if (idx >= 0) {
                        this.hmiClients.splice(idx, 1);
                        if (!this.hmiClients.length) this.hmiAppVisible = false;
                    }
                };
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
                                this.executeHmiCommand(c.cmd, c.arg || {}, client).catch((e) => this.log('ctl.sock error: ' + e.message));
                            }
                        } catch (e) {}
                    }
                });
                client.on('close', dropClient);
                client.on('error', dropClient);
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
        if (this.installedApp && this.installedApp.root) {
            this.overlay.addFontDir(path.join(this.installedApp.root, 'source', 'javascript', 'kit', 'fonts'));
        }
        try { fs.chmodSync(path.join(this.cfg.run, 'app'), 0o777); } catch (e) {}
        await this.startCtlSocket();

        if (!this.cfg.noOverlay) {
            this.overlay.start();
        }
        if (!this.cfg.noWakeStream) {
            this.micStream.start();
        }
        if (!this.cfg.simMode && this.offlineProbe && (this.offlineProbe.hasStt || this.offlineProbe.hasTts)) {
            this.offlineWorker.start(os.uptime() < 45 ? 12000 : 1500);
        }

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
            if (tick % 10 === 1) {
                this.installedApp = findInstalledApp(this.cfg.oap);
                if (this.installedApp && this.installedApp.root) {
                    this.overlay.addFontDir(path.join(this.installedApp.root, 'source', 'javascript', 'kit', 'fonts'));
                }
            }
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
        if (this.prewarmTimer) { clearTimeout(this.prewarmTimer); this.prewarmTimer = null; }
        await this.car.restoreMusicAfterListening().catch(() => {});
        await this.micStream.stop();
        await this.offlineWorker.stop();
        this.overlay.stop();
        Up.close(this.uplinkOpts);
        for (let i = 0; i < this.hmiClients.length; i++) {
            try { this.hmiClients[i].destroy(); } catch (e) {}
        }
        this.hmiClients.length = 0;
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
