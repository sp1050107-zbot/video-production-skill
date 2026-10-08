/**
 * FFmpeg Video Assembly Script — frame-aligned, single audio encode
 *
 * Combines slide PNGs + audio MP3s into a single video.
 * Automatically detects slide count from the slides/ directory.
 *
 * Usage: node assemble.js [project_dir]
 *   - project_dir: directory containing slides/ and audio/ (default: CWD)
 *
 * Optional config.json in project_dir:
 *   { "video": { "width": 1920, "height": 1080, "fps": 25, "audioBitrate": "192k", "slidePadding": 1.0 },
 *     "ffmpeg": "ffmpeg", "ffprobe": "ffprobe" }
 *
 * Why not "one clip per slide, then concat -c copy" (the old way)?
 * Every separately encoded AAC clip carries its own encoder priming, and the clip's
 * audio and video lengths never match exactly. Stream-copy concatenation keeps all of
 * that, so the narration slid ~30 ms later at EVERY seam (13 slides: +412 ms at the end).
 * Now:
 *   1. each slide lasts a whole number of frames: ceil((narration + slidePadding) * fps)
 *   2. all narration is decoded to PCM, each slide's audio is zero-padded to exactly its
 *      frame boundary, and the whole track is AAC-encoded ONCE
 *   3. video and audio are produced in one ffmpeg pass
 * Slide k therefore starts at an exact frame AND its narration starts at that same sample.
 * Segment start times are written to temp/segments.json (used by gen_subtitles.js).
 * Verify with: python scripts/check_sync.py [project_dir]
 */

const { execSync, execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

// --- Resolve project directory ---
const PROJECT_DIR = path.resolve(process.argv[2] || process.cwd());

// --- Load config ---
const CONFIG_PATH = path.join(PROJECT_DIR, 'config.json');
const config = fs.existsSync(CONFIG_PATH) ? JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')) : {};

const FFMPEG = config.ffmpeg || process.env.FFMPEG_PATH || 'ffmpeg';
const FFPROBE = config.ffprobe || process.env.FFPROBE_PATH || 'ffprobe';
const AUDIO_BITRATE = config.video?.audioBitrate || '192k';
const SLIDE_PADDING = config.video?.slidePadding ?? 1.0;
const FPS = config.video?.fps || 25;
const WIDTH = config.video?.width || 1920;
const HEIGHT = config.video?.height || 1080;
const SR = 44100;

const SLIDES_DIR = path.join(PROJECT_DIR, 'slides');
const AUDIO_DIR = path.join(PROJECT_DIR, 'audio');
const TEMP_DIR = path.join(PROJECT_DIR, 'temp');

// --- Validate directories ---
if (!fs.existsSync(SLIDES_DIR)) { console.error(`ERROR: slides/ not found in ${PROJECT_DIR}`); process.exit(1); }
if (!fs.existsSync(AUDIO_DIR)) { console.error(`ERROR: audio/ not found in ${PROJECT_DIR}`); process.exit(1); }
if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR, { recursive: true });

// --- Auto-detect slide count ---
const slideFiles = fs.readdirSync(SLIDES_DIR)
  .filter(f => /^slide_\d+\.png$/i.test(f))
  .sort();
const slideCount = slideFiles.length;

if (slideCount === 0) { console.error('ERROR: No slide_XX.png files found in slides/'); process.exit(1); }

console.log(`Project: ${PROJECT_DIR}`);
console.log(`Slides: ${slideCount} | ${WIDTH}×${HEIGHT} @ ${FPS}fps | Padding: ${SLIDE_PADDING}s | Audio bitrate: ${AUDIO_BITRATE}`);
console.log('---');

// --- Decode an mp3 to mono 16-bit PCM at SR (sample-exact length) ---
function decodePCM(audioPath) {
  return execFileSync(FFMPEG, ['-v', 'error', '-i', audioPath, '-vn', '-ac', '1', '-ar', String(SR), '-f', 's16le', '-'],
    { maxBuffer: 1024 * 1024 * 1024 });
}

function getDuration(p) {
  const out = execSync(`"${FFPROBE}" -v error -show_entries format=duration -of csv=p=0 "${p}"`, { encoding: 'utf8' });
  return parseFloat(out.trim());
}

// --- Step 1: frame-aligned segments + one continuous narration track ---
const pcmParts = [];
const segments = [];
let frameCursor = 0;
for (let i = 1; i <= slideCount; i++) {
  const num = String(i).padStart(2, '0');
  const imgPath = path.join(SLIDES_DIR, `slide_${num}.png`);
  const audioPath = path.join(AUDIO_DIR, `slide_${num}.mp3`);

  if (!fs.existsSync(imgPath)) { console.error(`Missing: ${imgPath}`); process.exit(1); }
  if (!fs.existsSync(audioPath)) { console.error(`Missing: ${audioPath}`); process.exit(1); }

  const pcm = decodePCM(audioPath);
  const audioSamples = pcm.length / 2;
  const frames = Math.ceil((audioSamples / SR + SLIDE_PADDING) * FPS - 1e-9);
  // sample boundaries derived from cumulative frames, so any fps (even 24 or 29.97-ish) never drifts
  const startSample = Math.round(frameCursor * SR / FPS);
  const endSample = Math.round((frameCursor + frames) * SR / FPS);
  const padded = Buffer.alloc((endSample - startSample) * 2); // zero = silence
  pcm.copy(padded, 0, 0, Math.min(pcm.length, padded.length));
  pcmParts.push(padded);

  segments.push({ slide: i, image: imgPath, frames, startFrame: frameCursor,
                  start: frameCursor / FPS, duration: frames / FPS, audioDuration: audioSamples / SR });
  console.log(`Slide ${num}: ${(audioSamples / SR).toFixed(2)}s audio → ${frames} frames (${(frames / FPS).toFixed(2)}s), starts ${(frameCursor / FPS).toFixed(2)}s`);
  frameCursor += frames;
}

// WAV header + the concatenated PCM
const pcmAll = Buffer.concat(pcmParts);
const header = Buffer.alloc(44);
header.write('RIFF', 0); header.writeUInt32LE(36 + pcmAll.length, 4); header.write('WAVE', 8);
header.write('fmt ', 12); header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22);
header.writeUInt32LE(SR, 24); header.writeUInt32LE(SR * 2, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34);
header.write('data', 36); header.writeUInt32LE(pcmAll.length, 40);
const wavPath = path.join(TEMP_DIR, 'narration.wav');
fs.writeFileSync(wavPath, Buffer.concat([header, pcmAll]));
fs.writeFileSync(path.join(TEMP_DIR, 'segments.json'),
  JSON.stringify({ fps: FPS, sampleRate: SR, slidePadding: SLIDE_PADDING, segments }, null, 2));

// --- Step 2: one ffmpeg pass — exact-frame slide loops concatenated + the single narration track ---
const outputPath = path.join(PROJECT_DIR, 'video.mp4');
const args = ['-y', '-v', 'error'];
for (const s of segments) args.push('-loop', '1', '-framerate', String(FPS), '-i', s.image);
args.push('-i', wavPath);
const chains = segments.map((s, k) =>
  `[${k}:v]trim=end_frame=${s.frames},setpts=PTS-STARTPTS,scale=${WIDTH}:${HEIGHT},setsar=1,format=yuv420p[v${k}]`);
const filter = chains.join(';') + ';' + segments.map((_, k) => `[v${k}]`).join('') + `concat=n=${segments.length}:v=1:a=0[v]`;
// +faststart: move moov atom to the front so the mp4 plays inline / streams (web players & chat
// attachments otherwise show "link won't open" until the whole file downloads). 2026-06-29 lesson.
args.push('-filter_complex', filter, '-map', '[v]', '-map', `${segments.length}:a`,
  '-c:v', 'libx264', '-tune', 'stillimage', '-pix_fmt', 'yuv420p', '-r', String(FPS),
  '-c:a', 'aac', '-b:a', AUDIO_BITRATE, '-movflags', '+faststart', outputPath);
execFileSync(FFMPEG, args, { stdio: 'pipe', maxBuffer: 64 * 1024 * 1024 });

// --- Report ---
const finalDur = getDuration(outputPath);
const finalSize = fs.statSync(outputPath).size;
console.log(`\n${'='.repeat(40)}`);
console.log(`🎬 Done!`);
console.log(`📁 Output: ${outputPath}`);
console.log(`⏱️  Duration: ${Math.floor(finalDur / 60)}:${String(Math.floor(finalDur % 60)).padStart(2, '0')} (planned ${(frameCursor / FPS).toFixed(2)}s)`);
console.log(`💾 Size: ${(finalSize / 1024 / 1024).toFixed(1)} MB`);

// --- Quick audio check ---
try {
  const probeOut = execSync(`"${FFPROBE}" -v error -select_streams a:0 -show_entries stream=bit_rate -of csv=p=0 "${outputPath}"`, { encoding: 'utf8' });
  const audioBps = parseInt(probeOut.trim());
  if (audioBps && audioBps < 50000) {
    console.log(`\n⚠️ WARNING: Audio bitrate is only ${Math.round(audioBps / 1000)}kbps — may be silent!`);
  } else {
    console.log(`🔊 Audio: ${Math.round(audioBps / 1000)}kbps ✅`);
  }
} catch (e) {
  console.log(`⚠️ Could not check audio bitrate: ${e.message}`);
}
console.log('Sync check: .venv/bin/python scripts/check_sync.py <project_dir>');
