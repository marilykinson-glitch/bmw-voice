#!/usr/bin/env python3
"""
alsa-smartx.py - One-shot non-blocking SmartXbar ceiling microphone recorder for `bmw-voice`.

Features:
  - Strictly read-only (`SND_PCM_STREAM_CAPTURE`), zero background loops, zero playback handles.
  - Dynamic End-of-Speech endpointing: stops automatically ~0.50s after the speaker finishes talking
    (instead of waiting out a fixed 4s timer), downsamples 24 kHz -> 16 kHz, and normalizes speech gain.
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


def _extract_pcm_chunk(raw, got, hw_ch, out_channels):
    if hw_ch == out_channels:
        return raw
    bytes_per_frame = hw_ch * 2
    sample_bytes = 4 if out_channels == 2 else 2
    out = bytearray()
    for f in range(got):
        off = f * bytes_per_frame
        out.extend(raw[off : off + sample_bytes])
    return bytes(out)


def _fast_chunk_db_and_peak(pcm_bytes, channels=1):
    samples = array.array("h")
    samples.frombytes(pcm_bytes)
    if sys.byteorder != "little":
        samples.byteswap()
    n = len(samples)
    if n == 0:
        return -90.0, 0
    if channels == 2 and n >= 8:
        sub_l = samples[0::4]
        sub_r = samples[1::4]
        peak_l = max((abs(x) for x in sub_l), default=0)
        peak_r = max((abs(x) for x in sub_r), default=0)
        rms_l = math.sqrt(sum(x * x for x in sub_l) / len(sub_l)) / 32768.0 if sub_l else 0.0
        rms_r = math.sqrt(sum(x * x for x in sub_r) / len(sub_r)) / 32768.0 if sub_r else 0.0
        rms = max(rms_l, rms_r)
        db = 20.0 * math.log10(rms) if rms > 1e-5 else -90.0
        return round(db, 1), int(max(peak_l, peak_r))
    sub = samples[::4] if n >= 32 else samples
    peak = max((abs(x) for x in sub), default=0)
    rms = math.sqrt(sum(x * x for x in sub) / len(sub)) / 32768.0
    db = 20.0 * math.log10(rms) if rms > 1e-5 else -90.0
    return round(db, 1), int(peak)


def _measure_snr_and_floor(samples, out_channels, out_rate):
    if not samples:
        return 0.0, -90.0
    win = max(240, int(out_rate * 0.06)) * max(1, out_channels)
    dbs = []
    step = 4 if win >= 480 else 1
    for i in range(0, len(samples), win):
        seg = samples[i : i + win : step]
        if len(seg) < 16:
            continue
        rms = math.sqrt(sum(x * x for x in seg) / len(seg)) / 32768.0
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
        if out_channels == 1:
            out_len = (len(samples) * 2) // 3
            samples = array.array("h", (samples[(i * 3) // 2] for i in range(out_len)))
            out_rate = 16000
        elif out_channels == 2:
            in_f = len(samples) // 2
            out_f = (in_f * 2) // 3
            rs = array.array("h")
            for i in range(out_f):
                src = ((i * 3) // 2) * 2
                rs.append(samples[src])
                rs.append(samples[src + 1])
            samples = rs
            out_rate = 16000

    snr_db, floor_db = _measure_snr_and_floor(samples, out_channels, out_rate)
    if 55 <= peak < 18000:
        gain = min(16.0, 22000.0 / float(peak))
        if snr_db < 4.2 and floor_db > -80.0:
            max_noise_gain = 10.0 ** ((-32.0 - floor_db) / 20.0)
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
        chunk_frames = max(480, int(hw_rate * 0.05))  # 50ms chunks for crisp 0.50s end-of-speech stop
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
            chunk_out = _extract_pcm_chunk(raw, got, hw_ch, out_channels)
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
                            floor_db = max(-65.0, min(-26.0, floor_db * 0.90 + db * 0.10))
                        if voiced_chunks >= 5:
                            post_quiet_chunks += 1
                            if post_quiet_chunks >= 10 and frames_read >= int(hw_rate * 0.85):
                                break
                        elif frames_read >= int(hw_rate * 2.1) and voiced_chunks < 2:
                            break
    finally:
        asound.snd_pcm_close(pcm)

    out_frames = len(collected) // (out_channels * 2)
    if out_frames < max(800, hw_rate // 5):
        raise RuntimeError(f"insufficient frames ({out_frames}) from {device}")

    final_pcm, final_ch, final_rate, peak, snr_db = _condition_and_boost_pcm(bytes(collected), out_channels, hw_rate)
    if peak == 0:
        raise RuntimeError(f"zero peak on {device}")

    _write_wav_atomic(out_wav, final_ch, final_rate, final_pcm)
    return {
        "ok": True,
        "device": device,
        "frames": len(final_pcm) // (final_ch * 2),
        "rate": final_rate,
        "channels": final_ch,
        "peak": peak,
        "snrDb": snr_db,
        "bytes": len(final_pcm),
    }


if __name__ == "__main__":
    if len(sys.argv) < 3:
        sys.stderr.write("usage: alsa-smartx.py <device> <out.wav> [duration_sec] [rate] [hw_channels]\n")
        sys.exit(2)
    dev = sys.argv[1]
    out_file = sys.argv[2]
    dur = float(sys.argv[3]) if len(sys.argv) > 3 else 4.2
    sr = int(sys.argv[4]) if len(sys.argv) > 4 else 24000
    ch = int(sys.argv[5]) if len(sys.argv) > 5 else 8
    try:
        res = record_smartx_wav(dev, out_file, dur, sr, ch)
        sys.stdout.write(json.dumps(res) + "\n")
    except Exception as exc:
        sys.stderr.write(str(exc) + "\n")
        sys.exit(1)
