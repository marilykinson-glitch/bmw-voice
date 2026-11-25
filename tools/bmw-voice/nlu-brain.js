'use strict';
/**
 * nlu-brain.js - Deterministic Vietnamese NLU + Grounded Gemini Audio & "Hey BMW" Decoder (`bmw-voice` `v1.1.1`).
 *
 * Anti-Hallucination Architecture:
 *   1. Zero example sentences in Gemini system prompts (`temperature: 0.0`) so Gemini can NEVER parrot or append
 *      example commands onto unrelated speech or mic checks.
 *   2. Explicit Mic-Test recognizer ("Alo", "Mày nghe tao nói không?", "Nghe rõ không?"): responds cleanly confirming
 *      the ceiling mic is working with ZERO hardware calls, stripping any hallucinated trailing sentence.
 *   3. Deterministic Transcript Grounding (`groundToolCallsAgainstTranscript`):
 *      - Always prefers deterministic `parseOfflineVietnamese(transcript)` over raw LLM `toolCalls`.
 *      - Blocks any LLM `toolCalls` whose target domain keywords or numeric values (`tempC`, `fanLevel`,
 *        `volumePercent`, `brightness`) do not actually appear in `transcript`!
 *
 * Node 8 (ES2017) compatible.
 */
const Up = require('./uplink');

const TOOL_CATALOG_LINES = [
    'DANH SÁCH 6 NHÓM CÔNG CỤ DUY NHẤT ĐƯỢC PHÉP GỌI KHI NGƯỜI NÓI YÊU CẦU RÕ RÀNG:',
    '1. set_climate: {systemOn?:bool, maxAc?:bool, defrost?:bool, tempC?:16|18..28, deltaTempC?:-3..3, zone?:"driver"|"passenger"|"both", fanLevel?:1..5, freshAir?:bool, sync?:bool}',
    '2. set_seat_comfort: {seat?:"driver"|"passenger"|"both", heatingLevel?:0..3, coolingLevel?:0..3, massage?:bool, wheelHeat?:bool}',
    '3. set_ambient_light: {on?:bool, color?:"bronze"|"orange"|"white"|"blue"|"cyan"|"green"|"lilac"|"red", brightness?:10..100}',
    '4. control_media: {action:"volume"|"volume_up"|"volume_down"|"mute"|"unmute"|"play"|"pause"|"next"|"previous", volumePercent?:0..100}',
    '5. control_windows: {target:"driver"|"passenger"|"rear"|"all"|"sunroof"|"sunshade", action:"open"|"close"|"vent"}',
    '6. query_vehicle_status: {}',
    'QUY TẮC CHỐNG ẢO GIÁC BẮT BUỘC:',
    '- Chỉ chép ĐÚNG nguyên văn những từ người dùng thực sự phát âm trong đoạn âm thanh. TUYỆT ĐỐI KHÔNG tự nối thêm vế câu, không tự đoán ý, không bịa số độ C.',
    '- Nếu người nói chỉ thử mic, hỏi xem có nghe thấy không, nói chuyện phiếm hoặc câu nói không liên quan tới 6 công cụ trên: giữ đúng transcript nghe được và BẮT BUỘC trả "toolCalls":[].',
    '- Nếu yêu cầu mở cốp, gập gương, khoá cửa hoặc đèn đọc sách trần xe: trả "toolCalls":[] và ghi ngắn gọn trong unsupportedReason là chức năng đó trên BMW G30 dùng nút vật lý.',
];

const COMPACT_SYSTEM_PROMPT = [
    'Bạn là bộ nhận dạng giọng nói Tiếng Việt chính xác nguyên văn cho xe BMW iDrive 7.',
    'Trả về DUY NHẤT 1 JSON hợp lệ (không markdown):',
    '{"speechDetected":bool,"transcript":"nguyên văn câu nghe được","toolCalls":[],"unsupportedReason":""}',
    'Nếu chỉ có tiếng ồn hoặc im lặng: {"speechDetected":false,"transcript":"","toolCalls":[],"unsupportedReason":""}',
].concat(TOOL_CATALOG_LINES).join('\n');

const WAKE_SYSTEM_PROMPT = [
    'Bạn là bộ nhận diện từ khoá rảnh tay "Hey BMW" và chép lời nguyên văn Tiếng Việt cho xe BMW iDrive 7.',
    'Trả về DUY NHẤT 1 JSON hợp lệ (không markdown):',
    '{"speechDetected":bool,"wakeDetected":bool,"wakeOnly":bool,"transcript":"nguyên văn câu nghe được","toolCalls":[],"unsupportedReason":""}',
    'QUY TẮC RẢNH TAY:',
    '- Chỉ đặt "wakeDetected":true KHI đầu câu thực sự có lời gọi xe: Hey BMW, Ê BMW, Ok BMW, Hello BMW, Hi BMW, BMW ơi, Hey Bimmer (hoặc phát âm tiếng Việt tương đương).',
    '- Nếu KHÔNG có lời gọi BMW ở đầu câu: BẮT BUỘC đặt "wakeDetected":false, "wakeOnly":false, "toolCalls":[].',
    '- Nếu chỉ gọi "Hey BMW" mà chưa nói lệnh điều khiển: đặt "wakeDetected":true, "wakeOnly":true, "toolCalls":[].',
    '- Nếu gọi "Hey BMW" kèm câu lệnh điều khiển thật sự: đặt "wakeDetected":true, "wakeOnly":false và điền đúng "toolCalls".',
].concat(TOOL_CATALOG_LINES).join('\n');

const HEY_BMW_RE = /^[\s,."“”'!?-]*((?:hey|hây|hay|hê|he|ê|ok|okay|hello|hi|này|ơi)\s+(?:bmw|b\.m\.w\.?|bm\b|bimmer|bê\s*em(?:\s*vê|\s*đắp\s*liu|\s*đúp\s*lưu)?|bi\s*em(?:\s*đắp\s*liu|\s*vê)?)|(?:bmw|bimmer)\s+ơi)(?=$|[\s,.:;!?'"“”-])[\s,.:;!?'"“”-]*/i;
const POLITE_TAIL_RE = /^(?:ơi|à|ạ|dạ|nhé|nha|hả|nghe\s*không|nghe\s*rõ\s*không)?[\s,.:;!?-]*$/i;

// Matches mic-check phrases such as "Alo", "Mày nghe tao nói không?", "Có nghe rõ không?", "Test mic"
const MIC_CHECK_RE = /^[\s,."“”'!?-]*(?:(?:alo|a\s*lô)(?:\s+\d+)*|(?:ê\s+|này\s+)?(?:mày|bạn|em|xe|bmw)?\s*(?:có\s+)?nghe\s*(?:thấy\s*)?(?:tao|anh|mình|tôi|em)?\s*(?:nói(?:\s*gì)?|rõ)?\s*không(?:\s*(?:vậy|đấy|hả|nhỉ))?|(?:thử|test|kiểm\s*tra)\s*(?:cái\s*)?(?:mic|micro))(?=$|[\s,.:;!?'"“”-])/i;

const VI_TEMP_WORDS = [
    [/mười\s*sáu(?:\s*rưỡi)?/, 16],
    [/mười\s*tám\s*rưỡi/, 18.5], [/mười\s*tám/, 18],
    [/mười\s*chín\s*rưỡi/, 19.5], [/mười\s*chín/, 19],
    [/hai\s*(?:mươi\s*)?mốt\s*rưỡi/, 21.5], [/hai\s*(?:mươi\s*)?mốt/, 21],
    [/hai\s*(?:mươi\s*)?hai\s*rưỡi/, 22.5], [/hai\s*(?:mươi\s*)?hai/, 22],
    [/hai\s*(?:mươi\s*)?ba\s*rưỡi/, 23.5], [/hai\s*(?:mươi\s*)?ba/, 23],
    [/hai\s*(?:mươi\s*)?tư\s*rưỡi|hai\s*(?:mươi\s*)?bốn\s*rưỡi/, 24.5],
    [/hai\s*(?:mươi\s*)?tư|hai\s*(?:mươi\s*)?bốn/, 24],
    [/hai\s*(?:mươi\s*)?lăm\s*rưỡi/, 25.5], [/hai\s*(?:mươi\s*)?lăm/, 25],
    [/hai\s*(?:mươi\s*)?sáu\s*rưỡi/, 26.5], [/hai\s*(?:mươi\s*)?sáu/, 26],
    [/hai\s*(?:mươi\s*)?bảy\s*rưỡi/, 27.5], [/hai\s*(?:mươi\s*)?bảy/, 27],
    [/hai\s*(?:mươi\s*)?tám/, 28],
    [/hai\s*mươi\s*rưỡi/, 20.5], [/hai\s*mươi/, 20],
];

function sanitizePlainQuotes(s) {
    let out = String(s || '')
        .replace(/[\u201c\u201d\u201e\u00ab\u00bb]/g, '"')
        .replace(/[\u2018\u2019]/g, "'")
        .replace(/[\u2014\u2013]/g, '-')
        .trim();
    if (out.length >= 2 && ((out[0] === '"' && out[out.length - 1] === '"') || (out[0] === "'" && out[out.length - 1] === "'"))) {
        out = out.slice(1, -1).trim();
    }
    return out;
}

function extractHeyBmwWake(rawText) {
    const s = sanitizePlainQuotes(rawText);
    if (!s) return { matched: false, wakeOnly: false, commandText: '' };
    const m = HEY_BMW_RE.exec(s);
    if (!m) {
        return { matched: false, wakeOnly: false, commandText: '' };
    }
    const rest = s.slice(m[0].length).trim();
    if (!rest || POLITE_TAIL_RE.test(rest)) {
        return { matched: true, wakeOnly: true, commandText: '' };
    }
    return { matched: true, wakeOnly: false, commandText: rest };
}

function detectMicCheckUtterance(rawText, fromAudio) {
    const s = sanitizePlainQuotes(rawText);
    if (!s) return null;
    const wk = extractHeyBmwWake(s);
    const body = wk.matched ? wk.commandText : s;
    if (!body) return null;

    const m = MIC_CHECK_RE.exec(body);
    if (!m) return null;

    const after = body.slice(m[0].length).replace(/^[\s,.:;!?'"-]+/, '').trim();
    // If audio transcription starts with a mic-check question ("Mày nghe tao nói không? ...") and Gemini
    // hallucinated a second sentence after `?` or `.`, strip the hallucinated tail deterministically!
    if (!after || (fromAudio && /^[?!.]/.test(body.slice(m[0].length).trim()))) {
        const cleanTranscript = body.slice(0, m[0].length).trim() + (/\?$/.test(m[0]) ? '' : (/nghe|không/i.test(m[0]) ? '?' : ''));
        return {
            isMicCheck: true,
            cleanTranscript: wk.matched ? ('Hey BMW, ' + cleanTranscript) : cleanTranscript,
        };
    }
    return null;
}

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

function extractSpokenTempC(low) {
    const tempM = /(?:điều\s*hoà|nhiệt\s*độ|máy\s*lạnh|chỉnh|hạ|tăng|xuống|lên|đặt|về|mức)?\s*(\d{2}(?:[.,]5)?)\s*(?:độ|°|c\b)/.exec(low)
        || /(?:điều\s*hoà|nhiệt\s*độ|máy\s*lạnh)\s*(?:xuống|lên|về|ở|mức)?\s*(\d{2}(?:[.,]5)?)\b/.exec(low);
    if (tempM) {
        const tv = parseFloat(tempM[1].replace(',', '.'));
        if (tv >= 16 && tv <= 28) {
            return /rưỡi/.test(low.slice(tempM.index, tempM.index + tempM[0].length + 8)) && (tv % 1 === 0) ? (tv + 0.5) : tv;
        }
    }
    for (let i = 0; i < VI_TEMP_WORDS.length; i++) {
        const pair = VI_TEMP_WORDS[i];
        if (new RegExp(pair[0].source + '\\s*(?:độ|°|c\\b)?').test(low) && /điều\s*hoà|nhiệt\s*độ|máy\s*lạnh|độ\b/.test(low)) {
            return pair[1];
        }
    }
    return null;
}

function parseOfflineVietnamese(rawText, speakerZone) {
    const wk = extractHeyBmwWake(rawText);
    const text = (wk.matched && wk.commandText) ? wk.commandText : sanitizePlainQuotes(rawText);
    const low = text.toLowerCase();
    if (!low) return [];

    const zone = /(cả\s*2|cả\s*hai|hai\s*bên|2\s*bên|cả\s*xe|2\s*vùng|hai\s*vùng|toàn\s*xe)/.test(low) ? 'both'
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

    const spokenTemp = extractSpokenTempC(low);
    const deltaStepM = /(giảm|hạ|tăng)\s*(?:nhiệt\s*độ\s*|điều\s*hoà\s*)?([1-3](?:[.,]5)?)\s*độ/.exec(low);
    if (spokenTemp !== null) {
        clim.tempC = spokenTemp;
        clim.zone = zone;
        hasClim = true;
    } else if (deltaStepM) {
        const mag = parseFloat(deltaStepM[2].replace(',', '.'));
        clim.deltaTempC = /tăng/.test(deltaStepM[1]) ? mag : -mag;
        clim.zone = zone;
        hasClim = true;
    } else if (!clim.maxAc && /(nóng\s*quá|hơi\s*nóng|cho\s*mát\s*hơn|lạnh\s*hơn|giảm\s*nhiệt|hạ\s*nhiệt)/.test(low)) {
        clim.deltaTempC = -1.5;
        clim.zone = zone;
        hasClim = true;
    } else if (/(lạnh\s*quá|rét\s*quá|hơi\s*lạnh|cho\s*ấm\s*hơn|tăng\s*nhiệt)/.test(low)) {
        clim.deltaTempC = 1.5;
        clim.zone = zone;
        hasClim = true;
    }

    const fanM = /(?:mức\s*gió|quạt\s*gió|gió\s*mức|gió\s*số|quạt\s*số|gió)\s*([1-5]|một|hai|ba|bốn|năm)/.exec(low);
    if (fanM) {
        const fw = fanM[1];
        const fv = fw === 'một' ? 1 : fw === 'hai' ? 2 : fw === 'ba' ? 3 : fw === 'bốn' ? 4 : fw === 'năm' ? 5 : parseInt(fw, 10);
        if (fv >= 1 && fv <= 5) {
            clim.fanLevel = fv;
            clim.zone = zone;
            hasClim = true;
        }
    }
    if (hasClim) calls.push({ name: 'set_climate', args: clim });

    // 2. Seat Heating / Cooling / Massage / Steering Wheel Heat
    const seat = {};
    let hasSeat = false;
    if (/sưởi\s*(vô[\s-]*lăng|tay\s*lái)|ấm\s*(vô[\s-]*lăng|tay\s*lái)/.test(low)) {
        seat.wheelHeat = !/tắt/.test(low);
        hasSeat = true;
    }
    const parseStage = () => {
        const m = /(?:mức|số)\s*([0-3]|không|một|hai|ba)/.exec(low);
        if (!m) return null;
        const w = m[1];
        return w === 'không' ? 0 : w === 'một' ? 1 : w === 'hai' ? 2 : w === 'ba' ? 3 : parseInt(w, 10);
    };
    if (/sưởi\s*ghế|ấm\s*ghế/.test(low)) {
        const st = parseStage();
        seat.heatingLevel = /tắt/.test(low) ? 0 : (st !== null ? st : 2);
        seat.seat = zone;
        hasSeat = true;
    }
    if (/(làm\s*mát|thông\s*gió|quạt)\s*ghế|mát\s*ghế/.test(low)) {
        const st = parseStage();
        seat.coolingLevel = /tắt/.test(low) ? 0 : (st !== null ? st : 2);
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
        const volM = /(?:âm\s*lượng|loa|volume|tiếng)\s*(?:mức|xuống|lên|ở|về)?\s*(\d{1,3})\s*%?/.exec(low);
        if (volM) {
            calls.push({ name: 'control_media', args: { action: 'volume', volumePercent: Math.max(0, Math.min(100, parseInt(volM[1], 10))) } });
        } else if (/(tăng|to|mở\s*to)\s*(âm\s*lượng|tiếng|loa)|to\s*lên/.test(low)) {
            calls.push({ name: 'control_media', args: { action: 'volume_up' } });
        } else if (/(giảm|nhỏ|hạ)\s*(âm\s*lượng|tiếng|loa)|nhỏ\s*(lại|xuống)/.test(low)) {
            calls.push({ name: 'control_media', args: { action: 'volume_down' } });
        }
    }

    if (/bài\s*(tiếp|kế|sau)|qua\s*bài|next\s*bài|chuyển\s*bài/.test(low)) {
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

    // 6. Vehicle Status Check
    if (/(tình\s*trạng|kiểm\s*tra|khám|thông\s*số)\s*xe|áp\s*suất\s*lốp|nhiệt\s*độ\s*(dầu|nước)|bình\s*(ắc\s*quy|12v)|bao\s*nhiêu\s*xăng|còn\s*(mấy\s*vạch\s*|bao\s*nhiêu\s*)?xăng/.test(low)) {
        calls.push({ name: 'query_vehicle_status', args: {} });
    }

    return calls;
}

/**
 * Deterministic Anti-Hallucination Gate:
 *   1. If `parseOfflineVietnamese(cmdText)` finds explicit Vietnamese commands, ALWAYS trust it over LLM `toolCalls`.
 *   2. Otherwise, filter LLM `toolCalls` so every domain & numeric setpoint MUST be explicitly grounded in `cmdText`.
 */
function groundToolCallsAgainstTranscript(cmdText, rawGemCalls, speakerZone) {
    const clean = sanitizePlainQuotes(cmdText);
    const low = clean.toLowerCase();
    if (!low) return [];

    const offline = parseOfflineVietnamese(clean, speakerZone);
    if (offline.length > 0) {
        return offline;
    }
    if (!Array.isArray(rawGemCalls) || !rawGemCalls.length) return [];

    const grounded = [];
    for (let i = 0; i < rawGemCalls.length; i++) {
        const tc = rawGemCalls[i];
        if (!tc || typeof tc.name !== 'string') continue;
        const a = (tc.args && typeof tc.args === 'object') ? Object.assign({}, tc.args) : {};

        if (tc.name === 'set_climate') {
            if (!/điều\s*hoà|máy\s*lạnh|\ba\/?c\b|nhiệt\s*độ|nóng|lạnh|rét|mát\s*hơn|ấm\s*hơn|hạ\s*nhiệt|tăng\s*nhiệt|sấy\s*kính|mờ\s*kính|tan\s*sương|quạt\s*gió|mức\s*gió|gió\s*trong|gió\s*ngoài|tuần\s*hoàn|\bsync\b|đồng\s*bộ/.test(low)) {
                continue;
            }
            if (a.tempC !== undefined) {
                const sp = extractSpokenTempC(low);
                const intStr = String(Math.floor(Number(a.tempC) || 0));
                if (sp === null && low.indexOf(intStr) < 0) {
                    delete a.tempC;
                } else if (sp !== null) {
                    a.tempC = sp;
                }
            }
            if (a.fanLevel !== undefined && !/[1-5]|một|hai|ba|bốn|năm/.test(low)) {
                delete a.fanLevel;
            }
            const argKeys = Object.keys(a).filter((k) => k !== 'zone');
            if (!argKeys.length) continue;
            grounded.push({ name: 'set_climate', args: a });
        } else if (tc.name === 'set_seat_comfort') {
            if (!/ghế|vô[\s-]*lăng|tay\s*lái|massage|mát[\s-]*xa/.test(low)) continue;
            grounded.push({ name: 'set_seat_comfort', args: a });
        } else if (tc.name === 'set_ambient_light') {
            if (!/đèn|viền|ambient|nội\s*thất|\bled\b/.test(low)) continue;
            if (a.brightness !== undefined && !/\d/.test(low)) delete a.brightness;
            if (!Object.keys(a).length) continue;
            grounded.push({ name: 'set_ambient_light', args: a });
        } else if (tc.name === 'control_media') {
            if (!/âm\s*lượng|\bloa\b|tiếng|volume|mute|unmute|nhạc|\bbài\b|play|pause|dừng/.test(low)) continue;
            if (a.action === 'volume' && !/\d/.test(low)) continue;
            grounded.push({ name: 'control_media', args: a });
        } else if (tc.name === 'control_windows') {
            if (!/kính|cửa\s*sổ|cửa\s*nóc|sunroof|rèm/.test(low) || /sấy\s*kính/.test(low)) continue;
            grounded.push({ name: 'control_windows', args: a });
        } else if (tc.name === 'query_vehicle_status') {
            if (!/tình\s*trạng|kiểm\s*tra|khám|thông\s*số|áp\s*suất|lốp|dầu|nước\s*mát|ắc\s*quy|12v|xăng|odo|\bkm\b/.test(low)) continue;
            grounded.push({ name: 'query_vehicle_status', args: {} });
        }
    }
    return grounded;
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
    const wakeMode = !!opts.wakeMode;
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
            ? ('Người ngồi (' + opts.speakerZone + ') nói nguyên văn: "' + opts.text + '"')
            : (wakeMode
                ? ('Chép đúng nguyên văn câu nghe được từ người ngồi (' + opts.speakerZone + ') và kiểm tra từ khoá Hey BMW.')
                : ('Chép đúng nguyên văn câu tiếng Việt nghe được từ người ngồi (' + opts.speakerZone + '), tuyệt đối không bịa thêm câu.')),
    });

    const genCfg = {
        temperature: 0.0,
        maxOutputTokens: 260,
        responseMimeType: 'application/json',
    };
    if (/gemini-3/i.test(model)) {
        genCfg.thinkingConfig = { thinkingLevel: 'minimal' };
    } else if (/gemini-2\.5/i.test(model)) {
        genCfg.thinkingConfig = { thinkingBudget: 0 };
    }

    const body = JSON.stringify({
        systemInstruction: { parts: [{ text: wakeMode ? WAKE_SYSTEM_PROMPT : COMPACT_SYSTEM_PROMPT }] },
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
    const wakeMode = !!o.wakeMode;
    const speakerZone = o.speakerZone === 'passenger' ? 'passenger' : 'driver';
    const car = o.carController;
    let transcript = sanitizePlainQuotes(o.text || '');
    let plannedCalls = [];
    let unsupportedReason = '';
    let engine = 'offline';

    // 1. Deterministic fast gate for plain-text commands
    if (transcript && !o.audioWavBase64) {
        if (wakeMode) {
            const wk = extractHeyBmwWake(transcript);
            if (!wk.matched) {
                return {
                    at: Date.now(),
                    ok: false,
                    ignored: true,
                    wakeOnly: false,
                    engine: 'wake_gate',
                    speakerZone,
                    transcript,
                    replyVi: '',
                    actions: [],
                };
            }
            if (wk.wakeOnly) {
                return {
                    at: Date.now(),
                    ok: true,
                    ignored: false,
                    wakeOnly: true,
                    engine: 'wake_gate',
                    speakerZone,
                    transcript,
                    replyVi: 'Xin chào, tôi đang lắng nghe…',
                    actions: [],
                };
            }
            const mcWake = detectMicCheckUtterance(transcript, false);
            if (mcWake) {
                return {
                    at: Date.now(),
                    ok: true,
                    micCheck: true,
                    engine: 'offline',
                    speakerZone,
                    transcript: mcWake.cleanTranscript,
                    replyVi: 'Mic trần BMW đang nghe rõ - mời đọc câu lệnh điều khiển xe.',
                    actions: [],
                };
            }
            unsupportedReason = detectPhysicalOnlyUnsupported(wk.commandText);
            if (!unsupportedReason) {
                plannedCalls = parseOfflineVietnamese(wk.commandText, speakerZone);
            }
        } else {
            const wkOpt = extractHeyBmwWake(transcript);
            if (wkOpt.matched && wkOpt.wakeOnly) {
                return {
                    at: Date.now(),
                    ok: true,
                    ignored: false,
                    wakeOnly: true,
                    engine: 'offline',
                    speakerZone,
                    transcript,
                    replyVi: 'Xin chào, mời nói câu lệnh tiếp theo…',
                    actions: [],
                };
            }
            const mc = detectMicCheckUtterance(transcript, false);
            if (mc) {
                return {
                    at: Date.now(),
                    ok: true,
                    micCheck: true,
                    engine: 'offline',
                    speakerZone,
                    transcript: mc.cleanTranscript,
                    replyVi: 'Mic trần BMW đang nghe rõ - mời đọc câu lệnh điều khiển xe.',
                    actions: [],
                };
            }
            unsupportedReason = detectPhysicalOnlyUnsupported(transcript);
            if (!unsupportedReason) {
                plannedCalls = parseOfflineVietnamese(transcript, speakerZone);
            }
        }
    }

    // 2. Online Gemini Multimodal Audio / Unfamiliar Text Decoder
    if (!plannedCalls.length && !unsupportedReason && o.apiKey && (o.audioWavBase64 || transcript)) {
        try {
            const gem = await decodeWithGemini({
                apiKey: o.apiKey,
                model: o.model || 'gemini-3-flash-preview',
                audioWavBase64: o.audioWavBase64 || '',
                audioMimeType: o.audioMimeType || 'audio/wav',
                text: transcript,
                speakerZone,
                wakeMode,
                uplinkOpts: o.uplinkOpts,
            });
            engine = 'gemini';

            if (typeof gem.transcript === 'string' && gem.transcript.trim()) {
                transcript = sanitizePlainQuotes(gem.transcript);
            }

            if (wakeMode) {
                const wkCheck = extractHeyBmwWake(transcript || '');
                const hasBmwToken = /bmw|b\.m\.w|\bbm\b|bimmer|bê\s*em|bi\s*em/i.test(transcript || '');
                if (gem.speechDetected === false || (!wkCheck.matched && !(gem.wakeDetected === true && hasBmwToken))) {
                    return {
                        at: Date.now(),
                        ok: false,
                        ignored: true,
                        wakeOnly: false,
                        engine,
                        speakerZone,
                        transcript: transcript || '',
                        replyVi: '',
                        actions: [],
                    };
                }

                const mcWake = detectMicCheckUtterance(transcript, !!o.audioWavBase64);
                if (mcWake) {
                    return {
                        at: Date.now(),
                        ok: true,
                        micCheck: true,
                        engine,
                        speakerZone,
                        transcript: mcWake.cleanTranscript,
                        replyVi: 'Mic trần BMW đang nghe rõ - mời đọc câu lệnh điều khiển xe.',
                        actions: [],
                    };
                }

                const cmdSlice = wkCheck.matched ? wkCheck.commandText : transcript;
                unsupportedReason = detectPhysicalOnlyUnsupported(cmdSlice) || String(gem.unsupportedReason || '').trim();
                if (!unsupportedReason && cmdSlice) {
                    plannedCalls = groundToolCallsAgainstTranscript(cmdSlice, gem.toolCalls, speakerZone);
                }

                if (!plannedCalls.length && !unsupportedReason && (gem.wakeOnly === true || wkCheck.wakeOnly)) {
                    return {
                        at: Date.now(),
                        ok: true,
                        ignored: false,
                        wakeOnly: true,
                        engine,
                        speakerZone,
                        transcript: transcript || 'Hey BMW',
                        replyVi: 'Xin chào, tôi đang lắng nghe…',
                        actions: [],
                    };
                }
            } else {
                if (gem.speechDetected === false && o.audioWavBase64) {
                    return {
                        at: Date.now(),
                        ok: false,
                        engine,
                        speakerZone,
                        transcript: '',
                        replyVi: 'Chưa nghe rõ câu lệnh - mời đọc lại giúp mình.',
                        actions: [],
                    };
                }

                const mcAudio = detectMicCheckUtterance(transcript, !!o.audioWavBase64);
                if (mcAudio) {
                    return {
                        at: Date.now(),
                        ok: true,
                        micCheck: true,
                        engine,
                        speakerZone,
                        transcript: mcAudio.cleanTranscript,
                        replyVi: 'Mic trần BMW đang nghe rõ - mời đọc câu lệnh điều khiển xe.',
                        actions: [],
                    };
                }

                if (transcript) {
                    unsupportedReason = detectPhysicalOnlyUnsupported(transcript) || String(gem.unsupportedReason || '').trim();
                    if (!unsupportedReason) {
                        plannedCalls = groundToolCallsAgainstTranscript(transcript, gem.toolCalls, speakerZone);
                    }
                }
            }
        } catch (e) {
            if (wakeMode && o.audioWavBase64 && !transcript) {
                return {
                    at: Date.now(),
                    ok: false,
                    ignored: true,
                    wakeOnly: false,
                    netError: e.message,
                    engine: 'wake_net_err',
                    speakerZone,
                    transcript: '',
                    replyVi: '',
                    actions: [],
                };
            }
            if (!transcript) {
                return {
                    at: Date.now(),
                    ok: false,
                    engine: 'net_err',
                    speakerZone,
                    transcript: '',
                    replyVi: 'Chưa kết nối mạng tới Gemini (' + sanitizePlainQuotes(e.message).slice(0, 72) + '). Kiểm tra Wi-Fi/4G xe.',
                    actions: [],
                };
            }
        }
    } else if (wakeMode && o.audioWavBase64 && !o.apiKey) {
        return {
            at: Date.now(),
            ok: false,
            ignored: true,
            wakeOnly: false,
            engine: 'wake_no_key',
            speakerZone,
            transcript: '',
            replyVi: '',
            actions: [],
        };
    }

    if (unsupportedReason) {
        return {
            at: Date.now(),
            ok: false,
            engine,
            speakerZone,
            transcript: sanitizePlainQuotes(transcript),
            replyVi: sanitizePlainQuotes(unsupportedReason),
            actions: [],
        };
    }

    if (!plannedCalls.length) {
        return {
            at: Date.now(),
            ok: false,
            engine,
            speakerZone,
            transcript: sanitizePlainQuotes(transcript),
            replyVi: transcript
                ? 'Chưa nhận diện được lệnh điều khiển xe (thử: "Điều hoà 22 độ", "Đèn màu cam", "Âm lượng 30%").'
                : 'Cần dán Gemini API Key trong Cài đặt QR để nhận giọng nói Tiếng Việt.',
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
    const replyVi = sanitizePlainQuotes(actions.map((a) => a.summaryVi).join(' · '));

    return {
        at: Date.now(),
        ok: allOk,
        engine,
        speakerZone,
        transcript: sanitizePlainQuotes(transcript),
        replyVi,
        actions,
    };
}

module.exports = {
    sanitizePlainQuotes,
    extractHeyBmwWake,
    detectMicCheckUtterance,
    detectPhysicalOnlyUnsupported,
    parseOfflineVietnamese,
    groundToolCallsAgainstTranscript,
    processVoiceOrText,
};
