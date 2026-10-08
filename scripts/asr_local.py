"""Local Whisper ASR (mlx-whisper, Apple Silicon) — no API key, runs offline.

Drop-in replacement for the OpenAI /v1/audio/transcriptions calls: prints the same
shape as OpenAI's verbose_json with word timestamps, so callers don't care which
provider produced it:

  {"text": "...", "duration": 12.3, "words": [{"word": "...", "start": 0.1, "end": 0.4}, ...]}

Usage: python asr_local.py AUDIO [AUDIO ...] [--lang zh] [--model HF_REPO] [--prompt TEXT]
  One file  -> one JSON object on stdout.
  Many files -> one JSON object per line (model loads once — much faster for batches).

Setup (once):  uv venv --python 3.12 .venv && uv pip install --python .venv/bin/python mlx-whisper pypinyin
The first run downloads the model (~1.6GB for large-v3-turbo) into ~/.cache/huggingface.

--prompt biases the output script. For Traditional Chinese narration the default
nudges Whisper away from Simplified output, which otherwise tanks character-overlap
similarity even when the audio is perfect. Pass --prompt "" to disable.
"""
import argparse, json, re, sys

DEFAULT_MODEL = "mlx-community/whisper-large-v3-turbo"
DEFAULT_ZH_PROMPT = "以下是繁體中文的句子。"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("audio", nargs="+")
    ap.add_argument("--lang", default="zh")
    ap.add_argument("--model", default=DEFAULT_MODEL)
    ap.add_argument("--prompt", default=None)
    a = ap.parse_args()

    try:
        import mlx_whisper
    except ImportError:
        sys.exit("ERROR: mlx-whisper not installed. See setup line at the top of asr_local.py.")

    prompt = a.prompt if a.prompt is not None else (DEFAULT_ZH_PROMPT if a.lang.startswith("zh") else None)

    def run(path, p):
        return mlx_whisper.transcribe(path, path_or_hf_repo=a.model, language=a.lang,
                                      word_timestamps=True, initial_prompt=p or None,
                                      condition_on_previous_text=False, verbose=None)

    core = re.sub(r"[\W_]", "", prompt or "")[-6:]  # e.g. 中文的句子
    for path in a.audio:
        r = run(path, prompt)
        # On short or English-led clips Whisper sometimes "hears" the prompt itself.
        # If the prompt leaks into the transcript, redo this clip without it.
        if core and core in re.sub(r"[\W_]", "", r.get("text", "")):
            r = run(path, None)
        segs = r.get("segments", [])
        words = [{"word": w["word"], "start": round(w["start"], 3), "end": round(w["end"], 3)}
                 for s in segs for w in s.get("words", [])]
        out = {"text": r.get("text", "").strip(),
               "duration": segs[-1]["end"] if segs else 0.0,
               "words": words}
        print(json.dumps(out, ensure_ascii=False), flush=True)


if __name__ == "__main__":
    main()
