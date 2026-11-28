#!/usr/bin/env python3
"""
alsa-smartx.py - SmartXbar Ceiling Microphone Recorder & Zero-Spawn "Hey BMW" Stream Engine (`bmw-voice`).

Modes:
  1. One-shot fallback clip capture:
       alsa-smartx.py <device> <out.wav> [duration_sec] [rate] [hw_channels]
  2. Persistent low-CPU (<0.2%) stream daemon (`--stream-daemon`):
       alsa-smartx.py --stream-daemon <device> <work_dir> [rate] [hw_channels]
     - Keeps a 800ms RAM pre-roll buffer so "Hey BMW" is never clipped and Steering Wheel PTT starts in <1ms
       (zero Python/ALSA spawn delay!).
     - Uses Amplifier Reference channel (`ch 2` on `2MIC_6REF` / `1MIC_6REF`) + syllabic SNR gate to reject
       steady CarPlay music bleed, road hum, and short cabin clicks before waking NLU.
     - Automatically exits if parent `stdin` closes (zero orphan processes).
"""
import array
import collections
import ctypes
import json
import math
import os
import signal
import sys
import threading
import time
import wave

SND_PCM_STREAM_CAPTURE = 1
SND_PCM_NONBLOCK = 1
SND_PCM_FORMAT_S16_LE = 2
SND_PCM_ACCESS_RW_INTERLEAVED = 3
EAGAIN = -11

STOP_FLAG = False


def _handle_sig(_signum, _frame):
    global STOP_FLAG
    STOP_FLAG = True


signal.signal(signal.SIGTERM, _handle_sig)
signal.signal(signal.SIGINT, _handle_sig)


def _emit_json(obj):
    try:
        sys.stdout.write(json.dumps(obj, ensure_ascii=False) + "\n")
        sys.stdout.flush()
    except OSError:
        pass


# ============================================================
# Optional 100% Offline Streaming "Hey BMW" KWS (`sherpa-onnx` C-API v1.12.x)
# ============================================================

class _SherpaFeatureConfig(ctypes.Structure):
    _fields_ = [
        ("sample_rate", ctypes.c_int32),
        ("feature_dim", ctypes.c_int32),
    ]


class _SherpaOnlineTransducerModelConfig(ctypes.Structure):
    _fields_ = [
        ("encoder", ctypes.c_char_p),
        ("decoder", ctypes.c_char_p),
        ("joiner", ctypes.c_char_p),
    ]


class _SherpaOnlineParaformerModelConfig(ctypes.Structure):
    _fields_ = [
        ("encoder", ctypes.c_char_p),
        ("decoder", ctypes.c_char_p),
    ]


class _SherpaOnlineZipformer2CtcModelConfig(ctypes.Structure):
    _fields_ = [("model", ctypes.c_char_p)]


class _SherpaOnlineNemoCtcModelConfig(ctypes.Structure):
    _fields_ = [("model", ctypes.c_char_p)]


class _SherpaOnlineToneCtcModelConfig(ctypes.Structure):
    _fields_ = [("model", ctypes.c_char_p)]


class _SherpaOnlineModelConfig(ctypes.Structure):
    _fields_ = [
        ("transducer", _SherpaOnlineTransducerModelConfig),
        ("paraformer", _SherpaOnlineParaformerModelConfig),
        ("zipformer2_ctc", _SherpaOnlineZipformer2CtcModelConfig),
        ("tokens", ctypes.c_char_p),
        ("num_threads", ctypes.c_int32),
        ("provider", ctypes.c_char_p),
        ("debug", ctypes.c_int32),
        ("model_type", ctypes.c_char_p),
        ("modeling_unit", ctypes.c_char_p),
        ("bpe_vocab", ctypes.c_char_p),
        ("tokens_buf", ctypes.c_char_p),
        ("tokens_buf_size", ctypes.c_int32),
        ("nemo_ctc", _SherpaOnlineNemoCtcModelConfig),
        ("t_one_ctc", _SherpaOnlineToneCtcModelConfig),
    ]


class _SherpaKeywordSpotterConfig(ctypes.Structure):
    _fields_ = [
        ("feat_config", _SherpaFeatureConfig),
        ("model_config", _SherpaOnlineModelConfig),
        ("max_active_paths", ctypes.c_int32),
        ("num_trailing_blanks", ctypes.c_int32),
        ("keywords_score", ctypes.c_float),
        ("keywords_threshold", ctypes.c_float),
        ("keywords_file", ctypes.c_char_p),
        ("keywords_buf", ctypes.c_char_p),
        ("keywords_buf_size", ctypes.c_int32),
    ]


class LocalKwsEngine:
    """Zero-network streaming 'Hey BMW' keyword spotter powered by libsherpa-onnx-c-api.so."""

    @staticmethod
    def _pick_onnx(kws_dir, prefix, prefer_int8=True):
        if not os.path.isdir(kws_dir):
            return ""
        cands = [f for f in os.listdir(kws_dir) if f.startswith(prefix) and f.endswith(".onnx")]
        if not cands:
            return ""
        cands.sort(key=lambda n: (0 if (".int8." in n) == prefer_int8 else 1, len(n), n))
        return os.path.join(kws_dir, cands[0])

    def __init__(self, offline_dir):
        self.lib = None
        self.spotter = None
        self.stream = None
        self.available = False
        self.error = ""
        self._keepalive = []
        self._ds_carry = None
        self._hp_xp = 0.0
        self._hp_yp = 0.0
        self._agc_gain = 1.0

        if not offline_dir:
            return
        lib_dir = os.path.join(offline_dir, "lib")
        kws_dir = os.path.join(offline_dir, "kws")
        ort_so = os.path.join(lib_dir, "libonnxruntime.so")
        capi_so = os.path.join(lib_dir, "libsherpa-onnx-c-api.so")
        enc = self._pick_onnx(kws_dir, "encoder", prefer_int8=True)
        dec = self._pick_onnx(kws_dir, "decoder", prefer_int8=False)
        joi = self._pick_onnx(kws_dir, "joiner", prefer_int8=True)
        tok = os.path.join(kws_dir, "tokens.txt")
        kwf = os.path.join(kws_dir, "keywords.txt")

        for p in (ort_so, capi_so, enc, dec, joi, tok, kwf):
            if not p or not os.path.exists(p):
                return

        try:
            ctypes.CDLL(ort_so, mode=ctypes.RTLD_GLOBAL)
            lib = ctypes.CDLL(capi_so)

            lib.SherpaOnnxCreateKeywordSpotter.argtypes = [ctypes.POINTER(_SherpaKeywordSpotterConfig)]
            lib.SherpaOnnxCreateKeywordSpotter.restype = ctypes.c_void_p
            lib.SherpaOnnxDestroyKeywordSpotter.argtypes = [ctypes.c_void_p]
            lib.SherpaOnnxDestroyKeywordSpotter.restype = None

            lib.SherpaOnnxCreateKeywordStream.argtypes = [ctypes.c_void_p]
            lib.SherpaOnnxCreateKeywordStream.restype = ctypes.c_void_p
            lib.SherpaOnnxDestroyOnlineStream.argtypes = [ctypes.c_void_p]
            lib.SherpaOnnxDestroyOnlineStream.restype = None

            lib.SherpaOnnxOnlineStreamAcceptWaveform.argtypes = [
                ctypes.c_void_p,
                ctypes.c_int32,
                ctypes.POINTER(ctypes.c_float),
                ctypes.c_int32,
            ]
            lib.SherpaOnnxOnlineStreamAcceptWaveform.restype = None

            lib.SherpaOnnxIsKeywordStreamReady.argtypes = [ctypes.c_void_p, ctypes.c_void_p]
            lib.SherpaOnnxIsKeywordStreamReady.restype = ctypes.c_int32
            lib.SherpaOnnxDecodeKeywordStream.argtypes = [ctypes.c_void_p, ctypes.c_void_p]
            lib.SherpaOnnxDecodeKeywordStream.restype = None
            lib.SherpaOnnxResetKeywordStream.argtypes = [ctypes.c_void_p, ctypes.c_void_p]
            lib.SherpaOnnxResetKeywordStream.restype = None

            lib.SherpaOnnxGetKeywordResultAsJson.argtypes = [ctypes.c_void_p, ctypes.c_void_p]
            lib.SherpaOnnxGetKeywordResultAsJson.restype = ctypes.c_void_p
            lib.SherpaOnnxFreeKeywordResultJson.argtypes = [ctypes.c_void_p]
            lib.SherpaOnnxFreeKeywordResultJson.restype = None

            cfg = _SherpaKeywordSpotterConfig()
            cfg.feat_config.sample_rate = 16000
            cfg.feat_config.feature_dim = 80
            b_enc = enc.encode("utf-8")
            b_dec = dec.encode("utf-8")
            b_joi = joi.encode("utf-8")
            b_tok = tok.encode("utf-8")
            b_kwf = kwf.encode("utf-8")
            b_prov = b"cpu"
            self._keepalive = [b_enc, b_dec, b_joi, b_tok, b_kwf, b_prov]

            cfg.model_config.transducer.encoder = b_enc
            cfg.model_config.transducer.decoder = b_dec
            cfg.model_config.transducer.joiner = b_joi
            cfg.model_config.tokens = b_tok
            cfg.model_config.num_threads = 1
            cfg.model_config.provider = b_prov
            cfg.model_config.debug = 0

            cfg.max_active_paths = 6
            cfg.num_trailing_blanks = 1
            cfg.keywords_score = 3.0
            cfg.keywords_threshold = 0.05
            cfg.keywords_file = b_kwf

            spotter = lib.SherpaOnnxCreateKeywordSpotter(ctypes.byref(cfg))
            if not spotter:
                self.error = "SherpaOnnxCreateKeywordSpotter returned NULL"
                return
            stream = lib.SherpaOnnxCreateKeywordStream(spotter)
            if not stream:
                lib.SherpaOnnxDestroyKeywordSpotter(spotter)
                self.error = "SherpaOnnxCreateKeywordStream returned NULL"
                return

            self.lib = lib
            self.spotter = spotter
            self.stream = stream
            self.available = True
        except Exception as exc:
            self.error = str(exc)
            self.close()

    def reset(self):
        self._hp_xp = 0.0
        self._hp_yp = 0.0
        self._agc_gain = 1.0
        if self.available and self.lib and self.spotter and self.stream:
            try:
                self.lib.SherpaOnnxResetKeywordStream(self.spotter, self.stream)
            except Exception:
                pass

    def feed_pcm_int16(self, pcm_bytes, out_channels, sample_rate):
        """Feed raw s16le PCM (mono or stereo) into sherpa-onnx KWS at 16 kHz. Returns detected keyword or ''."""
        if not self.available or not pcm_bytes:
            return ""
        samples = array.array("h")
        samples.frombytes(pcm_bytes)
        if sys.byteorder != "little":
            samples.byteswap()
        if not samples:
            return ""

        if out_channels >= 2:
            left = samples[0::2]
            right = samples[1::2]
            n_frames = len(left)
            if n_frames <= 0:
                return ""
            step = 4 if n_frames > 120 else 1
            sq_l = 0.0
            sq_r = 0.0
            for i in range(0, n_frames, step):
                sq_l += left[i] * left[i]
                sq_r += right[i] * right[i]
            if sq_l >= sq_r * 1.82:
                mono = left
            elif sq_r >= sq_l * 1.82:
                mono = right
            else:
                mono = array.array("h", ((left[i] + right[i]) >> 1 for i in range(n_frames)))
        else:
            mono = samples

        sr = int(sample_rate)
        # 1st-order ~175 Hz high-pass filter + smooth AGC boost (car cabin -34 dBFS -> ~-16 dBFS)
        alpha = 0.954 if sr >= 22000 else 0.932
        xp = self._hp_xp
        yp = self._hp_yp
        hp = []
        sq_hp = 0.0
        for x in mono:
            fx = float(x)
            yp = (fx - xp) + alpha * yp
            xp = fx
            hp.append(yp)
            sq_hp += yp * yp
        self._hp_xp = xp
        self._hp_yp = yp

        rms = math.sqrt(sq_hp / float(max(1, len(hp))))
        if rms >= 160.0:
            tgt_gain = min(6.5, max(1.0, 4800.0 / rms))
            self._agc_gain = self._agc_gain * 0.65 + tgt_gain * 0.35
        g = self._agc_gain
        inv = g / 32768.0

        if sr == 24000 and len(hp) >= 3:
            # Clean 3:2 linear downsample to 16 kHz in float domain
            n_triples = len(hp) // 3
            ds = []
            for i in range(n_triples):
                b = i * 3
                v0 = hp[b] * inv
                v1 = ((hp[b + 1] + hp[b + 2]) * 0.5) * inv
                if v0 > 0.98:
                    v0 = 0.98
                elif v0 < -0.98:
                    v0 = -0.98
                if v1 > 0.98:
                    v1 = 0.98
                elif v1 < -0.98:
                    v1 = -0.98
                ds.append(v0)
                ds.append(v1)
            if not ds:
                return ""
            fbuf = (ctypes.c_float * len(ds))(*ds)
            n_in = len(ds)
            sr = 16000
        else:
            n_in = len(hp)
            ds = []
            for v in hp:
                fv = v * inv
                if fv > 0.98:
                    fv = 0.98
                elif fv < -0.98:
                    fv = -0.98
                ds.append(fv)
            fbuf = (ctypes.c_float * n_in)(*ds)

        self.lib.SherpaOnnxOnlineStreamAcceptWaveform(self.stream, sr, fbuf, int(n_in))
        while self.lib.SherpaOnnxIsKeywordStreamReady(self.spotter, self.stream):
            self.lib.SherpaOnnxDecodeKeywordStream(self.spotter, self.stream)

        ptr = self.lib.SherpaOnnxGetKeywordResultAsJson(self.spotter, self.stream)
        if not ptr:
            return ""
        try:
            raw_json = ctypes.string_at(ptr).decode("utf-8", "replace")
        finally:
            self.lib.SherpaOnnxFreeKeywordResultJson(ptr)

        if not raw_json:
            return ""
        try:
            data = json.loads(raw_json)
            kw = str(data.get("keyword") or "").strip()
            if kw:
                self.lib.SherpaOnnxResetKeywordStream(self.spotter, self.stream)
                return kw
        except Exception:
            pass
        return ""

    def close(self):
        if self.lib:
            try:
                if self.stream:
                    self.lib.SherpaOnnxDestroyOnlineStream(self.stream)
            except Exception:
                pass
            try:
                if self.spotter:
                    self.lib.SherpaOnnxDestroyKeywordSpotter(self.spotter)
            except Exception:
                pass
        self.stream = None
        self.spotter = None
        self.lib = None
        self.available = False


def _load_asound():
    asound = ctypes.CDLL("libasound.so.2")
    asound.snd_strerror.argtypes = [ctypes.c_int]
    asound.snd_strerror.restype = ctypes.c_char_p
    asound.snd_pcm_open.argtypes = [ctypes.POINTER(ctypes.c_void_p), ctypes.c_char_p, ctypes.c_int, ctypes.c_int]
    asound.snd_pcm_open.restype = ctypes.c_int
    asound.snd_pcm_nonblock.argtypes = [ctypes.c_void_p, ctypes.c_int]
    asound.snd_pcm_nonblock.restype = ctypes.c_int
    asound.snd_pcm_set_params.argtypes = [
        ctypes.c_void_p,
        ctypes.c_int,
        ctypes.c_int,
        ctypes.c_uint,
        ctypes.c_uint,
        ctypes.c_int,
        ctypes.c_uint,
    ]
    asound.snd_pcm_set_params.restype = ctypes.c_int
    asound.snd_pcm_prepare.argtypes = [ctypes.c_void_p]
    asound.snd_pcm_prepare.restype = ctypes.c_int
    asound.snd_pcm_start.argtypes = [ctypes.c_void_p]
    asound.snd_pcm_start.restype = ctypes.c_int
    asound.snd_pcm_readi.argtypes = [ctypes.c_void_p, ctypes.c_void_p, ctypes.c_ulong]
    asound.snd_pcm_readi.restype = ctypes.c_long
    asound.snd_pcm_recover.argtypes = [ctypes.c_void_p, ctypes.c_int, ctypes.c_int]
    asound.snd_pcm_recover.restype = ctypes.c_int
    asound.snd_pcm_close.argtypes = [ctypes.c_void_p]
    asound.snd_pcm_close.restype = ctypes.c_int
    return asound


def _open_alsa_capture(asound, device, hw_rate, hw_ch):
    pcm = ctypes.c_void_p()
    rc = asound.snd_pcm_open(ctypes.byref(pcm), device.encode("utf-8"), SND_PCM_STREAM_CAPTURE, SND_PCM_NONBLOCK)
    if rc < 0:
        err = asound.snd_strerror(rc).decode("utf-8", "replace")
        raise RuntimeError(f"snd_pcm_open({device}): {err} ({rc})")
    asound.snd_pcm_nonblock(pcm, 1)
    rc = asound.snd_pcm_set_params(
        pcm,
        SND_PCM_FORMAT_S16_LE,
        SND_PCM_ACCESS_RW_INTERLEAVED,
        hw_ch,
        hw_rate,
        1,
        120000,
    )
    if rc < 0:
        asound.snd_pcm_close(pcm)
        err = asound.snd_strerror(rc).decode("utf-8", "replace")
        raise RuntimeError(f"snd_pcm_set_params({device}, ch={hw_ch}, rate={hw_rate}): {err} ({rc})")
    asound.snd_pcm_prepare(pcm)
    asound.snd_pcm_start(pcm)
    return pcm


def _extract_pcm_and_ref_db(raw, got, hw_ch, out_channels):
    """Extract 1/2 mic channels + compute speaker reference channel dB (if hw_ch >= 3)."""
    ref_db = -90.0
    if hw_ch >= 3 and got >= 16:
        all_s = array.array("h")
        all_s.frombytes(raw)
        if sys.byteorder != "little":
            all_s.byteswap()
        # Channel index 2 is ReferenceInput1 (Harman / B&W speaker loopback)
        ref_sub = all_s[2 :: hw_ch * 4]
        if ref_sub:
            ref_rms = math.sqrt(sum(x * x for x in ref_sub) / len(ref_sub)) / 32768.0
            ref_db = round(20.0 * math.log10(ref_rms), 1) if ref_rms > 1e-5 else -90.0

    if hw_ch == out_channels:
        return raw, ref_db
    bytes_per_frame = hw_ch * 2
    sample_bytes = 4 if out_channels == 2 else 2
    out = bytearray()
    for f in range(got):
        off = f * bytes_per_frame
        out.extend(raw[off : off + sample_bytes])
    return bytes(out), ref_db


def _speech_band_db_peak_zcr(pcm_bytes, channels=1):
    """
    Measure human speech band (600-5000 Hz) RMS dBFS, peak, and zero-crossing rate.
    Uses difference filter y[k] = 0.70 * (s[k] - s[k-2]) on 12 kHz decimated PCM:
      |H(f)| = 1.40 * |sin(pi * f / 6000)|
      -> Attenuates <150 Hz truck/tire/exhaust rumble by 21..32 dB & notches 6 kHz AC hiss,
         while passing 1000-4500 Hz human voice ("Hey BMW" & Vietnamese formants) cleanly.
    """
    samples = array.array("h")
    samples.frombytes(pcm_bytes)
    if sys.byteorder != "little":
        samples.byteswap()
    n = len(samples)
    if n < 16:
        return -90.0, 0, 0.0

    def _chan_stats(sub):
        m = len(sub)
        if m < 6:
            return -90.0, 0, 0.0
        sq_sum = 0.0
        pk = 0
        zc = 0
        prev_y = 0.0
        cnt = m - 2
        for k in range(2, m):
            y = (sub[k] - sub[k - 2]) * 0.70
            ay = abs(y)
            if ay > pk:
                pk = ay
            sq_sum += y * y
            if (y >= 0.0 and prev_y < 0.0) or (y < 0.0 and prev_y >= 0.0):
                zc += 1
            prev_y = y
        rms = math.sqrt(sq_sum / float(cnt)) / 32768.0
        db = 20.0 * math.log10(rms) if rms > 1e-5 else -90.0
        return round(db, 1), int(min(32767, round(pk))), round(zc / float(cnt), 3)

    if channels == 2 and n >= 16:
        # Step by 4 interleaved int16s -> 12 kHz per channel when hw_rate == 24 kHz
        db_l, pk_l, zcr_l = _chan_stats(samples[0::4])
        db_r, pk_r, zcr_r = _chan_stats(samples[1::4])
        if db_l >= db_r:
            return db_l, max(pk_l, pk_r), zcr_l
        return db_r, max(pk_l, pk_r), zcr_r

    sub = samples[::2] if n >= 32 else samples
    return _chan_stats(sub)


def _fast_chunk_db_and_peak(pcm_bytes, channels=1):
    db, pk, _ = _speech_band_db_peak_zcr(pcm_bytes, channels)
    return db, pk


def _highpass_speech_samples(samples, channels):
    """1st-order ~175 Hz high-pass filter at 16 kHz to strip road/truck sub-bass before auto-gain & STT."""
    n = len(samples)
    if n < 4:
        return samples
    out = array.array("h", [0] * n)
    alpha = 0.932
    if channels == 2:
        xl = samples[0]
        xr = samples[1]
        yl = 0.0
        yr = 0.0
        for i in range(0, n - 1, 2):
            sl = samples[i]
            sr = samples[i + 1]
            yl = (sl - xl) + alpha * yl
            yr = (sr - xr) + alpha * yr
            xl = sl
            xr = sr
            out[i] = max(-32767, min(32767, int(yl)))
            out[i + 1] = max(-32767, min(32767, int(yr)))
        return out
    xp = samples[0]
    yp = 0.0
    for i in range(n):
        s = samples[i]
        yp = (s - xp) + alpha * yp
        xp = s
        out[i] = max(-32767, min(32767, int(yp)))
    return out


def _measure_snr_and_floor(samples, out_channels, out_rate):
    if not samples:
        return 0.0, -90.0
    win = max(240, int(out_rate * 0.06)) * max(1, out_channels)
    dbs = []
    step = 2 * max(1, out_channels)
    for i in range(0, len(samples), win):
        seg = samples[i : i + win : step]
        if len(seg) < 16:
            continue
        # Evaluate syllabic SNR in the human speech band so <180 Hz truck bumps never fake high SNR
        sq = 0.0
        cnt = len(seg) - 1
        for k in range(1, len(seg)):
            d = (seg[k] - seg[k - 1]) * 0.72
            sq += d * d
        rms = math.sqrt(sq / float(max(1, cnt))) / 32768.0
        dbs.append(20.0 * math.log10(rms) if rms > 1e-5 else -90.0)
    if not dbs:
        return 0.0, -90.0
    dbs.sort()
    p20 = dbs[int(len(dbs) * 0.20)]
    p90 = dbs[min(len(dbs) - 1, int(len(dbs) * 0.90))]
    return round(max(0.0, p90 - p20), 1), round(p20, 1)


def _condition_and_boost_pcm(pcm_bytes, out_channels, out_rate=24000):
    samples = array.array("h")
    samples.frombytes(pcm_bytes)
    if sys.byteorder != "little":
        samples.byteswap()
    if not samples:
        return pcm_bytes, out_channels, out_rate, 0, 0.0

    if out_channels == 2 and len(samples) >= 4:
        left = samples[0::2]
        right = samples[1::2]
        peak_l = max((abs(x) for x in left), default=0)
        peak_r = max((abs(x) for x in right), default=0)
        if peak_r < 25 and peak_l >= 60:
            samples = left
            out_channels = 1
            peak = peak_l
        elif peak_l < 25 and peak_r >= 60:
            samples = right
            out_channels = 1
            peak = peak_r
        else:
            peak = max(peak_l, peak_r)
    else:
        peak = max((abs(x) for x in samples), default=0)

    if out_rate == 24000 and len(samples) >= 12:
        # Clean linear-interpolated 3:2 downsampling (24 kHz -> 16 kHz) to avoid nearest-neighbor
        # jitter/aliasing that distorts Vietnamese vowel formants and tones.
        if out_channels == 1:
            n_in = len(samples)
            out_len = (n_in * 2) // 3
            rs = array.array("h", [0] * out_len)
            for i in range(out_len):
                if (i & 1) == 0:
                    rs[i] = samples[(i // 2) * 3]
                else:
                    base = (i // 2) * 3 + 1
                    nxt = base + 1 if (base + 1) < n_in else base
                    rs[i] = (samples[base] + samples[nxt]) >> 1
            samples = rs
            out_rate = 16000
        elif out_channels == 2:
            in_f = len(samples) // 2
            out_f = (in_f * 2) // 3
            rs = array.array("h", [0] * (out_f * 2))
            for i in range(out_f):
                if (i & 1) == 0:
                    s0 = ((i // 2) * 3) * 2
                    rs[i * 2] = samples[s0]
                    rs[i * 2 + 1] = samples[s0 + 1]
                else:
                    f1 = (i // 2) * 3 + 1
                    f2 = f1 + 1 if (f1 + 1) < in_f else f1
                    rs[i * 2] = (samples[f1 * 2] + samples[f2 * 2]) >> 1
                    rs[i * 2 + 1] = (samples[f1 * 2 + 1] + samples[f2 * 2 + 1]) >> 1
            samples = rs
            out_rate = 16000

    samples = _highpass_speech_samples(samples, out_channels)
    peak = max((abs(x) for x in samples), default=0)

    snr_db, floor_db = _measure_snr_and_floor(samples, out_channels, out_rate)
    # Boost quiet driver speech even in noisy AC/road cabin (`snr_db >= 3.2`), while avoiding boosting pure hiss
    if 80 <= peak < 18000 and snr_db >= 3.2:
        gain = min(12.0, 21000.0 / float(peak))
        if floor_db > -80.0:
            max_noise_gain = 10.0 ** ((-34.0 - floor_db) / 20.0)
            gain = min(gain, max(1.0, max_noise_gain))
        if gain > 1.25:
            samples = array.array("h", (max(-32767, min(32767, int(x * gain))) for x in samples))
            peak = min(32767, int(peak * gain))

    if sys.byteorder != "little":
        samples.byteswap()
    return samples.tobytes(), out_channels, out_rate, int(peak), snr_db


def _write_wav_atomic(out_wav, out_channels, out_rate, pcm_bytes):
    tmp_path = out_wav + ".tmp." + str(os.getpid())
    try:
        with wave.open(tmp_path, "wb") as wf:
            wf.setnchannels(out_channels)
            wf.setsampwidth(2)
            wf.setframerate(out_rate)
            wf.writeframes(pcm_bytes)
        os.replace(tmp_path, out_wav)
    except BaseException:
        try:
            if os.path.exists(tmp_path):
                os.unlink(tmp_path)
        except OSError:
            pass
        raise


def record_smartx_wav(device, out_wav, duration_sec=4.2, rate=24000, hw_channels=8):
    asound = _load_asound()
    hw_rate = int(rate)
    hw_ch = max(1, int(hw_channels))
    out_channels = 2 if hw_ch >= 2 else 1
    max_dur = max(1.5, min(6.0, float(duration_sec)))
    use_early_vad = max_dur >= 2.8

    pcm = _open_alsa_capture(asound, device, hw_rate, hw_ch)
    try:
        total_hw_frames = max(2400, int(max_dur * hw_rate))
        chunk_frames = max(480, int(hw_rate * 0.05))
        bytes_per_frame = hw_ch * 2
        buf = ctypes.create_string_buffer(chunk_frames * bytes_per_frame)

        collected = bytearray()
        frames_read = 0
        saw_nonzero = False
        zero_frames = 0
        max_zero_frames = int(hw_rate * 0.35)
        calib_dbs = []
        floor_db = -45.0
        voiced_chunks = 0
        post_quiet_chunks = 0
        t0 = time.monotonic()
        first_frame_deadline = t0 + 0.75
        hard_deadline = t0 + max_dur + 1.0

        while frames_read < total_hw_frames and not STOP_FLAG:
            now = time.monotonic()
            if frames_read == 0 and now > first_frame_deadline:
                raise RuntimeError(f"no audio frames within 0.75s on {device}")
            if now > hard_deadline:
                break

            want = min(chunk_frames, total_hw_frames - frames_read)
            got = asound.snd_pcm_readi(pcm, buf, want)
            if got == EAGAIN or got == 0:
                time.sleep(0.008)
                continue
            if got < 0:
                rec = asound.snd_pcm_recover(pcm, int(got), 1)
                if rec < 0:
                    err = asound.snd_strerror(int(got)).decode("utf-8", "replace")
                    raise RuntimeError(f"snd_pcm_readi({device}): {err} ({got})")
                asound.snd_pcm_start(pcm)
                time.sleep(0.008)
                continue

            raw = buf.raw[: got * bytes_per_frame]
            chunk_out, _ = _extract_pcm_and_ref_db(raw, got, hw_ch, out_channels)
            if not saw_nonzero:
                if any(b != 0 for b in chunk_out):
                    saw_nonzero = True
                else:
                    zero_frames += got
                    if zero_frames >= max_zero_frames:
                        raise RuntimeError(f"digital zero stream on {device}")
            collected.extend(chunk_out)
            frames_read += got

            if use_early_vad and chunk_out:
                db, pk = _fast_chunk_db_and_peak(chunk_out, out_channels)
                if len(calib_dbs) < 4:
                    if db > -85.0:
                        calib_dbs.append(db)
                        sc = sorted(calib_dbs)
                        floor_db = max(-65.0, min(-26.0, sc[len(sc) // 2]))
                else:
                    is_voiced = (db >= max(-47.0, floor_db + 6.0)) and (pk >= 120)
                    if is_voiced:
                        voiced_chunks += 1
                        post_quiet_chunks = 0
                    else:
                        if voiced_chunks < 4 and db > -85.0:
                            floor_db = max(-65.0, min(-26.0, floor_db * 0.88 + db * 0.12))
                        if voiced_chunks >= 5:
                            post_quiet_chunks += 1
                            if post_quiet_chunks >= 10 and frames_read >= int(hw_rate * 0.85):
                                break

        if not saw_nonzero or len(collected) < 1600:
            raise RuntimeError(f"silent/empty capture on {device}")

        boosted_bytes, final_ch, final_rate, final_peak, snr_db = _condition_and_boost_pcm(
            bytes(collected), out_channels, hw_rate
        )
        _write_wav_atomic(out_wav, final_ch, final_rate, boosted_bytes)
        return {
            "ok": True,
            "device": device,
            "frames": frames_read,
            "outChannels": final_ch,
            "sampleRate": final_rate,
            "peak": final_peak,
            "snrDb": snr_db,
        }
    finally:
        asound.snd_pcm_close(pcm)


def _stereo_lr_db(pcm_bytes, out_channels):
    """Estimate Left (driver) and Right (passenger) RMS dBFS from short PCM buffer."""
    samples = array.array("h")
    samples.frombytes(pcm_bytes)
    if sys.byteorder != "little":
        samples.byteswap()
    if len(samples) < 8:
        return -60.0, -60.0
    if out_channels >= 2:
        left = samples[0::4]
        right = samples[1::4]
        rms_l = math.sqrt(sum(x * x for x in left) / float(max(1, len(left)))) / 32768.0
        rms_r = math.sqrt(sum(x * x for x in right) / float(max(1, len(right)))) / 32768.0
        db_l = round(20.0 * math.log10(rms_l), 1) if rms_l > 1e-5 else -65.0
        db_r = round(20.0 * math.log10(rms_r), 1) if rms_r > 1e-5 else -65.0
        return db_l, db_r
    sub = samples[::2]
    rms = math.sqrt(sum(x * x for x in sub) / float(max(1, len(sub)))) / 32768.0
    db = round(20.0 * math.log10(rms), 1) if rms > 1e-5 else -65.0
    return db, db


def run_stream_daemon(device, work_dir, rate=24000, hw_channels=8, offline_dir=""):
    global STOP_FLAG
    try:
        os.nice(8)
    except OSError:
        pass
    os.makedirs(work_dir, exist_ok=True)
    cmd_queue = collections.deque()

    def _stdin_reader():
        global STOP_FLAG
        while not STOP_FLAG:
            try:
                line = sys.stdin.readline()
            except BaseException:
                line = ""
            if not line:
                STOP_FLAG = True
                break
            s = line.strip()
            if not s:
                continue
            try:
                cmd_queue.append(json.loads(s))
            except ValueError:
                pass

    reader = threading.Thread(target=_stdin_reader, daemon=True)
    reader.start()

    kws = LocalKwsEngine(offline_dir or os.environ.get("BV_OFFLINE_DIR", ""))
    asound = _load_asound()
    hw_rate = int(rate)
    hw_ch = max(1, int(hw_channels))
    out_channels = 2 if hw_ch >= 2 else 1

    pcm = _open_alsa_capture(asound, device, hw_rate, hw_ch)
    try:
        chunk_frames = max(480, int(hw_rate * 0.05))  # 50ms chunks
        bytes_per_frame = hw_ch * 2
        buf = ctypes.create_string_buffer(chunk_frames * bytes_per_frame)

        preroll = collections.deque(maxlen=16)  # 800ms pre-roll
        saw_nonzero = False
        zero_frames = 0
        max_zero_frames = int(hw_rate * 0.60)
        first_frame_deadline = time.monotonic() + 1.10
        ready_sent = False

        floor_db = -46.0
        echo_offset_db = -8.0  # typical ceiling mic attenuation vs speaker reference
        calib_count = 0
        speaker_playing = False
        speaker_active_until = 0.0
        has_ref_channel = hw_ch >= 3

        # Mode: "wake" | "ptt"
        mode = "wake"
        ptt_buf = bytearray()
        ptt_frames = 0
        ptt_max_frames = int(hw_rate * 5.0)
        ptt_voiced = 0
        ptt_voiced_frames = 0
        ptt_quiet_frames = 0
        ptt_req_id = 0
        last_level_emit = 0.0

        wake_active = False
        wake_buf = bytearray()
        wake_frames = 0
        wake_voiced = 0
        wake_voiced_frames = 0
        wake_quiet_frames = 0
        wake_hint_sent = False
        last_hint_at = 0.0
        wake_cooldown_until = 0.0
        kws_hangover_until = 0.0
        kws_active = False

        while not STOP_FLAG:
            # 1. Process instant commands from Node (<1ms PTT switch!)
            while cmd_queue:
                c = cmd_queue.popleft()
                cname = c.get("cmd")
                if cname == "stop":
                    STOP_FLAG = True
                    break
                if cname == "ptt":
                    mode = "ptt"
                    wake_active = False
                    wake_buf.clear()
                    kws.reset()
                    ptt_buf = bytearray()
                    if not c.get("noPreroll"):
                        recent = list(preroll)[-4:]  # 200ms pre-roll so 1st syllable is crisp
                        for ch_bytes in recent:
                            ptt_buf.extend(ch_bytes)
                    ptt_frames = 0
                    max_sec = max(1.8, min(6.5, float(c.get("maxSec", 5.0))))
                    ptt_max_frames = int(hw_rate * max_sec)
                    ptt_voiced = 0
                    ptt_voiced_frames = 0
                    ptt_quiet_frames = 0
                    ptt_req_id = int(c.get("reqId", 0))
                    _emit_json({"event": "ptt_started", "reqId": ptt_req_id})
                elif cname == "ptt_stop" and mode == "ptt":
                    ptt_max_frames = ptt_frames  # finish immediately on next chunk
                elif cname == "cooldown":
                    ms = float(c.get("ms", 800))
                    wake_cooldown_until = time.monotonic() + (ms / 1000.0)
                    wake_active = False
                    wake_buf.clear()
                    kws.reset()

            if STOP_FLAG:
                break

            now = time.monotonic()
            if not ready_sent and now > first_frame_deadline:
                raise RuntimeError(f"no audio frames within 1.1s on {device}")

            got = asound.snd_pcm_readi(pcm, buf, chunk_frames)
            if got == EAGAIN or got == 0:
                time.sleep(0.010)
                continue
            if got < 0:
                rec = asound.snd_pcm_recover(pcm, int(got), 1)
                if rec < 0:
                    err = asound.snd_strerror(int(got)).decode("utf-8", "replace")
                    raise RuntimeError(f"snd_pcm_readi({device}): {err} ({got})")
                asound.snd_pcm_start(pcm)
                time.sleep(0.010)
                continue

            raw = buf.raw[: got * bytes_per_frame]
            chunk_out, ref_db = _extract_pcm_and_ref_db(raw, got, hw_ch, out_channels)
            if not saw_nonzero:
                if any(b != 0 for b in chunk_out):
                    saw_nonzero = True
                else:
                    zero_frames += got
                    if zero_frames >= max_zero_frames:
                        raise RuntimeError(f"digital zero stream on {device}")
                    continue

            if not ready_sent:
                ready_sent = True
                _emit_json({
                    "event": "ready",
                    "device": device,
                    "kwsMode": "offline" if kws.available else "cloud_vad",
                    "kwsError": kws.error,
                    "hasRefChannel": has_ref_channel,
                })

            if has_ref_channel:
                if ref_db > -38.0:
                    speaker_active_until = now + 0.90
                next_spk = now < speaker_active_until
                if next_spk != speaker_playing:
                    speaker_playing = next_spk
                    _emit_json({
                        "event": "speaker_state",
                        "playing": speaker_playing,
                        "refDb": ref_db,
                    })

            db, pk, zcr = _speech_band_db_peak_zcr(chunk_out, out_channels)

            # 2. Active PTT / 2-step follow-up recording
            if mode == "ptt":
                ptt_buf.extend(chunk_out)
                ptt_frames += got
                if (now - last_level_emit) >= 0.14:
                    last_level_emit = now
                    _emit_json({"event": "mic_level", "db": db})

                is_voiced = (db >= max(-48.0, floor_db + 4.8)) and (pk >= 100) and (0.015 <= zcr <= 0.75)
                if is_voiced:
                    ptt_voiced += 1
                    ptt_voiced_frames += got
                    ptt_quiet_frames = 0
                elif ptt_voiced_frames >= int(hw_rate * 0.28):
                    ptt_quiet_frames += got

                # Frame-accurate timing (SmartXbar reads ~22ms per call): wait >=1.40s total & 0.80s pause
                done_early = (
                    ptt_voiced_frames >= int(hw_rate * 0.28)
                    and ptt_quiet_frames >= int(hw_rate * 0.80)
                    and ptt_frames >= int(hw_rate * 1.40)
                )
                if done_early or ptt_frames >= ptt_max_frames:
                    out_wav = os.path.join(work_dir, "ptt_clip.wav")
                    boosted, f_ch, f_rate, f_peak, snr_db = _condition_and_boost_pcm(
                        bytes(ptt_buf), out_channels, hw_rate
                    )
                    _write_wav_atomic(out_wav, f_ch, f_rate, boosted)
                    dur_ms = int(round((len(boosted) / float(max(1, f_ch * 2 * f_rate))) * 1000))
                    _emit_json({
                        "event": "ptt_clip",
                        "reqId": ptt_req_id,
                        "file": out_wav,
                        "durationMs": dur_ms,
                        "peak": f_peak,
                        "snrDb": snr_db,
                        "voicedChunks": ptt_voiced,
                        "device": device,
                    })
                    ptt_buf.clear()
                    preroll.clear()
                    kws.reset()
                    mode = "wake"
                    wake_cooldown_until = time.monotonic() + 0.60
                continue

            # 3. Background "Hey BMW" Wake Word Listener (`mode == "wake"`)
            preroll.append(chunk_out)
            if now < wake_cooldown_until:
                continue

            if calib_count < 6:
                if db > -85.0:
                    floor_db = db if calib_count == 0 else (floor_db * 0.72 + db * 0.28)
                    floor_db = max(-62.0, min(-22.0, floor_db))
                    if hw_ch >= 3 and ref_db > -35.0:
                        echo_offset_db = max(-22.0, min(6.0, db - ref_db))
                    calib_count += 1
                continue

            # 3A. Hybrid "Hey BMW" Wake: Fast Offline Streaming KWS (<50ms) + Short-Utterance VAD Fallback (`wake_clip`)
            if kws.available:
                music_playing = (hw_ch >= 3) and (ref_db > -30.0)
                expected_bleed = (ref_db + echo_offset_db) if music_playing else -90.0
                # Soft speech gate (3.2 dB above floor) wakes KWS with 500ms preroll; skips silence to save CPU
                kws_thresh = max(-54.0, floor_db + 3.2, expected_bleed + 2.0)
                has_speech = (db >= kws_thresh) and (pk >= 80) and (0.015 <= zcr <= 0.78)
                if has_speech:
                    if not kws_active:
                        kws_active = True
                        wake_active = True
                        wake_buf = bytearray()
                        for ch_bytes in list(preroll)[-10:]:
                            wake_buf.extend(ch_bytes)
                        wake_frames = got
                        wake_voiced = 1
                        wake_voiced_frames = got
                        wake_quiet_frames = 0
                        # Feed recent ~500ms preroll chunks so first syllable "Hey" is never lost
                        for pre_ch in list(preroll)[-11:-1]:
                            kw_pre = kws.feed_pcm_int16(pre_ch, out_channels, hw_rate)
                            if kw_pre:
                                recent_pcm = b"".join(list(preroll)[-10:])
                                ldb, rdb = _stereo_lr_db(recent_pcm, out_channels)
                                wake_cooldown_until = time.monotonic() + 1.80
                                kws_active = False
                                kws_hangover_until = 0.0
                                wake_active = False
                                wake_buf.clear()
                                kws.reset()
                                _emit_json({
                                    "event": "local_wake",
                                    "keyword": kw_pre,
                                    "leftDb": ldb,
                                    "rightDb": rdb,
                                    "device": device,
                                })
                                break
                    else:
                        if wake_active:
                            wake_buf.extend(chunk_out)
                            wake_frames += got
                            wake_voiced += 1
                            wake_voiced_frames += got
                            wake_quiet_frames = 0
                    kws_hangover_until = now + 1.80
                else:
                    if wake_active:
                        wake_buf.extend(chunk_out)
                        wake_frames += got
                        wake_quiet_frames += got
                    if db > -85.0:
                        if db < floor_db:
                            floor_db = max(-62.0, min(-22.0, floor_db * 0.70 + db * 0.30))
                        else:
                            floor_db = max(-62.0, min(-22.0, floor_db * 0.96 + db * 0.04))
                    if music_playing and db > -75.0:
                        echo_offset_db = max(-22.0, min(6.0, echo_offset_db * 0.95 + (db - ref_db) * 0.05))

                if kws_active and now < wake_cooldown_until:
                    continue
                if kws_active:
                    if now <= kws_hangover_until:
                        kw = kws.feed_pcm_int16(chunk_out, out_channels, hw_rate)
                        if kw:
                            recent_pcm = b"".join(list(preroll)[-10:])
                            ldb, rdb = _stereo_lr_db(recent_pcm, out_channels)
                            wake_cooldown_until = time.monotonic() + 1.80
                            kws_active = False
                            kws_hangover_until = 0.0
                            wake_active = False
                            wake_buf.clear()
                            kws.reset()
                            _emit_json({
                                "event": "local_wake",
                                "keyword": kw,
                                "leftDb": ldb,
                                "rightDb": rdb,
                                "device": device,
                            })
                            continue
                    else:
                        kws_active = False
                        kws.reset()

                # Fallback if KWS missed accented "Hey BMW": check short clear utterance once on pause!
                if wake_active:
                    if wake_frames > int(hw_rate * 2.8):
                        wake_active = False
                        wake_buf.clear()
                    elif wake_quiet_frames >= int(hw_rate * 0.42):
                        if int(hw_rate * 0.25) <= wake_voiced_frames <= int(hw_rate * 1.90):
                            boosted, f_ch, f_rate, f_peak, snr_db = _condition_and_boost_pcm(
                                bytes(wake_buf), out_channels, hw_rate
                            )
                            if snr_db >= 2.8 and f_peak >= 320:
                                out_wav = os.path.join(work_dir, "wake_clip.wav")
                                _write_wav_atomic(out_wav, f_ch, f_rate, boosted)
                                dur_ms = int(round((len(boosted) / float(max(1, f_ch * 2 * f_rate))) * 1000))
                                _emit_json({
                                    "event": "wake_clip",
                                    "file": out_wav,
                                    "durationMs": dur_ms,
                                    "peak": f_peak,
                                    "snrDb": snr_db,
                                    "device": device,
                                })
                                wake_cooldown_until = time.monotonic() + 1.20
                        wake_active = False
                        wake_buf.clear()
                continue

            # 3B. Fallback Cloud VAD "Hey BMW" Clipper (used only when offline KWS bundle is absent)
            # Music reference echo check: only engage speaker bleed floor during real audible playback (`ref_db > -30`)
            music_playing = (hw_ch >= 3) and (ref_db > -30.0)
            expected_bleed = (ref_db + echo_offset_db) if music_playing else -90.0
            thresh_db = max(-48.0, floor_db + 4.8, expected_bleed + 3.0)
            is_voiced = (db >= thresh_db) and (pk >= 110) and (0.018 <= zcr <= 0.74)

            if not wake_active:
                if is_voiced:
                    wake_active = True
                    wake_buf = bytearray()
                    for ch_bytes in preroll:
                        wake_buf.extend(ch_bytes)
                    wake_frames = got
                    wake_voiced = 1
                    wake_voiced_frames = got
                    wake_quiet_frames = 0
                    wake_hint_sent = False
                else:
                    if db > -85.0:
                        # Fast downward recovery so transient noise never deafens "Hey BMW"
                        if db < floor_db:
                            floor_db = max(-62.0, min(-22.0, floor_db * 0.70 + db * 0.30))
                        else:
                            floor_db = max(-62.0, min(-22.0, floor_db * 0.96 + db * 0.04))
                    if music_playing and db > -75.0:
                        echo_offset_db = max(-22.0, min(6.0, echo_offset_db * 0.95 + (db - ref_db) * 0.05))
            else:
                wake_buf.extend(chunk_out)
                wake_frames += got
                if is_voiced:
                    wake_voiced += 1
                    wake_voiced_frames += got
                    wake_quiet_frames = 0
                    if not wake_hint_sent and wake_voiced_frames >= int(hw_rate * 0.14) and (now - last_hint_at) > 3.5:
                        wake_hint_sent = True
                        last_hint_at = now
                        _emit_json({"event": "speech_hint"})
                else:
                    wake_quiet_frames += got

                # Continuous talk/noise > 5.2s without pause is radio/passenger conversation -> reset quietly
                if wake_frames > int(hw_rate * 5.2):
                    wake_active = False
                    wake_buf.clear()
                    preroll.clear()
                    wake_cooldown_until = time.monotonic() + 1.2
                    continue

                # Adaptive end-of-speech pause: snappy 0.32s for short "Hey BMW" wake (~0.5-1.1s voiced),
                # 0.50s for longer 1-shot commands ("Hey BMW điều hòa 22 độ").
                quiet_target_frames = int(hw_rate * (0.32 if wake_voiced_frames <= int(hw_rate * 1.15) else 0.50))
                if wake_quiet_frames >= quiet_target_frames:
                    # Brisk "Hey BMW" is >= 220ms voiced. Short clicks & low-SNR road hum drop locally!
                    if wake_voiced_frames >= int(hw_rate * 0.22):
                        boosted, f_ch, f_rate, f_peak, snr_db = _condition_and_boost_pcm(
                            bytes(wake_buf), out_channels, hw_rate
                        )
                        if snr_db >= 2.6 and f_peak >= 320:
                            out_wav = os.path.join(work_dir, "wake_clip.wav")
                            _write_wav_atomic(out_wav, f_ch, f_rate, boosted)
                            dur_ms = int(round((len(boosted) / float(max(1, f_ch * 2 * f_rate))) * 1000))
                            _emit_json({
                                "event": "wake_clip",
                                "file": out_wav,
                                "durationMs": dur_ms,
                                "peak": f_peak,
                                "snrDb": snr_db,
                                "device": device,
                            })
                            wake_cooldown_until = time.monotonic() + 1.2
                    wake_active = False
                    wake_buf.clear()
    finally:
        kws.close()
        asound.snd_pcm_close(pcm)


def main():
    if len(sys.argv) >= 4 and sys.argv[1] == "--stream-daemon":
        dev = sys.argv[2]
        wdir = sys.argv[3]
        rt = int(sys.argv[4]) if len(sys.argv) > 4 else 24000
        ch = int(sys.argv[5]) if len(sys.argv) > 5 else 8
        odir = sys.argv[6] if len(sys.argv) > 6 else ""
        try:
            run_stream_daemon(dev, wdir, rt, ch, odir)
        except Exception as exc:
            _emit_json({"event": "error", "error": str(exc)})
            sys.exit(2)
        return

    if len(sys.argv) < 3:
        sys.stderr.write("Usage: alsa-smartx.py <device> <out.wav> [duration_sec] [rate] [hw_channels]\n")
        sys.exit(2)

    dev = sys.argv[1]
    out = sys.argv[2]
    dur = float(sys.argv[3]) if len(sys.argv) > 3 else 4.2
    rt = int(sys.argv[4]) if len(sys.argv) > 4 else 24000
    ch = int(sys.argv[5]) if len(sys.argv) > 5 else 8

    try:
        res = record_smartx_wav(dev, out, dur, rt, ch)
        sys.stdout.write(json.dumps(res) + "\n")
    except Exception as exc:
        sys.stderr.write(str(exc) + "\n")
        sys.exit(2)


if __name__ == "__main__":
    main()
