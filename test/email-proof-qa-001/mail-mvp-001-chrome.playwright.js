#!/usr/bin/env node
'use strict';

/**
 * MAIL-MVP-001-QA-001 — offline Playwright chrome proof.
 *
 * This test never opens staging and installs no live request path. It evaluates
 * the shipped Inbox renderer/action source in Chromium with a fake fetch only.
 * It does not click or invoke Approve & send.
 *
 * Run: node test/email-proof-qa-001/mail-mvp-001-chrome.playwright.js
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');

const ROOT = path.join(__dirname, '..', '..');
const THREAD = path.join(ROOT, 'scripts/browser/inbox-thread.js');
const source = fs.readFileSync(THREAD, 'utf8');
const createStart = source.indexOf('function performEmailCreateDraft(');
const createEnd = source.indexOf('function performEmailLunaDraftGenerate(', createStart);
assert.ok(createStart >= 0 && createEnd > createStart, 'Create Draft action function is present');
const createDraftAction = source.slice(createStart, createEnd);

async function main() {
  const browser = await chromium.launch({ headless: true });
  let passed = 0;
  try {
    const page = await browser.newPage();
    await page.setContent('<main id="qa-root"></main>');

    const chrome = await page.evaluate((threadSource) => {
      const contextAt = threadSource.indexOf('id=\"inbox-email-create-draft-context\"');
      const createAt = threadSource.indexOf('id=\"btn-email-create-draft\"');
      const approveAt = threadSource.indexOf('id=\"btn-email-approve-send\"');
      const contextBlock = threadSource.slice(
        threadSource.lastIndexOf("html += '<div class=\"inbox-email-create-draft-context-area\"", contextAt),
        contextAt + 300,
      );
      const actionBlock = threadSource.slice(createAt, approveAt + 300);
      return {
        contextBeforeCreate: contextAt >= 0 && contextAt < createAt,
        twoRows: contextBlock.replaceAll('\\', '').includes('rows="2"'),
        contextIsSiblingOfActions: threadSource.slice(contextAt - 350, createAt).replaceAll('\\', '').includes('inbox-email-create-draft-context-area')
          && threadSource.slice(contextAt, createAt).replaceAll('\\', '').includes('<div class="draft-actions">'),
        createBeforeApprove: createAt >= 0 && createAt < approveAt,
        actionBlockHasBoth: /Create Draft/.test(actionBlock) && /Approve &amp; send/.test(actionBlock),
        noAutoSendControl: !/\/staff\/inbox\/luna-mode/.test(threadSource)
          && !/email['\"]\s*,\s*['\"]auto/.test(threadSource),
      };
    }, source);

    assert.equal(chrome.contextBeforeCreate, true, 'two-row Context field must be left of Create Draft');
    passed += 1;
    assert.equal(chrome.twoRows, true, 'Context field must be exactly two rows');
    passed += 1;
    assert.equal(chrome.contextIsSiblingOfActions, true, 'Context field and action row must share the Create Draft bar');
    passed += 1;
    assert.equal(chrome.createBeforeApprove, true, 'Create Draft must precede Approve & send');
    passed += 1;
    assert.equal(chrome.actionBlockHasBoth, true, 'Create Draft and Approve & send must remain separate adjacent controls');
    passed += 1;
    assert.equal(chrome.noAutoSendControl, true, 'email auto-send control must remain absent');
    passed += 1;

    const emptyContextRequest = await page.evaluate(async (actionSource) => {
      window.__mailMvpQaCalls = [];
      const textarea = { value: 'existing draft text' };
      const context = { value: '' };
      const target = {
        querySelector(selector) {
          return ({
            '#draft-textarea': textarea,
            '#draft-send-status': {},
            '#inbox-email-create-draft-context': context,
          })[selector] || null;
        },
      };
      const create = new Function(`
        let selectedConvId = 'sunset-existing-thread';
        function emailReplyState() { return { locked: false, inFlight: false, generationUncertain: false, seq: 0 }; }
        function setEmailReplyControlsDisabled() {}
        function showDraftSendStatus() {}
        function emailParseFetchJson() { return Promise.resolve({ parseOk: true, status: 500, data: {} }); }
        function emailUiFailureCopy() { return 'offline fake response'; }
        function acceptEmailCreateDraftSuccess() { return null; }
        function updateEmailDraftByteCount() {}
        function fetch(url, init) { window.__mailMvpQaCalls.push({ url, init }); return Promise.resolve({}); }
        ${actionSource}
        return performEmailCreateDraft;
      `)();
      create('sunset-existing-thread', target);
      await new Promise((resolve) => setTimeout(resolve, 0));
      return window.__mailMvpQaCalls;
    }, createDraftAction);

    assert.equal(emptyContextRequest.length, 1, 'empty Context must make one Create Draft request');
    passed += 1;
    assert.equal(emptyContextRequest[0].url, '/staff/inbox/email/create-draft', 'Create Draft must use only its draft endpoint');
    passed += 1;
    assert.equal(emptyContextRequest[0].init.method, 'POST', 'Create Draft request is the draft action');
    passed += 1;
    assert.deepEqual(JSON.parse(emptyContextRequest[0].init.body), {
      conversation_id: 'sunset-existing-thread', context: '',
    }, 'empty Context must still create a thread-only draft request');
    passed += 1;
    assert.equal(createDraftAction.includes('/staff/inbox/email/approve-send'), false,
      'Create Draft implementation must not invoke Approve & send');
    passed += 1;

    console.log(`PASS MAIL-MVP-001-QA-001: ${passed} Playwright assertions passed, 0 failed`);
  } finally {
    await browser.close();
  }
}

main().catch((error) => {
  console.error(`FAIL MAIL-MVP-001-QA-001: ${error.stack || error.message}`);
  process.exitCode = 1;
});
