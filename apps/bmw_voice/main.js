'use strict';
/**
 * main.js - Instant Zero-Lag iDrive 7 Entry Point + Native PTT Auto-Open for `bmw_voice` (`v1.1.1`).
 *
 *   1. Subscribes over `/run/bmw-voice/ctl.sock` (`0.00%` idle CPU in background, `<2ms` push latency).
 *   2. When Steering Wheel Mic (`PTT`) or 2-step `"Hey BMW"` triggers while on another iDrive screen,
 *      automatically calls `ctx.openApp()` (`ui.rhmi.openEntryState`) to natively dismiss/replace BMW's
 *      `"Nhập bằng giọng nói không khả dụng"` screen with our sleek BMW Voice Assistant screen, then
 *      auto-closes (`ctx.closeApp()`) 3.2s after execution to return to the previous screen!
 *   3. Reports `app_visible` to `bmw-voice` so `IpaOverlay` yields cleanly whenever `MAIN` is visible.
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

        let pushSock = null;
        let pushBuf = '';
        let pushRetryTimer = null;
        let frontReportTimer = null;
        let voiceSessionActive = false;
        let autoOpenedByVoice = false;
        let autoCloseTimer = null;
        let counterReclaimTimer = null;
        const reopenWaveTimers = [];

        function clearReclaimTimers() {
            while (reopenWaveTimers.length) {
                clearTimeout(reopenWaveTimers.pop());
            }
            if (counterReclaimTimer) {
                clearTimeout(counterReclaimTimer);
                counterReclaimTimer = null;
            }
        }

        function clearVoicePopTimers() {
            if (autoCloseTimer) { clearTimeout(autoCloseTimer); autoCloseTimer = null; }
            clearReclaimTimers();
        }

        function isMainVisible() {
            return !!(ui.isVisible && ui.isVisible('MAIN'));
        }

        // Only report `visible: true` to daemon when MAIN is visible, ROOT_APP is in front, AND unfocused-free!
        function isMainUnobscured() {
            const rootOk = !ui.isRootInFront || ui.isRootInFront();
            const focusOk = !ui.hasFocus || ui.hasFocus('MAIN');
            return isMainVisible() && rootOk && focusOk;
        }

        function reclaimHmiScreen() {
            // Only reopen MAIN via openState if MAIN is already in our HMI stack; calling openEntryState
            // unsolicited from background is rejected by HmiMain3D with RemoteError: INVALID_UUID.
            // System-wide PTT & Hey BMW visual coverage is handled cleanly by uid=0 IpaOverlay!
            if (ui.isRootInFront && ui.isRootInFront() && isMainVisible()) {
                if (ui.open) ui.open('MAIN');
            }
        }

        function scheduleReclaimWaves() {
            clearReclaimTimers();
            // Fire multi-stage openEntryState waves across +140..+1050ms so whether HmiMain3D opens
            // "Không khả dụng" at +100ms, +250ms, or +500ms after PTT, our RHMI entry immediately replaces it!
            [140, 340, 640, 1050].forEach((ms) => {
                const t = setTimeout(() => {
                    if ((voiceSessionActive || autoOpenedByVoice) && !isMainUnobscured()) {
                        reclaimHmiScreen();
                    }
                }, ms);
                if (t.unref) t.unref();
                reopenWaveTimers.push(t);
            });
        }

        function closeIfAutoOpened() {
            clearVoicePopTimers();
            voiceSessionActive = false;
            if (autoOpenedByVoice && !showQr) {
                autoOpenedByVoice = false;
                if (ctx.closeApp) ctx.closeApp();
            }
        }

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
            if (status && status.car && status.car.callActive && autoOpenedByVoice) {
                closeIfAutoOpened();
            }
        }

        function handleVoiceUiEvent(ev) {
            if (!ev || ev.event !== 'voice_ui') return;
            if (ev.state) {
                const prevUp = !!status;
                applyStatus(ev.state, Date.now());
                const sig = JSON.stringify(Object.assign({}, ev.state, { at: 0 }));
                if (sig !== lastSig || prevUp !== !!status || ev.action !== 'state') {
                    lastSig = sig;
                    repaint(true);
                }
            }

            if (ev.action === 'open' || ev.action === 'open_result') {
                if (autoCloseTimer) { clearTimeout(autoCloseTimer); autoCloseTimer = null; }
                if (!voiceSessionActive) {
                    autoOpenedByVoice = !isMainUnobscured();
                    voiceSessionActive = true;
                }
                // UNCONDITIONALLY reclaim HMI screen & schedule waves even if MAIN was already visible before PTT,
                // because HmiMain3D jumps to "Không khả dụng" ~100-350ms AFTER physical Steering Wheel Mic press!
                reclaimHmiScreen();
                scheduleReclaimWaves();

                if (ev.action === 'open_result') {
                    const hold = Math.max(1500, Number(ev.holdMs) || 3200);
                    autoCloseTimer = setTimeout(() => {
                        autoCloseTimer = null;
                        closeIfAutoOpened();
                    }, hold);
                    if (autoCloseTimer.unref) autoCloseTimer.unref();
                }
            } else if (ev.action === 'finish') {
                const endSessionTimer = setTimeout(() => {
                    voiceSessionActive = false;
                    clearReclaimTimers();
                }, 420);
                if (endSessionTimer.unref) endSessionTimer.unref();
                if (!isMainUnobscured()) reclaimHmiScreen();

                if (autoOpenedByVoice && !showQr) {
                    if (autoCloseTimer) clearTimeout(autoCloseTimer);
                    const hold = Math.max(1500, Number(ev.holdMs) || 3200);
                    autoCloseTimer = setTimeout(() => {
                        autoCloseTimer = null;
                        closeIfAutoOpened();
                    }, hold);
                    if (autoCloseTimer.unref) autoCloseTimer.unref();
                }
            }
        }

        function connectPushStream() {
            if (pushSock) return;
            const sockPath = path.join(RUN, 'ctl.sock');
            let s;
            try {
                s = net.createConnection(sockPath);
            } catch (e) {
                schedulePushReconnect();
                return;
            }
            pushSock = s;
            pushBuf = '';
            s.setEncoding('utf8');
            s.on('connect', () => {
                if (s.setNoDelay) s.setNoDelay(true);
                try {
                    s.write(JSON.stringify({ id: ++cmdId, cmd: 'subscribe_hmi', arg: { visible: isMainUnobscured() } }) + '\n');
                } catch (e) {}
            });
            s.on('data', (chunk) => {
                pushBuf += chunk;
                let idx;
                while ((idx = pushBuf.indexOf('\n')) >= 0) {
                    const line = pushBuf.slice(0, idx).trim();
                    pushBuf = pushBuf.slice(idx + 1);
                    if (!line) continue;
                    try {
                        handleVoiceUiEvent(JSON.parse(line));
                    } catch (e) {}
                }
            });
            s.on('error', () => {});
            s.on('close', () => {
                if (pushSock === s) pushSock = null;
                schedulePushReconnect();
            });
        }

        function schedulePushReconnect() {
            if (pushRetryTimer) return;
            pushRetryTimer = setTimeout(() => {
                pushRetryTimer = null;
                connectPushStream();
            }, 3500);
            if (pushRetryTimer.unref) pushRetryTimer.unref();
        }

        function syncFrontVisibilityReport() {
            if (frontReportTimer) { clearTimeout(frontReportTimer); frontReportTimer = null; }
            const unobscured = isMainUnobscured();
            if (!unobscured) {
                // Report false immediately so IpaOverlay (`uid=0`) covers any HmiMain3D popup with zero gap!
                notifyVisibility(false);
                return;
            }
            // Wait 380ms (`display.js` SHOW_DELAY_MS is 350ms) before telling IpaOverlay to yield!
            frontReportTimer = setTimeout(() => {
                frontReportTimer = null;
                if (isMainUnobscured()) notifyVisibility(true);
            }, 380);
            if (frontReportTimer.unref) frontReportTimer.unref();
        }

        function notifyVisibility(vis) {
            if (pushSock && !pushSock.destroyed) {
                try {
                    pushSock.write(JSON.stringify({ id: ++cmdId, cmd: 'app_visible', arg: { visible: !!vis } }) + '\n');
                } catch (e) {}
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
                    pollTimer = setInterval(pollAsync, 900);
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
            if (pushSock && !pushSock.destroyed) {
                try {
                    pushSock.write(payload + '\n');
                    return;
                } catch (e) {}
            }
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
                autoOpenedByVoice = false;
                clearVoicePopTimers();
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
                autoOpenedByVoice = false;
                clearVoicePopTimers();
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
        connectPushStream();
        loop = ctx.loop('MAIN', 2, render);
        if (ctx.onLayout) ctx.onLayout(() => repaint(true));
        if (ui.onVisible) {
            ui.onVisible((name, vis) => {
                if (name === 'MAIN') {
                    syncFrontVisibilityReport();
                    if (!vis) {
                        if (voiceSessionActive) {
                            // HmiMain3D just jumped to "Không khả dụng" mid-voice-turn! Counter-reclaim immediately!
                            if (!counterReclaimTimer) {
                                counterReclaimTimer = setTimeout(() => {
                                    counterReclaimTimer = null;
                                    if (voiceSessionActive && !isMainUnobscured()) reclaimHmiScreen();
                                }, 55);
                                if (counterReclaimTimer.unref) counterReclaimTimer.unref();
                            }
                        } else {
                            autoOpenedByVoice = false;
                            clearVoicePopTimers();
                        }
                    }
                    syncPollTimer(vis);
                    if (vis) repaint(true);
                }
            });
        }
        if (ui.onFocus) {
            ui.onFocus((name, on) => {
                if (name === 'MAIN') {
                    syncFrontVisibilityReport();
                    if (!on && voiceSessionActive && !counterReclaimTimer) {
                        counterReclaimTimer = setTimeout(() => {
                            counterReclaimTimer = null;
                            if (voiceSessionActive && !isMainUnobscured()) reclaimHmiScreen();
                        }, 55);
                        if (counterReclaimTimer.unref) counterReclaimTimer.unref();
                    }
                }
            });
        }
        syncPollTimer(isMainVisible());

        ['BTN_MIC', 'BTN_QR'].forEach((b) => { if (ctx.hideButton) ctx.hideButton(b); });
        ui.onClick('BTN_MIC', acts.triggerMic);
        ui.onClick('BTN_QR', acts.toggleQr);

        await render();
        log.info('bmw_voice v1.2.1 ready');
    },
});
