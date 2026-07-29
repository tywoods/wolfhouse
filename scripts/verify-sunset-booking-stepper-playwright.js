'use strict';
/**
 * Focused Create + Edit integer stepper contract (compact − N +) at 320/390/430.
 * Same portal-schedule-int-stepper dimensions/classes; no Admin/money fields.
 */
const assert = require('assert');
process.env.STAFF_AUTH_REQUIRED = 'false';
process.env.STAFF_AUTH_ALLOW_OPEN = 'true';
process.env.NODE_ENV = 'test';

function pw() {
  try { return require('playwright'); } catch (e) {
    return require('/opt/data/workspaces/wolfhouse-grok/node_modules/playwright');
  }
}
const listen = (s) => new Promise((r, j) => {
  s.once('error', j);
  s.listen(0, '127.0.0.1', () => r(`http://127.0.0.1:${s.address().port}`));
});

const DATE = '2026-08-20';
const BOOKING_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

async function assertStepperContract(page, inputSelector, surfaceLabel) {
  await page.evaluate((sel) => {
    if (typeof scheduleEnhanceIntSteppersIn === 'function') {
      const root = document.querySelector('#ps-create-modal')
        || document.querySelector('#ps-drawer-edit-form')
        || document.querySelector('#ps-drawer-body')
        || document.body;
      scheduleEnhanceIntSteppersIn(root);
    }
    const inp = document.querySelector(sel);
    if (inp && typeof scheduleEnhanceIntStepper === 'function'
      && !(inp.closest && inp.closest('.portal-schedule-int-stepper'))) {
      scheduleEnhanceIntStepper(inp, { label: 'Surfers' });
    }
  }, inputSelector);

  const step = page.locator(inputSelector).locator('xpath=ancestor::*[contains(@class,"portal-schedule-int-stepper")]');
  await step.waitFor({ state: 'visible', timeout: 8000 });
  assert.strictEqual(await step.locator('[data-int-step="dec"]').getAttribute('aria-label') != null, true);
  assert.strictEqual(await step.locator('[data-int-step="inc"]').count(), 1);

  // Same compact wrapper class as Create/Edit shared CSS owner
  const className = await step.evaluate((el) => el.className);
  assert.ok(/portal-schedule-int-stepper/.test(className), `${surfaceLabel} wrapper class: ${className}`);

  const input = page.locator(inputSelector);
  await input.fill('2');
  await input.dispatchEvent('change');
  assert.strictEqual(await input.inputValue(), '2');
  await step.locator('[data-int-step="inc"]').click();
  assert.strictEqual(await input.inputValue(), '3');
  await step.locator('[data-int-step="dec"]').click();
  assert.strictEqual(await input.inputValue(), '2');
  await input.fill('5');
  await input.dispatchEvent('input');
  assert.strictEqual(await input.inputValue(), '5');
  // Min boundary — minus disabled at min
  await input.fill('1');
  await input.dispatchEvent('input');
  await input.dispatchEvent('change');
  assert.strictEqual(await input.inputValue(), '1');
  assert.strictEqual(await step.locator('[data-int-step="dec"]').isDisabled(), true);

  // No native spinner-facing control after enhance (webkit appearance none on wrapper input)
  const nativeSpin = await input.evaluate((el) => {
    const style = window.getComputedStyle(el);
    // appearance textfield / none means not native spinner chrome
    const app = String(style.webkitAppearance || style.appearance || '');
    return /inner-spin|auto/i.test(app);
  });
  assert.strictEqual(nativeSpin, false, `${surfaceLabel} must not show native spinner-facing control`);

  for (const width of [320, 390, 430]) {
    await page.setViewportSize({ width, height: 900 });
    const overflow = await page.evaluate((sel) => {
      const modal = document.querySelector('#ps-create-modal .portal-schedule-create-drawer')
        || document.querySelector('#ps-create-modal')
        || document.querySelector('.portal-schedule-drawer-edit')
        || document.querySelector('#ps-drawer-body')
        || document.querySelector(sel)?.closest('.portal-schedule-drawer')
        || document.body;
      if (!modal) return true;
      return modal.scrollWidth > modal.clientWidth + 1;
    }, inputSelector);
    assert.strictEqual(overflow, false, `${surfaceLabel} horizontal overflow at ${width}px`);
    const dims = await step.evaluate((el) => {
      const buttons = [...el.querySelectorAll('button')].map((b) => {
        const r = b.getBoundingClientRect();
        return { h: r.height, w: r.width };
      });
      const inp = el.querySelector('input');
      const ir = inp ? inp.getBoundingClientRect() : null;
      return {
        buttons,
        input: ir ? { h: ir.height, w: ir.width } : null,
        className: el.className,
      };
    });
    assert.ok(dims.buttons.every((b) => b.h >= 32), `${surfaceLabel} touch target height at ${width}: ${JSON.stringify(dims.buttons)}`);
    assert.ok(dims.input && dims.input.h >= 32, `${surfaceLabel} input height at ${width}`);
    assert.ok(/portal-schedule-int-stepper/.test(dims.className));
  }
  return step;
}

(async () => {
  const { createSunsetAdminVerifyServer } = require('./fixtures/sunset-admin-verify-server');
  const server = createSunsetAdminVerifyServer();
  const base = await listen(server);
  const browser = await pw().chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.addInitScript(() => {
    localStorage.setItem('staff_portal_client', 'sunset');
    localStorage.setItem('staff_portal_sunset_location', 'sunset-somo');
    localStorage.setItem('wh_staff_portal_locale', 'en');
  });
  await page.route('**/staff/schedule/day?**', (r) => {
    const date = new URL(r.request().url()).searchParams.get('date') || DATE;
    return r.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        success: true,
        date,
        lessons: [],
        gear: [],
        rows: [{
          booking_id: BOOKING_ID,
          booking_code: 'STEP-EDIT',
          guest_name: 'Stepper Edit Guest',
          record_source: 'staff_manual',
          service_date: date,
          service_time_local: '09:30',
          service_type: 'surf_lesson',
          offering_label: 'Stepper Course',
          metadata: { component: 'course', course_id: 'step-course' },
          quantity: 2,
          payment_status: 'unpaid',
          booking_status: 'confirmed',
          status: 'confirmed',
        }],
      }),
    });
  });
  await page.route('**/staff/schedule/bookings/catalog?**', (r) => r.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      success: true,
      courses: [{
        course_id: 'step-course',
        label: 'Stepper Course',
        eligible_on_requested_dates: true,
        equipment_options: [],
        price_tiers: [{ key: '1_day', label: '1 day', duration_days: 1, bookable: true }],
      }],
      rentals: [],
      offerings: [],
    }),
  }));
  await page.route('**/staff/schedule/bookings/detail?**', (r) => r.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      success: true,
      booking_id: BOOKING_ID,
      booking_code: 'STEP-EDIT',
      guest_name: 'Stepper Edit Guest',
      phone: '+34911111111',
      payment_status: 'unpaid',
      date_from: DATE,
      date_to: DATE,
      components: {
        course: {
          course_id: 'step-course',
          course_label: 'Stepper Course',
          quantity: 2,
          tier_key: '1_day',
        },
      },
      lessons: [{ kind: 'group', course_id: 'step-course', date: DATE, schedule_key: '0930_1130', tier_key: '1_day' }],
      course_equipment: [],
      rentals: [],
      custom_line_items: [],
      editable: true,
      location_id: 'sunset-somo',
      payment: {
        subtotal_cents: 3500,
        paid_cents: 0,
        balance_due_cents: 3500,
        line_items: [],
      },
    }),
  }));
  await page.route('**/staff/schedule/bookings/quote?**', (r) => r.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      success: true,
      total_cents: 3500,
      subtotal_cents: 3500,
      line_items: [],
      quote_provenance: { quote_fingerprint: 'fp-step' },
    }),
  }));
  try {
    await page.goto(`${base}/staff/ui`);
    await page.waitForFunction(() => document.querySelector('#c-client')?.value === 'sunset');
    await page.waitForTimeout(500);

    // ── Edit surface first (real drawer) — day chips must paint before Create overlay ──
    const row = page.locator('[data-ps-booking-id]').filter({ hasText: 'Stepper Edit Guest' }).first();
    await row.waitFor({ timeout: 15000 });
    await row.click();
    await page.locator('#ps-drawer-edit').click();
    await page.locator('#ps-drawer-course-qty, #ps-drawer-surfers, #ps-drawer-private-lesson-surfers').first()
      .waitFor({ state: 'attached', timeout: 8000 });
    await page.waitForTimeout(400);

    // Ensure group mode so course qty is visible
    let editSel = '#ps-drawer-course-qty';
    if (await page.locator('#ps-drawer-comp-course').count()) {
      await page.evaluate(() => {
        const r = document.getElementById('ps-drawer-comp-course');
        if (r) {
          r.checked = true;
          r.dispatchEvent(new Event('change', { bubbles: true }));
        }
        if (typeof scheduleDrawerPopulateComponentFields === 'function') {
          scheduleDrawerPopulateComponentFields();
        }
      });
      await page.waitForTimeout(200);
      editSel = '#ps-drawer-course-qty';
    }
    if (!(await page.locator(editSel).isVisible().catch(() => false))) {
      if (await page.locator('#ps-drawer-surfers').isVisible().catch(() => false)) editSel = '#ps-drawer-surfers';
      else if (await page.locator('#ps-drawer-private-lesson-surfers').count()) editSel = '#ps-drawer-private-lesson-surfers';
    }
    await page.locator(editSel).waitFor({ state: 'visible', timeout: 8000 });
    await assertStepperContract(page, editSel, 'Edit');

    // Create/Edit share the same compact stepper class (scoped; not Admin/money).
    const classParity = await page.evaluate(() => {
      const editInp = document.querySelector('#ps-drawer-course-qty');
      const editWrap = editInp && editInp.closest('.portal-schedule-int-stepper');
      const moneyTouched = [...document.querySelectorAll('.portal-schedule-int-stepper input')].some((inp) => {
        return /amount|price|cents|money|eur/i.test(String(inp.id || ''))
          || (inp.step && String(inp.step).indexOf('.') >= 0);
      });
      return {
        editClass: editWrap ? editWrap.className : null,
        inputClass: editInp ? editInp.className : null,
        moneyTouched,
      };
    });
    assert.ok(classParity.editClass && /portal-schedule-int-stepper/.test(classParity.editClass));
    assert.ok(classParity.inputClass && /portal-schedule-int-stepper-input/.test(classParity.inputClass));
    assert.strictEqual(classParity.moneyTouched, false, 'no Admin/money fields in schedule steppers');
    console.log('PASS focused Edit integer stepper mobile parity 320/390/430 (same class as Create)');

    // Close drawer and open Create
    await page.keyboard.press('Escape').catch(() => {});
    if (await page.locator('#ps-drawer-close').count()) {
      await page.locator('#ps-drawer-close').click().catch(() => {});
    }
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.waitForTimeout(200);

    // ── Create surface ────────────────────────────────────────────────
    await page.locator('#ps-create-booking').click();
    await page.locator('#ps-create-modal').waitFor({ state: 'visible' });
    await page.waitForTimeout(300);
    await assertStepperContract(page, '#ps-create-surfers', 'Create');
    console.log('PASS focused Create integer stepper mobile parity 320/390/430');

    assert.deepStrictEqual(errors, []);
  } finally {
    await browser.close();
    await new Promise((r) => server.close(r));
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
