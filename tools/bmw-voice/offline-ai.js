'use strict';
/**
 * offline-ai.js - 100% On-Device Offline Vietnamese AI Engine (`bmw-voice`).
 *
 * Uses `sherpa-onnx v1.12.40` (x86_64 Linux, GLIBC 2.17) installed under `/var/opt/bmw-voice/offline`
 * (overrideable via `BV_OFFLINE_DIR`):
 *   1. Offline KWS (`libsherpa-onnx-c-api.so` + `kws/`): streaming `"Hey BMW"` inside `alsa-smartx.py` (<50ms).
 *   2. Offline Vietnamese STT (`bin/sherpa-onnx-offline` + `stt-vi/`): Zipformer 30M int8 (6000h Vietnamese).
 *   3. Offline Vietnamese TTS (`bin/sherpa-onnx-offline-tts` + `tts-vi/`): Piper VITS `vi_VN-vais1000-medium` + espeak-ng.
 *
 * All heavy STT/TTS processes run on-demand and exit immediately, keeping MGU idle RAM near zero.
 *
 * Node 8 (ES2017) compatible.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');

const MGU_PYTHON = '/var/opt/mgu-python/current/bin/python3';
const WORKER_SCRIPT = path.join(__dirname, 'offline-worker.py');
const DEFAULT_OFFLINE_DIR = process.env.BV_OFFLINE_DIR || '/var/opt/bmw-voice/offline';

function unlinkSafe(f) {
    try { if (f && fs.existsSync(f)) fs.unlinkSync(f); } catch (e) {}
}

function resolveOfflinePaths(baseDir) {
    const dir = baseDir || DEFAULT_OFFLINE_DIR;
    const libDir = path.join(dir, 'lib');
    const binDir = path.join(dir, 'bin');
    const kwsDir = path.join(dir, 'kws');
    const sttDir = path.join(dir, 'stt-vi');
    const ttsDir = path.join(dir, 'tts-vi');

    const pickOnnx = (d, prefix, preferInt8) => {
        try {
            const list = fs.readdirSync(d).filter((f) => f.indexOf(prefix) === 0 && /\.onnx$/.test(f));
            if (!list.length) return '';
            list.sort((a, b) => {
                const ai = a.indexOf('.int8.') >= 0;
                const bi = b.indexOf('.int8.') >= 0;
                if (ai !== bi) return (ai === !!preferInt8) ? -1 : 1;
                return a.length - b.length;
            });
            return path.join(d, list[0]);
        } catch (e) { return ''; }
    };

    return {
        dir,
        libDir,
        binDir,
        kwsDir,
        sttDir,
        ttsDir,
        cApiLib: path.join(libDir, 'libsherpa-onnx-c-api.so'),
        ortLib: path.join(lib_dir_safe(libDir), 'libonnxruntime.so'),
        sttBin: path.join(binDir, 'sherpa-onnx-offline'),
        ttsBin: path.join(binDir, 'sherpa-onnx-offline-tts'),
        kwsEncoder: pickOnnx(kwsDir, 'encoder', true),
        kwsDecoder: pickOnnx(kwsDir, 'decoder', false),
        kwsJoiner: pickOnnx(kwsDir, 'joiner', true),
        kwsTokens: path.join(kwsDir, 'tokens.txt'),
        kwsKeywords: path.join(kwsDir, 'keywords.txt'),
        sttEncoder: path.join(sttDir, 'encoder.int8.onnx'),
        sttDecoder: path.join(sttDir, 'decoder.onnx'),
        sttJoiner: path.join(sttDir, 'joiner.int8.onnx'),
        sttTokens: path.join(sttDir, 'tokens.txt'),
        ttsModel: path.join(ttsDir, 'vi_VN-vais1000-medium.onnx'),
        ttsTokens: path.join(ttsDir, 'tokens.txt'),
        ttsDataDir: path.join(ttsDir, 'espeak-ng-data'),
    };
}

function lib_dir_safe(d) { return d; }

function allExist(list) {
    for (let i = 0; i < list.length; i++) {
        if (!list[i] || !fs.existsSync(list[i])) return false;
    }
    return true;
}

function probeOfflineAi(baseDir) {
    const p = resolveOfflinePaths(baseDir);
    const hasLibs = allExist([p.ortLib, p.cApiLib]);
    const hasKws = hasLibs && allExist([p.kwsEncoder, p.kwsDecoder, p.kwsJoiner, p.kwsTokens, p.kwsKeywords]);
    const hasStt = hasLibs && allExist([p.sttEncoder, p.sttDecoder, p.sttJoiner, p.sttTokens]);
    const hasTts = hasLibs && allExist([p.ttsModel, p.ttsTokens, path.join(p.ttsDataDir, 'phontab')]);
    return {
        dir: p.dir,
        hasKws,
        hasStt,
        hasTts,
        hasWorker: fs.existsSync(WORKER_SCRIPT),
        ready: hasKws || hasStt || hasTts,
        paths: p,
    };
}

class OfflineWorkerClient {
    constructor(opts) {
        const o = opts || {};
        this.offlineDir = o.offlineDir || DEFAULT_OFFLINE_DIR;
        this.workDir = o.workDir || os.tmpdir();
        this.mguPython = o.mguPython || MGU_PYTHON;
        this.workerScript = o.workerScript || WORKER_SCRIPT;
        this.onLog = o.onLog || (() => {});
        this.onReadyChange = o.onReadyChange || null;

        this.running = false;
        this.child = null;
        this.sttReady = false;
        this.ttsReady = false;
        this.stdoutBuf = '';
        this.reqSeq = 1;
        this.pending = Object.create(null);
        this.restartTimer = null;
        this.bootTimer = null;
    }

    start(delayMs) {
        if (this.running) return;
        const probe = probeOfflineAi(this.offlineDir);
        if ((!probe.hasStt && !probe.hasTts) || !fs.existsSync(this.mguPython) || !fs.existsSync(this.workerScript)) {
            return;
        }
        this.running = true;
        const delay = Number(delayMs) > 0 ? Number(delayMs) : 0;
        if (delay > 0) {
            this.bootTimer = setTimeout(() => {
                this.bootTimer = null;
                this._spawn();
            }, delay);
            if (this.bootTimer.unref) this.bootTimer.unref();
        } else {
            this._spawn();
        }
    }

    _spawn() {
        if (!this.running || this.child) return;
        const p = resolveOfflinePaths(this.offlineDir);
        const env = buildLibEnv(p.libDir);
        this.stdoutBuf = '';
        this.sttReady = false;
        this.ttsReady = false;
        const child = cp.spawn(this.mguPython, [this.workerScript, this.offlineDir], {
            stdio: ['pipe', 'pipe', 'pipe'],
            env,
        });
        this.child = child;
        if (child.stderr) {
            let errBuf = '';
            child.stderr.on('data', (chunk) => {
                errBuf += chunk.toString('utf8');
                let idx;
                while ((idx = errBuf.indexOf('\n')) >= 0) {
                    const line = errBuf.slice(0, idx).trim();
                    errBuf = errBuf.slice(idx + 1);
                    if (line) this.onLog('[offline-worker] ' + line.slice(0, 180));
                }
            });
        }
        child.stdout.on('data', (chunk) => {
            this.stdoutBuf += chunk.toString('utf8');
            let idx;
            while ((idx = this.stdoutBuf.indexOf('\n')) >= 0) {
                const line = this.stdoutBuf.slice(0, idx).trim();
                this.stdoutBuf = this.stdoutBuf.slice(idx + 1);
                if (!line) continue;
                try { this._onEvent(JSON.parse(line)); } catch (e) {}
            }
        });
        child.on('close', (code) => {
            if (this.child === child) {
                this.child = null;
                this.sttReady = false;
                this.ttsReady = false;
                this._rejectAll('worker exited (' + code + ')');
                if (this.onReadyChange) this.onReadyChange({ sttReady: false, ttsReady: false });
                if (this.running && !this.restartTimer) {
                    this.restartTimer = setTimeout(() => {
                        this.restartTimer = null;
                        this._spawn();
                    }, 6000);
                    if (this.restartTimer.unref) this.restartTimer.unref();
                }
            }
        });
        child.on('error', () => {
            if (this.child === child) {
                this.child = null;
                this.sttReady = false;
                this.ttsReady = false;
            }
        });
    }

    _rejectAll(reason) {
        Object.keys(this.pending).forEach((k) => {
            const p = this.pending[k];
            delete this.pending[k];
            clearTimeout(p.timer);
            p.reject(new Error(reason));
        });
    }

    _onEvent(ev) {
        if (!ev || !ev.event) return;
        if (ev.event === 'stt_ready') {
            this.sttReady = true;
            this.onLog('Offline Vietnamese STT warm (' + (ev.initMs || 0) + 'ms)');
            if (this.onReadyChange) this.onReadyChange({ sttReady: this.sttReady, ttsReady: this.ttsReady });
        } else if (ev.event === 'tts_ready') {
            this.ttsReady = true;
            this.onLog('Offline Vietnamese TTS warm (' + (ev.initMs || 0) + 'ms)');
            if (this.onReadyChange) this.onReadyChange({ sttReady: this.sttReady, ttsReady: this.ttsReady });
        } else if (ev.event === 'stt_result' || ev.event === 'tts_result') {
            const p = this.pending[ev.reqId];
            if (p) {
                delete this.pending[ev.reqId];
                clearTimeout(p.timer);
                p.resolve(ev);
            }
        }
    }

    _sendReq(cmdObj, timeoutMs) {
        if (!this.child || !this.child.stdin || this.child.stdin.destroyed) {
            return Promise.reject(new Error('offline worker not running'));
        }
        const reqId = ++this.reqSeq;
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                if (this.pending[reqId]) {
                    delete this.pending[reqId];
                    reject(new Error('offline worker timeout'));
                }
            }, timeoutMs || 15000);
            this.pending[reqId] = { resolve, reject, timer };
            try {
                this.child.stdin.write(JSON.stringify(Object.assign({}, cmdObj, { reqId })) + '\n');
            } catch (e) {
                clearTimeout(timer);
                delete this.pending[reqId];
                reject(e);
            }
        });
    }

    async transcribe(opts) {
        const o = opts || {};
        if (!this.sttReady) return null;
        let wavBuf = o.wavBuffer;
        if (!wavBuf && o.wavBase64) wavBuf = Buffer.from(o.wavBase64, 'base64');
        else if (!wavBuf && o.wavPath && fs.existsSync(o.wavPath)) wavBuf = fs.readFileSync(o.wavPath);
        if (!Buffer.isBuffer(wavBuf) || wavBuf.length < 100) return null;

        const tmpWav = path.join(this.workDir, 'stt_in_' + process.pid + '_' + Date.now() + '.wav');
        try {
            fs.writeFileSync(tmpWav, wavBuf, { mode: 0o644 });
            const res = await this._sendReq({ cmd: 'stt', wavPath: tmpWav }, o.timeoutMs || 14000);
            if (!res || !res.ok) return null;
            const transcript = formatOfflineTranscriptVi(res.text || '');
            return {
                ok: !!transcript,
                transcript,
                elapsedMs: res.elapsedMs || 0,
                engine: 'sherpa_vi_warm',
            };
        } finally {
            unlinkSafe(tmpWav);
        }
    }

    async synthesize(opts) {
        const o = opts || {};
        const text = String(o.text || '').trim();
        if (!this.ttsReady || !text) return null;
        const outWav = path.join(this.workDir, 'tts_out_' + process.pid + '_' + Date.now() + '.wav');
        try {
            const res = await this._sendReq({
                cmd: 'tts',
                text,
                outPath: outWav,
                speed: Number(o.speed) > 0 ? Number(o.speed) : 1.20,
            }, o.timeoutMs || 22000);
            if (!res || !res.ok || !fs.existsSync(outWav)) return null;
            const wavBuffer = fs.readFileSync(outWav);
            return {
                wavBuffer,
                durationMs: res.durationMs || 2000,
                sampleRate: res.sampleRate || 22050,
                elapsedMs: res.elapsedMs || 0,
                model: 'piper-vi-warm',
                spoken: text,
            };
        } finally {
            unlinkSafe(outWav);
        }
    }

    async stop() {
        this.running = false;
        if (this.bootTimer) { clearTimeout(this.bootTimer); this.bootTimer = null; }
        if (this.restartTimer) { clearTimeout(this.restartTimer); this.restartTimer = null; }
        this._rejectAll('stopped');
        const c = this.child;
        this.child = null;
        this.sttReady = false;
        this.ttsReady = false;
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
    }
}

function readWavHeaderInfo(wavBuf) {
    const info = { valid: false, channels: 1, sampleRate: 16000, bitsPerSample: 16, byteRate: 32000, dataOffset: -1, dataLen: 0, durationMs: 0 };
    if (!Buffer.isBuffer(wavBuf) || wavBuf.length < 44) return info;
    if (wavBuf.toString('ascii', 0, 4) !== 'RIFF' || wavBuf.toString('ascii', 8, 12) !== 'WAVE') return info;
    let offset = 12;
    while (offset + 8 <= wavBuf.length) {
        const chunkId = wavBuf.toString('ascii', offset, offset + 4);
        const chunkSize = wavBuf.readUInt32LE(offset + 4);
        if (chunkId === 'fmt ' && chunkSize >= 16 && offset + 24 <= wavBuf.length) {
            info.channels = wavBuf.readUInt16LE(offset + 10);
            info.sampleRate = wavBuf.readUInt32LE(offset + 12);
            info.byteRate = wavBuf.readUInt32LE(offset + 16);
            info.bitsPerSample = wavBuf.readUInt16LE(offset + 22);
        } else if (chunkId === 'data') {
            info.dataOffset = offset + 8;
            info.dataLen = Math.min(chunkSize, wavBuf.length - info.dataOffset);
            break;
        }
        offset += 8 + chunkSize + (chunkSize % 2);
    }
    if (info.dataOffset >= 0 && info.dataLen > 0 && info.sampleRate > 0 && info.channels > 0) {
        info.valid = true;
        const br = info.byteRate || (info.sampleRate * info.channels * (info.bitsPerSample / 8));
        info.durationMs = br > 0 ? Math.round((info.dataLen / br) * 1000) : 0;
    }
    return info;
}

/**
 * Ensure a clean 16-bit mono WAV for sherpa-onnx-offline (which expects single-channel PCM).
 * For stereo ceiling mic captures (L=driver, R=passenger), selects the cleaner louder channel
 * when separated by >= 4 dB (preventing phase cancellation), otherwise blends (L+R)/2.
 */
function extractBestMonoWav(wavBuf) {
    const info = readWavHeaderInfo(wavBuf);
    if (!info.valid || info.bitsPerSample !== 16) return wavBuf;
    if (info.channels === 1) return wavBuf;

    const frameSize = info.channels * 2;
    const totalFrames = Math.floor(info.dataLen / frameSize);
    if (totalFrames < 10) return wavBuf;

    let sumL = 0, sumR = 0;
    for (let i = 0; i < totalFrames; i++) {
        const pos = info.dataOffset + i * frameSize;
        const sL = wavBuf.readInt16LE(pos);
        const sR = wavBuf.readInt16LE(pos + 2);
        sumL += sL * sL;
        sumR += sR * sR;
    }
    const rmsL = Math.sqrt(sumL / totalFrames);
    const rmsR = Math.sqrt(sumR / totalFrames);
    const ratioDb = (rmsL > 1 && rmsR > 1) ? (20 * Math.log10(rmsL / rmsR)) : (rmsL >= rmsR ? 12 : -12);
    const mode = ratioDb >= 4.0 ? 'L' : (ratioDb <= -4.0 ? 'R' : 'MIX');

    const dataLen = totalFrames * 2;
    const out = Buffer.alloc(44 + dataLen);
    out.write('RIFF', 0);
    out.writeUInt32LE(36 + dataLen, 4);
    out.write('WAVE', 8);
    out.write('fmt ', 12);
    out.writeUInt32LE(16, 16);
    out.writeUInt16LE(1, 20);
    out.writeUInt16LE(1, 22);
    out.writeUInt32LE(info.sampleRate, 24);
    out.writeUInt32LE(info.sampleRate * 2, 28);
    out.writeUInt16LE(2, 32);
    out.writeUInt16LE(16, 34);
    out.write('data', 36);
    out.writeUInt32LE(dataLen, 40);

    for (let i = 0; i < totalFrames; i++) {
        const pos = info.dataOffset + i * frameSize;
        let sample;
        if (mode === 'L') {
            sample = wavBuf.readInt16LE(pos);
        } else if (mode === 'R') {
            sample = wavBuf.readInt16LE(pos + 2);
        } else {
            sample = (wavBuf.readInt16LE(pos) + wavBuf.readInt16LE(pos + 2)) >> 1;
        }
        out.writeInt16LE(sample, 44 + i * 2);
    }
    return out;
}

/**
 * Normalize raw Zipformer Vietnamese transcript (which outputs UPPERCASE tokens like "ĐIỀU HÒA HAI MƯƠI HAI ĐỘ")
 * into clean Vietnamese sentence casing suitable for iDrive display & NLU matching.
 */
function formatOfflineTranscriptVi(raw) {
    let s = String(raw || '').replace(/\s+/g, ' ').trim();
    if (!s) return '';
    // Zipformer-vi-30M outputs ALL-CAPS; normalize cleanly to sentence case while preserving BMW / AC acronyms
    if (s === s.toUpperCase() && s !== s.toLowerCase()) {
        s = s.toLowerCase();
        s = s.charAt(0).toUpperCase() + s.slice(1);
    }
    s = s
        .replace(/\bbmw\b/gi, 'BMW')
        .replace(/\bmax\s+ac\b/gi, 'Max AC');
    return s;
}

/**
 * Parse stdout/stderr from `sherpa-onnx-offline`.
 * Format emitted by sherpa-onnx-offline:
 *   ----
 *   /path/to/audio.wav
 *   {"lang": "", "emotion": "", "event": "", "text": "ĐIỀU HÒA HAI MƯƠI HAI ĐỘ", "timestamps": [...]}
 *   ----
 */
function parseSherpaOfflineOutput(stdout, stderr) {
    const combined = String(stdout || '') + '\n' + String(stderr || '');
    const lines = combined.split(/\r?\n/);
    let found = '';

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();
        if (!line || line[0] !== '{' || line.indexOf('"text"') < 0) continue;
        try {
            const obj = JSON.parse(line);
            if (obj && typeof obj.text === 'string' && obj.text.trim()) {
                found = obj.text.trim();
            }
        } catch (e) {}
    }

    if (!found) {
        // Fallback for older plain-text output format between `----` separators
        let afterSep = false;
        for (let i = 0; i < lines.length; i++) {
            const line = lines[i].trim();
            if (line === '----') {
                afterSep = !afterSep;
                continue;
            }
            if (afterSep && line && !/\.wav$/i.test(line) && !/^(Elapsed|Real time|num threads|decoding|Started|Done)/i.test(line)) {
                found = line;
            }
        }
    }
    return formatOfflineTranscriptVi(found);
}

function buildLibEnv(libDir) {
    const env = Object.assign({}, process.env);
    env.LD_LIBRARY_PATH = libDir + (env.LD_LIBRARY_PATH ? (':' + env.LD_LIBRARY_PATH) : '');
    return env;
}

function transcribeOfflineVi(opts) {
    const o = opts || {};
    if (o.worker && o.worker.sttReady) {
        return o.worker.transcribe(o).then((r) => (r || { ok: false, transcript: '', elapsedMs: 0, engine: 'sherpa_vi_warm' }));
    }
    const probe = probeOfflineAi(o.offlineDir);
    if (!probe.hasStt || !allExist([probe.paths.sttBin])) {
        return Promise.resolve({ ok: false, unavailable: true, transcript: '', elapsedMs: 0, engine: 'offline_unavailable' });
    }

    const workDir = o.workDir || os.tmpdir();
    const tmpWav = path.join(workDir, 'stt_mono_' + process.pid + '_' + Date.now() + '.wav');
    let cleanupTmp = false;
    let targetWav = o.wavPath || '';

    try {
        let wavBuf = o.wavBuffer;
        if (!wavBuf && o.wavBase64) {
            wavBuf = Buffer.from(o.wavBase64, 'base64');
        } else if (!wavBuf && targetWav && fs.existsSync(targetWav)) {
            wavBuf = fs.readFileSync(targetWav);
        }
        if (!Buffer.isBuffer(wavBuf) || wavBuf.length < 100) {
            return Promise.resolve({ ok: false, transcript: '', elapsedMs: 0, engine: 'sherpa_vi_offline', error: 'empty wav' });
        }
        const monoBuf = extractBestMonoWav(wavBuf);
        fs.writeFileSync(tmpWav, monoBuf, { mode: 0o644 });
        targetWav = tmpWav;
        cleanupTmp = true;
    } catch (e) {
        return Promise.resolve({ ok: false, transcript: '', elapsedMs: 0, engine: 'sherpa_vi_offline', error: e.message });
    }

    const p = probe.paths;
    const threads = Math.max(1, Math.min(4, Number(o.numThreads) || 2));
    const args = [
        '--tokens=' + p.sttTokens,
        '--encoder=' + p.sttEncoder,
        '--decoder=' + p.sttDecoder,
        '--joiner=' + p.sttJoiner,
        '--model-type=transducer',
        '--decoding-method=greedy_search',
        '--num-threads=' + threads,
        targetWav,
    ];

    const t0 = Date.now();
    return new Promise((resolve) => {
        cp.execFile(p.sttBin, args, {
            env: buildLibEnv(p.libDir),
            timeout: Number(o.timeoutMs) || 12000,
            maxBuffer: 2 * 1024 * 1024,
        }, (err, stdout, stderr) => {
            if (cleanupTmp) unlinkSafe(tmpWav);
            const elapsedMs = Date.now() - t0;
            if (err) {
                return resolve({
                    ok: false,
                    transcript: '',
                    elapsedMs,
                    engine: 'sherpa_vi_offline',
                    error: String(stderr || err.message || '').trim().slice(0, 200),
                });
            }
            const transcript = parseSherpaOfflineOutput(stdout, stderr);
            resolve({
                ok: !!transcript,
                transcript,
                elapsedMs,
                engine: 'sherpa_vi_offline',
            });
        });
    });
}

function synthesizeOfflineViTts(opts) {
    const o = opts || {};
    const text = String(o.text || '').trim();
    if (!text) return Promise.resolve(null);
    if (o.worker && o.worker.ttsReady) {
        return o.worker.synthesize(o);
    }

    const probe = probeOfflineAi(o.offlineDir);
    if (!probe.hasTts || !allExist([probe.paths.ttsBin])) return Promise.resolve(null);

    const workDir = o.workDir || os.tmpdir();
    const outPath = o.outWavPath || path.join(workDir, 'tts_vi_' + process.pid + '_' + Date.now() + '.wav');
    const keepOut = !!o.outWavPath;
    unlinkSafe(outPath);

    const p = probe.paths;
    const threads = Math.max(1, Math.min(4, Number(o.numThreads) || 2));
    const speed = Number(o.speed) > 0 ? Number(o.speed) : 1.04;
    const args = [
        '--vits-model=' + p.ttsModel,
        '--vits-tokens=' + p.ttsTokens,
        '--vits-data-dir=' + p.ttsDataDir,
        '--num-threads=' + threads,
        '--speed=' + speed,
        '--output-filename=' + outPath,
        text,
    ];

    const t0 = Date.now();
    return new Promise((resolve) => {
        cp.execFile(p.ttsBin, args, {
            env: buildLibEnv(p.libDir),
            timeout: Number(o.timeoutMs) || 10000,
            maxBuffer: 1024 * 1024,
        }, (err) => {
            const elapsedMs = Date.now() - t0;
            if (err || !fs.existsSync(outPath)) {
                unlinkSafe(outPath);
                return resolve(null);
            }
            try {
                const wavBuffer = fs.readFileSync(outPath);
                if (!keepOut) unlinkSafe(outPath);
                const info = readWavHeaderInfo(wavBuffer);
                if (!info.valid || wavBuffer.length < 400) return resolve(null);
                resolve({
                    wavBuffer,
                    durationMs: info.durationMs || 2000,
                    sampleRate: info.sampleRate || 22050,
                    elapsedMs,
                    model: 'piper-vi-offline',
                    spoken: text,
                });
            } catch (e) {
                if (!keepOut) unlinkSafe(outPath);
                resolve(null);
            }
        });
    });
}

module.exports = {
    DEFAULT_OFFLINE_DIR,
    resolveOfflinePaths,
    probeOfflineAi,
    readWavHeaderInfo,
    extractBestMonoWav,
    formatOfflineTranscriptVi,
    parseSherpaOfflineOutput,
    transcribeOfflineVi,
    synthesizeOfflineViTts,
    OfflineWorkerClient,
};
