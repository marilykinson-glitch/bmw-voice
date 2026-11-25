'use strict';
/**
 * ui.js - Minimalist Single-Screen OEM BMW Intelligent Personal Assistant UI (`apps/bmw_voice`, 1600x520).
 *
 * Performance & Design:
 *   - Pure 1-screen BMW IPA layout: iconic BMW Voice Ring on the left + clean confirmation banner & live cabin strip on the right.
 *   - Zero tabs, zero clutter cards, zero 60fps idle animations (`0.0%` CPU when idle).
 *   - Cached `G.layer` panels & memoized `QR.encode` (`<0.5ms` render on both GPU and software RHMI paths).
 *
 * Node 8 (ES2017) compatible.
 */
const QR = require('./kit/qr');

const W = 1600, H = 520;
const nop = () => {};

const qrMatrixCache = new Map();
const fitCache = new Map();

function cleanText(s) {
    return String(s || '')
        .replace(/[\u201c\u201d\u201e\u00ab\u00bb]/g, '"')
        .replace(/[\u2018\u2019]/g, "'")
        .replace(/[\u2014\u2013]/g, '-');
}

function fit(cv, str, size, o, max) {
    str = cleanText(str);
    if (!str) return '';
    const fk = (o && o.font) || '';
    const key = size + '|' + max + '|' + fk + '|' + str;
    const hit = fitCache.get(key);
    if (hit !== undefined) return hit;

    let out = str;
    if (cv.textWidth(str, size, o) > max) {
        let s = str;
        while (s.length > 1 && cv.textWidth(s + '…', size, o) > max) s = s.slice(0, -1);
        out = s + '…';
    }
    if (fitCache.size >= 300) fitCache.clear();
    fitCache.set(key, out);
    return out;
}

function drawOemBox(cv, G, x, y, w, h, accent, bgAlpha) {
    x = Math.round(x); y = Math.round(y); w = Math.round(w); h = Math.round(h);
    const acc = accent || '#00a8ff';
    const ba = bgAlpha != null ? bgAlpha : 0.06;
    const paint = (c, ox, oy) => {
        c.fillRect(ox, oy, w, h, G.withAlpha('#b4bccc', ba));
        c.fillRect(ox, oy, w, 2, G.withAlpha(acc, 0.85));
        c.fillRect(ox, oy + h - 1, w, 1, G.withAlpha('#ffffff', 0.12));
        c.fillRect(ox, oy, 4, h, acc);
    };
    if (G && typeof G.layer === 'function' && typeof cv.blit === 'function') {
        const L = G.layer(['bv_box', w, h, acc, ba].join('|'), w, h, (c) => paint(c, 0, 0), cv.textScale || 1);
        cv.blit(L, x, y);
    } else {
        paint(cv, x, y);
    }
}

function drawCachedQr(cv, G, url, x, y, mod) {
    const text = String(url || '');
    if (!text) return 0;
    if (typeof QR.encode !== 'function') {
        return typeof QR.draw === 'function' ? QR.draw(cv, text, x, y, mod) : 185;
    }
    let q = qrMatrixCache.get(text);
    if (!q) {
        q = QR.encode(text);
        if (qrMatrixCache.size >= 12) qrMatrixCache.clear();
        qrMatrixCache.set(text, q);
    }
    const side = (q.length + 8) * mod;
    const paintQr = (c, ox, oy) => {
        c.fillRect(ox, oy, side, side, '#ffffff');
        for (let r = 0; r < q.length; r++) {
            const row = q[r];
            for (let col = 0; col < row.length;) {
                if (!row[col]) { col++; continue; }
                let e = col;
                while (e < row.length && row[e]) e++;
                c.fillRect(ox + (4 + col) * mod, oy + (4 + r) * mod, (e - col) * mod, mod, '#000000');
                col = e;
            }
        }
    };
    if (G && typeof G.layer === 'function' && typeof cv.blit === 'function') {
        const L = G.layer('bv_qr|' + mod + '|' + text, side, side, (c) => paintQr(c, 0, 0), 1);
        cv.blit(L, x, y);
    } else {
        paintQr(cv, x, y);
    }
    return side;
}

function drawIpaOrb(cv, G, t, cx, cy, state, animTick) {
    const active = state === 'listening' || state === 'thinking';
    const ringCol = state === 'listening' ? '#00e5ff' : (state === 'thinking' ? '#38bdf8' : '#0088ff');
    const step = active && ((animTick || 0) & 1) ? 5 : 0;

    cv.circle(cx, cy, 86 + step, G.withAlpha(ringCol, active ? 0.14 : 0.07));
    cv.circle(cx, cy, 66 + Math.floor(step / 2), G.withAlpha(ringCol, active ? 0.30 : 0.16));
    cv.circle(cx, cy, 48, G.withAlpha(ringCol, 0.92));
    cv.circle(cx, cy, 38, t.bg || '#080c14');
    cv.circle(cx, cy, 14, state === 'listening' ? '#ffffff' : ringCol);
}

function drawQrSetupScreen(cv, G, t, top, bottom, v, act) {
    const boxX = 160, boxW = W - 320, boxH = 320;
    const boxY = top + 24;
    const hasKey = !!(v.settings && v.settings.hasApiKey);
    drawOemBox(cv, G, boxX, boxY, boxW, boxH, hasKey ? '#2fd27a' : '#00a8ff', 0.065);

    if (v.daemonUp && v.url) {
        const qs = drawCachedQr(cv, G, v.url, boxX + 36, boxY + 34, 6) || 222;
        const tx = boxX + 72 + qs;
        const tw = boxW - (72 + qs) - 36;

        cv.text('CÀI ĐẶT TRỢ LÝ GIỌNG NÓI BMW', tx, boxY + 54, 24, t.text, { literal: true, font: 'bold' });
        cv.text(hasKey ? ('Trạng thái: ĐÃ CÀI GEMINI API KEY (' + (v.settings.apiKeyMasked || 'Sẵn sàng') + ')') : 'Trạng thái: CHƯA DÁN GEMINI API KEY',
            tx, boxY + 90, 17, hasKey ? '#2fd27a' : '#ffb020', { literal: true, font: 'bold' });

        cv.text('1. Kết nối điện thoại cùng mạng Wi-Fi / Hotspot với đầu xe MGU.', tx, boxY + 132, 16, t.dim, { literal: true, font: 'label' });
        cv.text('2. Quét mã QR bên trái rồi dán Gemini API Key một lần duy nhất.', tx, boxY + 162, 16, t.dim, { literal: true, font: 'label' });
        cv.text('3. Sau đó ở bất kỳ màn hình nào: nói "Hey BMW" hoặc bấm nút Mic vô-lăng!', tx, boxY + 192, 16, t.dim, { literal: true, font: 'label' });

        cv.text('ĐỊA CHỈ:', tx, boxY + 242, 15, t.dim, { literal: true, font: 'bold' });
        cv.text(fit(cv, v.host || '', 19, { literal: true, font: 'bold' }, tw - 260), tx + 92, boxY + 242, 19, '#38bdf8', { literal: true, font: 'bold' });

        cv.text('MÃ PIN: ' + String(v.pin || '----'), tx, boxY + 280, 22, t.text, { literal: true, font: 'bold' });

        if (v.ipCount > 1 && cv.target && act.nextIp) {
            cv.fillRect(tx + 240, boxY + 256, 130, 34, G.withAlpha('#ffffff', 0.10));
            cv.text('ĐỔI ĐỊA CHỈ IP', tx + 305, boxY + 279, 14, '#38bdf8', { literal: true, align: 'center', font: 'bold' });
            cv.target(tx + 240, boxY + 256, 130, 34, act.nextIp, 'bvNextIp');
        }
    } else {
        cv.text('ĐANG KHỞI ĐỘNG DỊCH VỤ BMW-VOICE…', W / 2, boxY + 150, 22, t.text, { literal: true, align: 'center', font: 'bold' });
        cv.text('Chờ vài giây sau khi mở khoá xe để dịch vụ kết nối.', W / 2, boxY + 190, 16, t.dim, { literal: true, align: 'center', font: 'label' });
    }

    const by = bottom - 50;
    G.button(cv, t, W / 2 - 170, by, 340, 50, 'Đóng cài đặt', act.toggleQr || nop, { key: 'bvBtnCloseQr', primary: true, color: '#0088ff' });
}

function draw(cv, G, t, v, act) {
    act = act || {};
    cv.clear(t.bg);

    const state = v.assistantState || 'idle';
    const hasKey = !!(v.settings && v.settings.hasApiKey);
    const wakeArmed = v.wakeStatus === 'armed';
    const badge = state === 'listening'
        ? { text: 'ĐANG NGHE…', color: 'info' }
        : (state === 'thinking'
            ? { text: 'ĐANG XỬ LÝ…', color: 'info' }
            : (!v.daemonUp
                ? { text: 'ĐANG KẾT NỐI', color: 'warn' }
                : (hasKey
                    ? { text: wakeArmed ? 'HEY BMW · SẴN SÀNG' : 'MIC VÔ-LĂNG · SẴN SÀNG', color: 'ok' }
                    : { text: 'CHƯA CÀI KEY', color: 'warn' })));

    G.frame(cv, t, [], -1, [badge]);

    const top = G.TOP + 14;
    const bottom = G.pageBottom(cv) - (cv.own ? G.MARGIN : 8);

    if (v.showQr) {
        drawQrSetupScreen(cv, G, t, top, bottom, v, act);
        return cv;
    }

    // Left Zone: Minimalist OEM BMW Intelligent Personal Assistant Voice Ring
    const orbCx = 225, orbCy = top + 162;
    drawIpaOrb(cv, G, t, orbCx, orbCy, state, v.animTick);

    const orbStatus = state === 'listening'
        ? 'ĐANG LẮNG NGHE…'
        : (state === 'thinking'
            ? 'ĐANG THỰC THI…'
            : (v.car && v.car.callActive
                ? 'ĐANG CÓ CUỘC GỌI'
                : (hasKey ? '"HEY BMW" · MIC VÔ-LĂNG' : 'BẤM CÀI ĐẶT QR')));
    const orbSub = state === 'listening'
        ? 'Ngừng nói 0.5s tự thực thi'
        : (hasKey ? 'Tự hiện giao diện trên mọi màn hình' : 'để dán Gemini API Key 1 lần');

    cv.text(orbStatus, orbCx, orbCy + 118, 17, state === 'listening' ? '#00e5ff' : t.text, { literal: true, align: 'center', font: 'bold' });
    cv.text(orbSub, orbCx, orbCy + 144, 14, t.dim, { literal: true, align: 'center', font: 'label' });
    if (cv.target) {
        cv.target(70, top + 30, 310, 310, hasKey ? (act.triggerMic || nop) : (act.toggleQr || nop), 'bvTapOrb');
    }

    // Right Zone: Clean OEM BMW Transcript + Confirmation + Compact Live Cabin Strip
    const rx = 420;
    const rw = W - 64 - rx;
    const turn = v.lastTurn || {};
    const car = v.car || {};
    const clim = car.climate || {};
    const amb = car.ambient || {};
    const med = car.media || {};

    cv.text('TRỢ LÝ GIỌNG NÓI BMW', rx, top + 32, 28, t.text, { literal: true, font: 'bold', spacing: 1.5 });
    G.stripes(cv, t, rx, top + 42, 168);

    // Main OEM Confirmation Box
    const boxY = top + 64, boxH = 148;
    const isIdleMsg = !!turn.idle || !turn.transcript;
    const boxAccent = state !== 'idle' ? '#00e5ff' : (isIdleMsg ? '#0088ff' : (turn.ok ? '#2fd27a' : '#ffb020'));
    const replyColor = state !== 'idle' ? '#ffffff' : (isIdleMsg ? t.text : (turn.ok ? '#4ade80' : '#fcd34d'));

    drawOemBox(cv, G, rx, boxY, rw, boxH, boxAccent, 0.065);

    const zonePrefix = turn.speakerZone === 'passenger' ? '[GHẾ PHỤ] ' : '';
    const cleanTr = cleanText(turn.transcript).trim().replace(/^"+|"+$/g, '').trim();
    const lineTop = cleanTr
        ? (zonePrefix + '"' + cleanTr + '"')
        : 'Hoạt động trên mọi màn hình (CarPlay / Bản đồ / Menu chính)';
    const lineMain = (turn.ok && !isIdleMsg ? '✓ ' : '') + cleanText(turn.replyVi || 'Nói "Hey BMW" hoặc bấm nút Mic trên vô-lăng.');

    cv.text(fit(cv, lineTop, 17, { literal: true, font: 'label' }, rw - 44), rx + 24, boxY + 46, 17, '#93c5fd', { literal: true, font: 'label' });
    cv.text(fit(cv, lineMain, 24, { literal: true, font: 'bold' }, rw - 44), rx + 24, boxY + 102, 24, replyColor, { literal: true, font: 'bold' });

    // Single Clean Horizontal Cabin Status Strip (4 live BMW domains)
    const stripY = boxY + boxH + 18, stripH = 68;
    drawOemBox(cv, G, rx, stripY, rw, stripH, amb.hex || '#0088ff', 0.045);

    const segW = Math.floor(rw / 4);
    const items = [
        ['ĐIỀU HOÀ', clim.on === false ? 'TẮT' : (clim.maxAc ? 'MAX AC 16°C' : ((clim.tempDriverC || 22.5) + '°C / ' + (clim.tempPassengerC || 22.5) + '°C · Gió ' + (clim.fanLevel || 2)))],
        ['GHẾ NGỒI', 'Sưởi ' + (clim.seatHeatDriver || 0) + ' · Mát ' + (clim.seatCoolDriver || 0) + (clim.massageDriver ? ' · Massage' : '')],
        ['ĐÈN VIỀN', amb.on === false ? 'TẮT' : ((amb.name || 'Cam BMW') + ' (' + (amb.brightness != null ? amb.brightness : 80) + '%)')],
        ['ÂM LƯỢNG', med.muted ? 'TẮT TIẾNG' : ('Loa ' + (med.volumePercent != null ? med.volumePercent : 30) + '%')],
    ];
    for (let i = 0; i < items.length; i++) {
        const sx = rx + i * segW + 22;
        if (i > 0) cv.fillRect(rx + i * segW, stripY + 14, 1, stripH - 28, G.withAlpha('#ffffff', 0.12));
        cv.text(items[i][0], sx, stripY + 26, 12, t.dim, { literal: true, font: 'bold' });
        cv.text(fit(cv, items[i][1], 17, { literal: true, font: 'bold' }, segW - 32), sx, stripY + 51, 17, t.text, { literal: true, font: 'bold' });
    }

    // Subtle Voice Examples Line
    cv.text(
        fit(cv, 'Ví dụ: "Hey BMW điều hoà 22 độ" · "Hey BMW làm mát ghế mức 2" · "Đèn viền màu cam" · "Bài tiếp theo" · "Tình trạng xe"', 14, { literal: true, font: 'label' }, rw),
        rx,
        stripY + stripH + 28,
        14,
        t.dim,
        { literal: true, font: 'label' }
    );

    // Bottom 2 Minimal OEM Buttons
    const by = bottom - 50;
    const bw = 270, bgap = 18;
    G.button(cv, t, rx, by, bw, 50,
        state === 'listening' ? 'Đang nghe…' : 'Nói lệnh',
        act.triggerMic || nop,
        { key: 'bvBtnMic', color: '#00a8ff', primary: state === 'listening' });

    G.button(cv, t, rx + bw + bgap, by, bw, 50,
        'Cài đặt QR',
        act.toggleQr || nop,
        { key: 'bvBtnQr' });

    return cv;
}

module.exports = { draw, W, H, qrMatrixCache };
