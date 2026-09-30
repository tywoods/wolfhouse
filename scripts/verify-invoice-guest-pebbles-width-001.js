'use strict';
// INVOICE-GUEST-PEBBLES-WIDTH-001
// Package / bed / Paid chips grow to their text. A narrow drawer scrolls.
// Chips must not wrap, squeeze, or clip.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
const { readStaffPortalUiSource } = require('./lib/staff-portal-ui-source');

const ROOT = path.resolve(__dirname, '..');
const invoice = fs.readFileSync(path.join(ROOT, 'scripts/browser/booking-invoice.js'), 'utf8');
const api = fs.readFileSync(path.join(ROOT, 'scripts/staff-query-api.js'), 'utf8');

assert(invoice.includes('grid-template-columns:minmax(40px,1fr) max-content max-content max-content'), 'pebble columns size to text');
assert(invoice.includes('overflow-x:auto'), 'narrow guest row can scroll');
assert(invoice.includes('white-space:nowrap'), 'chips do not wrap');
assert(!invoice.includes('minmax(0,.8fr)'), 'fractional squeeze columns are gone');
assert(!invoice.includes('white-space:normal;overflow-wrap:anywhere;text-align:center'), 'chip wrap rule is gone');
assert(api.includes('#bc-drawer-card-booking .bc-guest-pebble-line{display:flex;flex-wrap:nowrap'), 'fallback line does not wrap');
assert(api.includes('#bc-drawer-card-booking .bc-guest-package-pebble{margin:0;max-width:none;white-space:nowrap}'), 'package chip is not capped');
assert(!api.includes('.bc-guest-pebble-line{display:flex;flex-wrap:wrap'), 'phone no longer forces a wrapping pebble line');

async function measure(page, width) {
  await page.setViewportSize({ width: 900, height: 700 });
  await page.locator('#bc-drawer-card-booking').evaluate((el, w) => {
    el.style.width = w + 'px';
    el.style.maxWidth = '100%';
  }, width);
  return page.evaluate(() => {
    function chipBox(node) {
      const range = document.createRange();
      range.selectNodeContents(node);
      const text = range.getBoundingClientRect();
      const box = node.getBoundingClientRect();
      const style = getComputedStyle(node);
      return {
        text: node.textContent,
        whiteSpace: style.whiteSpace,
        overflow: style.overflow,
        textOverflow: style.textOverflow,
        maxWidth: style.maxWidth,
        lines: range.getClientRects().length,
        textW: text.width,
        textH: text.height,
        boxW: box.width,
        boxH: box.height,
        top: box.top,
        left: box.left,
        right: box.right,
      };
    }
    const host = document.getElementById('bc-guest-names');
    const rows = [...host.querySelectorAll('.bc-guest-name-row')].map(row => ({
      name: row.querySelector('.bc-guest-name-line').textContent,
      chips: [...row.querySelectorAll('.bc-guest-package-pebble,.bc-guest-bed,.bc-accom-pay-pebble')].map(chipBox),
    }));
    const style = getComputedStyle(host);
    return {
      overflowX: style.overflowX,
      columns: style.gridTemplateColumns,
      client: host.clientWidth,
      scroll: host.scrollWidth,
      rows,
    };
  });
}

async function main() {
  const html = readStaffPortalUiSource();
  const styles = [...html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map(x => x[0]).join('');
  const body = `<div id="bc-drawer-card-booking" style="position:static;box-sizing:border-box">
    <div id="bc-field-group-guests" class="ctx-field-edit-group">
      <div class="ctx-field-read-row"><div class="kv" id="bc-field-guests-kv-only"><span class="v">
        <div id="bc-guest-names">
          <span class="bc-guest-name-row">
            <span class="bc-guest-name-line">Ada Montenegro</span>
            <span class="bc-guest-pebble-line">
              <span class="pkg-pebble pkg-pebble-rose bc-guest-package-pebble">Sunset Surf Week</span>
              <span class="bc-guest-bed">R12-B8</span>
              <span class="bc-accom-pay-pebble is-deposit">Deposit paid</span>
            </span>
          </span>
          <span class="bc-guest-name-row">
            <span class="bc-guest-name-line">Bo</span>
            <span class="bc-guest-pebble-line">
              <span class="pkg-pebble pkg-pebble-peach bc-guest-package-pebble">Malibu</span>
              <span class="bc-guest-bed">B1</span>
              <span class="bc-accom-pay-pebble is-unpaid">Unpaid</span>
            </span>
          </span>
        </div>
      </span></div></div>
    </div>
  </div>`;
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(styles + body);
    await page.evaluate(code => {
      window.el = id => document.getElementById(id);
      eval(code);
      bcInvoiceStyles();
    }, invoice);
    const narrow = await measure(page, 240);
    const wide = await measure(page, 720);
    console.log('narrow', JSON.stringify(narrow));
    console.log('wide', JSON.stringify(wide));
    assert.equal(narrow.overflowX, 'auto', 'names row scrolls instead of squeezing');
    assert(narrow.scroll > narrow.client + 1, 'narrow drawer actually overflows horizontally');
    for (const shot of [narrow, wide]) {
      assert(shot.columns.split(' ').length >= 4, 'four shared columns remain');
      const starts = { package: [], bed: [], paid: [] };
      for (const row of shot.rows) {
        assert.equal(row.chips.length, 3, 'package, bed, payment');
        let prev = null;
        for (const chip of row.chips) {
          assert.equal(chip.whiteSpace, 'nowrap', chip.text + ' stays one line');
          assert.equal(chip.lines, 1, chip.text + ' does not wrap');
          assert(chip.textW <= chip.boxW + 1, chip.text + ' is not clipped');
          assert(chip.textH <= chip.boxH + 1, chip.text + ' height is inside the chip');
          assert.notEqual(chip.maxWidth, '100%', chip.text + ' is not capped to the column');
          assert.notEqual(chip.textOverflow, 'ellipsis', chip.text + ' is not ellipsized');
          if (prev) assert(prev.right <= chip.left + 1, 'chips do not overlap');
          prev = chip;
        }
        starts.package.push(row.chips[0].left);
        starts.bed.push(row.chips[1].left);
        starts.paid.push(row.chips[2].left);
      }
      for (const [key, xs] of Object.entries(starts)) {
        assert(xs.every(x => Math.abs(x - xs[0]) <= 1), key + ' column stays aligned');
      }
    }
    assert(wide.rows[0].chips[0].boxW >= narrow.rows[0].chips[0].boxW - 1, 'a wider drawer does not shrink the chip');
  } finally {
    await browser.close();
  }
  console.log('verify-invoice-guest-pebbles-width-001: ok');
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
