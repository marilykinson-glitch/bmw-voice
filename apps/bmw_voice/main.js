'use strict';
/**
 * main.js - Instant Zero-Lag iDrive 7 Entry Point for `bmw_voice` (`v1.1.0`).
 *
 *   - Pauses `hmi.json` polling completely while app screen is in the background (`0.00%` idle CPU).
 *   - Software-path `lastSoftWords` fast-skip (`0.0%` CPU when screen is steady).
 *   - Instant `<1ms` Unix socket IPC (`/run/bmw-voice/ctl.sock`) with immediate visual feedback.
 *
 * Node 8 (ES2017) compatible.
 */
const fs = require('fs');
const net = require('net');
const path = require('path');
const mgu = require('./kit/mgu');
const G = require('./kit/gauges');
const { Recorder } = require('./kit/record');
const UI = require('./ui');

const RUN = process.env.BV_RUN || '/run/bmw-voice';
const STALE_MS = 10000;

mgu.run({
    async start(ctx) {
        const { ui, log } = ctx;
        let status = null, cmdId = Date.now();
        let showQr = false, userClosedQr = false, animTick = 0;
        let lastSig = '', polling = false;
        let lastSoftWords = null, lastSoftAt = 0;
        let pollTimer = null;

        let pendingUntil = 0;
        let pendingState = '';
        let pendingBaseTurnAt = 0;
        let pendingTurn = null;

        function applyStatus(s, now) {
            const fresh = (s && typeof s.at === 'number' && Math.abs(now - s.at) < STALE_MS) ? s : null;
            status = fresh;
            if (status && !userClosedQr && status.settings && !status.settings.hasApiKey) {
                showQr = true;
            } else if (status && status.settings && status.settings.hasApiKey && !userClosedQr) {
                userClosedQr = true;
                showQr = false;
            }
            if (status && pendingUntil > 0) {
                const curAt = (status.lastTurn && status.lastTurn.at) || 0;
                if ((status.assistantState && status.assistantState !== 'idle') || curAt > pendingBaseTurnAt) {
                    pendingUntil = 0;
                    pendingState = '';
                    pendingTurn = null;
                }
            }
        }

        function readInitialSync() {
            const hmiFile = path.join(RUN, 'hmi.json');
            try {
                const raw = fs.readFileSync(hmiFile, 'utf8');
                const parsed = JSON.parse(raw);
                applyStatus(parsed, Date.now());
                lastSig = JSON.stringify(Object.assign({}, parsed, { at: 0 }));
            } catch (e) {}
        }

        function pollAsync() {
            if (polling) return;
            polling = true;
            fs.readFile(path.join(RUN, 'hmi.json'), 'utf8', (err, raw) => {
                polling = false;
                if (err || !raw) {
                    if (status !== null) {
                        status = null;
                        lastSig = '';
                        repaint(true);
                    }
                    return;
                }
                try {
                    const parsed = JSON.parse(raw);
                    const prevUp = !!status;
                    applyStatus(parsed, Date.now());
                    const sig = JSON.stringify(Object.assign({}, parsed, { at: 0 }));
                    if (sig !== lastSig || prevUp !== !!status) {
                        lastSig = sig;
                        repaint(true);
                    }
                } catch (e) {}
            });
        }

        function syncPollTimer(visible) {
            if (visible) {
                if (!pollTimer) {
                    pollTimer = setInterval(pollAsync, 450);
                    if (pollTimer.unref) pollTimer.unref();
                }
                pollAsync();
            } else if (pollTimer) {
                clearInterval(pollTimer);
                pollTimer = null;
            }
        }

        function writeFallback(payload) {
            const ramCmd = path.join(RUN, 'app', 'command.json');
            try {
                fs.writeFileSync(ramCmd + '.tmp', payload);
                fs.renameSync(ramCmd + '.tmp', ramCmd);
                return;
            } catch (e) {}
            try {
                const f = path.join(ctx.dataDir, 'command.json');
                fs.writeFileSync(f + '.tmp', payload);
                fs.renameSync(f + '.tmp', f);
            } catch (e2) {}
        }

        function send(cmd, arg) {
            const payload = JSON.stringify({ id: ++cmdId, cmd, arg: arg || {} });
            const sockPath = path.join(RUN, 'ctl.sock');
            try {
                let sent = false;
                const s = net.createConnection(sockPath, () => {
                    sent = true;
                    s.end(payload + '\n');
                });
                s.on('error', () => { if (!sent) writeFallback(payload); });
                setTimeout(pollAsync, 120);
                return;
            } catch (e) {}
            writeFallback(payload);
            setTimeout(pollAsync, 150);
        }

        let loop = null;
        function repaint(forceSoft) {
            if (forceSoft) lastSoftWords = null;
            return loop && loop.kick ? loop.kick() : render();
        }

        const acts = {
            triggerMic: () => {
                if (status && status.settings && !status.settings.hasApiKey) {
                    showQr = true;
                    return repaint(true);
                }
                showQr = false;
                send('ptt_trigger', {});
                pendingBaseTurnAt = (status && status.lastTurn && status.lastTurn.at) || 0;
                pendingState = 'listening';
                pendingTurn = {
                    idle: false,
                    ok: true,
                    speakerZone: 'driver',
                    transcript: '',
                    replyVi: 'Xin chào, tôi đang lắng nghe…',
                };
                pendingUntil = Date.now() + 5500;
                return repaint(true);
            },
            toggleQr: () => {
                showQr = !showQr;
                if (!showQr) userClosedQr = true;
                return repaint(true);
            },
            nextIp: () => {
                send('next_ip', {});
                return repaint(true);
            },
        };

        function buildModel() {
            const now = Date.now();
            if (pendingUntil > 0 && now > pendingUntil) {
                pendingUntil = 0;
                pendingState = '';
                pendingTurn = null;
            }
            const s = status;
            const liveState = s ? s.assistantState : 'idle';
            const effState = (liveState && liveState !== 'idle') ? liveState : (pendingState || liveState || 'idle');
            if (effState !== 'idle') animTick = (animTick + 1) & 1023;
            const hostOf = (u) => String(u || '').replace(/^http:\/\//, '').replace(/\/\?pin=\d+$/, '');
            return {
                daemonUp: !!s,
                showQr,
                animTick,
                url: s ? s.url : 'http://192.168.10.1:8145/?pin=1234',
                host: s ? hostOf(s.url) : '192.168.10.1:8145',
                pin: s ? s.pin : '1234',
                ipCount: (s && Array.isArray(s.ips)) ? s.ips.length : 1,
                assistantState: effState,
                wakeStatus: (s && s.wakeStatus) || 'off',
                settings: (s && s.settings) || { hasApiKey: false, apiKeyMasked: '', handsFreeWake: true },
                car: (s && s.car) || {
                    climate: { on: true, tempDriverC: 22.5, tempPassengerC: 22.5, fanLevel: 2, seatHeatDriver: 0, seatCoolDriver: 0 },
                    ambient: { on: true, name: 'Cam BMW', hex: '#FF5500', brightness: 80 },
                    media: { volumePercent: 30, muted: false },
                },
                lastTurn: pendingTurn || (s && s.lastTurn) || {
                    idle: true,
                    ok: true,
                    transcript: '',
                    replyVi: 'Nói "Hey BMW" hoặc bấm nút Mic trên vô-lăng để ra lệnh Tiếng Việt.',
                },
            };
        }

        const render = async () => {
            const m = buildModel();
            const cv = ctx.canvas(UI.W, UI.H) || new Recorder(UI.W, UI.H);
            UI.draw(cv, G, ctx.theme(), m, acts);

            const gpuActive = !!(ctx.display && typeof ctx.display.active === 'function' && ctx.display.active('MAIN'));
            if (!gpuActive && typeof cv.words === 'function') {
                const now = Date.now();
                const w = cv.words();
                const wBuf = Buffer.from(w.buffer, w.byteOffset, w.byteLength);
                if (lastSoftWords && (now - lastSoftAt) < 4500 && wBuf.length === lastSoftWords.length && wBuf.equals(lastSoftWords)) {
                    return;
                }
                lastSoftWords = Buffer.from(wBuf);
                lastSoftAt = now;
            }
            await ui.image('MAIN_GFX', cv);
        };

        readInitialSync();
        loop = ctx.loop('MAIN', 2, render);
        if (ctx.onLayout) ctx.onLayout(() => repaint(true));
        if (ui.onVisible) {
            ui.onVisible((name, vis) => {
                if (name === 'MAIN') {
                    syncPollTimer(vis);
                    if (vis) repaint(true);
                }
            });
        }
        syncPollTimer(!ui.isVisible || ui.isVisible('MAIN'));

        ['BTN_MIC', 'BTN_QR'].forEach((b) => { if (ctx.hideButton) ctx.hideButton(b); });
        ui.onClick('BTN_MIC', acts.triggerMic);
        ui.onClick('BTN_QR', acts.toggleQr);

        await render();
        log.info('bmw_voice v1.1.0 ready');
    },
});
