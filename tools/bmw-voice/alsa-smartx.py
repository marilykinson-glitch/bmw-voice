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
    # Never amplify low-SNR background hiss/hum (`snr_db < 4.8`), which causes LLM speech hallucinations
    if 90 <= peak < 18000 and snr_db >= 4.8:
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


def run_stream_daemon(device, work_dir, rate=24000, hw_channels=8):
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

        # Mode: "wake" | "ptt"
        mode = "wake"
        ptt_buf = bytearray()
        ptt_frames = 0
        ptt_max_frames = int(hw_rate * 4.2)
        ptt_voiced = 0
        ptt_quiet = 0
        ptt_req_id = 0
        last_level_emit = 0.0

        wake_active = False
        wake_buf = bytearray()
        wake_frames = 0
        wake_voiced = 0
        wake_quiet = 0
        wake_hint_sent = False
        last_hint_at = 0.0
        wake_cooldown_until = 0.0

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
                    ptt_buf = bytearray()
                    if not c.get("noPreroll"):
                        recent = list(preroll)[-4:]  # 200ms pre-roll so 1st syllable is crisp
                        for ch_bytes in recent:
                            ptt_buf.extend(ch_bytes)
                    ptt_frames = 0
                    max_sec = max(1.8, min(6.5, float(c.get("maxSec", 4.2))))
                    ptt_max_frames = int(hw_rate * max_sec)
                    ptt_voiced = 0
                    ptt_quiet = 0
                    ptt_req_id = int(c.get("reqId", 0))
                    _emit_json({"event": "ptt_started", "reqId": ptt_req_id})
                elif cname == "ptt_stop" and mode == "ptt":
                    ptt_max_frames = ptt_frames  # finish immediately on next chunk
                elif cname == "cooldown":
                    ms = float(c.get("ms", 800))
                    wake_cooldown_until = time.monotonic() + (ms / 1000.0)
                    wake_active = False
                    wake_buf.clear()

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
                _emit_json({"event": "ready", "device": device})

            db, pk = _fast_chunk_db_and_peak(chunk_out, out_channels)

            # 2. Active PTT / 2-step follow-up recording
            if mode == "ptt":
                ptt_buf.extend(chunk_out)
                ptt_frames += got
                if (now - last_level_emit) >= 0.14:
                    last_level_emit = now
                    _emit_json({"event": "mic_level", "db": db})

                is_voiced = (db >= max(-47.0, floor_db + 5.8)) and (pk >= 115)
                if is_voiced:
                    ptt_voiced += 1
                    ptt_quiet = 0
                elif ptt_voiced >= 5:
                    ptt_quiet += 1

                done_early = ptt_voiced >= 5 and ptt_quiet >= 10 and ptt_frames >= int(hw_rate * 0.75)
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
                    mode = "wake"
                    wake_cooldown_until = time.monotonic() + 0.40
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

            # Music reference echo check: only engage speaker bleed floor during real audible playback (`ref_db > -30`)
            music_playing = (hw_ch >= 3) and (ref_db > -30.0)
            expected_bleed = (ref_db + echo_offset_db) if music_playing else -90.0
            thresh_db = max(-47.5, floor_db + 5.0, expected_bleed + 4.5)
            is_voiced = (db >= thresh_db) and (pk >= 100)

            if not wake_active:
                if is_voiced:
                    wake_active = True
                    wake_buf = bytearray()
                    for ch_bytes in preroll:
                        wake_buf.extend(ch_bytes)
                    wake_frames = got
                    wake_voiced = 1
                    wake_quiet = 0
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
                    wake_quiet = 0
                    if not wake_hint_sent and wake_voiced >= 3 and (now - last_hint_at) > 3.0:
                        wake_hint_sent = True
                        last_hint_at = now
                        _emit_json({"event": "speech_hint"})
                else:
                    wake_quiet += 1

                # Continuous talk > 6.5s without pause is radio/passenger conversation -> reset quietly
                if wake_frames > int(hw_rate * 6.5):
                    wake_active = False
                    wake_buf.clear()
                    preroll.clear()
                    continue

                if wake_quiet >= 8:  # 0.40s end-of-speech pause
                    # Brisk "Hey BMW" is >= 250ms voiced (5 chunks). Short clicks (<5 chunks) drop locally!
                    if wake_voiced >= 5:
                        boosted, f_ch, f_rate, f_peak, snr_db = _condition_and_boost_pcm(
                            bytes(wake_buf), out_channels, hw_rate
                        )
                        if snr_db >= 3.5 and f_peak >= 500:
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
                    wake_active = False
                    wake_buf.clear()
    finally:
        asound.snd_pcm_close(pcm)


def main():
    if len(sys.argv) >= 4 and sys.argv[1] == "--stream-daemon":
        dev = sys.argv[2]
        wdir = sys.argv[3]
        rt = int(sys.argv[4]) if len(sys.argv) > 4 else 24000
        ch = int(sys.argv[5]) if len(sys.argv) > 5 else 8
        try:
            run_stream_daemon(dev, wdir, rt, ch)
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
