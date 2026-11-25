'use strict';
/**
 * bmw_voice_test.js - Comprehensive Unit, Anti-Hallucination & E2E Test Suite for `bmw-voice` (`v1.1.1`).
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const net = require('net');

const Up = require('../tools/bmw-voice/uplink');
const CarControl = require('../tools/bmw-voice/car-control');
const MicCapture = require('../tools/bmw-voice/mic-capture');
const NluBrain = require('../tools/bmw-voice/nlu-brain');
const { IpaOverlay, M, E } = require('../tools/bmw-voice/ipa-overlay');
const { BmwVoiceDaemon } = require('../tools/bmw-voice/bmw-voice');

function buildRendererReadyMsg() {
    const p = Buffer.alloc(16);
    p.writeUInt32LE(4, 0);
    p.writeUInt32LE(1920, 4);
    p.writeUInt32LE(720, 8);
    p.writeUInt32LE(1, 12);
    const out = Buffer.alloc(24);
    out.writeUInt32LE(E.READY, 0);
    out.writeUInt32LE(16, 4);
    p.copy(out, 8);
    return out;
}

async function runTests() {
    let passed = 0;
    const step = (name, fn) => Promise.resolve().then(fn).then(() => {
        passed++;
        console.log('  [PASS] ' + name);
    });

    console.log('Running bmw-voice v1.1.1 test suite...');

    // 1. MGU Boot Safety, Systemd, Bundled Vietnamese Fonts & Read-Only ALSA Capture Invariants
    await step('Systemd service, component.json v1.1.1, bundled Inter fonts & ALSA capture-only invariants', () => {
        const root = path.resolve(__dirname, '..');
        const svc = fs.readFileSync(path.join(root, 'tools', 'bmw-voice', 'bmw-voice.service'), 'utf8');
        assert.ok(svc.indexOf('WantedBy=oapcontroller.service') >= 0);
        assert.strictEqual(svc.indexOf('multi-user.target'), -1);
        assert.ok(svc.indexOf('LimitCORE=1') >= 0);
        assert.ok(svc.indexOf('Restart=on-failure') >= 0);

        const comp = JSON.parse(fs.readFileSync(path.join(root, 'tools', 'bmw-voice', 'component.json'), 'utf8'));
        assert.strictEqual(comp.id, 'bmw-voice');
        assert.strictEqual(comp.version, '1.1.1');
        assert.strictEqual(comp.enable[0].target, 'oapcontroller.service');
        assert.deepStrictEqual(comp.recmgr, ['bmw-voice']);

        comp.files.forEach((entry) => {
            assert.ok(fs.existsSync(path.join(root, 'tools', 'bmw-voice', entry.path)), 'missing file: ' + entry.path);
        });

        const appSpec = JSON.parse(fs.readFileSync(path.join(root, 'apps', 'bmw_voice', 'app.json'), 'utf8'));
        assert.strictEqual(appSpec.version, '1.1.1');
        assert.strictEqual(appSpec.startType, 'autostart');

        const repoSpec = JSON.parse(fs.readFileSync(path.join(root, 'mgu-repo.json'), 'utf8'));
        assert.strictEqual(repoSpec.components[0].requires['bmw-voice'], '1.1.1');

        const py = fs.readFileSync(path.join(root, 'tools', 'bmw-voice', 'alsa-smartx.py'), 'utf8');
        assert.strictEqual(py.indexOf('SND_PCM_STREAM_PLAYBACK'), -1);
        assert.strictEqual(py.indexOf('--play-loop'), -1);
        assert.ok(py.indexOf('--stream-daemon') >= 0);

        MicCapture.SMARTX_PROFILES.forEach((p) => {
            assert.ok(p.hw.indexOf('smartx:') === 0 && p.hw.indexOf('avb:') < 0 && p.hw.indexOf('hw:') < 0);
        });
    });

    // 2. Real-Car Regression #1: DNS `queryA ECONNREFUSED` Filtering + Automatic DoH Fallback (`uplink.js`)
    await step('Filters BMW internal 160.48.* DNS & falls back to DoH when UDP 53 returns ECONNREFUSED', async () => {
        Up.clearDnsCache();
        assert.strictEqual(Up.isUsableDnsIp('160.48.199.99'), false);
        assert.strictEqual(Up.isUsableDnsIp('169.254.10.1'), false);
        assert.strictEqual(Up.isUsableDnsIp('127.0.0.1'), false);
        assert.strictEqual(Up.isUsableDnsIp('8.8.8.8'), true);

        const dohSrv = http.createServer((req, res) => {
            res.writeHead(200, { 'Content-Type': 'application/dns-json' });
            res.end(JSON.stringify({
                Status: 0,
                Answer: [
                    { name: 'generativelanguage.googleapis.com.', type: 5, data: 'googleapis.l.google.com.' },
                    { name: 'googleapis.l.google.com.', type: 1, data: '142.250.199.106' },
                ],
            }));
        });
        await new Promise((r) => dohSrv.listen(0, '127.0.0.1', r));

        // Force UDP DNS to hit a closed/unusable port (`203.0.113.1` / fast fail) or mock resolver -> DoH recovers!
        const dnsMod = require('dns');
        const origResolve4 = dnsMod.Resolver.prototype.resolve4;
        dnsMod.Resolver.prototype.resolve4 = function (_host, cb) {
            const err = new Error('queryA ECONNREFUSED generativelanguage.googleapis.com');
            err.code = 'ECONNREFUSED';
            setImmediate(() => cb(err));
        };
        try {
            const lk = Up.customLookup('/nonexistent/lease.json', '/nonexistent/route', ['8.8.8.8'], [
                { proto: 'http', ip: '127.0.0.1', port: dohSrv.address().port, hostHeader: 'dns.google', pathPrefix: '/resolve' },
            ]);
            const resolved = await new Promise((resolve, reject) => {
                lk('generativelanguage.googleapis.com', {}, (err, ip, fam) => {
                    if (err) reject(err);
                    else resolve({ ip, fam });
                });
            });
            assert.strictEqual(resolved.ip, '142.250.199.106');
            assert.strictEqual(resolved.fam, 4);
        } finally {
            dnsMod.Resolver.prototype.resolve4 = origResolve4;
            Up.clearDnsCache();
            await new Promise((r) => dohSrv.close(r));
        }
    });

    // 3. Real-Car Regression #2: Exact Photo 3 Hallucination ("Mày nghe tao nói không? Tôi nóng quá..." / 17.5°C) Blocked!
    await step('Blocks Gemini prompt-contamination hallucinations, mic-check false actions & snaps G30 IHKA setpoints', async () => {
        // Verify hot-climate BMW G30 IHKA valid step snapping (16.0 LOW, then 18.0..28.0)
        assert.strictEqual(CarControl.snapBmwIhkaTempC(16.0), 16.0);
        assert.strictEqual(CarControl.snapBmwIhkaTempC(17.5), 18.0);
        assert.strictEqual(CarControl.snapBmwIhkaTempC(24.5), 24.5);

        const car = new CarControl.CarController();
        car.patchState({ climate: { tempDriverC: 24.5, tempPassengerC: 24.5, fanLevel: 3 } });

        // Exact hallucinated Gemini payload observed on car at 20:46 (`media_1795614525673_7e9ecfe2.jpg`)
        let callIdx = 0;
        const mockReplies = [
            {
                speechDetected: true,
                transcript: '“Mày nghe tao nói không? Tôi nóng quá, hạ nhiệt độ xuống cho cả hai bên đi.”',
                toolCalls: [{ name: 'set_climate', args: { tempC: 17.5, zone: 'driver' } }],
            },
            {
                speechDetected: true,
                transcript: 'Hôm nay hầm gửi xe hơi tối nhỉ',
                toolCalls: [{ name: 'set_climate', args: { tempC: 17.5, zone: 'driver' } }],
            },
        ];
        const mockGem = http.createServer((req, res) => {
            req.on('data', () => {});
            req.on('end', () => {
                const p = mockReplies[Math.min(callIdx++, mockReplies.length - 1)];
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify(p) }] } }] }));
            });
        });
        await new Promise((r) => mockGem.listen(0, '127.0.0.1', r));

        const wav = MicCapture.buildStereoWav(new Array(1600).fill(0.35), new Array(1600).fill(0.05), 16000);
        const turnMicCheck = await NluBrain.processVoiceOrText({
            audioWavBase64: wav.toString('base64'),
            speakerZone: 'driver',
            apiKey: 'AIzaSyTestKey',
            carController: car,
            uplinkOpts: Up.options({ noSetuid: true, baseUrl: 'http://127.0.0.1:' + mockGem.address().port }),
        });

        assert.strictEqual(turnMicCheck.ok, true);
        assert.strictEqual(turnMicCheck.micCheck, true);
        assert.strictEqual(turnMicCheck.transcript, '"Mày nghe tao nói không?"'.replace(/^"|"$/g, ''));
        assert.strictEqual(turnMicCheck.actions.length, 0, 'mic check MUST NOT touch car climate!');
        assert.strictEqual(car.state.climate.tempDriverC, 24.5, 'IHKA 24.5°C must remain untouched!');
        assert.strictEqual(turnMicCheck.transcript.indexOf('“'), -1);

        // Second call: casual non-command sentence where Gemini still tries to inject `set_climate(17.5)`
        const turnCasual = await NluBrain.processVoiceOrText({
            audioWavBase64: wav.toString('base64'),
            speakerZone: 'driver',
            apiKey: 'AIzaSyTestKey',
            carController: car,
            uplinkOpts: Up.options({ noSetuid: true, baseUrl: 'http://127.0.0.1:' + mockGem.address().port }),
        });
        assert.strictEqual(turnCasual.ok, false);
        assert.strictEqual(turnCasual.actions.length, 0);
        assert.strictEqual(car.state.climate.tempDriverC, 24.5);

        await new Promise((r) => mockGem.close(r));
    });

    // 4. All 6 OEM BMW IPA In-Car Domains & Honest Hardware Truth Gate
    await step('All 6 OEM BMW IPA domains execute accurately & physical-switch-only commands return ok: false', async () => {
        const car = new CarControl.CarController();
        car.patchState({ speedKmh: 0, gear: 'P', media: { playing: true, volumePercent: 42, muted: false } });

        const t1 = await NluBrain.processVoiceOrText({
            text: 'Lạnh quá tăng nhiệt độ với bật sưởi ghế cho em',
            speakerZone: 'passenger',
            carController: car,
        });
        assert.strictEqual(t1.ok, true);
        assert.strictEqual(car.state.climate.tempDriverC, 22.5);
        assert.strictEqual(car.state.climate.tempPassengerC, 24.0);
        assert.strictEqual(car.state.climate.seatHeatPassenger, 2);
        assert.strictEqual(car.state.media.volumePercent, 42);

        const tBoth = await NluBrain.processVoiceOrText({
            text: 'Nóng quá giảm nhiệt độ cả hai bên',
            speakerZone: 'driver',
            carController: car,
        });
        assert.strictEqual(tBoth.ok, true);
        assert.strictEqual(car.state.climate.tempDriverC, 21.0);
        assert.strictEqual(car.state.climate.tempPassengerC, 22.5);

        const t2 = await NluBrain.processVoiceOrText({
            text: 'Đổi đèn viền sang màu tím độ sáng 85%',
            speakerZone: 'driver',
            carController: car,
        });
        assert.strictEqual(t2.ok, true);
        assert.strictEqual(car.state.ambient.key, 'lilac');
        assert.strictEqual(car.state.ambient.brightness, 85);

        const t3 = await NluBrain.processVoiceOrText({
            text: 'Tăng âm lượng rồi qua bài tiếp theo',
            speakerZone: 'driver',
            carController: car,
        });
        assert.strictEqual(t3.ok, true);
        assert.strictEqual(car.state.media.volumePercent, 50);

        car.patchState({ speedKmh: 75, gear: 'D' });
        const t4 = await NluBrain.processVoiceOrText({
            text: 'Hạ kính ghế tài',
            speakerZone: 'driver',
            carController: car,
        });
        assert.strictEqual(t4.ok, true);
        assert.strictEqual(car.state.windows.fl, 20);

        const t5 = await NluBrain.processVoiceOrText({
            text: 'Kiểm tra tình trạng xe',
            speakerZone: 'driver',
            carController: car,
        });
        assert.strictEqual(t5.ok, true);
        assert.ok(t5.replyVi.indexOf('Dầu máy') >= 0 && t5.replyVi.indexOf('Bình') >= 0);

        const carLive = new CarControl.CarController({ comfortSock: '/nonexistent/comfort.sock' });
        carLive.state.liveCar = true;
        const rTrunk = await NluBrain.processVoiceOrText({
            text: 'Mở cốp sau cho anh',
            speakerZone: 'driver',
            carController: carLive,
        });
        assert.strictEqual(rTrunk.ok, false);
        assert.ok(rTrunk.replyVi.indexOf('nút vật lý') >= 0);
    });

    // 5. System-Wide OEM BMW IPA Overlay (`ipa-overlay.js`) + Vietnamese Font Atlas Coverage (Zero `?` Glyphs!)
    await step('IpaOverlay recreates top Wayland layer on PTT & all UI strings exist in bundled Vietnamese font atlas', async () => {
        const root = path.resolve(__dirname, '..');
        const fontJson = JSON.parse(fs.readFileSync(path.join(root, 'tools', 'bmw-voice', 'fonts', 'vietnamese.json'), 'utf8'));
        const glyphs = fontJson.sizes[0].glyphs;
        const testChars = '✓·…-°%"\'()[]/:0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyzXin chào, tôi đang lắng nghe ĐÃ CHỈNH ĐIỀU HOÀ GHẾ TÀI PHỤ MỨC GIÓ SƯỞI MÁT';
        for (const ch of testChars) {
            const cp = ch.codePointAt(0);
            assert.ok(glyphs[cp], 'bundled vietnamese.json missing glyph for: ' + ch + ' (' + cp + ')');
        }

        const tmpOv = fs.mkdtempSync(path.join(os.tmpdir(), 'bv-ov-'));
        const sockPath = path.join(tmpOv, 'render.sock');
        const rxMsgs = [];

        const renderSrv = net.createServer((client) => {
            let buf = Buffer.alloc(0);
            client.on('data', (d) => {
                buf = buf.length ? Buffer.concat([buf, d]) : d;
                while (buf.length >= 8) {
                    const type = buf.readUInt32LE(0);
                    const len = buf.readUInt32LE(4);
                    if (buf.length < 8 + len) break;
                    const p = buf.slice(8, 8 + len);
                    buf = buf.slice(8 + len);
                    rxMsgs.push({ type, p });
                    if (type === M.HELLO) {
                        client.write(buildRendererReadyMsg());
                    }
                }
            });
        });
        await new Promise((r) => renderSrv.listen(sockPath, r));

        const ov = new IpaOverlay({ sockets: [sockPath] });
        ov.start();
        await new Promise((r) => setTimeout(r, 60));

        ov.showListening({ reassertTop: true, speakerZone: 'driver' });
        await new Promise((r) => setTimeout(r, 290));

        const placeWidths = rxMsgs.filter((m) => m.type === M.PLACE).map((m) => m.p.readInt32LE(8));
        assert.ok(placeWidths.indexOf(1836) >= 0 && placeWidths.indexOf(1835) >= 0, 'must recreate Wayland layer to beat HmiMain3D popup');

        ov.showResult({ ok: true, speakerZone: 'driver', transcript: '“Hey BMW điều hoà 22 độ”', replyVi: 'Đã chỉnh điều hoà 22°C' }, 1200);
        assert.strictEqual(ov.subline, '"Hey BMW điều hoà 22 độ"');
        assert.strictEqual(ov.subline.indexOf('“'), -1);

        await new Promise((r) => setTimeout(r, 1320));
        assert.strictEqual(ov.phase, 'hidden');

        ov.stop();
        await new Promise((r) => renderSrv.close(r));
    });

    // 6. "Hey BMW" Wake Word + Instant PTT Button-Down + Native `bmw_voice` Auto-Open/Auto-Close IPC
    await step('Instant PTT button-down pushes voice_ui open/finish to bmw_voice & "Hey BMW" 1-shot / 2-step work E2E', async () => {
        assert.strictEqual(NluBrain.extractHeyBmwWake('Hôm nay kẹt xe quá nhỉ').matched, false);
        assert.deepStrictEqual(NluBrain.extractHeyBmwWake('Hey BMW!'), { matched: true, wakeOnly: true, commandText: '' });
        assert.deepStrictEqual(NluBrain.extractHeyBmwWake('Ê Bê Em chỉnh điều hoà 21 độ'), {
            matched: true,
            wakeOnly: false,
            commandText: 'chỉnh điều hoà 21 độ',
        });

        const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bv-wake-'));
        const smartxDir = path.join(tmp, 'smartx');
        fs.mkdirSync(smartxDir);
        fs.writeFileSync(path.join(smartxDir, 'smartx_SpeechSink_CF_2MIC_6REF_c'), '');

        const mockBin = path.join(tmp, 'mock-python.sh');
        const mockHelper = path.join(tmp, 'mock-smartx.js');
        const sampleWav = MicCapture.buildStereoWav(new Array(2400).fill(0.42), new Array(2400).fill(0.04), 16000);
        const sampleWavPath = path.join(tmp, 'sample.wav');
        fs.writeFileSync(sampleWavPath, sampleWav);

        const nodeExec = process.execPath;
        fs.writeFileSync(mockBin, '#!/bin/sh\nELECTRON_RUN_AS_NODE=1 exec "' + nodeExec + '" "$@"\n', { mode: 0o755 });
        fs.writeFileSync(mockHelper, [
            "'use strict';",
            "const fs = require('fs');",
            "const path = require('path');",
            "const workDir = process.argv[4];",
            "const devName = process.argv[3];",
            "const srcWav = " + JSON.stringify(sampleWavPath) + ";",
            "process.stdout.write(JSON.stringify({ event: 'ready', device: devName }) + '\\n');",
            "let buf = '';",
            "process.stdin.setEncoding('utf8');",
            "process.stdin.on('data', (c) => {",
            "  buf += c;",
            "  let idx;",
            "  while ((idx = buf.indexOf('\\n')) >= 0) {",
            "    const line = buf.slice(0, idx).trim();",
            "    buf = buf.slice(idx + 1);",
            "    if (!line) continue;",
            "    const msg = JSON.parse(line);",
            "    if (msg.cmd === 'stop') process.exit(0);",
            "    if (msg.cmd === 'ptt') {",
            "      const out = path.join(workDir, 'ptt_clip.wav');",
            "      fs.writeFileSync(out, fs.readFileSync(srcWav));",
            "      setTimeout(() => {",
            "        process.stdout.write(JSON.stringify({ event: 'ptt_clip', reqId: msg.reqId, file: out, durationMs: 650, voicedChunks: 6, snrDb: 9.0, device: devName }) + '\\n');",
            "      }, 30);",
            "    }",
            "    if (msg.cmd === 'emit_wake_test') {",
            "      const out = path.join(workDir, 'wake_clip.wav');",
            "      fs.writeFileSync(out, fs.readFileSync(srcWav));",
            "      process.stdout.write(JSON.stringify({ event: 'wake_clip', file: out, durationMs: 700, snrDb: 9.5, device: devName }) + '\\n');",
            "    }",
            "  }",
            "});",
        ].join('\n'), { mode: 0o755 });

        const scriptedReplies = [
            { speechDetected: true, wakeDetected: false, wakeOnly: false, transcript: 'Hôm nay trời mát quá anh ơi', toolCalls: [] },
            { speechDetected: true, wakeDetected: true, wakeOnly: false, transcript: 'Hey BMW chỉnh điều hoà 20 độ', toolCalls: [{ name: 'set_climate', args: { tempC: 20, zone: 'driver' } }] },
            { speechDetected: true, wakeDetected: true, wakeOnly: true, transcript: 'Hey BMW', toolCalls: [] },
            { speechDetected: true, transcript: 'Đổi đèn viền màu xanh lá', toolCalls: [{ name: 'set_ambient_light', args: { color: 'green' } }] },
            { speechDetected: true, transcript: 'Âm lượng 40%', toolCalls: [{ name: 'control_media', args: { action: 'volume', volumePercent: 40 } }] },
        ];
        let gemCallIdx = 0;
        const mockGem = http.createServer((req, res) => {
            req.on('data', () => {});
            req.on('end', () => {
                const payload = scriptedReplies[Math.min(gemCallIdx++, scriptedReplies.length - 1)];
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                    candidates: [{ content: { parts: [{ text: JSON.stringify(payload) }] } }],
                }));
            });
        });
        await new Promise((r) => mockGem.listen(0, '127.0.0.1', r));

        const dm = new BmwVoiceDaemon({
            run: path.join(tmp, 'run'),
            state: path.join(tmp, 'state'),
            oap: path.join(tmp, 'oap'),
            host: '127.0.0.1',
            port: 0,
            simMode: true,
            noNft: true,
            noOverlay: false,
            renderSockets: [path.join(tmp, 'nonexistent-render.sock')],
            quiet: true,
            geminiBaseUrl: 'http://127.0.0.1:' + mockGem.address().port,
            micOpts: {
                mguPython: mockBin,
                smartxHelper: mockHelper,
                smartxDir,
            },
        });
        const waitUntil = async (fn, timeoutMs) => {
            const deadline = Date.now() + (timeoutMs || 2500);
            while (Date.now() < deadline) {
                if (fn()) return;
                await new Promise((r) => setTimeout(r, 25));
            }
            throw new Error('waitUntil timed out after ' + (timeoutMs || 2500) + 'ms');
        };

        dm.saveSettings({ apiKey: 'AIzaSyTestWakeKey1234', handsFreeWake: true });
        await dm.start();
        await waitUntil(() => dm.wakeStatus === 'armed', 3000);

        // Connect mock `apps/bmw_voice` subscriber to `ctl.sock`
        const pushEvents = [];
        const hmiClient = net.createConnection(path.join(tmp, 'run', 'ctl.sock'), () => {
            hmiClient.write(JSON.stringify({ id: 1, cmd: 'subscribe_hmi', arg: { visible: false } }) + '\n');
        });
        let hmiBuf = '';
        hmiClient.setEncoding('utf8');
        hmiClient.on('data', (c) => {
            hmiBuf += c;
            let idx;
            while ((idx = hmiBuf.indexOf('\n')) >= 0) {
                const line = hmiBuf.slice(0, idx).trim();
                hmiBuf = hmiBuf.slice(idx + 1);
                if (line) pushEvents.push(JSON.parse(line));
            }
        });
        await waitUntil(() => pushEvents.length >= 1, 1500);

        // A) Cabin chatter without "Hey BMW" -> silently ignored
        dm.micStream._sendCmd({ cmd: 'emit_wake_test' });
        await waitUntil(() => gemCallIdx >= 1 && !dm.turnBusy, 2500);
        assert.strictEqual(dm.lastTurn.idle, true);

        // B) 1-Shot "Hey BMW chỉnh điều hoà 20 độ"
        dm.micStream._sendCmd({ cmd: 'emit_wake_test' });
        await waitUntil(() => dm.car.state.climate.tempDriverC === 20 && !dm.turnBusy, 2500);
        assert.strictEqual(dm.car.state.climate.tempDriverC, 20);

        // C) 2-Step "Hey BMW" -> pushes `open` to bmw_voice -> follow-up sets green ambient light -> pushes `finish`!
        pushEvents.length = 0;
        dm.micStream._sendCmd({ cmd: 'emit_wake_test' });
        await waitUntil(() => dm.car.state.ambient.key === 'green' && !dm.turnBusy, 3000);
        assert.ok(pushEvents.some((e) => e.action === 'open' && e.reason === 'hey_bmw'));
        assert.ok(pushEvents.some((e) => e.action === 'finish'));

        // D) Physical Steering Wheel Mic button DOWN fires immediately (`0ms`, before button release!)
        pushEvents.length = 0;
        dm.car.handleSteeringPttSignal(true);
        await waitUntil(() => pushEvents.some((e) => e.action === 'open' && e.reason === 'ptt'), 800);
        // Simulate `apps/bmw_voice` opening on screen -> overlay immediately yields!
        hmiClient.write(JSON.stringify({ id: 2, cmd: 'app_visible', arg: { visible: true } }) + '\n');
        await waitUntil(() => dm.hmiAppVisible === true && dm.overlay.phase === 'hidden', 800);
        await waitUntil(() => dm.car.state.media.volumePercent === 40 && !dm.turnBusy, 2500);
        dm.car.handleSteeringPttSignal(false);
        assert.ok(pushEvents.some((e) => e.action === 'finish'));

        hmiClient.destroy();
        await dm.stop();
        await new Promise((r) => mockGem.close(r));
    });

    // 7. Zero-Lag Single-Screen OEM BMW IPA UI (`apps/bmw_voice/ui.js`)
    await step('Single-screen OEM BMW UI caches QR matrix, sanitizes curly quotes & produces identical idle Recorder words', () => {
        const realQr = require('../kit/runtime/qr');
        const realG = require('../kit/runtime/gauges');
        const { Recorder } = require('../kit/runtime/record');
        const themes = require('../kit/runtime/themes');

        let qrCalls = 0;
        const wrappedQr = {
            encode: (txt, opts) => { qrCalls++; return realQr.encode(txt, opts); },
            draw: realQr.draw,
        };
        const Module = require('module');
        const origLoad = Module._load;
        Module._load = function (reqId, parent, isMain) {
            if (reqId === './kit/qr') return wrappedQr;
            return origLoad.apply(this, [reqId, parent, isMain]);
        };
        let UI;
        try {
            delete require.cache[require.resolve('../apps/bmw_voice/ui')];
            UI = require('../apps/bmw_voice/ui');
        } finally {
            Module._load = origLoad;
        }

        const theme = themes.theme();
        const baseModel = {
            daemonUp: true,
            showQr: true,
            animTick: 0,
            url: 'http://192.168.10.1:8145/?pin=5678',
            host: '192.168.10.1:8145',
            pin: '5678',
            ipCount: 1,
            assistantState: 'idle',
            wakeStatus: 'armed',
            settings: { hasApiKey: true, apiKeyMasked: 'AIzaSy••••1234', handsFreeWake: true },
            car: CarControl.createInitialState(),
            lastTurn: { idle: false, ok: true, transcript: '“Hey BMW điều hoà 22 độ”', replyVi: 'Đã chỉnh điều hoà ghế tài 22°C' },
        };

        for (let i = 0; i < 15; i++) {
            const r = new Recorder(UI.W, UI.H);
            UI.draw(r, realG, theme, baseModel, {});
        }
        assert.strictEqual(qrCalls, 1);

        const mainModel = Object.assign({}, baseModel, { showQr: false });
        const r1 = new Recorder(UI.W, UI.H);
        const r2 = new Recorder(UI.W, UI.H);
        UI.draw(r1, realG, theme, mainModel, {});
        UI.draw(r2, realG, theme, mainModel, {});
        const b1 = Buffer.from(Buffer.from(r1.words().buffer, r1.words().byteOffset, r1.words().byteLength));
        const b2 = Buffer.from(Buffer.from(r2.words().buffer, r2.words().byteOffset, r2.words().byteLength));
        assert.strictEqual(b1.equals(b2), true);
    });

    console.log('\nALL ' + passed + ' BMW-VOICE v1.1.1 TEST SUITES PASSED!');
}

runTests().catch((err) => {
    console.error('\nTEST FAILED:', err);
    process.exit(1);
});
