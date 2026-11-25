'use strict';
/**
 * mic-capture.js - On-demand BMW MGU SmartXbar Ceiling Microphone Capture & Stereo Zone Analyzer (`bmw-voice`).
 *
 * Strictly on-demand (triggered ONLY by Steering Wheel PTT or Screen Mic tap):
 *   - Uses shared virtual `smartx:SpeechSink_*` / `VoiceNotesSink` pipes ONLY (zero `avb:` or `hw:` contention).
 *   - Never disconnects BMW's persistent `129 -> 387` (`SpeechSink`) AudioManager route.
 *   - Analyzes Left (Driver) vs Right (Passenger) ceiling mic RMS dBFS so zone-free commands ("tôi lạnh quá")
 *     automatically target the person who spoke.
 *
 * Node 8 (ES2017) compatible.
 */
const fs = require('fs');
const path = require('path');
const cp = require('child_process');

const MGU_PYTHON = '/var/opt/mgu-python/current/bin/python3';
const SMARTX_HELPER = path.join(__dirname, 'alsa-smartx.py');

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
        try { if (fs.existsSync(outFile)) fs.unlinkSync(outFile); } catch (e) {}
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

module.exports = {
    SMARTX_PROFILES,
    probeSmartxStack,
    analyzeWavBuffer,
    buildStereoWav,
    captureCeilingMic,
};
