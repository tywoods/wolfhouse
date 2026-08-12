'use strict';

/**
 * verify:portal-template-escapes
 *
 * buildUiHtml() in scripts/staff-query-api.js writes the whole staff portal, browser
 * code included, inside one JavaScript template literal. A template literal eats a
 * backslash it does not recognise, so a regex typed as /\d/ reaches the browser as
 * /d/ — a valid regex that matches the wrong thing, with no error anywhere. Commit
 * 1ca1d4ca fixed seven of these in the Inbox; sixteen more had accumulated behind them.
 *
 * This gate renders the portal through the same seam the parity harness uses
 * (buildUiHtmlForOfflineTest, one child process per tenant because module-level config
 * is read at require time), pulls every regex literal out of the emitted browser code,
 * and fails on the fingerprints an eaten backslash leaves behind:
 *
 *   - a bare d/D/s/S/w/W carrying a quantifier      /^d{4}-d{2}-d{2}$/   was /^\d{4}-...
 *   - a character class of nothing but those letters /[^d]/g             was /[^\d]/g
 *   - a control character produced by \b, \v or \f   /<BS>word/          was /\bword/
 *
 * Write the backslash twice in the template (\\d) so the browser receives \d. If a
 * flagged pattern really does mean the plain letter, spell it so the intent is
 * unambiguous to the next reader and to this gate: [^0-9] rather than [^d], (?:s)+
 * rather than s+.
 *
 * Run:
 *   node scripts/verify-portal-template-escapes.js
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const OUT_DIR = path.join(ROOT, 'tmp', 'portal-template-escapes');

/** sunset exercises the surf-vertical branch; wolfhouse-somo the lodging default. */
const TENANTS = ['sunset', 'wolfhouse-somo'];

const SHORTHAND = 'dDsSwW';

const CONTROL_CHARS = [
  ['\u0008', '\\b'],
  ['\u000b', '\\v'],
  ['\u000c', '\\f'],
];

const KEYWORDS_BEFORE_REGEX = [
  'return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void',
  'case', 'do', 'else', 'yield', 'await', 'throw',
];

const PUNCT_BEFORE_REGEX = '(,=:[!&|?{};+-*%~^<>';

function runEmit(client, dest) {
  process.env.NODE_ENV = 'test';
  process.env.STAFF_UI_BUILDER_TEST_SEAM = '1';
  process.env.STAFF_AUTH_REQUIRED = 'false';
  process.env.STAFF_AUTH_ALLOW_OPEN = 'true';
  process.env.DEFAULT_CLIENT_SLUG = client;
  const api = require(path.join(ROOT, 'scripts', 'staff-query-api.js'));
  if (typeof api.buildUiHtmlForOfflineTest !== 'function') {
    console.error('Production staff UI builder seam is unavailable');
    process.exit(2);
  }
  fs.writeFileSync(dest, api.buildUiHtmlForOfflineTest(0, client), 'utf8');
}

function buildTenant(client) {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const dest = path.join(OUT_DIR, `rendered-${client}.html`);
  const r = spawnSync(process.execPath, [__filename, '--emit', client, dest], {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf8',
  });
  if (r.status !== 0) {
    throw new Error(`render failed for ${client}: ${(r.stderr || r.stdout || '').trim()}`);
  }
  return fs.readFileSync(dest, 'utf8');
}

/** Inline <script> bodies, with their offset in the full document. */
function inlineScripts(html) {
  const out = [];
  const re = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
  let m = re.exec(html);
  while (m) {
    const attrs = m[1] || '';
    const typeMatch = /\btype\s*=\s*["']?([^"'\s>]+)/i.exec(attrs);
    const type = typeMatch ? typeMatch[1].toLowerCase() : 'text/javascript';
    const isJs = type === 'text/javascript' || type === 'application/javascript' || type === 'module';
    if (!/\bsrc\s*=/i.test(attrs) && isJs) {
      out.push({ code: m[2], offset: m.index + m[0].indexOf(m[2]) });
    }
    m = re.exec(html);
  }
  return out;
}

function skipQuoted(code, start) {
  const quote = code[start];
  let i = start + 1;
  while (i < code.length) {
    if (code[i] === '\\') { i += 2; continue; }
    if (code[i] === quote) return i + 1;
    if (quote !== '`' && code[i] === '\n') return i;
    i += 1;
  }
  return code.length;
}

function readRegex(code, start) {
  let i = start + 1;
  let inClass = false;
  let body = '';
  while (i < code.length) {
    const c = code[i];
    if (c === '\n') return null;
    if (c === '\\') { body += c + (code[i + 1] || ''); i += 2; continue; }
    if (c === '/' && !inClass) break;
    if (c === '[') inClass = true;
    else if (c === ']') inClass = false;
    body += c;
    i += 1;
  }
  if (i >= code.length || code[i] !== '/' || !body) return null;
  let j = i + 1;
  let flags = '';
  while (j < code.length && /[a-z]/i.test(code[j])) { flags += code[j]; j += 1; }
  try { RegExp(body, flags); } catch (e) { return null; }
  return { body, flags, start, end: j };
}

/** A `/` opens a regex only where a value is expected, never after an operand. */
function regexCanStart(prevChar, prevWord) {
  if (prevWord) return KEYWORDS_BEFORE_REGEX.indexOf(prevWord) >= 0;
  if (!prevChar) return true;
  return PUNCT_BEFORE_REGEX.indexOf(prevChar) >= 0;
}

function regexLiterals(code) {
  const found = [];
  let i = 0;
  let prevChar = '';
  let prevWord = '';
  while (i < code.length) {
    const c = code[i];
    if (c === '/' && code[i + 1] === '/') {
      const nl = code.indexOf('\n', i);
      i = nl < 0 ? code.length : nl;
      continue;
    }
    if (c === '/' && code[i + 1] === '*') {
      const end = code.indexOf('*/', i + 2);
      i = end < 0 ? code.length : end + 2;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      i = skipQuoted(code, i);
      prevChar = c;
      prevWord = '';
      continue;
    }
    if (c === '/' && regexCanStart(prevChar, prevWord)) {
      const lit = readRegex(code, i);
      if (lit) {
        found.push(lit);
        i = lit.end;
        prevChar = '/';
        prevWord = '';
        continue;
      }
    }
    if (!/\s/.test(c)) {
      prevChar = c;
      prevWord = /[A-Za-z0-9_$]/.test(c) ? prevWord + c : '';
    }
    i += 1;
  }
  return found;
}

function quantifierAt(body, i) {
  const next = body[i + 1];
  if (next === '+' || next === '*') return next;
  if (next === '{') {
    const m = /^\{\d+(,\d*)?\}/.exec(body.slice(i + 1));
    return m ? m[0] : null;
  }
  return null;
}

/** True for /D/g, /^d$/ and /(d)/ — a lone letter where a shorthand class was meant. */
function standsAlone(body, i) {
  const prev = i === 0 ? '' : body[i - 1];
  const next = i === body.length - 1 ? '' : body[i + 1];
  return (prev === '' || prev === '^' || prev === '(')
    && (next === '' || next === '$' || next === ')');
}

/** Fingerprints of a backslash the template literal swallowed. */
function lostEscapes(body) {
  const reasons = [];
  for (const [ch, label] of CONTROL_CHARS) {
    if (body.indexOf(ch) >= 0) reasons.push(`holds the control character ${label} emits — write ${label} as \\${label}`);
  }
  let i = 0;
  let classStart = -1;
  while (i < body.length) {
    const c = body[i];
    if (c === '\\') { i += 2; continue; }
    if (c === '[' && classStart < 0) { classStart = i; i += 1; continue; }
    if (c === ']' && classStart >= 0) {
      const inner = body.slice(classStart + 1, i);
      const core = inner.charAt(0) === '^' ? inner.slice(1) : inner;
      if (core && !/[^dDsSwW]/.test(core)) {
        reasons.push(`character class [${inner}] holds only bare ${core.split('').join('/')} — should be [${inner.charAt(0) === '^' ? '^' : ''}${core.split('').map((x) => '\\' + x).join('')}]`);
      }
      classStart = -1;
      i += 1;
      continue;
    }
    if (classStart < 0 && SHORTHAND.indexOf(c) >= 0) {
      const q = quantifierAt(body, i);
      if (q) reasons.push(`bare ${c}${q} is quantified like a shorthand class — should be \\${c}${q}`);
      else if (standsAlone(body, i)) reasons.push(`bare ${c} is the whole pattern it sits in — should be \\${c}`);
    }
    i += 1;
  }
  return reasons;
}

function lineNumberAt(text, index) {
  let line = 1;
  for (let i = 0; i < index && i < text.length; i += 1) {
    if (text[i] === '\n') line += 1;
  }
  return line;
}

function enclosingFunction(code, index) {
  const head = code.slice(0, index);
  const re = /function\s+([A-Za-z0-9_$]+)\s*\(|([A-Za-z0-9_$]+)\s*[:=]\s*(?:async\s*)?function\s*\(/g;
  let name = '(top level)';
  let m = re.exec(head);
  while (m) {
    name = m[1] || m[2];
    m = re.exec(head);
  }
  return name;
}

function scanTenant(client) {
  const html = buildTenant(client);
  const findings = [];
  for (const script of inlineScripts(html)) {
    for (const lit of regexLiterals(script.code)) {
      const reasons = lostEscapes(lit.body);
      if (!reasons.length) continue;
      findings.push({
        fn: enclosingFunction(script.code, lit.start),
        regex: `/${lit.body}/${lit.flags}`,
        line: lineNumberAt(html, script.offset + lit.start),
        reasons,
      });
    }
  }
  return { html, findings };
}

function main() {
  const args = process.argv.slice(2);
  if (args[0] === '--emit') {
    runEmit(args[1], args[2]);
    return 0;
  }

  console.log('verify-portal-template-escapes');
  let fail = 0;
  for (const client of TENANTS) {
    const { html, findings } = scanTenant(client);
    if (!findings.length) {
      console.log(`  PASS  ${client}  no regex lost a backslash  (${html.length} bytes rendered)`);
      continue;
    }
    fail += findings.length;
    console.log(`  FAIL  ${client}  ${findings.length} regex literal(s) reached the browser with backslashes eaten`);
    for (const f of findings) {
      console.log(`        ${f.fn}()  ${f.regex}   (rendered line ${f.line})`);
      for (const reason of f.reasons) console.log(`          ${reason}`);
    }
  }

  if (fail) {
    console.log('');
    console.log(`${fail} broken regex literal(s). Double the backslash in the /staff/ui template source`);
    console.log('(scripts/staff-query-api.js buildUiHtml): \\d in the source emits d, \\\\d emits \\d.');
  }
  return fail ? 1 : 0;
}

process.exit(main());
