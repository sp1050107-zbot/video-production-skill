# 影片製作 SOP(video-production skill · 本機版)

> 本機客製版的操作手冊,完整規則以 [`SKILL.md`](SKILL.md) 為準;踩雷紀錄見 [`references/lessons-learned.md`](references/lessons-learned.md)。
> 本版**不需要 OpenAI**:語音辨識改用本機 Whisper(mlx-whisper),投影片和封面改用 HTML + Playwright 截圖,由 Claude Code 撰寫內容。唯一需要的 key 是 `ELEVENLABS_API_KEY`。

## 0. 環境(已安裝完成)

| 項目 | 狀態 / 位置 |
|---|---|
| Repo | `~/video-production-skill`,branch `claude-local-asr` |
| Codex 讀取 skill | `~/.agents/skills/video-production` → symlink 到 repo |
| Claude Code 讀取 skill | `~/.claude/skills/video-production` → symlink 到 `~/.agents/skills/` |
| 本機語音辨識 | `.venv/`(Python 3.12 + mlx-whisper + pypinyin),模型在 `~/.cache/huggingface`(約 1.6GB) |
| 截圖 | `node_modules/playwright` + Chromium |
| ffmpeg / ffprobe | Homebrew |

腳本會自動使用 repo 裡的 `.venv/bin/python`,不需要先 activate。

### 一次性設定

1. **ElevenLabs key** — 加在 `~/.zshrc`(已完成):
   ```
   export ELEVENLABS_API_KEY=你的key
   ```
   加完後要**重開終端機或 Claude Code / Codex session** 才讀得到。檢查方式(不會顯示內容):
   ```bash
   echo ${ELEVENLABS_API_KEY:+已設定}
   ```
2. **Voice ID** — 在 elevenlabs.io → Voices 複製一個,每個影片專案填進 `config.json` 的 `tts.voiceId`。
3. **重建環境**(換電腦或刪掉 `.venv`、`node_modules` 時):
   ```bash
   cd ~/video-production-skill
   uv venv --python 3.12 .venv && uv pip install --python .venv/bin/python mlx-whisper pypinyin
   npm install && npx playwright install chromium
   ```

> 🔴 key 只放環境變數或專案 `.env`,不要寫進腳本、不要貼進對話、不要 commit。

## 1. 每支影片的流程

```
建專案 → 寫旁白 → HTML 投影片 → 截圖+目視 → TTS+本機ASR → 組裝 → 品質檢查 → 字幕 → 封面 → 上傳 → 驗證縮圖
```

最快的做法是在 Claude Code 或 Codex 說:
> 先完整讀 video-production skill 的 SKILL.md,照 checklist 一步不跳地做一支影片,題目是 ___,專案放在 ~/videos/<主題>。

以下是每一步實際在做什麼,方便你檢查 agent 有沒有跳步。`$VP` 代表 `~/video-production-skill`。

### Step 1 建專案
```bash
mkdir -p ~/videos/<主題> && cd ~/videos/<主題>
cp $VP/references/config-example.json config.json   # 填 tts.voiceId、branding
```
專案目錄放在 repo 外面,mp3/mp4 不會混進 repo。

### Step 2 寫旁白 `narration.json`
- JSON 陣列,**一張投影片一個字串**,每則 80–150 字,一頁一個概念。
- 先讀 `references/teaching-style.md`、`references/narration-style.md`。
- 寫成 TTS 好唸的樣子:數字寫中文、縮寫拆開、單句 ≤50 字、用 `references/heteronyms.json` 掃破音字。
- ⭐ **對齊檢查**:旁白筆數必須等於投影片張數,不相等的話,錯開的那一頁之後全部音畫不同步。

### Step 3 HTML 投影片 → PNG
```bash
mkdir slides   # 依 references/slide-template.html 寫 slides/slide_01.html、slide_02.html…
node $VP/scripts/screenshot.js
```
字級下限:標題 ≥72px、正文 ≥32px、重點數字 ≥48px;內容填滿畫面 80% 以上;畫面上的每個元素旁白都要講到。

### Step 4 ⭐ 目視檢查每張 PNG
看有沒有錯字、被裁切、手機上看不清楚。

### Step 5 ⭐ TTS + 本機 ASR 驗證
```bash
node $VP/scripts/tts_with_asr.js
```
- ElevenLabs 配音,接著用本機 Whisper 轉回文字做比對,相似度 ≥0.85 才算通過;沒過會自動重試(上限 `maxRetries`)。
- 第一次執行會下載模型,之後離線也能用。每段轉錄約 5–10 秒。
- 不要為了 0.85 一直重試:差異只是同音字或數字寫法時,保留最好的那一版。數字很多的旁白可以再跑:
  ```bash
  $VP/.venv/bin/python $VP/scripts/rescore.py   # 拼音比對,≥0.90 過關
  ```
- 同一個詞**每次**都被辨識成同一個錯字,代表是 TTS 真的唸錯了,要改寫那個詞。

### Step 6 組裝
```bash
node $VP/scripts/assemble.js      # → video.mp4
```

### Step 7 ⭐ 品質檢查(三項都要做)
```bash
ffprobe -v error -show_entries stream=codec_type,codec_name,bit_rate -of default video.mp4   # 音訊約 130–192kbps;≈2kbps 代表沒聲音
ffmpeg -ss 3 -i video.mp4 -frames:v 1 -update 1 verify.png                                    # 對照 slides/slide_01.png
```
確認畫面一致、字在手機上看得清楚。

### Step 8 字幕
```bash
node $VP/scripts/gen_subtitles.js        # → subtitles_aligned.srt(本機 Whisper 抓時間,顯示原稿文字)
ffmpeg -i video.mp4 -i subtitles_aligned.srt -map 0 -map 1 -c copy -c:s mov_text \
  -metadata:s:s:0 language=chi -movflags +faststart video_softsub.mp4   # 內嵌可開關的字幕軌
```
建議優先用外掛 SRT 字幕軌或內嵌軟字幕。⚠️ Homebrew 的 ffmpeg 沒有 libass,**無法燒錄字幕**(`pad_and_burn.js burn` 會直接提示);若改用有 libass 的 ffmpeg,深色投影片要加 `SUB_STYLE=dark`。

### Step 9 ⭐ 封面(沒有封面 = 沒做完)
```bash
cp $VP/references/cover-template.html cover.html   # 填小標、主標題(≤12 字)、一句鉤子
node $VP/scripts/cover_html.js                     # → thumbnail.jpg 1280×720,自動壓在 2MB 以下
```
打開 `thumbnail.jpg` 確認縮小後標題仍然清楚。

### Step 10 上傳與驗收
1. 先以 unlisted/private 上傳,實際播放審片。
2. ⭐ 上傳後確認縮圖是自己的封面,不是系統自動截的畫面。
3. 對話框重新開啟後,再檢查一次標題、描述、語言(上傳精靈有時會悄悄重置選項)。
4. 外掛字幕:上傳字幕軌、發布,再到觀看頁確認字幕有出現。
5. 描述中註明是 AI 製作。
6. 都確認後才改成公開。

## 2. 出貨檢查表

```
□ narration 筆數 == 投影片張數
□ 每張投影片已目視檢查
□ 每段音訊 ASR 通過(或已判定為誤報)
□ ffprobe 音訊位元率正常
□ 抽出的畫面與投影片一致
□ 字幕已對齊、已檢視
□ thumbnail.jpg 1280×720、≤2MB、已目視
□ 上傳後縮圖 / 字幕 / 可見度已驗證
□ 描述含 AI 揭露
□ 沒有任何 key 被寫進檔案或 commit
```

## 3. 派 sub-agent / Codex 時

task prompt **一定要**寫:「先完整讀 `~/.agents/skills/video-production/SKILL.md`,照 checklist 一步不跳地做」。沒寫的話,agent 常會略過這套流程,自己發明一套比較差的。

Codex 如果沒有自動觸發 skill,在 `~/.codex/AGENTS.md` 加一行:
```
Before any video production task, read ~/.agents/skills/video-production/SKILL.md and follow it exactly, including the mandatory checklist.
```

## 4. 設定參考(`config.json` 的 `asr` 區塊)

| 欄位 | 預設 | 說明 |
|---|---|---|
| `provider` | `"local"` | `"local"` = mlx-whisper(免 key);`"openai"` = 原版 whisper-1 API(需 `OPENAI_API_KEY`) |
| `localModel` | `mlx-community/whisper-large-v3-turbo` | 想更準可換 `mlx-community/whisper-large-v3-mlx`(較大較慢) |
| `prompt` | 「以下是繁體中文的句子。」 | 讓 Whisper 輸出繁體;設成 `""` 可關閉 |
| `python` | repo 的 `.venv/bin/python` | 使用其他 Python 時才需要指定 |
| `passThreshold` | `0.85` | ASR 通過門檻 |

## 5. 疑難排解

| 症狀 | 處理 |
|---|---|
| `ELEVENLABS_API_KEY env var not set` | 重開終端機或 session;用 `echo ${ELEVENLABS_API_KEY:+已設定}` 檢查 |
| `local ASR failed: …mlx-whisper not installed` | 照第 0 節「重建環境」重裝 `.venv` |
| `Cannot find module 'playwright'` | 在 repo 執行 `npm install && npx playwright install chromium` |
| ASR 結果是簡體、相似度偏低 | 確認 `asr.prompt` 沒有被設成 `""` |
| 影片有畫面沒聲音 / 位元率約 2kbps | TTS 失敗(key 失效或額度用完)→ 重跑 Step 5 |
| 字幕越到後面越晚 | 不要自己用「音訊長度+padding」累加時間,改用 `gen_subtitles.js`;換了 ASR 設定後要刪掉 `temp/words_*.json` 快取再跑 |
| 某些播放器打不開 | concat copy 或取樣率混用的問題 → 見 lessons-learned |
| 其他狀況 | `grep -i <關鍵字> $VP/references/lessons-learned.md` |

## 6. 維護

- 本機客製版合併在你自己 fork 的 `main`(`sp1050107-zbot/video-production-skill`),不影響原作者的 repo。
- Remote 設定:`origin` = 你的 fork;`upstream` = 原作者 `speechlab0210/video-production-skill`,**只能拉、不能推**(push 網址已設為 `DISABLED`)。
- 跟進原作者更新(注意是從 `upstream` 拉,`git pull` 只會拉到你自己的 fork):
  ```bash
  cd ~/video-production-skill && git checkout main && git fetch upstream && git merge upstream/main && git push origin main
  ```
  原作者若也改了同一個檔案(例如 `tts_with_asr.js`、`gen_subtitles.js`),合併時可能出現衝突,解完再 push。
- 想把改動回饋給原作者:到 GitHub 開 PR 到 `speechlab0210/video-production-skill`,需要原作者同意才會合併。
- `.venv/`、`node_modules/`、`.env`、`.serena/`、影音產物都已列在 `.gitignore`;commit 前仍建議掃一次有沒有 `sk_` / `sk-` 開頭的 key。
