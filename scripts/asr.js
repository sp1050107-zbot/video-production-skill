/**
 * Shared ASR helper for tts_with_asr.js and gen_subtitles.js.
 *
 *   const { transcribe } = require('./asr');
 *   const { text, words, duration } = await transcribe('audio/slide_01.mp3', config);
 *
 * config.asr.provider:
 *   "local"  (default) — mlx-whisper via scripts/asr_local.py. No API key.
 *   "openai"           — OpenAI whisper-1 API. Needs OPENAI_API_KEY.
 *
 * Local options (all optional):
 *   asr.python      — python with mlx-whisper installed
 *                     (default: <repo>/.venv/bin/python if it exists, else python3)
 *   asr.localModel  — HF repo (default: mlx-community/whisper-large-v3-turbo)
 *   asr.prompt      — initial prompt; "" disables the Traditional-Chinese nudge
 */
const fs = require('fs');
const path = require('path');
const https = require('https');
const { execFile } = require('child_process');

const REPO_DIR = path.resolve(__dirname, '..');

function resolvePython(cfg) {
  if (cfg.asr?.python) return cfg.asr.python;
  if (process.env.VP_PYTHON) return process.env.VP_PYTHON;
  const venv = path.join(REPO_DIR, '.venv', 'bin', 'python');
  return fs.existsSync(venv) ? venv : 'python3';
}

function transcribeLocal(audioPath, cfg) {
  const args = [path.join(__dirname, 'asr_local.py'), audioPath, '--lang', cfg.asr?.language || 'zh'];
  if (cfg.asr?.localModel) args.push('--model', cfg.asr.localModel);
  if (cfg.asr?.prompt !== undefined) args.push('--prompt', cfg.asr.prompt);
  return new Promise((resolve, reject) => {
    execFile(resolvePython(cfg), args, { maxBuffer: 64 * 1024 * 1024, timeout: 600000 }, (err, stdout, stderr) => {
      if (err) return reject(new Error(`local ASR failed: ${(stderr || err.message).trim().split('\n').pop()}`));
      try { resolve(JSON.parse(stdout.trim().split('\n').pop())); } catch (e) { reject(e); }
    });
  });
}

function transcribeOpenAI(audioPath, cfg) {
  const key = process.env.OPENAI_API_KEY;
  if (!key) return Promise.reject(new Error('asr.provider is "openai" but OPENAI_API_KEY is not set'));
  const b = '----b' + Date.now() + Math.random();
  const field = (name, val) => `\r\n--${b}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${val}`;
  const body = Buffer.concat([
    Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="file"; filename="a.mp3"\r\nContent-Type: audio/mpeg\r\n\r\n`),
    fs.readFileSync(audioPath),
    Buffer.from(field('model', cfg.asr?.model || 'whisper-1') + field('language', cfg.asr?.language || 'zh') +
      field('response_format', 'verbose_json') + field('timestamp_granularities[]', 'word') + `\r\n--${b}--\r\n`),
  ]);
  return new Promise((resolve, reject) => {
    const r = https.request({
      hostname: 'api.openai.com', path: '/v1/audio/transcriptions', method: 'POST',
      headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': `multipart/form-data; boundary=${b}`, 'Content-Length': body.length },
    }, rs => {
      let d = '';
      rs.on('data', x => d += x);
      rs.on('end', () => {
        if (rs.statusCode !== 200) return reject(new Error(`ASR HTTP ${rs.statusCode}: ${d.slice(0, 200)}`));
        try { const j = JSON.parse(d); resolve({ text: j.text || '', words: j.words || [], duration: j.duration }); } catch (e) { reject(e); }
      });
    });
    r.setTimeout(90000, () => r.destroy(new Error('whisper timeout')));
    r.on('error', reject);
    r.write(body);
    r.end();
  });
}

function transcribe(audioPath, cfg = {}) {
  const provider = cfg.asr?.provider || 'local';
  if (provider === 'local') return transcribeLocal(audioPath, cfg);
  if (provider === 'openai') return transcribeOpenAI(audioPath, cfg);
  return Promise.reject(new Error(`unknown asr.provider "${provider}" (use "local" or "openai")`));
}

module.exports = { transcribe, resolvePython };
