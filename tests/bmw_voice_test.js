'use strict';
/**
 * bmw_voice_test.js - Comprehensive Unit & E2E Test Suite for `bmw-voice` (`v1.1.0`).
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const net = require('net');

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

    console.log('Running bmw-voice v1.1.0 test suite...');

    // 1. MGU Boot Safety, Systemd, Bundled Vietnamese Fonts & Read-Only ALSA Capture Invariants
    await step('Systemd service, component.json v1.1.0, bundled Inter fonts & ALSA capture-only invariants', () => {
        const root = path.resolve(__dirname, '..');
        const svc = fs.readFileSync(path.join(root, 'tools', 'bmw-voice', 'bmw-voice.service'), 'utf8');
        assert.ok(svc.indexOf('WantedBy=oapcontroller.service') >= 0);
        assert.strictEqual(svc.indexOf('multi-user.target'), -1);
        assert.ok(svc.indexOf('LimitCORE=1') >= 0);
        assert.ok(svc.indexOf('Restart=on-failure') >= 0);

        const comp = JSON.parse(fs.readFileSync(path.join(root, 'tools', 'bmw-voice', 'component.json'), 'utf8'));
        assert.strictEqual(comp.id, 'bmw-voice');
        assert.strictEqual(comp.version, '1.1.0');
        assert.strictEqual(comp.enable[0].target, 'oapcontroller.service');
        assert.deepStrictEqual(comp.recmgr, ['bmw-voice']);

        comp.files.forEach((entry) => {
            assert.ok(fs.existsSync(path.join(root, 'tools', 'bmw-voice', entry.path)), 'missing file: ' + entry.path);
        });

        const appSpec = JSON.parse(fs.readFileSync(path.join(root, 'apps', 'bmw_voice', 'app.json'), 'utf8'));
        assert.strictEqual(appSpec.version, '1.1.0');
        assert.strictEqual(appSpec.startType, 'autostart');

        const py = fs.readFileSync(path.join(root, 'tools', 'bmw-voice', 'alsa-smartx.py'), 'utf8');
        assert.strictEqual(py.indexOf('SND_PCM_STREAM_PLAYBACK'), -1);
        assert.strictEqual(py.indexOf('--play-loop'), -1);
        assert.ok(py.indexOf('--stream-daemon') >= 0);

        MicCapture.SMARTX_PROFILES.forEach((p) => {
            assert.ok(p.hw.indexOf('smartx:') === 0 && p.hw.indexOf('avb:') < 0 && p.hw.indexOf('hw:') < 0);
        });
    });

    // 2. All 6 OEM BMW IPA In-Car Domains & Zero Music Ducking
    await step('All 6 OEM BMW IPA domains execute accurately without touching CarPlay volume on non-media turns', async () => {
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
    });

    // 3. Honest Hardware Truth Gate (Never Report Fake Success)
    await step('Physical-switch-only & unequipped liveCar options return ok: false honestly', async () => {
        const carLive = new CarControl.CarController({ comfortSock: '/nonexistent/comfort.sock' });
        carLive.state.liveCar = true;

        const rTrunk = await NluBrain.processVoiceOrText({
            text: 'Mở cốp sau cho anh',
            speakerZone: 'driver',
            carController: carLive,
        });
        assert.strictEqual(rTrunk.ok, false);
        assert.ok(rTrunk.replyVi.indexOf('nút vật lý') >= 0);

        const rMirror = await NluBrain.processVoiceOrText({
            text: 'Gập gương chiếu hậu',
            speakerZone: 'driver',
            carController: carLive,
        });
        assert.strictEqual(rMirror.ok, false);

        const rMassage = await carLive.executeTool('set_seat_comfort', { seat: 'driver', massage: true }, 'driver');
        assert.strictEqual(rMassage.ok, false);
        assert.strictEqual(carLive.state.climate.massageDriver, false);
        assert.ok(rMassage.summaryVi.indexOf('không trang bị') >= 0);
    });

    // 4. System-Wide OEM BMW IPA Overlay (`ipa-overlay.js`) Wire Protocol & PTT Z-Order Re-assertion
    await step('IpaOverlay connects to mgu-render socket, uploads Vietnamese atlases, re-asserts top layer on PTT & auto-hides', async () => {
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

        // Verify HELLO -> READY -> PLACE(84, 76, 1836, 644)
        const helloMsg = rxMsgs.find((m) => m.type === M.HELLO);
        const placeMsg = rxMsgs.find((m) => m.type === M.PLACE);
        assert.ok(helloMsg && helloMsg.p.toString('utf8').indexOf('bmw_voice_ipa') === 0);
        assert.ok(placeMsg);
        assert.strictEqual(placeMsg.p.readInt32LE(0), 84);
        assert.strictEqual(placeMsg.p.readInt32LE(4), 76);
        assert.strictEqual(placeMsg.p.readInt32LE(8), 1836);
        assert.strictEqual(placeMsg.p.readInt32LE(12), 644);

        // Trigger Steering Wheel PTT listening overlay (with z-order top reassertion at +240ms)
        ov.showListening({ reassertTop: true, speakerZone: 'driver' });
        await new Promise((r) => setTimeout(r, 310));

        const atlasMsgs = rxMsgs.filter((m) => m.type === M.ATLAS);
        const frameMsgs = rxMsgs.filter((m) => m.type === M.FRAME);
        const showVals = rxMsgs.filter((m) => m.type === M.SHOW).map((m) => m.p.readUInt32LE(0));
        assert.ok(atlasMsgs.length >= 2, 'should upload bold + regular Vietnamese Inter glyph atlases');
        assert.ok(frameMsgs.length >= 2);
        // Must have initial SHOW(1), then SHOW(0) -> SHOW(1) reassert over HmiMain3D's unsupported-language popup!
        assert.ok(showVals[0] === 1 && showVals.indexOf(0) > 0 && showVals[showVals.length - 1] === 1);

        // Show execution result and verify clean auto-hide SHOW(0)
        ov.showResult({ ok: true, speakerZone: 'driver', transcript: 'Hey BMW điều hoà 22 độ', replyVi: 'Đã chỉnh điều hoà 22°C' }, 1200);
        await new Promise((r) => setTimeout(r, 1320));
        const finalShow = rxMsgs.filter((m) => m.type === M.SHOW).pop();
        assert.strictEqual(finalShow.p.readUInt32LE(0), 0);
        assert.strictEqual(ov.phase, 'hidden');

        ov.stop();
        await new Promise((r) => renderSrv.close(r));
    });

    // 5. "Hey BMW" Wake Word: Deterministic Chatter Filter, 1-Shot Execution & 2-Step Follow-Up E2E
    await step('"Hey BMW" 1-shot, 2-step wake->overlay->follow-up & cabin chatter silent rejection work E2E', async () => {
        // Unit check on extractHeyBmwWake
        assert.strictEqual(NluBrain.extractHeyBmwWake('Hôm nay kẹt xe quá nhỉ').matched, false);
        assert.deepStrictEqual(NluBrain.extractHeyBmwWake('Hey BMW!'), { matched: true, wakeOnly: true, commandText: '' });
        assert.deepStrictEqual(NluBrain.extractHeyBmwWake('Hây Bê Em Vê chỉnh điều hoà 21 độ'), {
            matched: true,
            wakeOnly: false,
            commandText: 'chỉnh điều hoà 21 độ',
        });

        const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bv-wake-'));
        const smartxDir = path.join(tmp, 'smartx');
        fs.mkdirSync(smartxDir);
        fs.writeFileSync(path.join(smartxDir, 'smartx_SpeechSink_CF_2MIC_6REF_c'), '');

        // Create mock persistent stream helper (`--stream-daemon`) driven by control file / stdin
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
            "        process.stdout.write(JSON.stringify({ event: 'ptt_clip', reqId: msg.reqId, file: out, durationMs: 650, device: devName }) + '\\n');",
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

        // Mock Gemini responder scripted across 4 calls:
        //   Call 1 (wake): random cabin chatter -> ignored!
        //   Call 2 (wake): 1-shot "Hey BMW chỉnh điều hoà 20 độ" -> sets 20°C!
        //   Call 3 (wake): 2-step "Hey BMW" -> wakeOnly: true!
        //   Call 4 (follow-up ptt): "Đổi đèn viền màu xanh lá" -> sets green!
        const scriptedReplies = [
            { speechDetected: true, wakeDetected: false, wakeOnly: false, transcript: 'Hôm nay trời mát quá anh ơi', toolCalls: [] },
            { speechDetected: true, wakeDetected: true, wakeOnly: false, transcript: 'Hey BMW chỉnh điều hoà 20 độ', toolCalls: [{ name: 'set_climate', args: { tempC: 20, zone: 'driver' } }] },
            { speechDetected: true, wakeDetected: true, wakeOnly: true, transcript: 'Hey BMW', toolCalls: [] },
            { speechDetected: true, transcript: 'Đổi đèn viền màu xanh lá', toolCalls: [{ name: 'set_ambient_light', args: { color: 'green' } }] },
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
        assert.strictEqual(dm.wakeStatus, 'armed');

        // A) Cabin chatter without "Hey BMW" -> silently ignored, overlay stays hidden, lastTurn remains idle!
        dm.micStream._sendCmd({ cmd: 'emit_wake_test' });
        await waitUntil(() => gemCallIdx >= 1 && !dm.turnBusy, 2500);
        assert.strictEqual(dm.lastTurn.idle, true);
        assert.strictEqual(dm.overlay.phase, 'hidden');

        // B) 1-Shot "Hey BMW chỉnh điều hoà 20 độ" -> executes immediately & shows result overlay!
        dm.micStream._sendCmd({ cmd: 'emit_wake_test' });
        await waitUntil(() => dm.car.state.climate.tempDriverC === 20 && !dm.turnBusy, 2500);
        assert.strictEqual(dm.car.state.climate.tempDriverC, 20);
        assert.strictEqual(dm.overlay.phase, 'result');

        // C) 2-Step "Hey BMW" -> opens listening overlay -> instant follow-up PTT -> sets green ambient light!
        dm.micStream._sendCmd({ cmd: 'emit_wake_test' });
        await waitUntil(() => dm.car.state.ambient.key === 'green' && !dm.turnBusy, 3000);
        assert.strictEqual(dm.car.state.ambient.key, 'green');
        assert.strictEqual(dm.overlay.phase, 'result');

        // D) Reverse gear ('R') immediately hides IPA overlay for camera safety!
        dm.car.patchState({ gear: 'R' });
        assert.strictEqual(dm.overlay.phase, 'hidden');

        await dm.stop();
        await new Promise((r) => mockGem.close(r));
    });

    // 6. Steering Wheel PTT Guard, Stereo Zone Localization & Coalesced IPC
    await step('Steering PTT capacitive guard, passenger stereo localization, ctl.sock & coalesced hmi.json writes', async () => {
        const pttEvents = [];
        const cTest = new CarControl.CarController({ onPttEvent: (ev) => pttEvents.push(ev) });
        cTest.handleSteeringPttSignal(true);
        await new Promise((r) => setTimeout(r, 40));
        cTest.handleSteeringPttSignal(false);
        assert.strictEqual(pttEvents.length, 1);
        assert.strictEqual(pttEvents[0].kind, 'short_press');

        const mockGem = http.createServer((req, res) => {
            req.on('data', () => {});
            req.on('end', () => {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                    candidates: [{
                        content: {
                            parts: [{
                                text: JSON.stringify({
                                    speechDetected: true,
                                    transcript: 'Chỉnh điều hoà 21.5 độ',
                                    toolCalls: [{ name: 'set_climate', args: { tempC: 21.5 } }],
                                    unsupportedReason: '',
                                }),
                            }],
                        },
                    }],
                }));
            });
        });
        await new Promise((r) => mockGem.listen(0, '127.0.0.1', r));

        const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bmw-voice-test-'));
        const dm = new BmwVoiceDaemon({
            run: path.join(tmp, 'run'),
            state: path.join(tmp, 'state'),
            oap: path.join(tmp, 'oap'),
            host: '127.0.0.1',
            port: 0,
            simMode: true,
            noNft: true,
            noOverlay: true,
            noWakeStream: true,
            quiet: true,
            geminiBaseUrl: 'http://127.0.0.1:' + mockGem.address().port,
        });
        await dm.start();
        dm.saveSettings({ apiKey: 'AIzaSyTestBmwVoiceKey1234' });

        const wavPass = MicCapture.buildStereoWav(new Array(2400).fill(0.03), new Array(2400).fill(0.45), 16000);
        const turn = await dm.handleTurn({
            audioWavBase64: wavPass.toString('base64'),
            audioMimeType: 'audio/wav',
        });
        assert.strictEqual(turn.ok, true);
        assert.strictEqual(turn.speakerZone, 'passenger');
        assert.strictEqual(dm.car.state.climate.tempPassengerC, 21.5);
        assert.strictEqual(dm.car.state.climate.tempDriverC, 22.5);

        const sockPath = path.join(tmp, 'run', 'ctl.sock');
        await new Promise((resolve, reject) => {
            const s = net.createConnection(sockPath, () => {
                s.end(JSON.stringify({ id: 777, cmd: 'ask_text', arg: { text: 'Đèn viền màu xanh băng', speakerZone: 'driver' } }) + '\n', resolve);
            });
            s.on('error', reject);
        });
        await new Promise((r) => setTimeout(r, 120));
        assert.strictEqual(dm.car.state.ambient.key, 'cyan');

        const beforeWrites = dm.statusWriteCount;
        for (let i = 0; i < 50; i++) {
            dm.car.patchState({ rpm: 900 + i * 15, speedKmh: 30 + (i % 10) });
        }
        await new Promise((r) => setTimeout(r, 450));
        assert.strictEqual(dm.statusWriteCount, beforeWrites);

        for (let i = 0; i < 50; i++) {
            dm.car.patchState({ oilTempC: 70 + (i % 25) });
        }
        assert.strictEqual(dm.statusWriteCount, beforeWrites);
        await new Promise((r) => setTimeout(r, 460));
        const deltaWrites = dm.statusWriteCount - beforeWrites;
        assert.ok(deltaWrites >= 1 && deltaWrites <= 2);

        await dm.stop();
        await new Promise((r) => mockGem.close(r));
    });

    // 7. Zero-Lag Single-Screen OEM BMW IPA UI (`apps/bmw_voice/ui.js`)
    await step('Single-screen OEM BMW UI caches QR matrix once and produces 100% identical idle Recorder words', () => {
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
            lastTurn: { idle: false, ok: true, transcript: 'Hey BMW điều hoà 22 độ', replyVi: 'Đã chỉnh điều hoà ghế tài 22°C' },
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

    console.log('\nALL ' + passed + ' BMW-VOICE TEST SUITES PASSED!');
}

runTests().catch((err) => {
    console.error('\nTEST FAILED:', err);
    process.exit(1);
});
