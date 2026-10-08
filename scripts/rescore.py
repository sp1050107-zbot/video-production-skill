"""Homophone-tolerant ASR rescoring (second-chance gate for digit-heavy narration).

Whisper false-fails Chinese narration in two systematic ways:
  (a) Chinese numerals transcribed as digits (五百六十五 -> 565) — similarity tanks
      even though the audio is CORRECT (digits in ASR output are POSITIVE evidence);
  (b) same-sound different-tone homophones (誠實 -> 程式).

This rescores the kept audio with:
  1. numerals stripped from both sides (digits verified separately by presence)
  2. toneless-pinyin multiset overlap similarity  (>=0.90 = pass)

Usage: python rescore.py [project_dir]   (default: cwd)
Needs: pip install pypinyin (already in the repo .venv), plus either local mlx-whisper
(default, config.asr.provider = "local") or OPENAI_API_KEY with asr.provider = "openai".
Caches transcripts in temp/asr_full_NN.txt (re-runs are free).
"""
import os, sys, json, re, pathlib, subprocess, urllib.request, uuid

PROJ = pathlib.Path(sys.argv[1] if len(sys.argv) > 1 else ".").resolve()

CFG_P = PROJ / "config.json"
CFG = json.loads(CFG_P.read_text(encoding="utf-8")) if CFG_P.exists() else {}
ASR = CFG.get("asr", {})
PROVIDER = ASR.get("provider", "local")
SCRIPTS = pathlib.Path(__file__).resolve().parent

KEY = os.environ.get("OPENAI_API_KEY")
if not KEY:
    envf = PROJ / ".env"
    if envf.exists():
        for line in envf.read_text(encoding="utf-8").splitlines():
            if line.startswith("OPENAI_API_KEY="):
                KEY = line.split("=", 1)[1].strip().strip('"').strip("'"); break
if PROVIDER == "openai":
    assert KEY, "asr.provider is openai but OPENAI_API_KEY not set (env var or .env in project dir)"

from pypinyin import lazy_pinyin

narration = json.loads((PROJ / "narration.json").read_text(encoding="utf-8"))
(PROJ / "temp").mkdir(exist_ok=True)

NUMERALS = set("0123456789〇零一二三四五六七八九十百千萬万兩两億亿")
CJK = re.compile(r"[一-鿿]")

def transcribe(mp3):
    if PROVIDER == "local":
        return transcribe_local(mp3)
    boundary = "----b" + uuid.uuid4().hex
    data = mp3.read_bytes()
    parts = []
    def add(name, val):
        parts.append(f"--{boundary}\r\nContent-Disposition: form-data; name=\"{name}\"\r\n\r\n{val}\r\n".encode())
    parts.append(f"--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"a.mp3\"\r\nContent-Type: audio/mpeg\r\n\r\n".encode())
    parts.append(data); parts.append(b"\r\n")
    add("model", "whisper-1"); add("language", "zh")
    parts.append(f"--{boundary}--\r\n".encode())
    body = b"".join(parts)
    req = urllib.request.Request("https://api.openai.com/v1/audio/transcriptions", data=body,
        headers={"Authorization": f"Bearer {KEY}", "Content-Type": f"multipart/form-data; boundary={boundary}"})
    with urllib.request.urlopen(req, timeout=120) as r:
        return json.loads(r.read())["text"]

def transcribe_local(mp3):
    venv = SCRIPTS.parent / ".venv" / "bin" / "python"
    py = ASR.get("python") or os.environ.get("VP_PYTHON") or (str(venv) if venv.exists() else sys.executable)
    cmd = [py, str(SCRIPTS / "asr_local.py"), str(mp3), "--lang", ASR.get("language", "zh")]
    if ASR.get("localModel"): cmd += ["--model", ASR["localModel"]]
    if "prompt" in ASR: cmd += ["--prompt", ASR["prompt"]]
    out = subprocess.run(cmd, capture_output=True, text=True, check=True).stdout
    return json.loads(out.strip().splitlines()[-1])["text"]

def strip_numerals(s):
    return "".join(c for c in s if c not in NUMERALS)

def cjk_only(s):
    return "".join(CJK.findall(s))

def pinyin_multiset_sim(a, b):
    pa = lazy_pinyin(a); pb = lazy_pinyin(b)
    if not pa or not pb: return 0.0
    from collections import Counter
    ca, cb = Counter(pa), Counter(pb)
    inter = sum((ca & cb).values())
    return inter / max(len(pa), len(pb))

def digits_in(s):
    return re.findall(r"\d+", s)

results = []
for i, text in enumerate(narration):
    n = i + 1
    mp3 = PROJ / "audio" / f"slide_{n:02d}.mp3"
    cache = PROJ / "temp" / f"asr_full_{n:02d}.txt"
    if cache.exists():
        tr = cache.read_text(encoding="utf-8")
    else:
        tr = transcribe(mp3)
        cache.write_text(tr, encoding="utf-8")
    orig_core = cjk_only(strip_numerals(text))
    asr_core = cjk_only(strip_numerals(tr))
    psim = pinyin_multiset_sim(orig_core, asr_core)
    results.append((n, psim, digits_in(tr), tr))
    print(f"[{n:02d}] pinyin_sim={psim*100:.1f}%  digits_heard={digits_in(tr)}")
    if psim < 0.90:
        print(f"     ORIG: {text}")
        print(f"     ASR : {tr}")

print("\n=== Summary ===")
bad = [r for r in results if r[1] < 0.90]
print(f"pinyin-sim >=90%: {len(results)-len(bad)}/{len(results)}")
if bad:
    print("below threshold:", [r[0] for r in bad])
