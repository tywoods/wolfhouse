'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(ROOT, 'scripts', 'staff-query-api.js'), 'utf8');
const requiredRules = [
  '#bc-side-drawer .bc-drawer-footer{flex-direction:row;align-items:flex-start;flex-wrap:nowrap}',
  '#bc-side-drawer .bc-drawer-footer-left{flex:1 1 auto}',
  '#bc-side-drawer .bc-drawer-footer-right{align-items:flex-end;margin-left:auto;flex:0 0 auto}',
  '#bc-side-drawer #bc-cancel-reservation-btn{width:auto;align-self:flex-end;white-space:nowrap}',
];

for (const rule of requiredRules) {
  assert.ok(source.includes(rule), `missing drawer action layout rule: ${rule}`);
}
assert.ok(!source.includes('#bc-side-drawer .bc-drawer-footer{flex-direction:column;align-items:stretch}'), 'legacy stacked drawer footer rule must be removed');

async function main() {
  const { chromium } = require('playwright');
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 480, height: 800 } });
    await page.setContent(`<!doctype html><style>
      .bc-drawer-footer{display:flex;justify-content:space-between;align-items:flex-start;gap:16px;flex-wrap:wrap}
      .bc-drawer-footer-left{display:flex;flex-direction:column;align-items:flex-start;gap:6px;flex:1;min-width:0}
      .bc-drawer-footer-right{display:flex;flex-direction:column;align-items:flex-end;gap:6px;margin-left:auto;flex-shrink:0}
      .btn{padding:8px 14px}
      ${requiredRules.join('\n')}
    </style>
    <div id="bc-side-drawer" style="width:420px">
      <div class="bc-drawer-footer">
        <div class="bc-drawer-footer-left"><button class="btn" id="bc-open-conv-btn">Open Conversation</button></div>
        <div class="bc-drawer-footer-right"><button class="btn" id="bc-cancel-reservation-btn">Cancel Booking</button></div>
      </div>
    </div>`);
    const layout = await page.evaluate(() => {
      const open = document.getElementById('bc-open-conv-btn').getBoundingClientRect();
      const cancel = document.getElementById('bc-cancel-reservation-btn').getBoundingClientRect();
      const right = document.querySelector('.bc-drawer-footer-right').getBoundingClientRect();
      return {
        sameRow: Math.abs(open.top - cancel.top) < 2,
        cancelWidth: cancel.width,
        rightWidth: right.width,
        drawerWidth: document.getElementById('bc-side-drawer').getBoundingClientRect().width,
        whiteSpace: getComputedStyle(document.getElementById('bc-cancel-reservation-btn')).whiteSpace,
      };
    });
    assert.strictEqual(layout.sameRow, true, 'Open Conversation and Cancel Booking must share one row');
    assert.ok(layout.cancelWidth < layout.drawerWidth / 2, `Cancel Booking must stay content-width (${layout.cancelWidth}px vs drawer ${layout.drawerWidth}px)`);
    assert.ok(Math.abs(layout.cancelWidth - layout.rightWidth) < 2, 'cancel action wrapper must not stretch wider than its button');
    assert.strictEqual(layout.whiteSpace, 'nowrap', 'Cancel Booking label must remain on one line');
    console.log('DRAWER_OPEN_CANCEL_SAME_ROW_001=PASS');
    console.log(JSON.stringify(layout));
  } finally {
    await browser.close();
  }
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
