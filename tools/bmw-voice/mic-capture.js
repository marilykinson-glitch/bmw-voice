'use strict';
/**
 * mic-capture.js - BMW MGU SmartXbar Ceiling Microphone Engine (`bmw-voice`).
 *
 * Capabilities:
 *   1. Persistent low-CPU `MicStreamEngine` (`alsa-smartx.py --stream-daemon`):
 *      - Listens hands-free for `"Hey BMW"` on shared `smartx:SpeechSink_*` pipes after 45s MGU boot grace.
 *      - Handles Steering Wheel Mic (`PTT`) and 2-step follow-up in `<1ms` (zero Python/ALSA process spawn delay!).
 *      - Automatically yields and closes ALSA during phone / CarPlay calls (`shouldPause()`).
 *   2. One-shot `captureCeilingMic` fallback when hands-free mode is turned off or still in boot grace.
 *   3. Stereo Left (Driver) vs Right (Passenger) RMS dBFS zone localization.
 *
 * Node 8 (ES2017) compatible.
 */
const os = require('os');
const fs = require('fs');
const path = require('path');
const cp = require('child_process');

const MGU_PYTHON = '/var/opt/mgu-python/current/bin/python3';
const SMARTX_HELPER = path.join(__dirname, 'alsa-smartx.py');
const DEFAULT_OFFLINE_DIR = process.env.BV_OFFLINE_DIR || '/var/opt/bmw-voice/offline';

const SMARTX_PROFILES = [
    {
        match: 'smartx_SpeechSink_CF_2MIC_6REF_c',
        hw: 'smartx:SpeechSink_CF_2MIC_6REF',
        rate: 24000,
        hwChannels: 8,
        amRoute: { sourceID: 129, sinkID: 387 },
        label: 'SpeechSink 2-Mic 6-Ref (B&W / Harman · 24kHz)',
        score: 99,
    },
    {
        match: 'smartx_SpeechSink_CF_2MIC_1REF_SPEECH_c',
        hw: 'smartx:SpeechSink_CF_2MIC_1REF_SPEECH',
        rate: 24000,
        hwChannels: 3,
        amRoute: { sourceID: 129, sinkID: 387 },
        label: 'SpeechSink 2-Mic 1-Ref (24kHz)',
        score: 97,
    },
    {
        match: 'smartx_SpeechSink_CF_1MIC_6REF_c',
        hw: 'smartx:SpeechSink_CF_1MIC_6REF',
        rate: 24000,
        hwChannels: 7,
        amRoute: { sourceID: 129, sinkID: 387 },
        label: 'SpeechSink 1-Mic 6-Ref (24kHz)',
        score: 93,
    },
    {
        match: 'smartx_SpeechSink_CF_1MIC_1REF_SPEECH_c',
        hw: 'smartx:SpeechSink_CF_1MIC_1REF_SPEECH',
        rate: 24000,
        hwChannels: 2,
        amRoute: { sourceID: 129, sinkID: 387 },
        label: 'SpeechSink 1-Mic 1-Ref (24kHz)',
        score: 91,
    },
    {
        match: 'smartx_VoiceNotesSink_CF_24_MONO_c',
        hw: 'smartx:VoiceNotesSink_CF_24_MONO',
        rate: 24000,
        hwChannels: 1,
        amRoute: { sourceID: 389, sinkID: 389 },
        label: 'VoiceNotesSink ECNR (24kHz)',
        score: 88,
    },
];

let lastWorkingHw = '';

function unlinkSafe(f) {
    try { if (fs.existsSync(f)) fs.unlinkSync(f); } catch (e) {}
}

function probeSmartxStack(opts) {
    const o = opts || {};
    const smartxDir = o.smartxDir || '/run/smartx';
    const pyBin = o.mguPython || MGU_PYTHON;
    const hasPython = fs.existsSync(pyBin);
    const streams = [];

    if (fs.existsSync(smartxDir)) {
        try {
            const entries = fs.readdirSync(smartxDir);
            SMARTX_PROFILES.forEach((p) => {
                if (entries.indexOf(p.match) >= 0) {
                    streams.push({
                        hw: p.hw,
                        rate: p.rate,
                        hwChannels: p.hwChannels,
                        amRoute: p.amRoute,
                        label: p.label,
                        score: (lastWorkingHw && p.hw === lastWorkingHw) ? (p.score + 20) : p.score,
                    });
                }
            });
        } catch (e) {}
    }
    streams.sort((a, b) => b.score - a.score);
    const best = streams[0] || null;
    return {
        hasSmartxHelper: hasPython && fs.existsSync(o.smartxHelper || SMARTX_HELPER),
        hasAlsaCapture: !!(hasPython && best),
        recommendedDevice: best ? best.hw : '',
        recommendedLabel: best ? best.label : 'Mô phỏng (Mac)',
        captureStreams: streams,
    };
}

function analyzeWavBuffer(wavBuf, opts) {
    const swap = !!(opts && opts.swapChannels);
    const fallback = {
        valid: false,
        channels: 1,
        sampleRate: 16000,
        durationMs: 0,
        leftDb: -65,
        rightDb: -65,
        speakerZone: 'driver',
        confidence: 0,
    };
    if (!Buffer.isBuffer(wavBuf) || wavBuf.length < 44) return fallback;
    if (wavBuf.toString('ascii', 0, 4) !== 'RIFF' || wavBuf.toString('ascii', 8, 12) !== 'WAVE') return fallback;

    let offset = 12;
    let channels = 1, sampleRate = 16000, bitsPerSample = 16;
    let dataOffset = -1, dataLen = 0;

    while (offset + 8 <= wavBuf.length) {
        const chunkId = wavBuf.toString('ascii', offset, offset + 4);
        const chunkSize = wavBuf.readUInt32LE(offset + 4);
        if (chunkId === 'fmt ' && chunkSize >= 16 && offset + 24 <= wavBuf.length) {
            channels = wavBuf.readUInt16LE(offset + 10);
            sampleRate = wavBuf.readUInt32LE(offset + 12);
            bitsPerSample = wavBuf.readUInt16LE(offset + 22);
        } else if (chunkId === 'data') {
            dataOffset = offset + 8;
            dataLen = Math.min(chunkSize, wavBuf.length - dataOffset);
            break;
        }
        offset += 8 + chunkSize + (chunkSize % 2);
    }
    if (dataOffset < 0 || dataLen <= 0 || bitsPerSample !== 16 || channels < 1) return fallback;

    const frameSize = channels * 2;
    const totalFrames = Math.floor(dataLen / frameSize);
    if (totalFrames < 10) return fallback;

    let sumSqL = 0, sumSqR = 0;
    for (let i = 0; i < totalFrames; i++) {
        const pos = dataOffset + i * frameSize;
        const sL = wavBuf.readInt16LE(pos) / 32768;
        const sR = channels >= 2 ? (wavBuf.readInt16LE(pos + 2) / 32768) : sL;
        sumSqL += sL * sL;
        sumSqR += sR * sR;
    }

    const rmsL = Math.sqrt(sumSqL / totalFrames);
    const rmsR = Math.sqrt(sumSqR / totalFrames);
    const toDb = (r) => (r > 1e-5 ? +(20 * Math.log10(r)).toFixed(1) : -65.0);

    const rawLeftDb = toDb(rmsL);
    const rawRightDb = toDb(rmsR);
    const driverDb = swap ? rawRightDb : rawLeftDb;
    const passDb = swap ? rawLeftDb : rawRightDb;
    const diffDb = driverDb - passDb;

    let speakerZone = 'driver';
    let confidence = 0.5;
    if (channels >= 2 && Math.max(driverDb, passDb) > -50) {
        if (diffDb >= 2.5) {
            speakerZone = 'driver';
            confidence = Math.min(0.99, +(0.55 + diffDb / 16).toFixed(2));
        } else if (diffDb <= -2.5) {
            speakerZone = 'passenger';
            confidence = Math.min(0.99, +(0.55 + Math.abs(diffDb) / 16).toFixed(2));
        }
    }

    return {
        valid: true,
        channels,
        sampleRate,
        durationMs: Math.round((totalFrames / sampleRate) * 1000),
        leftDb: driverDb,
        rightDb: passDb,
        speakerZone,
        confidence,
    };
}

function buildStereoWav(leftSamples, rightSamples, sampleRate) {
    const sr = sampleRate || 16000;
    const frames = Math.min(leftSamples.length, rightSamples.length);
    const dataLen = frames * 4;
    const buf = Buffer.alloc(44 + dataLen);
    buf.write('RIFF', 0);
    buf.writeUInt32LE(36 + dataLen, 4);
    buf.write('WAVE', 8);
    buf.write('fmt ', 12);
    buf.writeUInt32LE(16, 16);
    buf.writeUInt16LE(1, 20);
    buf.writeUInt16LE(2, 22);
    buf.writeUInt32LE(sr, 24);
    buf.writeUInt32LE(sr * 4, 28);
    buf.writeUInt16LE(4, 32);
    buf.writeUInt16LE(16, 34);
    buf.write('data', 36);
    buf.writeUInt32LE(dataLen, 40);
    for (let i = 0; i < frames; i++) {
        const l = Math.max(-1, Math.min(1, leftSamples[i]));
        const r = Math.max(-1, Math.min(1, rightSamples[i]));
        buf.writeInt16LE(Math.round(l * 32767), 44 + i * 4);
        buf.writeInt16LE(Math.round(r * 32767), 44 + i * 4 + 2);
    }
    return buf;
}

function recordOnce(pyBin, helperPath, cand, dur, outFile) {
    return new Promise((resolve, reject) => {
        unlinkSafe(outFile);
        const args = [
            helperPath,
            cand.hw,
            outFile,
            String(dur),
            String(cand.rate || 24000),
            String(cand.hwChannels || 8),
        ];
        cp.execFile(pyBin, args, { timeout: (dur + 3) * 1000 }, (err, stdout, stderr) => {
            if (err) {
                return reject(new Error(String(stderr || stdout || err.message).trim()));
            }
            if (!fs.existsSync(outFile)) {
                return reject(new Error('missing wav output'));
            }
            const wavBuffer = fs.readFileSync(outFile);
            if (wavBuffer.length < 400) {
                return reject(new Error('empty wav (' + wavBuffer.length + 'B)'));
            }
            resolve(wavBuffer);
        });
    });
}

async function captureCeilingMic(opts) {
    const o = Object.assign({
        maxDurationSec: 4.2,
        outFile: '/run/bmw-voice/capture.wav',
        swapChannels: false,
        connectAmRoute: null,
        disconnectAmRoute: null,
        isCallActive: null,
        mguPython: MGU_PYTHON,
        smartxHelper: SMARTX_HELPER,
        smartxDir: '/run/smartx',
        onLog: () => {},
    }, opts || {});

    if (o.isCallActive && o.isCallActive()) {
        throw new Error('Đang có cuộc gọi điện thoại / CarPlay');
    }

    const probe = probeSmartxStack(o);
    if (!probe.hasSmartxHelper || !probe.captureStreams.length) {
        throw new Error('Không tìm thấy đường Mic trần SmartXbar trên đầu xe');
    }

    let lastErr = null;
    for (let i = 0; i < probe.captureStreams.length; i++) {
        const cand = probe.captureStreams[i];
        let routeTok = null;
        if (cand.amRoute && typeof o.connectAmRoute === 'function') {
            try { routeTok = await o.connectAmRoute(cand.amRoute); } catch (e) {}
        }
        try {
            const wavBuffer = await recordOnce(o.mguPython, o.smartxHelper, cand, o.maxDurationSec, o.outFile);
            const analysis = analyzeWavBuffer(wavBuffer, { swapChannels: o.swapChannels });
            if (Math.max(analysis.leftDb, analysis.rightDb) <= -64.5) {
                throw new Error('Tín hiệu Mic 0 dB trên ' + cand.hw);
            }
            lastWorkingHw = cand.hw;
            if (routeTok && routeTok.created && routeTok.connId > 0 && typeof o.disconnectAmRoute === 'function') {
                o.disconnectAmRoute(routeTok.connId).catch(() => {});
            }
            return { wavBuffer, analysis, deviceUsed: cand.hw };
        } catch (e) {
            lastErr = e;
            o.onLog('mic failover (' + cand.hw + '): ' + e.message);
            if (routeTok && routeTok.created && routeTok.connId > 0 && typeof o.disconnectAmRoute === 'function') {
                try { await o.disconnectAmRoute(routeTok.connId); } catch (x) {}
            }
        }
    }
    throw lastErr || new Error('Không thu được tín hiệu từ cặp Mic trần');
}

class MicStreamEngine {
    constructor(opts) {
        const isCustomPy = !!(opts && opts.mguPython && opts.mguPython !== MGU_PYTHON);
        this.opts = Object.assign({
            mguPython: MGU_PYTHON,
            smartxHelper: SMARTX_HELPER,
            smartxDir: '/run/smartx',
            workDir: '/run/bmw-voice',
            offlineDir: DEFAULT_OFFLINE_DIR,
            swapChannels: false,
            minUptimeSec: isCustomPy ? 0 : 45,
            connectAmRoute: null,
            disconnectAmRoute: null,
            shouldPause: () => false,
            onSpeechHint: null,
            onMicLevel: null,
            onLocalWake: null,
            onWakeUtterance: null,
            onStatusChange: null,
            onLog: () => {},
        }, opts || {});

        this.running = false;
        this.tickInFlight = false;
        this.child = null;
        this.routeToken = null;
        this.activeDevice = '';
        this.kwsMode = 'cloud_vad';
        this.hasRefChannel = false;
        this.speakerPlaying = false;
        this.lastRefDb = -90.0;
        this.status = 'off'; // off | paused | armed
        this.profileIdx = 0;
        this.consecutiveFails = 0;
        this.cooldownUntil = 0;
        this.watchTimer = null;
        this.stdoutBuf = '';

        this.reqSeq = 1;
        this.pendingPtt = null;
    }

    setSwapChannels(flag) {
        this.opts.swapChannels = !!flag;
    }

    setStatus(next) {
        if (this.status === next) return;
        this.status = next;
        if (this.opts.onStatusChange) this.opts.onStatusChange(next, this.activeDevice);
    }

    holdCooldown(ms) {
        this.cooldownUntil = Math.max(this.cooldownUntil, Date.now() + (ms || 900));
        this._sendCmd({ cmd: 'cooldown', ms: ms || 900 });
    }

    _sendCmd(obj) {
        if (!this.child || !this.child.stdin || this.child.stdin.destroyed) return false;
        try {
            return this.child.stdin.write(JSON.stringify(obj) + '\n');
        } catch (e) {
            return false;
        }
    }

    start() {
        if (this.running) return;
        this.running = true;
        this.watchTimer = setInterval(() => {
            this.tick().catch((e) => this.opts.onLog('mic stream tick warn: ' + e.message));
        }, 1200);
        if (this.watchTimer.unref) this.watchTimer.unref();
        this.tick().catch(() => {});
    }

    async stop() {
        this.running = false;
        if (this.watchTimer) {
            clearInterval(this.watchTimer);
            this.watchTimer = null;
        }
        await this.killWorker('stopped');
        this.setStatus('off');
    }

    async killWorker(reason) {
        if (this.pendingPtt) {
            const p = this.pendingPtt;
            this.pendingPtt = null;
            clearTimeout(p.timer);
            p.reject(new Error(reason || 'stream closed'));
        }
        const c = this.child;
        this.child = null;
        this.stdoutBuf = '';
        if (c) {
            await new Promise((resolve) => {
                let done = false;
                const fin = () => { if (!done) { done = true; resolve(); } };
                c.once('close', fin);
                try {
                    if (c.stdin && !c.stdin.destroyed) c.stdin.end(JSON.stringify({ cmd: 'stop' }) + '\n');
                    c.kill('SIGTERM');
                } catch (e) { fin(); }
                setTimeout(() => { try { c.kill('SIGKILL'); } catch (e) {} fin(); }, 350);
            });
        }
        const rt = this.routeToken;
        this.routeToken = null;
        if (rt && rt.created && rt.connId > 0 && typeof this.opts.disconnectAmRoute === 'function') {
            try { await this.opts.disconnectAmRoute(rt.connId); } catch (e) {}
        }
    }

    async tick() {
        if (!this.running || this.tickInFlight) return;
        this.tickInFlight = true;
        try {
            const bootSettling = this.opts.minUptimeSec > 0 && os.uptime() < this.opts.minUptimeSec;
            const paused = bootSettling || !!this.opts.shouldPause();
            if (paused) {
                if (this.child) await this.killWorker('paused');
                this.setStatus('paused');
                return;
            }
            if (this.child) return;
            if (Date.now() < this.cooldownUntil) {
                this.setStatus('paused');
                return;
            }

            const probe = probeSmartxStack(this.opts);
            if (!probe.hasSmartxHelper || !probe.captureStreams.length) {
                this.setStatus('paused');
                return;
            }

            const cand = probe.captureStreams[this.profileIdx % probe.captureStreams.length];
            if (cand.amRoute && typeof this.opts.connectAmRoute === 'function') {
                try { this.routeToken = await this.opts.connectAmRoute(cand.amRoute); } catch (e) { this.routeToken = null; }
            }
            if (!this.running || this.opts.shouldPause()) {
                await this.killWorker('paused');
                this.setStatus('paused');
                return;
            }

            this.stdoutBuf = '';
            const spawnEnv = Object.assign({}, process.env);
            if (this.opts.offlineDir) {
                const libDir = path.join(this.opts.offlineDir, 'lib');
                if (fs.existsSync(libDir)) {
                    spawnEnv.LD_LIBRARY_PATH = libDir + (spawnEnv.LD_LIBRARY_PATH ? (':' + spawnEnv.LD_LIBRARY_PATH) : '');
                }
                spawnEnv.BV_OFFLINE_DIR = String(this.opts.offlineDir);
            }
            const child = cp.spawn(this.opts.mguPython, [
                this.opts.smartxHelper,
                '--stream-daemon',
                String(cand.hw),
                String(this.opts.workDir),
                String(cand.rate || 24000),
                String(cand.hwChannels || 8),
                String(this.opts.offlineDir || ''),
            ], { stdio: ['pipe', 'pipe', 'ignore'], env: spawnEnv });

            this.child = child;
            this.activeDevice = cand.hw;

            child.stdout.on('data', (chunk) => {
                this.stdoutBuf += chunk.toString('utf8');
                let idx;
                while ((idx = this.stdoutBuf.indexOf('\n')) >= 0) {
                    const line = this.stdoutBuf.slice(0, idx).trim();
                    this.stdoutBuf = this.stdoutBuf.slice(idx + 1);
                    if (!line) continue;
                    try {
                        this._handleEvent(JSON.parse(line), cand);
                    } catch (e) {}
                }
            });

            child.on('close', (code) => {
                if (this.child === child) {
                    this.child = null;
                    if (this.pendingPtt) {
                        const p = this.pendingPtt;
                        this.pendingPtt = null;
                        clearTimeout(p.timer);
                        p.reject(new Error('mic stream exited (' + code + ')'));
                    }
                    if (code !== 0 && this.running && !this.opts.shouldPause()) {
                        this.profileIdx++;
                        this.consecutiveFails++;
                        const backoff = this.consecutiveFails >= 3 ? 20000 : (3000 * this.consecutiveFails);
                        this.cooldownUntil = Date.now() + backoff;
                        this.setStatus('paused');
                    }
                }
            });

            child.on('error', () => {
                if (this.child === child) {
                    this.child = null;
                    this.profileIdx++;
                    this.consecutiveFails++;
                    this.cooldownUntil = Date.now() + 8000;
                    this.setStatus('paused');
                }
            });
        } finally {
            this.tickInFlight = false;
        }
    }

    _handleEvent(ev, cand) {
        if (!ev || !ev.event) return;
        if (ev.event === 'ready') {
            lastWorkingHw = cand.hw;
            this.consecutiveFails = 0;
            this.kwsMode = ev.kwsMode || 'cloud_vad';
            this.hasRefChannel = !!ev.hasRefChannel;
            this.speakerPlaying = false;
            this.setStatus('armed');
            this.opts.onLog('Hey BMW stream armed on ' + cand.hw + ' (kws=' + this.kwsMode + (ev.kwsError ? (', err=' + ev.kwsError) : '') + ')');
        } else if (ev.event === 'speaker_state') {
            this.speakerPlaying = !!ev.playing;
            if (typeof ev.refDb === 'number') this.lastRefDb = ev.refDb;
        } else if (ev.event === 'local_wake') {
            if (this.pendingPtt) return;
            const rawL = typeof ev.leftDb === 'number' ? ev.leftDb : -35;
            const rawR = typeof ev.rightDb === 'number' ? ev.rightDb : -35;
            const driverDb = this.opts.swapChannels ? rawR : rawL;
            const passDb = this.opts.swapChannels ? rawL : rawR;
            const speakerZone = (passDb - driverDb >= 2.5 && passDb > -50) ? 'passenger' : 'driver';
            if (this.opts.onLocalWake) {
                this.opts.onLocalWake({
                    keyword: ev.keyword || 'HEY_BMW',
                    speakerZone,
                    leftDb: driverDb,
                    rightDb: passDb,
                    deviceUsed: ev.device || cand.hw,
                });
            }
        } else if (ev.event === 'speech_hint') {
            if (this.opts.onSpeechHint) this.opts.onSpeechHint();
        } else if (ev.event === 'mic_level') {
            if (this.opts.onMicLevel) this.opts.onMicLevel(ev.db);
        } else if (ev.event === 'ptt_clip' && this.pendingPtt) {
            const p = this.pendingPtt;
            this.pendingPtt = null;
            clearTimeout(p.timer);
            try {
                const wavBuffer = fs.readFileSync(ev.file);
                unlinkSafe(ev.file);
                const analysis = analyzeWavBuffer(wavBuffer, { swapChannels: this.opts.swapChannels });
                    p.resolve({
                        wavBuffer,
                        analysis,
                        voicedChunks: typeof ev.voicedChunks === 'number' ? ev.voicedChunks : 4,
                        snrDb: typeof ev.snrDb === 'number' ? ev.snrDb : 8,
                        deviceUsed: ev.device || cand.hw,
                        instantStream: true,
                    });
            } catch (e) {
                p.reject(e);
            }
        } else if (ev.event === 'wake_clip' && ev.file) {
            if (this.pendingPtt) {
                unlinkSafe(ev.file);
                return;
            }
            try {
                const wavBuffer = fs.readFileSync(ev.file);
                unlinkSafe(ev.file);
                const analysis = analyzeWavBuffer(wavBuffer, { swapChannels: this.opts.swapChannels });
                if (this.opts.onWakeUtterance) {
                    this.opts.onWakeUtterance({
                        wavBuffer,
                        analysis,
                        durationMs: ev.durationMs || analysis.durationMs,
                        snrDb: ev.snrDb || 0,
                        deviceUsed: ev.device || cand.hw,
                    });
                }
            } catch (e) {}
        } else if (ev.event === 'error') {
            this.opts.onLog('mic stream switch (' + (ev.error || 'err') + ')');
        }
    }

    /**
     * Capture PTT / 2-step follow-up in `<1ms` via the already-open SmartX stream if armed,
     * otherwise cleanly fall back to one-shot `captureCeilingMic`.
     */
    async capturePtt(opts) {
        const o = Object.assign({
            maxDurationSec: 4.2,
            noPreroll: false,
            outFile: path.join(this.opts.workDir, 'capture.wav'),
        }, opts || {});

        if (this.child && this.status === 'armed' && !this.pendingPtt) {
            const reqId = ++this.reqSeq;
            try {
                return await new Promise((resolve, reject) => {
                    const timer = setTimeout(() => {
                        if (this.pendingPtt && this.pendingPtt.reqId === reqId) {
                            this.pendingPtt = null;
                            reject(new Error('ptt stream timeout'));
                        }
                    }, Math.round((o.maxDurationSec + 2.2) * 1000));
                    this.pendingPtt = { reqId, resolve, reject, timer };
                    const ok = this._sendCmd({
                        cmd: 'ptt',
                        reqId,
                        maxSec: o.maxDurationSec,
                        noPreroll: !!o.noPreroll,
                    });
                    if (!ok) {
                        clearTimeout(timer);
                        this.pendingPtt = null;
                        reject(new Error('ptt stdin write failed'));
                    }
                });
            } catch (e) {
                this.opts.onLog('instant stream fallback: ' + e.message);
            }
        }

        return captureCeilingMic(Object.assign({
            maxDurationSec: o.maxDurationSec,
            outFile: o.outFile,
            swapChannels: this.opts.swapChannels,
            connectAmRoute: this.opts.connectAmRoute,
            disconnectAmRoute: this.opts.disconnectAmRoute,
            mguPython: this.opts.mguPython,
            smartxHelper: this.opts.smartxHelper,
            smartxDir: this.opts.smartxDir,
            onLog: this.opts.onLog,
        }, o));
    }
}

module.exports = {
    SMARTX_PROFILES,
    probeSmartxStack,
    analyzeWavBuffer,
    buildStereoWav,
    captureCeilingMic,
    MicStreamEngine,
};
