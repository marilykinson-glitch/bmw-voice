#!/usr/bin/env python3
"""
offline-worker.py - Persistent Warm On-Device STT + TTS Engine for `bmw-voice` (Intel Atom A3960 MGU).

Keeping `SherpaOnnxOfflineRecognizer` (~104 MB RSS) and `SherpaOnnxOfflineTts` (~70 MB RSS) warm in memory
avoids the 19-50s per-call ONNX model graph compilation penalty on Apollo Lake, cutting offline STT to ~2.5-4s.

Also trims leading/trailing silence on incoming command WAVs before STT decoding so 5s capture windows with
1.5s of actual speech decode twice as fast. Automatically exits if parent `stdin` closes (zero orphans).
"""
import array
import ctypes
import json
import math
import os
import signal
import sys
import time
import wave

STOP_FLAG = False


def _handle_sig(_signum, _frame):
    global STOP_FLAG
    STOP_FLAG = True


signal.signal(signal.SIGTERM, _handle_sig)
signal.signal(signal.SIGINT, _handle_sig)


def _emit(obj):
    try:
        sys.stdout.write(json.dumps(obj, ensure_ascii=False) + "\n")
        sys.stdout.flush()
    except OSError:
        pass


# ============================================================
# sherpa-onnx v1.12.40 C-API ctypes Structs (`c-api.h`)
# ============================================================

class FeatureConfig(ctypes.Structure):
    _fields_ = [("sample_rate", ctypes.c_int32), ("feature_dim", ctypes.c_int32)]


class OfflineTransducerModelConfig(ctypes.Structure):
    _fields_ = [("encoder", ctypes.c_char_p), ("decoder", ctypes.c_char_p), ("joiner", ctypes.c_char_p)]


class OfflineParaformerModelConfig(ctypes.Structure):
    _fields_ = [("model", ctypes.c_char_p)]


class OfflineNemoEncDecCtcModelConfig(ctypes.Structure):
    _fields_ = [("model", ctypes.c_char_p)]


class OfflineWhisperModelConfig(ctypes.Structure):
    _fields_ = [
        ("encoder", ctypes.c_char_p),
        ("decoder", ctypes.c_char_p),
        ("language", ctypes.c_char_p),
        ("task", ctypes.c_char_p),
        ("tail_paddings", ctypes.c_int32),
        ("enable_token_timestamps", ctypes.c_int32),
        ("enable_segment_timestamps", ctypes.c_int32),
    ]


class OfflineTdnnModelConfig(ctypes.Structure):
    _fields_ = [("model", ctypes.c_char_p)]


class OfflineLMConfig(ctypes.Structure):
    _fields_ = [("model", ctypes.c_char_p), ("scale", ctypes.c_float)]


class OfflineSenseVoiceModelConfig(ctypes.Structure):
    _fields_ = [("model", ctypes.c_char_p), ("language", ctypes.c_char_p), ("use_itn", ctypes.c_int32)]


class OfflineMoonshineModelConfig(ctypes.Structure):
    _fields_ = [
        ("preprocessor", ctypes.c_char_p),
        ("encoder", ctypes.c_char_p),
        ("uncached_decoder", ctypes.c_char_p),
        ("cached_decoder", ctypes.c_char_p),
        ("merged_decoder", ctypes.c_char_p),
    ]


class OfflineFireRedAsrModelConfig(ctypes.Structure):
    _fields_ = [("encoder", ctypes.c_char_p), ("decoder", ctypes.c_char_p)]


class OfflineDolphinModelConfig(ctypes.Structure):
    _fields_ = [("model", ctypes.c_char_p)]


class OfflineZipformerCtcModelConfig(ctypes.Structure):
    _fields_ = [("model", ctypes.c_char_p)]


class OfflineCanaryModelConfig(ctypes.Structure):
    _fields_ = [
        ("encoder", ctypes.c_char_p),
        ("decoder", ctypes.c_char_p),
        ("src_lang", ctypes.c_char_p),
        ("tgt_lang", ctypes.c_char_p),
        ("use_pnc", ctypes.c_int32),
    ]


class OfflineWenetCtcModelConfig(ctypes.Structure):
    _fields_ = [("model", ctypes.c_char_p)]


class OfflineOmnilingualAsrCtcModelConfig(ctypes.Structure):
    _fields_ = [("model", ctypes.c_char_p)]


class OfflineMedAsrCtcModelConfig(ctypes.Structure):
    _fields_ = [("model", ctypes.c_char_p)]


class OfflineFunASRNanoModelConfig(ctypes.Structure):
    _fields_ = [
        ("encoder_adaptor", ctypes.c_char_p),
        ("llm", ctypes.c_char_p),
        ("embedding", ctypes.c_char_p),
        ("tokenizer", ctypes.c_char_p),
        ("system_prompt", ctypes.c_char_p),
        ("user_prompt", ctypes.c_char_p),
        ("max_new_tokens", ctypes.c_int32),
        ("temperature", ctypes.c_float),
        ("top_p", ctypes.c_float),
        ("seed", ctypes.c_int32),
        ("language", ctypes.c_char_p),
        ("itn", ctypes.c_int32),
        ("hotwords", ctypes.c_char_p),
    ]


class OfflineFireRedAsrCtcModelConfig(ctypes.Structure):
    _fields_ = [("model", ctypes.c_char_p)]


class OfflineQwen3ASRModelConfig(ctypes.Structure):
    _fields_ = [
        ("conv_frontend", ctypes.c_char_p),
        ("encoder", ctypes.c_char_p),
        ("decoder", ctypes.c_char_p),
        ("tokenizer", ctypes.c_char_p),
        ("max_total_len", ctypes.c_int32),
        ("max_new_tokens", ctypes.c_int32),
        ("temperature", ctypes.c_float),
        ("top_p", ctypes.c_float),
        ("seed", ctypes.c_int32),
        ("hotwords", ctypes.c_char_p),
    ]


class OfflineCohereTranscribeModelConfig(ctypes.Structure):
    _fields_ = [
        ("encoder", ctypes.c_char_p),
        ("decoder", ctypes.c_char_p),
        ("language", ctypes.c_char_p),
        ("use_punct", ctypes.c_int32),
        ("use_itn", ctypes.c_int32),
    ]


class OfflineModelConfig(ctypes.Structure):
    _fields_ = [
        ("transducer", OfflineTransducerModelConfig),
        ("paraformer", OfflineParaformerModelConfig),
        ("nemo_ctc", OfflineNemoEncDecCtcModelConfig),
        ("whisper", OfflineWhisperModelConfig),
        ("tdnn", OfflineTdnnModelConfig),
        ("tokens", ctypes.c_char_p),
        ("num_threads", ctypes.c_int32),
        ("debug", ctypes.c_int32),
        ("provider", ctypes.c_char_p),
        ("model_type", ctypes.c_char_p),
        ("modeling_unit", ctypes.c_char_p),
        ("bpe_vocab", ctypes.c_char_p),
        ("telespeech_ctc", ctypes.c_char_p),
        ("sense_voice", OfflineSenseVoiceModelConfig),
        ("moonshine", OfflineMoonshineModelConfig),
        ("fire_red_asr", OfflineFireRedAsrModelConfig),
        ("dolphin", OfflineDolphinModelConfig),
        ("zipformer_ctc", OfflineZipformerCtcModelConfig),
        ("canary", OfflineCanaryModelConfig),
        ("wenet_ctc", OfflineWenetCtcModelConfig),
        ("omnilingual", OfflineOmnilingualAsrCtcModelConfig),
        ("medasr", OfflineMedAsrCtcModelConfig),
        ("funasr_nano", OfflineFunASRNanoModelConfig),
        ("fire_red_asr_ctc", OfflineFireRedAsrCtcModelConfig),
        ("qwen3_asr", OfflineQwen3ASRModelConfig),
        ("cohere_transcribe", OfflineCohereTranscribeModelConfig),
    ]


class HomophoneReplacerConfig(ctypes.Structure):
    _fields_ = [("dict_dir", ctypes.c_char_p), ("lexicon", ctypes.c_char_p), ("rule_fsts", ctypes.c_char_p)]


class OfflineRecognizerConfig(ctypes.Structure):
    _fields_ = [
        ("feat_config", FeatureConfig),
        ("model_config", OfflineModelConfig),
        ("lm_config", OfflineLMConfig),
        ("decoding_method", ctypes.c_char_p),
        ("max_active_paths", ctypes.c_int32),
        ("hotwords_file", ctypes.c_char_p),
        ("hotwords_score", ctypes.c_float),
        ("rule_fsts", ctypes.c_char_p),
        ("rule_fars", ctypes.c_char_p),
        ("blank_penalty", ctypes.c_float),
        ("hr", HomophoneReplacerConfig),
    ]


class OfflineTtsVitsModelConfig(ctypes.Structure):
    _fields_ = [
        ("model", ctypes.c_char_p),
        ("lexicon", ctypes.c_char_p),
        ("tokens", ctypes.c_char_p),
        ("data_dir", ctypes.c_char_p),
        ("noise_scale", ctypes.c_float),
        ("noise_scale_w", ctypes.c_float),
        ("length_scale", ctypes.c_float),
        ("dict_dir", ctypes.c_char_p),
    ]


class OfflineTtsMatchaModelConfig(ctypes.Structure):
    _fields_ = [
        ("acoustic_model", ctypes.c_char_p),
        ("vocoder", ctypes.c_char_p),
        ("lexicon", ctypes.c_char_p),
        ("tokens", ctypes.c_char_p),
        ("data_dir", ctypes.c_char_p),
        ("noise_scale", ctypes.c_float),
        ("length_scale", ctypes.c_float),
        ("dict_dir", ctypes.c_char_p),
    ]


class OfflineTtsKokoroModelConfig(ctypes.Structure):
    _fields_ = [
        ("model", ctypes.c_char_p),
        ("voices", ctypes.c_char_p),
        ("tokens", ctypes.c_char_p),
        ("data_dir", ctypes.c_char_p),
        ("length_scale", ctypes.c_float),
        ("dict_dir", ctypes.c_char_p),
        ("lexicon", ctypes.c_char_p),
        ("lang", ctypes.c_char_p),
    ]


class OfflineTtsKittenModelConfig(ctypes.Structure):
    _fields_ = [
        ("model", ctypes.c_char_p),
        ("voices", ctypes.c_char_p),
        ("tokens", ctypes.c_char_p),
        ("data_dir", ctypes.c_char_p),
        ("length_scale", ctypes.c_float),
    ]


class OfflineTtsZipvoiceModelConfig(ctypes.Structure):
    _fields_ = [
        ("tokens", ctypes.c_char_p),
        ("encoder", ctypes.c_char_p),
        ("decoder", ctypes.c_char_p),
        ("vocoder", ctypes.c_char_p),
        ("data_dir", ctypes.c_char_p),
        ("lexicon", ctypes.c_char_p),
        ("feat_scale", ctypes.c_float),
        ("t_shift", ctypes.c_float),
        ("target_rms", ctypes.c_float),
        ("guidance_scale", ctypes.c_float),
    ]


class OfflineTtsPocketModelConfig(ctypes.Structure):
    _fields_ = [
        ("lm_flow", ctypes.c_char_p),
        ("lm_main", ctypes.c_char_p),
        ("encoder", ctypes.c_char_p),
        ("decoder", ctypes.c_char_p),
        ("text_conditioner", ctypes.c_char_p),
        ("vocab_json", ctypes.c_char_p),
        ("token_scores_json", ctypes.c_char_p),
        ("voice_embedding_cache_capacity", ctypes.c_int32),
    ]


class OfflineTtsSupertonicModelConfig(ctypes.Structure):
    _fields_ = [
        ("duration_predictor", ctypes.c_char_p),
        ("text_encoder", ctypes.c_char_p),
        ("vector_estimator", ctypes.c_char_p),
        ("vocoder", ctypes.c_char_p),
        ("tts_json", ctypes.c_char_p),
        ("unicode_indexer", ctypes.c_char_p),
        ("voice_style", ctypes.c_char_p),
    ]


class OfflineTtsModelConfig(ctypes.Structure):
    _fields_ = [
        ("vits", OfflineTtsVitsModelConfig),
        ("num_threads", ctypes.c_int32),
        ("debug", ctypes.c_int32),
        ("provider", ctypes.c_char_p),
        ("matcha", OfflineTtsMatchaModelConfig),
        ("kokoro", OfflineTtsKokoroModelConfig),
        ("kitten", OfflineTtsKittenModelConfig),
        ("zipvoice", OfflineTtsZipvoiceModelConfig),
        ("pocket", OfflineTtsPocketModelConfig),
        ("supertonic", OfflineTtsSupertonicModelConfig),
    ]


class OfflineTtsConfig(ctypes.Structure):
    _fields_ = [
        ("model", OfflineTtsModelConfig),
        ("rule_fsts", ctypes.c_char_p),
        ("max_num_sentences", ctypes.c_int32),
        ("rule_fars", ctypes.c_char_p),
        ("silence_scale", ctypes.c_float),
    ]


class GeneratedAudio(ctypes.Structure):
    _fields_ = [
        ("samples", ctypes.POINTER(ctypes.c_float)),
        ("n", ctypes.c_int32),
        ("sample_rate", ctypes.c_int32),
    ]


def _load_wav_best_mono_trimmed(wav_path):
    """Read 16-bit WAV, select clearest mono channel, trim dead leading/trailing silence (keeps 180ms pad)."""
    with wave.open(wav_path, "rb") as wf:
        ch = wf.getnchannels()
        sw = wf.getsampwidth()
        sr = wf.getframerate()
        raw = wf.readframes(wf.getnframes())
    if sw != 2 or sr <= 0 or not raw:
        return 16000, []
    samples = array.array("h")
    samples.frombytes(raw)
    if sys.byteorder != "little":
        samples.byteswap()
    if ch >= 2:
        left = samples[0::ch]
        right = samples[1::ch]
        n = min(len(left), len(right))
        rms_l = math.sqrt(sum(left[i] * left[i] for i in range(0, n, 2)) / float(max(1, n // 2)))
        rms_r = math.sqrt(sum(right[i] * right[i] for i in range(0, n, 2)) / float(max(1, n // 2)))
        if rms_l >= rms_r * 1.45:
            mono = left
        elif rms_r >= rms_l * 1.45:
            mono = right
        else:
            mono = array.array("h", ((left[i] + right[i]) >> 1 for i in range(n)))
    else:
        mono = samples

    n = len(mono)
    if n < 100:
        return sr, []

    # Speech-band RMS envelope in 40ms windows to trim long idle tail & halve Zipformer decode time
    win = max(160, int(sr * 0.04))
    w_rms = []
    for off in range(0, n, win):
        seg = mono[off : min(n, off + win)]
        if len(seg) < 8:
            w_rms.append(0.0)
            continue
        sq = 0.0
        for k in range(2, len(seg), 2):
            d = seg[k] - seg[k - 2]
            sq += d * d
        w_rms.append(math.sqrt(sq / float(max(1, len(seg) // 2))))
    if w_rms:
        s_rms = sorted(w_rms)
        floor = s_rms[int(len(s_rms) * 0.15)]
        pk = s_rms[-1]
        thr = max(floor * 2.1, pk * 0.12, 180.0)
        first = 0
        last = len(w_rms) - 1
        while first < len(w_rms) and w_rms[first] < thr:
            first += 1
        while last > first and w_rms[last] < thr:
            last -= 1
        if first <= last:
            pad = max(1, int(0.18 / 0.04))
            i0 = max(0, (first - pad) * win)
            i1 = min(n, (last + 1 + pad) * win)
            if (i1 - i0) >= int(sr * 0.45):
                mono = mono[i0:i1]

    inv = 1.0 / 32768.0
    return sr, [x * inv for x in mono]


def _write_wav_float_mono(out_path, sr, n, ptr):
    # Measure RMS to normalize Piper TTS (~-20.6 dBFS -> -10.8 dBFS) with soft tanh limiting
    sq = 0.0
    step = 2 if n > 8000 else 1
    cnt = 0
    for i in range(0, n, step):
        s = ptr[i]
        sq += s * s
        cnt += 1
    rms = math.sqrt(sq / float(max(1, cnt))) if cnt else 0.0
    gain = min(5.8, 0.29 / max(1e-4, rms)) if rms > 1e-4 else 1.0
    pcm = array.array("h")
    for i in range(n):
        raw_v = ptr[i] * gain
        if raw_v > 0.78:
            x = 0.78 + 0.17 * math.tanh((raw_v - 0.78) / 0.25)
        elif raw_v < -0.78:
            x = -0.78 - 0.17 * math.tanh((-raw_v - 0.78) / 0.25)
        else:
            x = raw_v
        v = x * 32767.0
        if v > 32767.0:
            v = 32767.0
        elif v < -32767.0:
            v = -32767.0
        pcm.append(int(v))
    if sys.byteorder != "little":
        pcm.byteswap()
    tmp = out_path + ".tmp." + str(os.getpid())
    with wave.open(tmp, "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(sr)
        wf.writeframes(pcm.tobytes())
    os.chmod(tmp, 0o644)
    os.replace(tmp, out_path)


def run_worker(offline_dir):
    try:
        os.nice(8)
    except OSError:
        pass

    lib_dir = os.path.join(offline_dir, "lib")
    stt_dir = os.path.join(offline_dir, "stt-vi")
    tts_dir = os.path.join(offline_dir, "tts-vi")
    ort_so = os.path.join(lib_dir, "libonnxruntime.so")
    capi_so = os.path.join(lib_dir, "libsherpa-onnx-c-api.so")

    if not os.path.exists(ort_so) or not os.path.exists(capi_so):
        _emit({"event": "fatal", "error": "missing sherpa-onnx shared libraries"})
        return 2

    ctypes.CDLL(ort_so, mode=ctypes.RTLD_GLOBAL)
    lib = ctypes.CDLL(capi_so)

    lib.SherpaOnnxCreateOfflineRecognizer.argtypes = [ctypes.POINTER(OfflineRecognizerConfig)]
    lib.SherpaOnnxCreateOfflineRecognizer.restype = ctypes.c_void_p
    lib.SherpaOnnxDestroyOfflineRecognizer.argtypes = [ctypes.c_void_p]
    lib.SherpaOnnxCreateOfflineStream.argtypes = [ctypes.c_void_p]
    lib.SherpaOnnxCreateOfflineStream.restype = ctypes.c_void_p
    lib.SherpaOnnxDestroyOfflineStream.argtypes = [ctypes.c_void_p]
    lib.SherpaOnnxAcceptWaveformOffline.argtypes = [
        ctypes.c_void_p, ctypes.c_int32, ctypes.POINTER(ctypes.c_float), ctypes.c_int32
    ]
    lib.SherpaOnnxDecodeOfflineStream.argtypes = [ctypes.c_void_p, ctypes.c_void_p]
    lib.SherpaOnnxGetOfflineStreamResultAsJson.argtypes = [ctypes.c_void_p]
    lib.SherpaOnnxGetOfflineStreamResultAsJson.restype = ctypes.c_void_p
    lib.SherpaOnnxDestroyOfflineStreamResultJson.argtypes = [ctypes.c_void_p]

    lib.SherpaOnnxCreateOfflineTts.argtypes = [ctypes.POINTER(OfflineTtsConfig)]
    lib.SherpaOnnxCreateOfflineTts.restype = ctypes.c_void_p
    lib.SherpaOnnxDestroyOfflineTts.argtypes = [ctypes.c_void_p]
    lib.SherpaOnnxOfflineTtsGenerate.argtypes = [
        ctypes.c_void_p, ctypes.c_char_p, ctypes.c_int32, ctypes.c_float
    ]
    lib.SherpaOnnxOfflineTtsGenerate.restype = ctypes.POINTER(GeneratedAudio)
    lib.SherpaOnnxDestroyOfflineTtsGeneratedAudio.argtypes = [ctypes.POINTER(GeneratedAudio)]

    rec = None
    tts = None
    _ka = []

    enc = os.path.join(stt_dir, "encoder.int8.onnx")
    dec = os.path.join(stt_dir, "decoder.onnx")
    joi = os.path.join(stt_dir, "joiner.int8.onnx")
    stt_tok = os.path.join(stt_dir, "tokens.txt")
    if all(os.path.exists(p) for p in (enc, dec, joi, stt_tok)):
        t0 = time.monotonic()
        rcfg = OfflineRecognizerConfig()
        rcfg.feat_config.sample_rate = 16000
        rcfg.feat_config.feature_dim = 80
        b_enc, b_dec, b_joi, b_tok = enc.encode(), dec.encode(), joi.encode(), stt_tok.encode()
        b_prov, b_mt, b_dm = b"cpu", b"transducer", b"greedy_search"
        _ka.extend([b_enc, b_dec, b_joi, b_tok, b_prov, b_mt, b_dm])
        rcfg.model_config.transducer.encoder = b_enc
        rcfg.model_config.transducer.decoder = b_dec
        rcfg.model_config.transducer.joiner = b_joi
        rcfg.model_config.tokens = b_tok
        rcfg.model_config.num_threads = 3
        rcfg.model_config.provider = b_prov
        rcfg.model_config.model_type = b_mt
        rcfg.decoding_method = b_dm
        rec = lib.SherpaOnnxCreateOfflineRecognizer(ctypes.byref(rcfg))
        if rec:
            _emit({"event": "stt_ready", "initMs": int(round((time.monotonic() - t0) * 1000))})

    t_mod = os.path.join(tts_dir, "vi_VN-vais1000-medium.onnx")
    t_tok = os.path.join(tts_dir, "tokens.txt")
    t_dd = os.path.join(tts_dir, "espeak-ng-data")
    if os.path.exists(t_mod) and os.path.exists(t_tok) and os.path.exists(os.path.join(t_dd, "phontab")):
        t0 = time.monotonic()
        tcfg = OfflineTtsConfig()
        bm, bt, bd, bp = t_mod.encode(), t_tok.encode(), t_dd.encode(), b"cpu"
        _ka.extend([bm, bt, bd, bp])
        tcfg.model.vits.model = bm
        tcfg.model.vits.tokens = bt
        tcfg.model.vits.data_dir = bd
        tcfg.model.vits.noise_scale = 0.667
        tcfg.model.vits.noise_scale_w = 0.8
        tcfg.model.vits.length_scale = 1.0
        tcfg.model.num_threads = 2
        tcfg.model.provider = bp
        tcfg.max_num_sentences = 4
        tcfg.silence_scale = 0.05
        tts = lib.SherpaOnnxCreateOfflineTts(ctypes.byref(tcfg))
        if tts:
            _emit({"event": "tts_ready", "initMs": int(round((time.monotonic() - t0) * 1000))})

    _emit({"event": "ready", "stt": bool(rec), "tts": bool(tts)})

    try:
        while not STOP_FLAG:
            line = sys.stdin.readline()
            if not line:
                break
            s = line.strip()
            if not s:
                continue
            try:
                cmd = json.loads(s)
            except ValueError:
                continue
            op = cmd.get("cmd")
            req_id = cmd.get("reqId", 0)
            if op == "stop":
                break
            elif op == "stt":
                wav_path = cmd.get("wavPath", "")
                t0 = time.monotonic()
                if not rec:
                    _emit({"event": "stt_result", "reqId": req_id, "ok": False, "text": "", "error": "stt not ready"})
                    continue
                try:
                    sr, floats = _load_wav_best_mono_trimmed(wav_path)
                    if not floats:
                        _emit({"event": "stt_result", "reqId": req_id, "ok": True, "text": "", "elapsedMs": 0})
                        continue
                    fbuf = (ctypes.c_float * len(floats))(*floats)
                    st = lib.SherpaOnnxCreateOfflineStream(rec)
                    lib.SherpaOnnxAcceptWaveformOffline(st, int(sr), fbuf, len(floats))
                    lib.SherpaOnnxDecodeOfflineStream(rec, st)
                    ptr = lib.SherpaOnnxGetOfflineStreamResultAsJson(st)
                    text = ""
                    if ptr:
                        js = json.loads(ctypes.string_at(ptr).decode("utf-8", "replace"))
                        text = str(js.get("text") or "").strip()
                        lib.SherpaOnnxDestroyOfflineStreamResultJson(ptr)
                    lib.SherpaOnnxDestroyOfflineStream(st)
                    dt = int(round((time.monotonic() - t0) * 1000))
                    _emit({"event": "stt_result", "reqId": req_id, "ok": True, "text": text, "elapsedMs": dt})
                except Exception as exc:
                    _emit({"event": "stt_result", "reqId": req_id, "ok": False, "text": "", "error": str(exc)})
            elif op == "tts":
                text = str(cmd.get("text") or "").strip()
                out_path = str(cmd.get("outPath") or "").strip()
                speed = float(cmd.get("speed") or 1.20)
                t0 = time.monotonic()
                if not tts or not text or not out_path:
                    _emit({"event": "tts_result", "reqId": req_id, "ok": False, "error": "tts not ready"})
                    continue
                au = None
                try:
                    au = lib.SherpaOnnxOfflineTtsGenerate(tts, text.encode("utf-8"), 0, ctypes.c_float(speed))
                    if not au or au.contents.n <= 0:
                        _emit({"event": "tts_result", "reqId": req_id, "ok": False, "error": "empty audio"})
                        continue
                    n_s = au.contents.n
                    sr = au.contents.sample_rate or 22050
                    _write_wav_float_mono(out_path, sr, n_s, au.contents.samples)
                    dur_ms = int(round((n_s / float(sr)) * 1000))
                    dt = int(round((time.monotonic() - t0) * 1000))
                    _emit({"event": "tts_result", "reqId": req_id, "ok": True, "durationMs": dur_ms, "sampleRate": sr, "elapsedMs": dt})
                except Exception as exc:
                    _emit({"event": "tts_result", "reqId": req_id, "ok": False, "error": str(exc)})
                finally:
                    if au:
                        lib.SherpaOnnxDestroyOfflineTtsGeneratedAudio(au)
    finally:
        if tts:
            lib.SherpaOnnxDestroyOfflineTts(tts)
        if rec:
            lib.SherpaOnnxDestroyOfflineRecognizer(rec)
    return 0


if __name__ == "__main__":
    if len(sys.argv) < 2:
        sys.stderr.write("Usage: offline-worker.py <offline_dir>\n")
        sys.exit(2)
    sys.exit(run_worker(sys.argv[1]))
