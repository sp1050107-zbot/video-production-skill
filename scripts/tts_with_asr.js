/**
 * TTS + ASR Verification Script
 *
 * Reads narration.json from the project directory, synthesizes each entry
 * via ElevenLabs TTS, and verifies with Whisper ASR (local mlx-whisper by default,
 * or the OpenAI API with asr.provider = "openai" — see asr.js).
 *
 * Usage: node tts_with_asr.js [project_dir] [--only 3,7]
 *   - project_dir: directory containing narration.json (default: CWD)
 *   - --only: re-synthesize just these slide numbers (1-based); other audio is left alone
 *
 * Environment variables (or a .env file in the project directory):
 *   ELEVENLABS_API_KEY — ElevenLabs API key
 *   OPENAI_API_KEY     — only if asr.provider is "openai"
 *
 * config.json in project_dir (required for voiceId):
 *   { "tts": { "voiceId": "...", "model": "...", "maxRetries": 5,
 *              "stripPunctuation": true },
 *     "asr": { "provider": "local", "passThreshold": 0.85, "language": "zh" } }
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const asr = require('./asr');

// --- Resolve project directory ---
const ARGS = process.argv.slice(2);
const onlyIdx = ARGS.indexOf('--only');
const ONLY = onlyIdx >= 0 ? new Set(ARGS[onlyIdx + 1].split(',').map(Number)) : null;
const PROJECT_DIR = path.resolve(ARGS.find((a, i) => !a.startsWith('--') && (onlyIdx < 0 || i !== onlyIdx + 1)) || process.cwd());

// --- Load .env fallback (project dir) ---
try {
  const envPath = path.join(PROJECT_DIR, '.env');
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^([A-Z_]+)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
  }
} catch (e) { /* no .env — fine, env vars may already be set */ }

// --- Load config ---
const CONFIG_PATH = path.join(PROJECT_DIR, 'config.json');
const config = fs.existsSync(CONFIG_PATH) ? JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')) : {};

const VOICE_ID = config.tts?.voiceId || process.env.TTS_VOICE_ID;
const MODEL_ID = config.tts?.model || 'eleven_multilingual_v2';
const PASS_THRESHOLD = config.asr?.passThreshold || 0.85;
const MAX_RETRIES = config.tts?.maxRetries || 5;
const STRIP_PUNCT = config.tts?.stripPunctuation !== false; // default true

if (!VOICE_ID || VOICE_ID.startsWith('YOUR_')) {
  console.error('ERROR: set tts.voiceId in config.json (or TTS_VOICE_ID env var).');
  console.error('Any voice from your ElevenLabs voice library works — premade or cloned.');
  process.exit(1);
}
const ELEVENLABS_KEY = process.env.ELEVENLABS_API_KEY;
if (!ELEVENLABS_KEY) { console.error('ERROR: ELEVENLABS_API_KEY env var not set'); process.exit(1); }
if ((config.asr?.provider || 'local') === 'openai' && !process.env.OPENAI_API_KEY) {
  console.error('ERROR: asr.provider is "openai" but OPENAI_API_KEY env var not set'); process.exit(1);
}

// --- Load narration ---
const narrationPath = path.join(PROJECT_DIR, 'narration.json');
if (!fs.existsSync(narrationPath)) {
  console.error(`ERROR: narration.json not found in ${PROJECT_DIR}`);
  process.exit(1);
}
const narration = JSON.parse(fs.readFileSync(narrationPath, 'utf8'));

const audioDir = path.join(PROJECT_DIR, 'audio');
if (!fs.existsSync(audioDir)) fs.mkdirSync(audioDir, { recursive: true });

console.log(`Project: ${PROJECT_DIR}`);
console.log(`Slides: ${narration.length} | Voice: ${VOICE_ID} | Threshold: ${PASS_THRESHOLD}`);
console.log('---');

// --- Similarity: character overlap ratio ---
function similarity(a, b) {
  if (!a || !b) return 0;
  const sa = a.replace(/[\s\p{P}]/gu, '');
  const sb = b.replace(/[\s\p{P}]/gu, '');
  if (!sa || !sb) return 0;
  let matches = 0;
  const bChars = sb.split('');
  for (const c of sa) {
    const idx = bChars.indexOf(c);
    if (idx >= 0) { matches++; bChars.splice(idx, 1); }
  }
  return matches / Math.max(sa.length, sb.length);
}

// --- ElevenLabs TTS ---
function synthesize(text, outputPath) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify({
      text,
      model_id: MODEL_ID,
      voice_settings: { stability: 0.5, similarity_boost: 0.75 }
    });
    const req = https.request({
      hostname: 'api.elevenlabs.io',
      path: `/v1/text-to-speech/${VOICE_ID}`,
      method: 'POST',
      headers: { 'Accept': 'audio/mpeg', 'Content-Type': 'application/json', 'xi-api-key': ELEVENLABS_KEY }
    }, res => {
      if (res.statusCode !== 200) {
        let body = '';
        res.on('data', d => body += d);
        res.on('end', () => reject(new Error(`TTS HTTP ${res.statusCode}: ${body}`)));
        return;
      }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => { fs.writeFileSync(outputPath, Buffer.concat(chunks)); resolve(); });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

// --- Whisper ASR (provider chosen by config.asr.provider, see asr.js) ---
async function transcribe(audioPath) {
  return (await asr.transcribe(audioPath, config)).text || '';
}

// --- Strip ALL punctuation (CJK + Latin) before sending to TTS ---
// Every punctuation mark becomes a pause in Chinese TTS output. Dense commas produce
// machine-gun narration; stripping them lets the voice flow in natural breath groups.
// Subtitles still come from the original punctuated narration.json.
// Disable with config.tts.stripPunctuation = false if your voice behaves differently.
function stripPunctForTTS(text) {
  return text
    .replace(/[。！？，；、：「」『』（）「」《》〈〉【】〔〕｛｝…—–‐~～]/g, ' ')
    .replace(/[.,!?;:"'(){}\[\]‐-―‘-‟…]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// --- Process one slide ---
async function processSlide(idx) {
  const num = String(idx + 1).padStart(2, '0');
  const text = narration[idx];
  const ttsText = STRIP_PUNCT ? stripPunctForTTS(text) : text;
  const outPath = path.join(audioDir, `slide_${num}.mp3`);
  // Each attempt goes to its own file so a later, worse attempt can't overwrite a better one.
  let best = { sim: -1, file: null };

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    console.log(`[${num}/${String(narration.length).padStart(2, '0')}] Attempt ${attempt}/${MAX_RETRIES}...`);
    const attemptPath = path.join(audioDir, `.attempt_${num}_${attempt}.mp3`);

    try {
      await synthesize(ttsText, attemptPath);
      const size = fs.statSync(attemptPath).size;
      console.log(`  TTS OK: ${Math.round(size / 1024)} KB`);

      console.log(`  ASR verifying...`);
      const transcript = await transcribe(attemptPath);
      const sim = similarity(text, transcript);
      console.log(`  Similarity: ${(sim * 100).toFixed(1)}%`);

      if (sim > best.sim) {
        if (best.file) fs.unlinkSync(best.file);
        best = { sim, file: attemptPath };
      } else {
        fs.unlinkSync(attemptPath);
      }

      if (sim >= PASS_THRESHOLD) {
        fs.renameSync(best.file, outPath);
        console.log(`  ✅ PASS`);
        return true;
      } else {
        console.log(`  ❌ FAIL (need ≥${(PASS_THRESHOLD * 100).toFixed(0)}%)`);
        console.log(`  Original: ${text.substring(0, 60)}...`);
        console.log(`  ASR got:  ${transcript.substring(0, 60)}...`);
      }
    } catch (err) {
      console.log(`  ERROR: ${err.message}`);
      if (best.file !== attemptPath && fs.existsSync(attemptPath)) fs.unlinkSync(attemptPath);
    }
  }

  if (best.file) {
    fs.renameSync(best.file, outPath);
    console.log(`  ⚠️ Keeping best attempt (${(best.sim * 100).toFixed(1)}%) after ${MAX_RETRIES} tries`);
  } else {
    console.log(`  ⚠️ No successful attempt after ${MAX_RETRIES} tries`);
  }
  return false;
}

// --- Main ---
(async () => {
  const todo = narration.map((_, i) => i).filter(i => !ONLY || ONLY.has(i + 1));
  console.log(`\nStarting TTS+ASR for ${todo.length} of ${narration.length} slides\n`);
  let passed = 0, failed = 0;

  for (const i of todo) {
    const ok = await processSlide(i);
    if (ok) passed++; else failed++;
  }

  console.log(`\n${'='.repeat(40)}`);
  console.log(`Done! Passed: ${passed}, Failed: ${failed}, Total: ${narration.length}`);
  if (failed > 0) console.log(`⚠️ ${failed} slide(s) did not meet ASR threshold — see SKILL.md "verify the words, ship on redundancy" before re-rolling forever.`);
})();
