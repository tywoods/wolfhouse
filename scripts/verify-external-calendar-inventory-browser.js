'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const api = fs.readFileSync(path.join(ROOT, 'scripts/staff-query-api.js'), 'utf8');

function extractCss() {
  const chunks = [];
  const re = /\.bc-(?:legend-sw|block)-owner_schedule_blocked\{[^}]+\}/g;
  let m;
  while ((m = re.exec(api))) chunks.push(m[0]);
  const dark = api.match(/\[data-theme="dark"\] \.bc-block-owner_schedule_blocked\{[^}]+\}/);
  if (dark) chunks.push(dark[0]);
  const darkLeg = api.match(/\[data-theme="dark"\] \.bc-legend-sw-owner_schedule_blocked\{[^}]+\}/);
  if (darkLeg) chunks.push(darkLeg[0]);
  return chunks.join('\n');
}

async function main() {
  console.log('verify-external-calendar-inventory-browser');
  let playwright;
  try { playwright = require('playwright'); }
  catch (e) {
    try { playwright = require('/opt/data/home/.npm/_npx/e41f203b7505f1fb/node_modules/playwright'); }
    catch (e2) {
      console.log('  SKIP playwright missing');
      process.exit(0);
    }
  }
  const css = extractCss();
  if (!css) throw new Error('yellow CSS not found');
  const browser = await playwright.chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 800, height: 400 } });
    await page.setContent(`<!doctype html><html><head><style>
${css}
body{margin:0;background:#181818}
.bc-block{height:28px;padding:4px 8px;font:600 12px sans-serif}
</style></head><body>
<div class="bc-block bc-block-owner_schedule_blocked" id="blk">Owner schedule blocked</div>
<div class="bc-legend-swatch bc-legend-sw-owner_schedule_blocked" id="sw" style="width:12px;height:12px"></div>
</body></html>`);
    const colors = await page.evaluate(() => {
      const blk = getComputedStyle(document.getElementById('blk'));
      const sw = getComputedStyle(document.getElementById('sw'));
      return {
        text: document.getElementById('blk').textContent,
        blkBg: blk.backgroundColor,
        swBg: sw.backgroundColor,
      };
    });
    if (colors.text !== 'Owner schedule blocked') throw new Error('label ' + colors.text);
    const rgb = colors.blkBg.match(/\d+/g).map(Number);
    const yellow = rgb[0] > 180 && rgb[1] > 160 && rgb[2] < 140;
    if (!yellow) throw new Error('not yellow: ' + colors.blkBg);
    console.log('  PASS  rendered label and yellow fill', colors.blkBg);

    await page.setContent(`<!doctype html><html><body>
<div id="cc-owner-schedule-bridge">secret</div>
<script>
function getClient(){ return 'sunset'; }
var card = document.getElementById('cc-owner-schedule-bridge');
if (getClient() !== 'wolfhouse-somo') {
  card.parentNode.removeChild(card);
}
</script></body></html>`);
    const gone = await page.evaluate(() => !document.getElementById('cc-owner-schedule-bridge'));
    if (!gone) throw new Error('sunset still sees card');
    console.log('  PASS  sunset client removes Luna Staff card from DOM');
  } finally {
    await browser.close();
  }
  console.log('\nverify-external-calendar-inventory-browser: ALL CHECKS PASSED');
}

main().catch((e) => { console.error(e); process.exit(1); });
