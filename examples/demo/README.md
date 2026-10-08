# Minimal demo project

A 3-slide "什麼是語音辨識" micro-video, showing the file formats the pipeline expects.

```
demo/
├── narration.json        ← 3 narration entries (one per slide)
├── slides_prompts.json   ← 3 gpt-image-2 prompts + shared style block (Path A only)
└── (config.json)         ← copy from ../../references/config-example.json and fill in
```

To actually produce it (from this directory, `ELEVENLABS_API_KEY` set). Default route —
HTML slides + local Whisper, no OpenAI key:

```bash
cp ../../references/config-example.json config.json   # then set tts.voiceId
mkdir -p slides  # write slides/slide_01..03.html from ../../references/slide-template.html
node ../../scripts/screenshot.js                      # → slides/slide_01..03.png
# eyeball every PNG
node ../../scripts/tts_with_asr.js                    # → audio/slide_01..03.mp3 (ASR-gated, local Whisper)
node ../../scripts/assemble.js                        # → video.mp4
node ../../scripts/gen_subtitles.js                   # → subtitles_aligned.srt
cp ../../references/cover-template.html cover.html    # fill in title/hook
node ../../scripts/cover_html.js                      # → thumbnail.jpg
```

Path A (gpt-image-2, needs `OPENAI_API_KEY`) uses `slides_prompts.json` instead:
`python ../../scripts/slides_gen.py` → eyeball → `node ../../scripts/pad_and_burn.js pad`.

Remember the alignment law: narration entries == slide count (here: 3 == 3).
