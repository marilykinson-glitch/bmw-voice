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
const OfflineAi = require('./offline-ai');

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
    'Nếu có giọng người nói tiếng Việt (kể cả giọng nhỏ hoặc có tiếng máy/điều hòa xe): hãy chép lại chính xác lời người nói (viết số bằng chữ số như 22 độ, 30%).',
    'Chỉ đặt "speechDetected":false khi hoàn toàn im lặng hoặc chỉ có tiếng ồn xe không có tiếng người nói.',
].concat(TOOL_CATALOG_LINES).join('\n');

const WAKE_SYSTEM_PROMPT = [
    'Bạn là bộ nhận diện từ khoá rảnh tay "Hey BMW" và chép lời nguyên văn Tiếng Việt cho xe BMW iDrive 7.',
    'Trả về DUY NHẤT 1 JSON hợp lệ (không markdown):',
    '{"speechDetected":bool,"wakeDetected":bool,"wakeOnly":bool,"transcript":"nguyên văn câu nghe được","toolCalls":[],"unsupportedReason":""}',
    'QUY TẮC RẢNH TAY:',
    '- Chỉ đặt "wakeDetected":true KHI đầu câu thực sự có lời gọi xe: Hey BMW, Ê BMW, Ok BMW, Hello BMW, Hi BMW, Xin chào BMW, Trợ lý BMW, BMW ơi, Hey Bimmer — kể cả phát âm tiếng Việt kiểu "hây bi em đắp liu", "hê bê em vê", "hey bim", "ây bi em".',
    '- Nếu KHÔNG có lời gọi BMW ở đầu câu: BẮT BUỘC đặt "wakeDetected":false, "wakeOnly":false, "toolCalls":[].',
    '- Nếu chỉ gọi "Hey BMW" mà chưa nói lệnh điều khiển: đặt "wakeDetected":true, "wakeOnly":true, "toolCalls":[].',
    '- Nếu gọi "Hey BMW" kèm câu lệnh điều khiển thật sự: đặt "wakeDetected":true, "wakeOnly":false và điền đúng "toolCalls".',
].concat(TOOL_CATALOG_LINES).join('\n');

const FAST_WAKE_SYSTEM_PROMPT = [
    'Kiểm tra nhanh âm thanh ngắn có phải lời gọi xe BMW ("Hey BMW", "Ê BMW", "BMW ơi", "Ok BMW", "Xin chào BMW", "Trợ lý BMW", hoặc phát âm Việt tương đương) không.',
    'Trả về DUY NHẤT 1 JSON ngắn (không markdown): {"speechDetected":bool,"wakeDetected":bool,"wakeOnly":bool,"transcript":"nguyên văn"}',
    'Nếu chỉ gọi "Hey BMW" không có lệnh đi kèm: wakeDetected=true, wakeOnly=true. Nếu không gọi BMW: wakeDetected=false, wakeOnly=false.',
].join('\n');

const HEY_BMW_RE = /^[\s,."“”'!?-]*((?:hey|hây|hay|hê|he|ê|ây|ok|okay|hello|hi|này|ơi|xin\s+chào|chào|trợ\s+lý)\s+(?:bmw|b\.m\.w\.?|b\s+m\s+w|bm\b|bim\b|bimmer|bê\s*em(?:\s*vê|\s*đắp\s*liu|\s*đúp\s*lưu)?|bi\s*em(?:\s*đắp\s*liu|\s*đúp\s*lưu|\s*vê)?)|(?:bmw|bimmer)\s+ơi)(?=$|[\s,.:;!?'"“”-])[\s,.:;!?'"“”-]*/i;
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

function normalizeViOrthography(s) {
    let out = String(s || '');
    if (typeof out.normalize === 'function') out = out.normalize('NFC');
    return out
        .toLowerCase()
        // Unify modern (`hòa`, `khóa`, `tỏa`) and classic (`hoà`, `khoá`, `toả`) Vietnamese tone placement
        .replace(/hoà/g, 'hòa')
        .replace(/hoá/g, 'hóa')
        .replace(/khoá/g, 'khóa')
        .replace(/toà/g, 'tòa')
        .replace(/toả/g, 'tỏa')
        .replace(/xoá/g, 'xóa')
        .replace(/loà/g, 'lòa')
        .replace(/oà/g, 'òa')
        .replace(/oá/g, 'óa')
        .replace(/oả/g, 'ỏa')
        .replace(/oã/g, 'õa')
        .replace(/oạ/g, 'ọa')
        .replace(/uý/g, 'úy');
}

function detectPhysicalOnlyUnsupported(text) {
    const low = normalizeViOrthography(text);
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
    const s = normalizeViOrthography(low);
    const tempM = /(?:điều\s*hòa|nhiệt\s*độ|máy\s*lạnh|chỉnh|hạ|tăng|xuống|lên|đặt|về|mức)?\s*(\d{2}(?:[.,]5)?)\s*(?:độ|°|c\b)/.exec(s)
        || /(?:điều\s*hòa|nhiệt\s*độ|máy\s*lạnh)\s*(?:xuống|lên|về|ở|mức)?\s*(\d{2}(?:[.,]5)?)\b/.exec(s);
    if (tempM) {
        const tv = parseFloat(tempM[1].replace(',', '.'));
        if (tv >= 16 && tv <= 28) {
            return /rưỡi/.test(s.slice(tempM.index, tempM.index + tempM[0].length + 8)) && (tv % 1 === 0) ? (tv + 0.5) : tv;
        }
    }
    const hasTempCtx = /điều\s*hòa|nhiệt\s*độ|máy\s*lạnh|độ(?=$|[\s,.:;!?])/.test(s);
    if (hasTempCtx) {
        for (let i = 0; i < VI_TEMP_WORDS.length; i++) {
            const pair = VI_TEMP_WORDS[i];
            if (new RegExp(pair[0].source + '(?:\\s*(?:độ|°|c\\b))?').test(s)) {
                return pair[1];
            }
        }
    }
    return null;
}

function extractSpokenPercent(low) {
    const s = normalizeViOrthography(low);
    const numM = /\b(\d{1,3})\s*%?/.exec(s);
    if (numM) {
        const n = parseInt(numM[1], 10);
        if (n >= 0 && n <= 100) return n;
    }
    if (/một\s*trăm|trăm\s*phần\s*trăm|tối\s*đa|hết\s*cỡ/.test(s)) return 100;
    const tens = [
        ['chín\\s*mươi', 90], ['tám\\s*mươi', 80], ['bảy\\s*mươi', 70], ['sáu\\s*mươi', 60],
        ['năm\\s*mươi', 50], ['bốn\\s*mươi', 40], ['ba\\s*mươi', 30], ['hai\\s*mươi', 20],
        ['mười', 10],
    ];
    const ones = [
        ['mốt|một', 1], ['hai', 2], ['ba', 3], ['tư|bốn', 4],
        ['lăm|năm', 5], ['sáu', 6], ['bảy', 7], ['tám', 8], ['chín', 9],
    ];
    for (let i = 0; i < tens.length; i++) {
        const tm = new RegExp(tens[i][0] + '(?:\\s+(' + ones.map((o) => o[0]).join('|') + '))?').exec(s);
        if (tm) {
            let val = tens[i][1];
            if (tm[1]) {
                for (let j = 0; j < ones.length; j++) {
                    if (new RegExp('^(?:' + ones[j][0] + ')$').test(tm[1])) {
                        val += ones[j][1];
                        break;
                    }
                }
            }
            return Math.max(0, Math.min(100, val));
        }
    }
    if (/\bkhông\s*(?:phần\s*trăm)?(?=$|[\s,.:;!?])/.test(s)) return 0;
    return null;
}

function parseOfflineVietnamese(rawText, speakerZone) {
    const wk = extractHeyBmwWake(rawText);
    const text = (wk.matched && wk.commandText) ? wk.commandText : sanitizePlainQuotes(rawText);
    const low = normalizeViOrthography(text);
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
    if (/đồng\s*bộ\s*(điều\s*hòa|nhiệt\s*độ)|\bsync\b/.test(low)) {
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
    if (/tắt\s+(điều\s*hòa|máy\s*lạnh|\bac\b)/.test(low)) {
        clim.systemOn = false;
        hasClim = true;
    } else if (/bật\s+(điều\s*hòa|máy\s*lạnh|\bac\b)/.test(low)) {
        clim.systemOn = true;
        hasClim = true;
    }

    const spokenTemp = extractSpokenTempC(low);
    const deltaStepM = /(giảm|hạ|tăng)\s*(?:nhiệt\s*độ\s*|điều\s*hòa\s*)?([1-3](?:[.,]5)?|một|hai|ba)\s*độ/.exec(low);
    if (spokenTemp !== null) {
        clim.tempC = spokenTemp;
        clim.zone = zone;
        hasClim = true;
    } else if (deltaStepM) {
        const dw = deltaStepM[2];
        const mag = dw === 'một' ? 1 : dw === 'hai' ? 2 : dw === 'ba' ? 3 : parseFloat(dw.replace(',', '.'));
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
    if (/đèn\s*(viền|nội\s*thất|ambient|led)|đổi\s*màu\s*đèn|màu\s*đèn|màu\s*(?:nội\s*thất|ánh\s*sáng)|(?:đổi|chuyển)\s*(?:màu\s*)?(?:sang|thành|qua|về)\s*(?:màu\s*)?(?:đồng|vàng|hổ\s*phách|cam|đỏ|trắng|xanh|tím|hồng|bronze|orange|red|white|cyan|green|lilac|blue)|đổi\s*màu\s*(?:đồng|vàng|hổ\s*phách|cam|đỏ|trắng|xanh|tím|hồng|bronze|orange|red|white|cyan|green|lilac|blue)/.test(low)) {
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
        const brCtxM = /(?:độ\s*sáng|sáng|mức)\s*([^\n,.!?]{1,24})/.exec(low);
        if (brCtxM) {
            const brVal = extractSpokenPercent(brCtxM[1]);
            if (brVal !== null) amb.brightness = Math.max(10, Math.min(100, brVal));
        }
        if (Object.keys(amb).length > 0) calls.push({ name: 'set_ambient_light', args: amb });
    }

    // 4. Audio Volume & Media Transport
    if (/tắt\s*(tiếng|âm|loa)|\bmute\b/.test(low)) {
        calls.push({ name: 'control_media', args: { action: 'mute' } });
    } else if (/bật\s*(tiếng|lại\s*tiếng|âm\s*thanh)|\bunmute\b/.test(low)) {
        calls.push({ name: 'control_media', args: { action: 'unmute' } });
    } else {
        const volCtxM = /(?:âm\s*lượng|loa|volume|tiếng)\s*(?:mức|xuống|lên|ở|về|thành|lại)?\s*([^\n,.!?]{1,24})/.exec(low);
        const volVal = volCtxM ? extractSpokenPercent(volCtxM[1]) : null;
        if (volVal !== null) {
            calls.push({ name: 'control_media', args: { action: 'volume', volumePercent: Math.max(0, Math.min(100, volVal)) } });
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
    } else if (/(hạ|mở|kéo|lên|đóng|hé)\s*(toàn\s*bộ\s*|4\s*|hết\s*)?(?:kính|cửa\s*sổ|cửa\s*kính)/.test(low) && !/sấy\s*kính/.test(low)) {
        const act = /(lên|đóng)/.test(low) ? 'close' : (/hé/.test(low) ? 'vent' : 'open');
        const tgt = /(toàn\s*bộ|4\s*kính|4\s*cửa|hết\s*kính|tất\s*cả)/.test(low) ? 'all'
            : /phụ/.test(low) ? 'passenger'
                : /(hàng\s*sau|ghế\s*sau|kính\s*sau|cửa\s*sổ\s*sau|bên\s*sau)/.test(low) ? 'rear'
                    : /(tài|lái)/.test(low) ? 'driver'
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
    const low = normalizeViOrthography(clean);
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
            if (!/điều\s*hòa|máy\s*lạnh|\ba\/?c\b|nhiệt\s*độ|nóng|lạnh|rét|mát\s*hơn|ấm\s*hơn|hạ\s*nhiệt|tăng\s*nhiệt|sấy\s*kính|mờ\s*kính|tan\s*sương|quạt\s*gió|mức\s*gió|gió\s*trong|gió\s*ngoài|tuần\s*hoàn|\bsync\b|đồng\s*bộ/.test(low)) {
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

const WAKE_MODEL_CASCADE = [
    'gemini-3.5-flash-lite',
    'gemini-flash-lite-latest',
    'gemini-3.5-flash',
    'gemini-3.1-flash-lite',
];

const COMMAND_MODEL_CASCADE = [
    'gemini-3.5-flash-lite',
    'gemini-3.5-flash',
    'gemini-flash-lite-latest',
    'gemini-3.8-flash',
];

const modelCooldowns = Object.create(null);

function resetModelCooldowns() {
    Object.keys(modelCooldowns).forEach((k) => { delete modelCooldowns[k]; });
}

function markModelCooldown(model, status) {
    const prev = modelCooldowns[model] || { strikes: 0, until: 0 };
    const strikes = prev.strikes + 1;
    let waitMs = 20000;
    if (status === 404) {
        waitMs = 3600000;
    } else if (status === 429) {
        waitMs = strikes >= 2 ? 180000 : 65000;
    }
    modelCooldowns[model] = {
        strikes,
        until: Date.now() + waitMs,
        lastStatus: status,
    };
}

function buildModelCandidates(preferredModel, wakeMode) {
    const base = wakeMode ? WAKE_MODEL_CASCADE : COMMAND_MODEL_CASCADE;
    const ordered = [];
    if (!wakeMode && preferredModel && typeof preferredModel === 'string') {
        ordered.push(preferredModel.trim());
    }
    for (let i = 0; i < base.length; i++) {
        if (ordered.indexOf(base[i]) < 0) ordered.push(base[i]);
    }
    if (wakeMode && preferredModel && ordered.indexOf(preferredModel.trim()) < 0) {
        ordered.push(preferredModel.trim());
    }
    const now = Date.now();
    const ready = [];
    const cooling = [];
    for (let j = 0; j < ordered.length; j++) {
        const m = ordered[j];
        const cd = modelCooldowns[m];
        if (cd && cd.until > now) cooling.push(m);
        else ready.push(m);
    }
    // Try non-cooled-down models first; keep earliest-expiring cooled model as final fallback
    cooling.sort((a, b) => (modelCooldowns[a].until || 0) - (modelCooldowns[b].until || 0));
    return ready.length ? ready.concat(cooling.slice(0, 1)) : cooling.slice(0, 2);
}

function formatGeminiErrorVi(err) {
    const msg = sanitizePlainQuotes((err && err.message) || String(err || '')).slice(0, 72);
    const status = err && err.httpStatus;
    if (status === 429 || /\b429\b/.test(msg)) {
        return 'API Key Gemini chạm giới hạn miễn phí (HTTP 429) - chờ 30 giây hoặc đổi Key trong Cài đặt QR.';
    }
    if (status === 404 || /\b404\b/.test(msg)) {
        return 'Model Gemini không khả dụng cho API Key này (HTTP 404) - kiểm tra cập nhật app.';
    }
    if (status === 500 || status === 502 || status === 503 || /\b(500|502|503)\b/.test(msg)) {
        return 'Máy chủ Gemini đang quá tải tạm thời (' + (status || msg) + ') - mời thử lại sau vài giây.';
    }
    if (status === 400 || status === 401 || status === 403 || /\b(400|401|403)\b/.test(msg)) {
        return 'Gemini API Key không hợp lệ hoặc hết quyền (' + (status || msg) + ') - kiểm tra trong Cài đặt QR.';
    }
    return 'Chưa kết nối mạng tới Gemini (' + msg + '). Kiểm tra Wi-Fi/4G xe.';
}

async function decodeSingleModelWithGemini(opts, model) {
    const wakeMode = !!opts.wakeMode;
    const fastWakeOnly = !!(wakeMode && opts.fastWakeOnly);
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
            : (fastWakeOnly
                ? 'Có phải lời gọi "Hey BMW" không?'
                : (wakeMode
                    ? ('Chép đúng nguyên văn câu nghe được từ người ngồi (' + opts.speakerZone + ') và kiểm tra từ khoá Hey BMW.')
                    : ('Chép đúng nguyên văn câu tiếng Việt nghe được từ người ngồi (' + opts.speakerZone + '), tuyệt đối không bịa thêm câu.'))),
    });

    const genCfg = {
        temperature: 0.0,
        maxOutputTokens: fastWakeOnly ? 72 : 260,
        responseMimeType: 'application/json',
    };
    if (/^gemini-3\.[789]|^gemini-4/i.test(model)) {
        genCfg.thinkingConfig = { thinkingLevel: 'low' };
    } else if (/^gemini-3/i.test(model) || /^gemini-flash-lite-latest$/i.test(model)) {
        genCfg.thinkingConfig = { thinkingLevel: 'minimal' };
    } else if (/^gemini-2\.5/i.test(model)) {
        genCfg.thinkingConfig = { thinkingBudget: 0 };
    }

    const body = JSON.stringify({
        systemInstruction: { parts: [{ text: fastWakeOnly ? FAST_WAKE_SYSTEM_PROMPT : (wakeMode ? WAKE_SYSTEM_PROMPT : COMPACT_SYSTEM_PROMPT) }] },
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
        const err = new Error('Gemini HTTP ' + res.status);
        err.httpStatus = res.status;
        err.model = model;
        err.bodySnippet = String(res.body || '').slice(0, 220);
        throw err;
    }
    if (modelCooldowns[model]) delete modelCooldowns[model];

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
    parsed._modelUsed = model;
    return parsed;
}

async function decodeWithGemini(opts) {
    const candidates = buildModelCandidates(opts.model || 'gemini-3.5-flash-lite', !!opts.wakeMode);
    let lastErr = null;
    for (let i = 0; i < candidates.length; i++) {
        const model = candidates[i];
        try {
            return await decodeSingleModelWithGemini(opts, model);
        } catch (e) {
            lastErr = e;
            const st = e && e.httpStatus;
            const isTimeout = /timeout/i.test(String((e && e.message) || ''));
            const isModelParamErr = st === 400 && /thinking|not supported|not enabled/i.test(String((e && e.bodySnippet) || ''));
            // Fail over immediately across independent model quota buckets on 429, 404, 5xx, timeout, or model config mismatch
            if (st === 429 || st === 404 || st === 500 || st === 502 || st === 503 || isTimeout || isModelParamErr) {
                markModelCooldown(model, isModelParamErr ? 404 : (st || 503));
                continue;
            }
            break;
        }
    }
    throw lastErr || new Error('Gemini unavailable');
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

    // 1.5. 100% On-Device Offline Vietnamese STT (`sherpa-onnx` Zipformer 30M int8) -> Zero-Internet Execution!
    let offlineSttTranscript = '';
    if (!plannedCalls.length && !unsupportedReason && o.audioWavBase64 && !transcript && !o.disableOfflineStt && !(wakeMode && o.fastWakeOnly && o.apiKey)) {
        const hasCustomStt = typeof o.offlineTranscribeFn === 'function';
        const warmReady = !!(o.offlineWorker && o.offlineWorker.sttReady);
        const hasLocalStt = hasCustomStt || warmReady || (!o.apiKey && OfflineAi.probeOfflineAi(o.offlineDir).hasStt);
        if (hasLocalStt) {
            try {
                const sttRes = hasCustomStt
                    ? await o.offlineTranscribeFn({ wavBase64: o.audioWavBase64, speakerZone, wakeMode })
                    : await OfflineAi.transcribeOfflineVi({
                        wavBase64: o.audioWavBase64,
                        offlineDir: o.offlineDir,
                        workDir: o.workDir,
                        worker: o.offlineWorker,
                    });
                const offText = sanitizePlainQuotes((sttRes && sttRes.transcript) || '');
                if (offText) {
                    offlineSttTranscript = offText;
                    if (wakeMode) {
                        const wkOff = extractHeyBmwWake(offText);
                        if (wkOff.matched) {
                            if (wkOff.wakeOnly) {
                                return {
                                    at: Date.now(),
                                    ok: true,
                                    ignored: false,
                                    wakeOnly: true,
                                    engine: 'offline_stt',
                                    speakerZone,
                                    transcript: offText,
                                    replyVi: 'Xin chào, tôi đang lắng nghe…',
                                    actions: [],
                                };
                            }
                            const mcOffWake = detectMicCheckUtterance(offText, true);
                            if (mcOffWake) {
                                return {
                                    at: Date.now(),
                                    ok: true,
                                    micCheck: true,
                                    engine: 'offline_stt',
                                    speakerZone,
                                    transcript: mcOffWake.cleanTranscript,
                                    replyVi: 'Mic trần BMW đang nghe rõ - mời đọc câu lệnh điều khiển xe.',
                                    actions: [],
                                };
                            }
                            const unsupOff = detectPhysicalOnlyUnsupported(wkOff.commandText);
                            const offCalls = unsupOff ? [] : parseOfflineVietnamese(wkOff.commandText, speakerZone);
                            if (unsupOff || offCalls.length > 0) {
                                transcript = offText;
                                unsupportedReason = unsupOff;
                                plannedCalls = offCalls;
                                engine = 'offline_stt';
                            }
                        } else if (!o.apiKey) {
                            return {
                                at: Date.now(),
                                ok: false,
                                ignored: true,
                                wakeOnly: false,
                                engine: 'offline_stt',
                                speakerZone,
                                transcript: offText,
                                replyVi: '',
                                actions: [],
                            };
                        }
                    } else {
                        const wkOffOpt = extractHeyBmwWake(offText);
                        if (wkOffOpt.matched && wkOffOpt.wakeOnly) {
                            return {
                                at: Date.now(),
                                ok: true,
                                ignored: false,
                                wakeOnly: true,
                                engine: 'offline_stt',
                                speakerZone,
                                transcript: offText,
                                replyVi: 'Xin chào, mời nói câu lệnh tiếp theo…',
                                actions: [],
                            };
                        }
                        const mcOff = detectMicCheckUtterance(offText, true);
                        if (mcOff) {
                            return {
                                at: Date.now(),
                                ok: true,
                                micCheck: true,
                                engine: 'offline_stt',
                                speakerZone,
                                transcript: mcOff.cleanTranscript,
                                replyVi: 'Mic trần BMW đang nghe rõ - mời đọc câu lệnh điều khiển xe.',
                                actions: [],
                            };
                        }
                        const unsupOff = detectPhysicalOnlyUnsupported(offText);
                        const offCalls = unsupOff ? [] : parseOfflineVietnamese(offText, speakerZone);
                        if (unsupOff || offCalls.length > 0) {
                            transcript = offText;
                            unsupportedReason = unsupOff;
                            plannedCalls = offCalls;
                            engine = 'offline_stt';
                        } else if (!o.apiKey) {
                            transcript = offText;
                            engine = 'offline_stt';
                        }
                    }
                } else if (!o.apiKey) {
                    if (wakeMode) {
                        return {
                            at: Date.now(),
                            ok: false,
                            ignored: true,
                            wakeOnly: false,
                            engine: 'offline_stt',
                            speakerZone,
                            transcript: '',
                            replyVi: '',
                            actions: [],
                        };
                    }
                    return {
                        at: Date.now(),
                        ok: false,
                        engine: 'offline_stt',
                        speakerZone,
                        transcript: '',
                        replyVi: 'Chưa nghe rõ câu lệnh - mời nói lại gần Mic trần hơn.',
                        actions: [],
                    };
                }
            } catch (e) {}
        }
    }

    // 2. Online Gemini Multimodal Audio / Unfamiliar Text Decoder (Optional Fallback)
    if (!plannedCalls.length && !unsupportedReason && o.apiKey && (o.audioWavBase64 || transcript)) {
        try {
            const gem = await decodeWithGemini({
                apiKey: o.apiKey,
                model: o.model || 'gemini-3.5-flash-lite',
                audioWavBase64: o.audioWavBase64 || '',
                audioMimeType: o.audioMimeType || 'audio/wav',
                text: transcript,
                speakerZone,
                wakeMode,
                fastWakeOnly: !!o.fastWakeOnly,
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
                    httpStatus: (e && e.httpStatus) || 0,
                    engine: 'wake_net_err',
                    speakerZone,
                    transcript: '',
                    replyVi: '',
                    actions: [],
                };
            }
            if (!transcript && offlineSttTranscript) {
                transcript = offlineSttTranscript;
                engine = 'offline_stt';
            } else if (!transcript) {
                return {
                    at: Date.now(),
                    ok: false,
                    httpStatus: (e && e.httpStatus) || 0,
                    engine: 'net_err',
                    speakerZone,
                    transcript: '',
                    replyVi: formatGeminiErrorVi(e),
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

const TTS_MODEL_CASCADE = [
    'gemini-3.8-flash-lite-tts',
    'gemini-3.1-flash-tts-preview',
    'gemini-2.5-flash-preview-tts',
];

function normalizeWavPcm16(wavBuf) {
    if (!Buffer.isBuffer(wavBuf) || wavBuf.length <= 46) return wavBuf;
    const hdr = OfflineAi.readWavHeaderInfo(wavBuf);
    if (!hdr || !hdr.valid || hdr.bitsPerSample !== 16 || hdr.dataOffset < 44) return wavBuf;
    const totalSamples = Math.floor(hdr.dataLen / 2);
    if (totalSamples < 32) return wavBuf;

    let sq = 0;
    let cnt = 0;
    const step = totalSamples > 8000 ? 2 : 1;
    for (let i = 0; i < totalSamples; i += step) {
        const s = wavBuf.readInt16LE(hdr.dataOffset + i * 2) / 32768.0;
        sq += s * s;
        cnt++;
    }
    const rms = cnt ? Math.sqrt(sq / cnt) : 0;
    if (rms <= 1e-4) return wavBuf;
    const gain = Math.min(5.8, 0.29 / rms);
    if (Math.abs(gain - 1.0) < 0.08) return wavBuf;

    const out = Buffer.from(wavBuf);
    for (let i = 0; i < totalSamples; i++) {
        const pos = hdr.dataOffset + i * 2;
        const raw = (out.readInt16LE(pos) / 32768.0) * gain;
        let x = raw;
        if (raw > 0.78) x = 0.78 + 0.17 * Math.tanh((raw - 0.78) / 0.25);
        else if (raw < -0.78) x = -0.78 - 0.17 * Math.tanh((-raw - 0.78) / 0.25);
        const iv = Math.max(-32767, Math.min(32767, Math.round(x * 32767.0)));
        out.writeInt16LE(iv, pos);
    }
    return out;
}

function intToWordsVi(n) {
    const num = Math.round(Number(n));
    if (!isFinite(num) || num < 0 || num > 999) return String(n);
    const digits = ['không', 'một', 'hai', 'ba', 'bốn', 'năm', 'sáu', 'bảy', 'tám', 'chín'];
    if (num < 10) return digits[num];
    const readTwo = (v) => {
        const t = Math.floor(v / 10);
        const u = v % 10;
        if (t === 1) return 'mười' + (u === 0 ? '' : (u === 5 ? ' lăm' : (' ' + digits[u])));
        const head = digits[t] + ' mươi';
        if (u === 0) return head;
        if (u === 1) return head + ' mốt';
        if (u === 4) return head + ' tư';
        if (u === 5) return head + ' lăm';
        return head + ' ' + digits[u];
    };
    if (num < 100) return readTwo(num);
    const h = Math.floor(num / 100);
    const rem = num % 100;
    if (rem === 0) return digits[h] + ' trăm';
    if (rem < 10) return digits[h] + ' trăm lẻ ' + digits[rem];
    return digits[h] + ' trăm ' + readTwo(rem);
}

/**
 * Expand numbers, decimals, percentages and abbreviations into full Vietnamese words
 * so offline espeak-ng + Piper TTS never spells out characters or breaks at decimal dots.
 */
function formatOfflineSpeechTextVi(rawText) {
    let s = formatSpeechTextVi(rawText)
        .replace(/\bB\s+M\s+W\b/gi, 'bi em')
        .replace(/\bBMW\b/gi, 'bi em')
        .replace(/(\d+)[.,](\d+)\s*%/g, (_, a, b) => intToWordsVi(a) + ' phẩy ' + intToWordsVi(b) + ' phần trăm')
        .replace(/(\d+)\s*%/g, (_, a) => intToWordsVi(a) + ' phần trăm')
        .replace(/(\d+)[.,](\d+)/g, (_, a, b) => intToWordsVi(a) + ' phẩy ' + intToWordsVi(b))
        .replace(/\b(\d{1,3})\b/g, (_, a) => intToWordsVi(a))
        .replace(/%/g, ' phần trăm')
        .replace(/\s+/g, ' ')
        .trim();
    return s;
}

function pcmToWav24kMono(pcmBuf, sampleRate) {
    const sr = sampleRate || 24000;
    const hdr = Buffer.alloc(44);
    hdr.write('RIFF', 0);
    hdr.writeUInt32LE(36 + pcmBuf.length, 4);
    hdr.write('WAVE', 8);
    hdr.write('fmt ', 12);
    hdr.writeUInt32LE(16, 16);
    hdr.writeUInt16LE(1, 20);
    hdr.writeUInt16LE(1, 22);
    hdr.writeUInt32LE(sr, 24);
    hdr.writeUInt32LE(sr * 2, 28);
    hdr.writeUInt16LE(2, 32);
    hdr.writeUInt16LE(16, 34);
    hdr.write('data', 36);
    hdr.writeUInt32LE(pcmBuf.length, 40);
    return Buffer.concat([hdr, pcmBuf]);
}

function formatSpeechTextVi(rawText) {
    let s = sanitizePlainQuotes(rawText)
        .replace(/^[✓✔•*\-\s]+/, '')
        .replace(/\s*·\s*/g, ', ')
        .replace(/°C/gi, ' độ')
        .replace(/°/g, ' độ')
        .replace(/(\d+)\.(\d+)\s*V\b/gi, '$1 phẩy $2 vôn')
        .replace(/(\d+)\.(\d+)\s*bar\b/gi, '$1 phẩy $2 ba')
        .replace(/\bkm\b/gi, 'ki lô mét')
        .replace(/\bBMW\b/gi, 'B M W')
        .replace(/\bAC\b/g, 'điều hòa')
        .replace(/\s+/g, ' ')
        .trim();
    if (s.length > 220) s = s.slice(0, 220);
    return s;
}

async function synthesizeVietnameseTts(opts) {
    const o = opts || {};
    const spoken = formatSpeechTextVi(o.text || '');
    if (!spoken || !o.apiKey) return null;

    const budget = Number(o.timeoutMs) > 0 ? Number(o.timeoutMs) : 9000;
    const deadline = Date.now() + budget;
    const log = typeof o.log === 'function' ? o.log : () => {};
    for (let i = 0; i < TTS_MODEL_CASCADE.length; i++) {
        const model = TTS_MODEL_CASCADE[i];
        const left = deadline - Date.now();
        if (left < 800) { log('Gemini TTS: out of time before ' + model); break; }
        const body = JSON.stringify({
            contents: [{ role: 'user', parts: [{ text: 'Đọc tự nhiên, rõ ràng, ngắn gọn bằng tiếng Việt: ' + spoken }] }],
            generationConfig: {
                responseModalities: ['AUDIO'],
                speechConfig: {
                    voiceConfig: {
                        prebuiltVoiceConfig: { voiceName: o.voiceName || 'Kore' },
                    },
                },
            },
        });
        try {
            const res = await Up.request(o.uplinkOpts || Up.options(), {
                host: 'generativelanguage.googleapis.com',
                path: '/v1beta/models/' + encodeURIComponent(model) + ':generateContent?key=' + encodeURIComponent(o.apiKey),
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body,
                timeoutMs: left,
            });
            if (res.status < 200 || res.status >= 300) { log('Gemini TTS ' + model + ': HTTP ' + res.status + ' ' + String(res.body || '').replace(/\s+/g, ' ').slice(0, 140)); continue; }
            const data = JSON.parse(res.body);
            const parts = (data && data.candidates && data.candidates[0] && data.candidates[0].content && data.candidates[0].content.parts) || [];
            let inline = null;
            for (let p = 0; p < parts.length; p++) {
                if (parts[p] && parts[p].inlineData && parts[p].inlineData.data) {
                    inline = parts[p].inlineData;
                    break;
                }
            }
            if (!inline) { log('Gemini TTS ' + model + ': no audio in reply'); continue; }
            const raw = Buffer.from(inline.data, 'base64');
            if (raw.length < 200) continue;
            const isWav = raw.length > 44 && raw.slice(0, 4).toString('ascii') === 'RIFF';
            const rateM = /rate=(\d+)/i.exec(String(inline.mimeType || ''));
            const sr = rateM ? Number(rateM[1]) : 24000;
            const wavBuffer = normalizeWavPcm16(isWav ? raw : pcmToWav24kMono(raw, sr));
            const dataBytes = Math.max(0, wavBuffer.length - 44);
            const durationMs = Math.round((dataBytes / (sr * 2)) * 1000);
            return { wavBuffer, durationMs, model, spoken };
        } catch (e) { log('Gemini TTS ' + model + ': ' + (e && e.message)); }
    }
    return null;
}

module.exports = {
    sanitizePlainQuotes,
    normalizeViOrthography,
    extractHeyBmwWake,
    detectMicCheckUtterance,
    detectPhysicalOnlyUnsupported,
    parseOfflineVietnamese,
    groundToolCallsAgainstTranscript,
    resetModelCooldowns,
    buildModelCandidates,
    formatGeminiErrorVi,
    formatSpeechTextVi,
    formatOfflineSpeechTextVi,
    synthesizeVietnameseTts,
    processVoiceOrText,
};
