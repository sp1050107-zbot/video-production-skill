/**
 * HTML Cover Screenshot (Playwright) — the no-image-API alternative to cover_gen.py.
 *
 * Renders cover.html in the project directory at 1280×720 and saves thumbnail.jpg.
 * Start from references/cover-template.html. Nothing is cropped: the page IS 16:9.
 *
 * Usage: node cover_html.js [project_dir]
 */

const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

const PROJECT_DIR = path.resolve(process.argv[2] || process.cwd());
const HTML = path.join(PROJECT_DIR, 'cover.html');
const OUT = path.join(PROJECT_DIR, 'thumbnail.jpg');
const MAX_BYTES = 2 * 1024 * 1024; // YouTube thumbnail limit

if (!fs.existsSync(HTML)) {
  console.error(`ERROR: cover.html not found in ${PROJECT_DIR} (copy references/cover-template.html)`);
  process.exit(1);
}

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  await page.goto('file://' + HTML);
  await page.waitForTimeout(500);
  for (const quality of [92, 85, 75, 65]) {
    await page.screenshot({ path: OUT, type: 'jpeg', quality });
    if (fs.statSync(OUT).size <= MAX_BYTES) break;
  }
  await browser.close();
  const kb = Math.round(fs.statSync(OUT).size / 1024);
  console.log(`✅ thumbnail.jpg 1280×720, ${kb} KB${kb * 1024 > MAX_BYTES ? ' ⚠️ over 2MB — simplify the cover' : ''}`);
  console.log('Now open thumbnail.jpg and check it visually (title readable at small size?).');
})();
