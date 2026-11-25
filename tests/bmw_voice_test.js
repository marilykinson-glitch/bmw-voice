'use strict';
/**
 * bmw_voice_test.js - Comprehensive Unit & E2E Test Suite for `bmw-voice` (`v1.0.0`).
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
const { BmwVoiceDaemon } = require('../tools/bmw-voice/bmw-voice');

async function runTests() {
    let passed = 0;
    const step = (name, fn) => Promise.resolve().then(fn).then(() => {
        passed++;
        console.log('  [PASS] ' + name);
    });

    console.log('Running bmw-voice v1.0.0 test suite...');

    // 1. MGU Boot Safety, Systemd & Read-Only ALSA Capture Invariants
    await step('Systemd service, component.json & ALSA capture-only safety invariants', () => {
        const root = path.resolve(__dirname, '..');
        const svc = fs.readFileSync(path.join(root, 'tools', 'bmw-voice', 'bmw-voice.service'), 'utf8');
        assert.ok(svc.indexOf('WantedBy=oapcontroller.service') >= 0);
        assert.strictEqual(svc.indexOf('multi-user.target'), -1);
        assert.ok(svc.indexOf('LimitCORE=1') >= 0);
        assert.ok(svc.indexOf('Restart=on-failure') >= 0);

        const comp = JSON.parse(fs.readFileSync(path.join(root, 'tools', 'bmw-voice', 'component.json'), 'utf8'));
        assert.strictEqual(comp.id, 'bmw-voice');
        assert.strictEqual(comp.version, '1.0.0');
        assert.strictEqual(comp.enable[0].target, 'oapcontroller.service');
        assert.deepStrictEqual(comp.recmgr, ['bmw-voice']);

        const py = fs.readFileSync(path.join(root, 'tools', 'bmw-voice', 'alsa-smartx.py'), 'utf8');
        assert.strictEqual(py.indexOf('SND_PCM_STREAM_PLAYBACK'), -1);
        assert.strictEqual(py.indexOf('--vad-loop'), -1);
        assert.strictEqual(py.indexOf('--play-loop'), -1);

        MicCapture.SMARTX_PROFILES.forEach((p) => {
            assert.ok(p.hw.indexOf('smartx:') === 0 && p.hw.indexOf('avb:') < 0 && p.hw.indexOf('hw:') < 0);
        });
    });

    // 2. All 6 OEM BMW IPA In-Car Domains & Zero Music Ducking
    await step('All 6 OEM BMW IPA domains execute accurately without touching CarPlay volume on non-media turns', async () => {
        const car = new CarControl.CarController();
        car.patchState({ speedKmh: 0, gear: 'P', media: { playing: true, volumePercent: 42, muted: false } });

        // Climate + Passenger Zone Routing
        const t1 = await NluBrain.processVoiceOrText({
            text: 'Lạnh quá tăng nhiệt độ với bật sưởi ghế cho em',
            speakerZone: 'passenger',
            carController: car,
        });
        assert.strictEqual(t1.ok, true);
        assert.strictEqual(car.state.climate.tempDriverC, 22.5);
        assert.strictEqual(car.state.climate.tempPassengerC, 24.0);
        assert.strictEqual(car.state.climate.seatHeatPassenger, 2);
        // CarPlay volume MUST remain completely untouched!
        assert.strictEqual(car.state.media.volumePercent, 42);

        // Ambient Light + Brightness
        const t2 = await NluBrain.processVoiceOrText({
            text: 'Đổi đèn viền sang màu tím độ sáng 85%',
            speakerZone: 'driver',
            carController: car,
        });
        assert.strictEqual(t2.ok, true);
        assert.strictEqual(car.state.ambient.key, 'lilac');
        assert.strictEqual(car.state.ambient.brightness, 85);

        // Media Volume Up (+8%) & Next Track
        const t3 = await NluBrain.processVoiceOrText({
            text: 'Tăng âm lượng rồi qua bài tiếp theo',
            speakerZone: 'driver',
            carController: car,
        });
        assert.strictEqual(t3.ok, true);
        assert.strictEqual(car.state.media.volumePercent, 50);

        // Power Windows High-Speed Safety Cap (> 50 km/h caps full open to 20% vent)
        car.patchState({ speedKmh: 75, gear: 'D' });
        const t4 = await NluBrain.processVoiceOrText({
            text: 'Hạ kính ghế tài',
            speakerZone: 'driver',
            carController: car,
        });
        assert.strictEqual(t4.ok, true);
        assert.strictEqual(car.state.windows.fl, 20);

        // Vehicle Status Query
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
        carLive.state.liveCar = true; // Simulate real G30 SP18 with no mock fallback

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

    // 4. Steering Wheel PTT Capacitive Guard, Full Daemon E2E, Stereo WAV Gemini & Coalesced IPC
    await step('Steering PTT capacitive guard, Gemini stereo WAV E2E, ctl.sock & coalesced hmi.json writes', async () => {
        const pttEvents = [];
        const cTest = new CarControl.CarController({ onPttEvent: (ev) => pttEvents.push(ev) });
        // Simulate real press -> release
        cTest.handleSteeringPttSignal(true);
        await new Promise((r) => setTimeout(r, 40));
        cTest.handleSteeringPttSignal(false);
        assert.strictEqual(pttEvents.length, 1);
        assert.strictEqual(pttEvents[0].kind, 'short_press');

        // Mock Gemini server returning structured JSON
        const mockGem = http.createServer((req, res) => {
            const chunks = [];
            req.on('data', (c) => chunks.push(c));
            req.on('end', () => {
                const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
                assert.strictEqual(body.generationConfig.responseMimeType, 'application/json');
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
            quiet: true,
            geminiBaseUrl: 'http://127.0.0.1:' + mockGem.address().port,
        });
        await dm.start();
        dm.saveSettings({ apiKey: 'AIzaSyTestBmwVoiceKey1234' });

        // Passenger speaks louder into Right ceiling mic without naming a zone -> adjusts Passenger temp to 21.5°C!
        const wavPass = MicCapture.buildStereoWav(new Array(2400).fill(0.03), new Array(2400).fill(0.45), 16000);
        const turn = await dm.handleTurn({
            audioWavBase64: wavPass.toString('base64'),
            audioMimeType: 'audio/wav',
        });
        assert.strictEqual(turn.ok, true);
        assert.strictEqual(turn.speakerZone, 'passenger');
        assert.strictEqual(dm.car.state.climate.tempPassengerC, 21.5);
        assert.strictEqual(dm.car.state.climate.tempDriverC, 22.5);

        // `ctl.sock` instant HMI command execution
        const sockPath = path.join(tmp, 'run', 'ctl.sock');
        await new Promise((resolve, reject) => {
            const s = net.createConnection(sockPath, () => {
                s.end(JSON.stringify({ id: 777, cmd: 'ask_text', arg: { text: 'Đèn viền màu xanh băng', speakerZone: 'driver' } }) + '\n', resolve);
            });
            s.on('error', reject);
        });
        await new Promise((r) => setTimeout(r, 120));
        assert.strictEqual(dm.car.state.ambient.key, 'cyan');

        // 50 rapid RPM/speed packets do ZERO writes (even after timer!) because HMI ignores high-rate FlexRay noise
        const beforeWrites = dm.statusWriteCount;
        for (let i = 0; i < 50; i++) {
            dm.car.patchState({ rpm: 900 + i * 15, speedKmh: 30 + (i % 10) });
        }
        await new Promise((r) => setTimeout(r, 450));
        assert.strictEqual(dm.statusWriteCount, beforeWrites);

        // 50 rapid cabin/thermal updates do ZERO sync writes and coalesce into 1 write!
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

    // 5. Zero-Lag Single-Screen OEM BMW IPA UI (`apps/bmw_voice/ui.js`)
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
            settings: { hasApiKey: true, apiKeyMasked: 'AIzaSy••••1234' },
            car: CarControl.createInitialState(),
            lastTurn: { idle: false, ok: true, transcript: 'Điều hoà 22 độ', replyVi: 'Đã chỉnh điều hoà ghế tài 22°C' },
        };

        // Render QR setup screen 15 times -> QR.encode called ONLY ONCE!
        for (let i = 0; i < 15; i++) {
            const r = new Recorder(UI.W, UI.H);
            UI.draw(r, realG, theme, baseModel, {});
        }
        assert.strictEqual(qrCalls, 1);

        // Render normal IPA screen twice -> 100% identical words for zero-CPU frame skip!
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
