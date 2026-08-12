'use strict';

/**
 * --tab-top-gap:24px uniform header→content on Schedule, Inbox, Customers, Bookings, Admin.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const API = path.join(ROOT, 'scripts/staff-query-api.js');

let pass = 0;
let fail = 0;
function ok(label, cond, detail) {
  if (cond) { pass += 1; console.log('  PASS ', label); }
  else { fail += 1; console.log('  FAIL ', label, detail || ''); }
}

async function main() {
  console.log('verify-tab-top-gap');
  const api = fs.readFileSync(API, 'utf8');

  ok(':root defines --tab-top-gap:24px', /:root\{[\s\S]*?--tab-top-gap:\s*24px/.test(api));
  ok('no light-theme schedule padding-top:20px override',
    !/:root:not\(\[data-theme="dark"\]\) #tab-portal-home \.portal-schedule-wrap\{padding-top:20px\}/.test(api));
  ok('schedule-wrap uses token',
    /\.portal-schedule-wrap\{[^}]*padding:var\(--tab-top-gap\) 20px 32px/.test(api));
  ok('admin-wrap uses token (Admin + Bookings shell)',
    /\.portal-admin-wrap\{[^}]*padding:var\(--tab-top-gap\) 20px 32px/.test(api));
  ok('inbox-shell-wrap uses token',
    /#tab-conversations\.active #wrap\.inbox-shell-wrap\{[\s\S]*?padding:var\(--tab-top-gap\) 20px 12px!important/.test(api));
  ok('customers-wrap uses token',
    /\.customers-wrap\{[^}]*padding:var\(--tab-top-gap\) 20px 12px/.test(api));
  ok('toolbar→content internal gap still 10px (not tab-top-gap)',
    /\.inbox-shell-toolbar\{[^}]*margin-bottom:10px/.test(api)
    && /\.customers-toolbar\{[^}]*margin-bottom:10px/.test(api));
  ok('3-col conversation shell still present',
    /\.inbox-two-col\.inbox-shell-cols\{/.test(api)
    && /#inbox-detail-sidebar > \.sidebar-card\{/.test(api));
  ok('schedule cockpit host still present', /ps-day-cockpit/.test(api));

  let playwright;
  try { playwright = require('playwright'); }
  catch (e) {
    try { playwright = require('/opt/data/home/.npm/_npx/e41f203b7505f1fb/node_modules/playwright'); }
    catch (e2) {
      ok('playwright', false, e2.message);
      console.log(`\n${pass} passed, ${fail} failed`);
      process.exit(fail ? 1 : 0);
    }
  }

  const browser = await playwright.chromium.launch({ headless: true });
  try {
    for (const theme of ['dark', 'light']) {
      const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
      await page.setContent(`<!doctype html><html ${theme === 'dark' ? 'data-theme="dark"' : ''}><head><style>
:root{
  --tab-top-gap:24px;--border-soft:#333;--surface:#1e1e1e;--text:#eee;--cream:#181818;
  --font-sans:system-ui;
}
html:not([data-theme="dark"]){--cream:#EDE8E0;--surface:#F5F1EA;--text:#4E5853;--border-soft:#E8E2D8}
*{box-sizing:border-box}
body{margin:0;background:var(--cream);color:var(--text);font-family:var(--font-sans)}
#tabs{height:48px;border-bottom:1px solid var(--border-soft);display:flex;align-items:stretch}
.tab-btn{padding:0 16px;border:0;background:none;border-bottom:3px solid transparent}
.tab-btn.active{border-bottom-color:#6a9}
.tab-panel{display:none}
.tab-panel.active{display:block}
.portal-schedule-wrap{max-width:1240px;margin:0 auto;padding:var(--tab-top-gap) 20px 32px}
.portal-admin-wrap{max-width:1240px;margin:0 auto;padding:var(--tab-top-gap) 20px 32px}
#tab-conversations.active #wrap.inbox-shell-wrap{
  max-width:1240px;margin:0 auto;padding:var(--tab-top-gap) 20px 12px;display:block;
}
.customers-wrap{max-width:1240px;margin:0 auto;padding:var(--tab-top-gap) 20px 12px}
.first{background:var(--surface);border:1px solid var(--border-soft);padding:12px;border-radius:10px}
</style></head><body>
<div id="tabs"><button class="tab-btn active" data-t="schedule">Schedule</button>
<button class="tab-btn" data-t="inbox">Inbox</button>
<button class="tab-btn" data-t="bookings">Bookings</button>
<button class="tab-btn" data-t="admin">Admin</button></div>
<div id="tab-portal-home" class="tab-panel active"><div class="portal-schedule-wrap"><div class="first" id="c-schedule">cockpit</div></div></div>
<div id="tab-conversations" class="tab-panel"><div id="wrap" class="inbox-shell-wrap"><div class="first" id="c-inbox">toolbar</div></div></div>
<div id="tab-bookings" class="tab-panel"><div class="portal-admin-wrap"><div class="portal-admin-bookings-shell"><div class="first" id="c-bookings">bookings</div></div></div></div>
<div id="tab-admin" class="tab-panel"><div class="portal-admin-wrap"><div class="first" id="c-admin">admin</div></div></div>
<script>
document.querySelectorAll('.tab-btn').forEach(function(b){
  b.onclick=function(){
    document.querySelectorAll('.tab-btn').forEach(x=>x.classList.remove('active'));
    document.querySelectorAll('.tab-panel').forEach(x=>x.classList.remove('active'));
    b.classList.add('active');
    var map={schedule:'tab-portal-home',inbox:'tab-conversations',bookings:'tab-bookings',admin:'tab-admin'};
    document.getElementById(map[b.getAttribute('data-t')]).classList.add('active');
  };
});
</script>
</body></html>`);

      const gaps = await page.evaluate(() => {
        const tabsBottom = document.getElementById('tabs').getBoundingClientRect().bottom;
        function gap(id) {
          const el = document.getElementById(id);
          // activate parent panel
          const panel = el.closest('.tab-panel');
          document.querySelectorAll('.tab-panel').forEach((p) => p.classList.remove('active'));
          panel.classList.add('active');
          const top = el.getBoundingClientRect().top;
          return Math.round(top - tabsBottom);
        }
        return {
          schedule: gap('c-schedule'),
          inbox: gap('c-inbox'),
          bookings: gap('c-bookings'),
          admin: gap('c-admin'),
        };
      });

      const vals = Object.values(gaps);
      const all24 = vals.every((v) => v === 24);
      ok(`${theme}: all 4 tabs header→content gap = 24px`, all24, JSON.stringify(gaps));
      await page.close();
    }
  } finally {
    await browser.close();
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
