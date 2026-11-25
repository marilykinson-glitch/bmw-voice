'use strict';
/**
 * nlu-brain.js - Fast Deterministic Vietnamese NLU + Gemini Multimodal Audio Decoder (`bmw-voice`).
 *
 * Principles:
 *   1. Strictly scoped to the 6 real OEM BMW IPA capabilities (`set_climate`, `set_seat_comfort`,
 *      `set_ambient_light`, `control_media`, `control_windows`, `query_vehicle_status`).
 *   2. Honest hardware boundary: if the driver asks for physical-switch-only functions on BMW G30 SP18
 *      (trunk pop, mirror fold, overhead reading lamp), immediately replies honestly without faking success.
 *   3. Zero-hallucination confirmation: the displayed status text is ALWAYS built from actual hardware
 *      execution results (`r.summaryVi`), never from optimistic LLM prose.
 *
 * Node 8 (ES2017) compatible.
 */
const Up = require('./uplink');

const COMPACT_SYSTEM_PROMPT = [
    'Bạn là bộ giải mã giọng nói Tiếng Việt cho Trợ lý BMW nguyên bản trên xe BMW iDrive 7.',
    'Trả về DUY NHẤT 1 JSON hợp lệ (không markdown):',
    '{"speechDetected":bool,"transcript":"câu tiếng Việt nghe được nguyên văn","toolCalls":[{"name":"...","args":{...}}],"unsupportedReason":""}',
    'Nếu băng ghi âm chỉ có tiếng ồn/im lặng: {"speechDetected":false,"transcript":"","toolCalls":[],"unsupportedReason":""}',
    'DANH SÁCH ĐÚNG 6 CÔNG CỤ HỖ TRỢ TRÊN XE BMW:',
    '1. set_climate: {systemOn?:bool, maxAc?:bool, defrost?:bool, tempC?:16..28, deltaTempC?:-3..3, zone?:"driver"|"passenger"|"both", fanLevel?:1..5, freshAir?:bool, sync?:bool}',
    '   ("tôi nóng quá" -> deltaTempC:-1.5; "tôi lạnh quá" -> deltaTempC:1.5; nếu nói "2 bên / cả xe" -> zone:"both")',
    '2. set_seat_comfort: {seat?:"driver"|"passenger"|"both", heatingLevel?:0..3, coolingLevel?:0..3, massage?:bool, wheelHeat?:bool}',
    '3. set_ambient_light: {on?:bool, color?:"bronze"|"orange"|"white"|"blue"|"cyan"|"green"|"lilac"|"red", brightness?:10..100}',
    '4. control_media: {action:"volume"|"volume_up"|"volume_down"|"mute"|"unmute"|"play"|"pause"|"next"|"previous", volumePercent?:0..100}',
    '5. control_windows: {target:"driver"|"passenger"|"rear"|"all"|"sunroof"|"sunshade", action:"open"|"close"|"vent"}',
    '6. query_vehicle_status: {} (khi hỏi tình trạng xe, nhiệt độ dầu, nước mát, bình ắc quy, xăng, áp suất lốp)',
    'Nếu người lái yêu cầu mở cốp sau, gập gương, khoá cửa hoặc đèn đọc sách trần xe: để toolCalls:[] và ghi unsupportedReason ngắn gọn rằng trên BMW G30 chức năng đó dùng nút bấm vật lý.',
].join('\n');

function detectPhysicalOnlyUnsupported(text) {
    const low = String(text || '').toLowerCase();
    if (!low) return '';
    if (/(mở|đóng)\s+cốp|cốp\s+sau/.test(low)) {
        return 'Mở/đóng cốp trên BMW G30 dùng nút vật lý bên cửa tài hoặc chìa khoá.';
    }
    if (/(gập|cụp|mở)\s+gương|gương\s+chiếu\s+hậu/.test(low)) {
        return 'Gập/mở gương chiếu hậu trên BMW G30 dùng nút vật lý trên cụm cửa tài.';
    }
    if (/đèn\s+(đọc\s+sách|trần)/.test(low)) {
        return 'Đèn đọc sách trên BMW G30 bật/tắt bằng nút vật lý trên cụm trần xe.';
    }
    return '';
}

function parseOfflineVietnamese(rawText, speakerZone) {
    const text = String(rawText || '').trim();
    const low = text.toLowerCase();
    if (!low) return [];

    const zone = /(cả\s*2|hai\s*bên|cả\s*xe|2\s*vùng|toàn\s*xe)/.test(low) ? 'both'
        : /(ghế\s*phụ|bên\s*phụ)/.test(low) ? 'passenger'
            : /(ghế\s*tài|ghế\s*lái|bên\s*tài)/.test(low) ? 'driver'
                : (speakerZone || 'driver');

    const calls = [];

    // 1. Climate & Defrost
    const clim = {};
    let hasClim = false;

    if (/max\s*a\/?c|làm\s*lạnh\s*tối\s*đa|lạnh\s*hết\s*cỡ/.test(low)) {
        clim.maxAc = !/tắt\s+max/.test(low);
        hasClim = true;
    }
    if (/sấy\s*kính|mờ\s*kính|tan\s*sương/.test(low)) {
        clim.defrost = !/tắt\s+sấy/.test(low);
        hasClim = true;
    }
    if (/đồng\s*bộ\s*(điều\s*hoà|nhiệt\s*độ)|\bsync\b/.test(low)) {
        clim.sync = !/tắt\s+(đồng\s*bộ|sync)/.test(low);
        hasClim = true;
    }
    if (/gió\s*trong|tuần\s*hoàn/.test(low)) {
        clim.freshAir = false;
        hasClim = true;
    } else if (/gió\s*(ngoài|tươi)/.test(low)) {
        clim.freshAir = true;
        hasClim = true;
    }
    if (/tắt\s+(điều\s*hoà|máy\s*lạnh|\bac\b)/.test(low)) {
        clim.systemOn = false;
        hasClim = true;
    } else if (/bật\s+(điều\s*hoà|máy\s*lạnh|\bac\b)/.test(low)) {
        clim.systemOn = true;
        hasClim = true;
    }

    const tempM = /(?:điều\s*hoà|nhiệt\s*độ|máy\s*lạnh|chỉnh|hạ|tăng|xuống|lên|đặt)?\s*(\d{2}(?:[.,]5)?)\s*(?:độ|°|c\b)/.exec(low);
    if (tempM) {
        const tv = parseFloat(tempM[1].replace(',', '.'));
        if (tv >= 16 && tv <= 28) {
            clim.tempC = tv;
            clim.zone = zone;
            hasClim = true;
        }
    } else if (!clim.maxAc && /(nóng\s*quá|hơi\s*nóng|giảm\s*nhiệt|hạ\s*nhiệt)/.test(low)) {
        clim.deltaTempC = -1.5;
        clim.zone = zone;
        hasClim = true;
    } else if (/(lạnh\s*quá|rét\s*quá|hơi\s*lạnh|tăng\s*nhiệt)/.test(low)) {
        clim.deltaTempC = 1.5;
        clim.zone = zone;
        hasClim = true;
    }

    const fanM = /(?:mức\s*gió|quạt\s*gió|gió\s*mức|gió\s*số|quạt\s*số|gió)\s*([1-5])/.exec(low);
    if (fanM) {
        clim.fanLevel = parseInt(fanM[1], 10);
        clim.zone = zone;
        hasClim = true;
    }
    if (hasClim) calls.push({ name: 'set_climate', args: clim });

    // 2. Seat Heating / Cooling / Massage / Steering Wheel Heat
    const seat = {};
    let hasSeat = false;
    if (/sưởi\s*vô[\s-]*lăng|ấm\s*vô[\s-]*lăng/.test(low)) {
        seat.wheelHeat = !/tắt/.test(low);
        hasSeat = true;
    }
    if (/sưởi\s*ghế|ấm\s*ghế/.test(low)) {
        const m = /mức\s*([0-3])|số\s*([0-3])/.exec(low);
        seat.heatingLevel = /tắt/.test(low) ? 0 : (m ? parseInt(m[1] || m[2], 10) : 2);
        seat.seat = zone;
        hasSeat = true;
    }
    if (/(làm\s*mát|thông\s*gió|quạt)\s*ghế|mát\s*ghế/.test(low)) {
        const m = /mức\s*([0-3])|số\s*([0-3])/.exec(low);
        seat.coolingLevel = /tắt/.test(low) ? 0 : (m ? parseInt(m[1] || m[2], 10) : 2);
        seat.seat = zone;
        hasSeat = true;
    }
    if (/massage|mát[\s-]*xa/.test(low)) {
        seat.massage = !/tắt/.test(low);
        seat.seat = zone;
        hasSeat = true;
    }
    if (hasSeat) calls.push({ name: 'set_seat_comfort', args: seat });

    // 3. OEM Ambient Light
    if (/đèn\s*(viền|nội\s*thất|ambient|led)|đổi\s*màu\s*đèn|màu\s*đèn/.test(low)) {
        const amb = {};
        if (/tắt\s*đèn/.test(low)) {
            amb.on = false;
        } else {
            if (/bật\s*đèn/.test(low)) amb.on = true;
            if (/đồng|vàng|hổ\s*phách|bronze|amber/.test(low)) amb.color = 'bronze';
            else if (/cam|orange/.test(low)) amb.color = 'orange';
            else if (/đỏ|red/.test(low)) amb.color = 'red';
            else if (/trắng|white/.test(low)) amb.color = 'white';
            else if (/xanh\s*(băng|ngọc)|cyan/.test(low)) amb.color = 'cyan';
            else if (/xanh\s*(lá|lục)|green/.test(low)) amb.color = 'green';
            else if (/tím|hồng|lilac|purple/.test(low)) amb.color = 'lilac';
            else if (/xanh|blue/.test(low)) amb.color = 'blue';
        }
        const brM = /(?:độ\s*sáng|sáng|mức)\s*(\d{1,3})\s*%?/.exec(low);
        if (brM) amb.brightness = Math.max(10, Math.min(100, parseInt(brM[1], 10)));
        if (Object.keys(amb).length > 0) calls.push({ name: 'set_ambient_light', args: amb });
    }

    // 4. Audio Volume & Media Transport
    if (/tắt\s*(tiếng|âm|loa)|\bmute\b/.test(low)) {
        calls.push({ name: 'control_media', args: { action: 'mute' } });
    } else if (/bật\s*(tiếng|lại\s*tiếng|âm\s*thanh)|\bunmute\b/.test(low)) {
        calls.push({ name: 'control_media', args: { action: 'unmute' } });
    } else {
        const volM = /(?:âm\s*lượng|loa|volume|tiếng)\s*(?:mức|xuống|lên)?\s*(\d{1,3})\s*%?/.exec(low);
        if (volM) {
            calls.push({ name: 'control_media', args: { action: 'volume', volumePercent: Math.max(0, Math.min(100, parseInt(volM[1], 10))) } });
        } else if (/(tăng|to)\s*(âm\s*lượng|tiếng|loa)|to\s*lên/.test(low)) {
            calls.push({ name: 'control_media', args: { action: 'volume_up' } });
        } else if (/(giảm|nhỏ|hạ)\s*(âm\s*lượng|tiếng|loa)|nhỏ\s*lại/.test(low)) {
            calls.push({ name: 'control_media', args: { action: 'volume_down' } });
        }
    }

    if (/bài\s*(tiếp|kế|sau)|qua\s*bài|next\s*bài/.test(low)) {
        calls.push({ name: 'control_media', args: { action: 'next' } });
    } else if (/bài\s*(trước|cũ)|lùi\s*bài/.test(low)) {
        calls.push({ name: 'control_media', args: { action: 'previous' } });
    } else if (/(tạm\s*dừng|dừng|tắt)\s*nhạc|\bpause\b/.test(low)) {
        calls.push({ name: 'control_media', args: { action: 'pause' } });
    } else if (/(phát|mở|bật)\s*(tiếp\s*)?nhạc/.test(low)) {
        calls.push({ name: 'control_media', args: { action: 'play' } });
    }

    // 5. Power Windows & Sunroof
    if (/cửa\s*sổ\s*trời|cửa\s*nóc|sunroof/.test(low)) {
        const act = /(đóng|kéo\s*lại)/.test(low) ? 'close' : (/(hé|nghiêng)/.test(low) ? 'vent' : 'open');
        calls.push({ name: 'control_windows', args: { target: 'sunroof', action: act } });
    } else if (/rèm\s*(trần|cửa\s*sổ\s*trời|nóc)/.test(low)) {
        const act = /(đóng|kéo\s*lại)/.test(low) ? 'close' : 'open';
        calls.push({ name: 'control_windows', args: { target: 'sunshade', action: act } });
    } else if (/(hạ|mở|kéo|lên|đóng|hé)\s*(toàn\s*bộ\s*|4\s*|hết\s*)?kính/.test(low) && !/sấy\s*kính/.test(low)) {
        const act = /(lên|đóng)/.test(low) ? 'close' : (/hé/.test(low) ? 'vent' : 'open');
        const tgt = /(toàn\s*bộ|4\s*kính|hết\s*kính|tất\s*cả)/.test(low) ? 'all'
            : /phụ/.test(low) ? 'passenger'
                : /sau/.test(low) ? 'rear'
                    : (zone === 'passenger' ? 'passenger' : 'driver');
        calls.push({ name: 'control_windows', args: { target: tgt, action: act } });
    }

    // 6. Vehicle Status Check (like BMW IPA "Vehicle status / Tire pressure / Oil temperature")
    if (/(tình\s*trạng|kiểm\s*tra|khám|thông\s*số)\s*xe|áp\s*suất\s*lốp|nhiệt\s*độ\s*(dầu|nước)|bình\s*(ắc\s*quy|12v)|bao\s*nhiêu\s*xăng|còn\s*mấy\s*vạch\s*xăng/.test(low)) {
        calls.push({ name: 'query_vehicle_status', args: {} });
    }

    return calls;
}

function parseJsonLoose(raw) {
    const s = String(raw || '').trim();
    if (!s) return null;
    const stripped = s.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
    try { return JSON.parse(stripped); } catch (e) {}
    const a = stripped.indexOf('{');
    const b = stripped.lastIndexOf('}');
    if (a >= 0 && b > a) {
        try { return JSON.parse(stripped.slice(a, b + 1)); } catch (e2) {}
    }
    return null;
}

async function decodeWithGemini(opts) {
    const model = opts.model || 'gemini-3-flash-preview';
    const userParts = [];
    if (opts.audioWavBase64) {
        userParts.push({
            inlineData: {
                mimeType: opts.audioMimeType || 'audio/wav',
                data: opts.audioWavBase64,
            },
        });
    }
    userParts.push({
        text: opts.text
            ? ('Người ngồi (' + opts.speakerZone + ') nói: "' + opts.text + '"')
            : ('Giải mã câu lệnh tiếng Việt của người ngồi (' + opts.speakerZone + ') từ đoạn âm thanh này.'),
    });

    const genCfg = {
        temperature: 0.05,
        maxOutputTokens: 260,
        responseMimeType: 'application/json',
    };
    if (/gemini-3/i.test(model)) {
        genCfg.thinkingConfig = { thinkingLevel: 'minimal' };
    } else if (/gemini-2\.5/i.test(model)) {
        genCfg.thinkingConfig = { thinkingBudget: 0 };
    }

    const body = JSON.stringify({
        systemInstruction: { parts: [{ text: COMPACT_SYSTEM_PROMPT }] },
        contents: [{ role: 'user', parts: userParts }],
        generationConfig: genCfg,
    });

    const res = await Up.request(opts.uplinkOpts || Up.options(), {
        host: 'generativelanguage.googleapis.com',
        path: '/v1beta/models/' + encodeURIComponent(model) + ':generateContent?key=' + encodeURIComponent(opts.apiKey),
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
        timeoutMs: 12000,
    });

    if (res.status < 200 || res.status >= 300) {
        throw new Error('Gemini HTTP ' + res.status);
    }
    const data = JSON.parse(res.body);
    const cand = data && data.candidates && data.candidates[0];
    const parts = (cand && cand.content && cand.content.parts) || [];
    let outText = '';
    for (let i = 0; i < parts.length; i++) {
        if (!parts[i].thought && parts[i].text) outText += parts[i].text;
    }
    const parsed = parseJsonLoose(outText);
    if (!parsed || typeof parsed !== 'object') {
        throw new Error('Phản hồi JSON không hợp lệ');
    }
    return parsed;
}

async function processVoiceOrText(opts) {
    const o = opts || {};
    const speakerZone = o.speakerZone === 'passenger' ? 'passenger' : 'driver';
    const car = o.carController;
    let transcript = String(o.text || '').trim();
    let plannedCalls = [];
    let unsupportedReason = '';
    let engine = 'offline';

    // Fast path: if text command is provided and matches deterministic Vietnamese NLU in <1ms, execute immediately!
    if (transcript && !o.audioWavBase64) {
        unsupportedReason = detectPhysicalOnlyUnsupported(transcript);
        if (!unsupportedReason) {
            plannedCalls = parseOfflineVietnamese(transcript, speakerZone);
        }
    }

    // Online Gemini path: always used for Ceiling Mic WAV audio, or unfamiliar text when API key is configured
    if (!plannedCalls.length && !unsupportedReason && o.apiKey && (o.audioWavBase64 || transcript)) {
        try {
            const gem = await decodeWithGemini({
                apiKey: o.apiKey,
                model: o.model || 'gemini-3-flash-preview',
                audioWavBase64: o.audioWavBase64 || '',
                audioMimeType: o.audioMimeType || 'audio/wav',
                text: transcript,
                speakerZone,
                uplinkOpts: o.uplinkOpts,
            });
            engine = 'gemini';
            if (gem.speechDetected === false && o.audioWavBase64) {
                return {
                    at: Date.now(),
                    ok: false,
                    engine,
                    speakerZone,
                    transcript: '',
                    replyVi: 'Chưa nghe rõ câu lệnh — bấm nút Mic vô-lăng và đọc lại giúp mình.',
                    actions: [],
                };
            }
            if (typeof gem.transcript === 'string' && gem.transcript.trim()) {
                transcript = gem.transcript.trim();
            }
            if (Array.isArray(gem.toolCalls) && gem.toolCalls.length > 0) {
                plannedCalls = gem.toolCalls.filter((c) => c && typeof c.name === 'string');
            }
            if (!plannedCalls.length && transcript) {
                unsupportedReason = detectPhysicalOnlyUnsupported(transcript) || String(gem.unsupportedReason || '').trim();
                if (!unsupportedReason) {
                    plannedCalls = parseOfflineVietnamese(transcript, speakerZone);
                }
            }
        } catch (e) {
            if (!transcript) {
                return {
                    at: Date.now(),
                    ok: false,
                    engine: 'net_err',
                    speakerZone,
                    transcript: '(Thu âm Mic trần)',
                    replyVi: 'Chưa kết nối mạng tới Gemini (' + e.message.slice(0, 80) + '). Kiểm tra Wi-Fi/4G xe.',
                    actions: [],
                };
            }
        }
    }

    if (unsupportedReason) {
        return {
            at: Date.now(),
            ok: false,
            engine,
            speakerZone,
            transcript,
            replyVi: unsupportedReason,
            actions: [],
        };
    }

    if (!plannedCalls.length) {
        return {
            at: Date.now(),
            ok: false,
            engine,
            speakerZone,
            transcript,
            replyVi: transcript
                ? 'Chưa nhận diện được lệnh xe BMW (thử: "Điều hoà 22 độ", "Đèn màu cam", "Âm lượng 30%", "Tình trạng xe").'
                : 'Cần dán Gemini API Key trong Cài đặt QR để nhận giọng nói Tiếng Việt từ Mic trần.',
            actions: [],
        };
    }

    const actions = [];
    for (let i = 0; i < plannedCalls.length; i++) {
        const tc = plannedCalls[i];
        const r = await car.executeTool(tc.name, tc.args || {}, speakerZone);
        actions.push({
            tool: tc.name,
            args: tc.args || {},
            ok: !!r.ok,
            summaryVi: r.summaryVi,
        });
    }

    const allOk = actions.length > 0 && actions.every((a) => a.ok);
    const replyVi = actions.map((a) => a.summaryVi).join(' · ');

    return {
        at: Date.now(),
        ok: allOk,
        engine,
        speakerZone,
        transcript,
        replyVi,
        actions,
    };
}

module.exports = {
    detectPhysicalOnlyUnsupported,
    parseOfflineVietnamese,
    processVoiceOrText,
};
