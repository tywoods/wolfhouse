/**
 * Shared CSP / inline-block helpers for Slice C.
 * Inventory is the authorization source — never approve hashes from dist.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync, copyFileSync } from 'node:fs';
import { join, relative } from 'node:path';

export const INVENTORY_REL = 'security/inline-blocks.inventory.json';
export const CONTRACT_REL = 'security/headers.contract.json';
export const HEADERS_REL = 'public/_headers';

/** @param {string} content */
export function sha256CspToken(content) {
  const hash = createHash('sha256').update(content, 'utf8').digest('base64');
  return `'sha256-${hash}'`;
}

/** Normalize inventory / CSP hash to quoted CSP token form. */
export function toCspHashToken(value) {
  const raw = String(value || '').trim().replace(/^'|'$/g, '');
  if (!raw.startsWith('sha256-')) {
    throw new Error(`invalid sha256 token: ${value}`);
  }
  return `'${raw}'`;
}

/** Strip quotes → sha256-... */
export function bareSha256(value) {
  return toCspHashToken(value).slice(1, -1);
}

/**
 * @param {string} html
 * @param {'script'|'style'} tag
 * @returns {string[]} raw bodies (no src= scripts)
 */
export function extractInlineBodies(html, tag) {
  const bodies = [];
  const re = new RegExp(`<${tag}\\b([^>]*)>([\\s\\S]*?)<\\/${tag}>`, 'gi');
  let m;
  while ((m = re.exec(html)) !== null) {
    if (/\bsrc\s*=/i.test(m[1] || '')) continue;
    bodies.push(m[2]);
  }
  return bodies;
}

/**
 * @param {string} dir
 * @returns {string[]} absolute html paths, sorted
 */
export function collectHtmlFiles(dir) {
  const out = [];
  function walk(d) {
    if (!existsSync(d)) return;
    for (const name of readdirSync(d)) {
      const abs = join(d, name);
      const st = statSync(abs);
      if (st.isDirectory()) walk(abs);
      else if (name.endsWith('.html')) out.push(abs);
    }
  }
  walk(dir);
  return out.sort();
}

/**
 * @param {string} distDir
 * @returns {{ page: string, type: 'script'|'style', sha256: string, body: string }[]}
 */
export function collectDistInlineBlocks(distDir) {
  const found = [];
  for (const file of collectHtmlFiles(distDir)) {
    const page = relative(distDir, file).split('\\').join('/');
    const html = readFileSync(file, 'utf8');
    for (const type of /** @type {const} */ (['script', 'style'])) {
      for (const body of extractInlineBodies(html, type)) {
        found.push({ page, type, sha256: bareSha256(sha256CspToken(body)), body });
      }
    }
  }
  return found;
}

/**
 * @param {string} text
 * @returns {string|null}
 */
export function parseCspFromHeaders(text) {
  const m = text.match(/Content-Security-Policy:\s*(.+)/i);
  return m ? m[1].trim() : null;
}

/**
 * @param {string} csp
 * @returns {Map<string, string[]>}
 */
export function parseCspDirectives(csp) {
  const map = new Map();
  for (const part of csp.split(';')) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const sp = trimmed.indexOf(' ');
    if (sp === -1) {
      map.set(trimmed.toLowerCase(), []);
      continue;
    }
    const name = trimmed.slice(0, sp).toLowerCase();
    const values = trimmed
      .slice(sp + 1)
      .trim()
      .split(/\s+/)
      .filter(Boolean);
    map.set(name, values);
  }
  return map;
}

/**
 * @param {string[]} a
 * @param {string[]} b
 */
export function sameMultiset(a, b) {
  if (a.length !== b.length) return false;
  const sa = [...a].sort();
  const sb = [...b].sort();
  return sa.every((v, i) => v === sb[i]);
}

/**
 * Bidirectional canonical equivalence of two CSP strings
 * (same directive names + same value multisets; order-insensitive).
 * @param {string} a
 * @param {string} b
 */
export function cspCanonicallyEquivalent(a, b) {
  const da = parseCspDirectives(a);
  const db = parseCspDirectives(b);
  if (da.size !== db.size) return false;
  for (const [name, vals] of da) {
    if (!db.has(name)) return false;
    if (!sameMultiset(vals, db.get(name) || [])) return false;
  }
  return true;
}

/**
 * Header name → value map from Netlify/CF _headers body (/* block only).
 * @param {string} text
 * @returns {Map<string, string>}
 */
export function parseHeadersFile(text) {
  const map = new Map();
  const block = text.match(/\/\*\s*\n([\s\S]*?)(?:\n\s*$|$)/);
  const body = block ? block[1] : text;
  for (const line of body.split('\n')) {
    const m = line.match(/^\s*([A-Za-z0-9-]+):\s*(.+?)\s*$/);
    if (m) map.set(m[1], m[2].trim());
  }
  return map;
}

/**
 * @param {object} inventory
 * @returns {{ script: string[], style: string[] }} CSP-quoted tokens, sorted unique
 */
export function approvedHashesFromInventory(inventory) {
  const script = new Set();
  const style = new Set();
  for (const block of inventory.blocks || []) {
    const token = toCspHashToken(block.sha256);
    if (block.type === 'script') script.add(token);
    else if (block.type === 'style') style.add(token);
    else throw new Error(`inventory block ${block.id}: bad type ${block.type}`);
  }
  return {
    script: [...script].sort(),
    style: [...style].sort(),
  };
}

/**
 * Verify every dist inline script/style exactly matches the committed inventory.
 * Refuses unknown, missing, duplicate (count mismatch), and moved (wrong page) blocks.
 * @param {string} rootDir website root
 * @param {string} [distDir]
 * @returns {{ ok: boolean, errors: string[], found: ReturnType<typeof collectDistInlineBlocks> }}
 */
export function verifyDistAgainstInventory(rootDir, distDir = join(rootDir, 'dist')) {
  const errors = [];
  const inventoryPath = join(rootDir, INVENTORY_REL);
  if (!existsSync(inventoryPath)) {
    return { ok: false, errors: [`missing ${INVENTORY_REL}`], found: [] };
  }
  const inventory = JSON.parse(readFileSync(inventoryPath, 'utf8'));
  if (!inventory.reviewed || !Array.isArray(inventory.blocks)) {
    return { ok: false, errors: ['inventory must be reviewed with a blocks array'], found: [] };
  }

  const found = collectDistInlineBlocks(distDir);
  /** @type {Map<string, object>} */
  const byKey = new Map();
  for (const block of inventory.blocks) {
    const key = `${block.type}|${bareSha256(block.sha256)}`;
    if (byKey.has(key)) {
      errors.push(`inventory duplicate key ${key}`);
    }
    byKey.set(key, block);
  }

  /** @type {Map<string, number>} */
  const counts = new Map();
  for (const hit of found) {
    const key = `${hit.type}|${hit.sha256}`;
    const block = byKey.get(key);
    if (!block) {
      errors.push(`unknown inline ${hit.type} on ${hit.page}: ${hit.sha256}`);
      continue;
    }
    const pages = block.pages || [];
    if (!pages.includes(hit.page)) {
      errors.push(
        `moved inline ${hit.type} ${hit.sha256}: found on ${hit.page}, allowed pages [${pages.join(', ')}]`,
      );
    }
    counts.set(key, (counts.get(key) || 0) + 1);
  }

  for (const block of inventory.blocks) {
    const key = `${block.type}|${bareSha256(block.sha256)}`;
    const got = counts.get(key) || 0;
    const expected = Number(block.expectedCount);
    if (got === 0) {
      errors.push(`missing inline ${block.type} ${block.id} (${block.sha256}) expected ${expected}`);
    } else if (got !== expected) {
      errors.push(
        `duplicate/count mismatch for ${block.type} ${block.id}: expected ${expected}, found ${got}`,
      );
    }
  }

  return { ok: errors.length === 0, errors, found };
}

/**
 * Contract CSP directives + _headers CSP + inventory hashes must be
 * bidirectionally canonical-equivalent with no extras. Non-CSP header names
 * and values must be an exact bidirectional set between contract and _headers.
 * @param {string} rootDir
 * @returns {{ ok: boolean, errors: string[] }}
 */
export function verifyContractHeadersInventoryEquivalence(rootDir) {
  const errors = [];
  const inventory = JSON.parse(readFileSync(join(rootDir, INVENTORY_REL), 'utf8'));
  const contract = JSON.parse(readFileSync(join(rootDir, CONTRACT_REL), 'utf8'));
  const headersText = readFileSync(join(rootDir, HEADERS_REL), 'utf8');
  const approved = approvedHashesFromInventory(inventory);

  const cspDirectives = contract.headers?.['Content-Security-Policy']?.directives || {};
  const contractScript = [...(cspDirectives['script-src'] || [])];
  const contractStyle = [...(cspDirectives['style-src'] || [])];

  const expectScript = ["'self'", ...approved.script];
  const expectStyle = ["'self'", ...approved.style];

  if (!sameMultiset(contractScript, expectScript)) {
    errors.push(
      `contract script-src not exactly inventory hashes + 'self': got [${contractScript.join(' ')}]`,
    );
  }
  if (!sameMultiset(contractStyle, expectStyle)) {
    errors.push(
      `contract style-src not exactly inventory hashes + 'self': got [${contractStyle.join(' ')}]`,
    );
  }

  const inlineScript = (contract.inlineHashes?.script || []).map(toCspHashToken);
  const inlineStyle = (contract.inlineHashes?.style || []).map(toCspHashToken);
  if (!sameMultiset(inlineScript, approved.script)) {
    errors.push('contract.inlineHashes.script must exactly match inventory script hashes');
  }
  if (!sameMultiset(inlineStyle, approved.style)) {
    errors.push('contract.inlineHashes.style must exactly match inventory style hashes');
  }

  const headersCsp = parseCspFromHeaders(headersText);
  if (!headersCsp) {
    errors.push('_headers missing Content-Security-Policy');
    return { ok: false, errors };
  }

  // Build expected CSP from contract directives (canonical order as stored).
  const directiveOrder = [
    'default-src',
    'script-src',
    'style-src',
    'img-src',
    'font-src',
    'connect-src',
    'frame-src',
    'object-src',
    'base-uri',
    'form-action',
    'frame-ancestors',
  ];
  const contractCspParts = [];
  for (const name of directiveOrder) {
    const vals = cspDirectives[name];
    if (!vals) {
      errors.push(`contract missing CSP directive ${name}`);
      continue;
    }
    contractCspParts.push(`${name} ${vals.join(' ')}`);
  }
  // Refuse extra directives in contract
  for (const name of Object.keys(cspDirectives)) {
    if (!directiveOrder.includes(name)) {
      errors.push(`contract has extra CSP directive: ${name}`);
    }
  }

  const contractCsp = contractCspParts.join('; ');
  if (!cspCanonicallyEquivalent(contractCsp, headersCsp)) {
    errors.push('_headers CSP is not bidirectionally canonical-equivalent to contract directives');
  }

  // Exact bidirectional header-name set between contract and _headers —
  // reject missing/extra names on either side before any value checks.
  const headerMap = parseHeadersFile(headersText);
  const contractHeaderNames = Object.keys(contract.headers || {});
  const headersFileNames = [...headerMap.keys()];
  const contractNameSet = new Set(contractHeaderNames);
  const headersNameSet = new Set(headersFileNames);

  for (const name of contractHeaderNames) {
    if (!headersNameSet.has(name)) {
      errors.push(`contract has header ${name} missing from _headers`);
    }
  }
  for (const name of headersFileNames) {
    if (!contractNameSet.has(name)) {
      errors.push(`_headers has extra header not in contract: ${name}`);
    }
  }

  // Value checks only after name-set comparison; CSP compared canonically above.
  for (const name of contractHeaderNames) {
    if (!headersNameSet.has(name)) continue;
    if (name === 'Content-Security-Policy') continue;
    const expected = contract.headers[name]?.value;
    const actual = headerMap.get(name);
    if (expected != null && actual !== expected) {
      errors.push(`_headers ${name} value diverges from contract`);
    }
  }

  // CSP hash tokens in headers must be exactly approved (no extras).
  const parsed = parseCspDirectives(headersCsp);
  const hScript = (parsed.get('script-src') || []).filter((v) => v.startsWith("'sha256-"));
  const hStyle = (parsed.get('style-src') || []).filter((v) => v.startsWith("'sha256-"));
  if (!sameMultiset(hScript, approved.script)) {
    errors.push('_headers script-src hashes must exactly match inventory (no extras)');
  }
  if (!sameMultiset(hStyle, approved.style)) {
    errors.push('_headers style-src hashes must exactly match inventory (no extras)');
  }

  // Refuse unsafe tokens
  if (/unsafe-eval|'unsafe-inline'/.test(headersCsp) || /unsafe-eval|'unsafe-inline'/.test(contractCsp)) {
    errors.push("CSP must not include unsafe-eval or 'unsafe-inline'");
  }

  return { ok: errors.length === 0, errors };
}

/** Copy committed public/_headers → dist/_headers only (never rewrite tracked). */
export function copyCommittedHeadersToDist(rootDir) {
  const src = join(rootDir, HEADERS_REL);
  const dest = join(rootDir, 'dist', '_headers');
  if (!existsSync(src)) throw new Error(`${HEADERS_REL} missing`);
  if (!existsSync(join(rootDir, 'dist'))) throw new Error('dist/ missing');
  copyFileSync(src, dest);
  return dest;
}

/**
 * Candidate report from dist — print-only helper data. Never writes tracked files.
 * @param {string} distDir
 */
export function collectInlineCandidates(distDir) {
  return collectDistInlineBlocks(distDir).map(({ page, type, sha256 }) => ({
    type,
    page,
    sha256,
    cspHash: `'${sha256}'`,
  }));
}
