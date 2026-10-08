"""Measure audio/visual sync drift in an assembled slide video — no ears needed.

For every slide k:
  V_k = when the picture actually changes to slide k (frame-difference on the video)
  A_k = where slide k's narration actually sits in the video's audio track
        (cross-correlation of audio/slide_NN.mp3 against the muxed audio)
  drift_k = A_k - V_k   (positive = narration starts AFTER its slide appears)

Usage: python check_sync.py [project_dir] [video.mp4]      (needs numpy; the repo .venv has it)
Exit code 1 if any |drift| > 20 ms.
"""
import json, pathlib, subprocess, sys

import numpy as np

PROJ = pathlib.Path(sys.argv[1] if len(sys.argv) > 1 else ".").resolve()
VIDEO = PROJ / (sys.argv[2] if len(sys.argv) > 2 else "video.mp4")
CFG_P = PROJ / "config.json"
CFG = json.loads(CFG_P.read_text(encoding="utf-8")) if CFG_P.exists() else {}
FFMPEG = CFG.get("ffmpeg", "ffmpeg")
SR = 44100
W, H = 64, 36          # tiny grayscale frames are plenty to see a slide change
LIMIT_MS = 20.0


def decode_audio(src, extra=()):
    raw = subprocess.run([FFMPEG, "-v", "error", "-i", str(src), *extra, "-vn", "-ac", "1", "-ar", str(SR),
                          "-f", "f32le", "-"], capture_output=True, check=True).stdout
    return np.frombuffer(raw, dtype=np.float32)


def slide_change_times(n_slides):
    probe = subprocess.run([FFMPEG, "-v", "error", "-i", str(VIDEO), "-map", "0:v:0", "-vf",
                            f"scale={W}:{H},format=gray", "-f", "rawvideo", "-fps_mode", "passthrough",
                            "-"], capture_output=True, check=True).stdout
    frames = np.frombuffer(probe, dtype=np.uint8).reshape(-1, H, W).astype(np.int16)
    pts = subprocess.run(["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries",
                          "frame=pts_time", "-of", "csv=p=0", str(VIDEO)],
                         capture_output=True, text=True, check=True).stdout.split()
    pts = [float(x.split(",")[0]) for x in pts if x.split(",")[0]][: len(frames)]
    diffs = np.abs(np.diff(frames, axis=0)).mean(axis=(1, 2))
    # the n-1 largest jumps are the slide boundaries (encoder noise on a still slide is tiny)
    cuts = sorted(np.argsort(diffs)[::-1][: n_slides - 1] + 1)
    return [pts[0]] + [pts[i] for i in cuts]


def locate(ref, mix, center, before=1.0, after=3.0, ref_len=2.5):
    """Return the time (s) in `mix` where `ref` best matches, searching around `center`."""
    r = ref[: int(ref_len * SR)]
    lo = max(0, int((center - before) * SR))
    seg = mix[lo: int((center + after) * SR) + len(r)]
    n = 1 << int(np.ceil(np.log2(len(seg) + len(r))))
    corr = np.fft.irfft(np.fft.rfft(seg, n) * np.conj(np.fft.rfft(r, n)), n)[: len(seg) - len(r) + 1]
    energy = np.sqrt(np.convolve(seg ** 2, np.ones(len(r)), "valid")) + 1e-9
    k = int(np.argmax(corr / energy))
    return (lo + k) / SR


def main():
    mp3s = sorted((PROJ / "audio").glob("slide_[0-9][0-9].mp3"))
    if not mp3s:
        sys.exit(f"no audio/slide_NN.mp3 in {PROJ}")
    mix = decode_audio(VIDEO)
    starts = slide_change_times(len(mp3s))
    worst = 0.0
    print(f"{VIDEO.name}: {len(mp3s)} slides")
    for k, mp3 in enumerate(mp3s):
        a = locate(decode_audio(mp3), mix, starts[k])
        drift = (a - starts[k]) * 1000
        worst = max(worst, abs(drift))
        print(f"  slide {k + 1:02d}: picture {starts[k]:8.3f}s  narration {a:8.3f}s  drift {drift:+7.1f} ms")
    ok = worst <= LIMIT_MS
    print(f"max |drift| = {worst:.1f} ms -> {'OK' if ok else 'OUT OF SYNC'} (limit {LIMIT_MS:.0f} ms)")
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()
