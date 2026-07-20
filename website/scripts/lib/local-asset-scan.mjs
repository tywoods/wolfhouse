/**
 * Deterministic source scanner: every website src CSS/Astro/HTML file must keep
 * stylesheet links, @import, and @font-face URLs local/same-origin.
 * Rejects protocol-relative, data:, and remote font sources anywhere.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, extname } from 'node:path';

const SCAN_EXTENSIONS = new Set(['.css', '.astro', '.html', '.htm']);

/** Absolute http(s) or protocol-relative URL. */
const ABSOLUTE_OR_PROTOCOL_RELATIVE = /^(?:https?:)?\/\//i;
const DATA_URI = /^data:/i;

/**
 * @param {string} rootDir absolute path to website/
 * @returns {string[]} sorted relative paths under src/
 */
export function enumerateSourceFiles(rootDir) {
  const srcRoot = join(rootDir, 'src');
  const out = [];

  function walk(dir) {
    for (const name of readdirSync(dir).sort()) {
      const abs = join(dir, name);
      const st = statSync(abs);
      if (st.isDirectory()) {
        walk(abs);
        continue;
      }
      if (!SCAN_EXTENSIONS.has(extname(name).toLowerCase())) continue;
      out.push(relative(rootDir, abs).split('\\').join('/'));
    }
  }

  walk(srcRoot);
  return out.sort();
}

/**
 * @param {string} css
 * @returns {string[]}
 */
export function extractFontFaceUrls(css) {
  const urls = [];
  const faceRe = /@font-face\s*\{([\s\S]*?)\}/gi;
  let face;
  while ((face = faceRe.exec(css)) !== null) {
    const block = face[1] ?? '';
    const urlRe = /url\(\s*(['"]?)([^'")]+)\1\s*\)/gi;
    let m;
    while ((m = urlRe.exec(block)) !== null) {
      urls.push((m[2] ?? '').trim());
    }
  }
  return urls;
}

/**
 * @param {string} source
 * @returns {string[]}
 */
export function extractImportUrls(source) {
  const urls = [];
  const re = /@import\s+(?:url\(\s*(['"]?)([^'")]+)\1\s*\)|(['"])([^'"]+)\3)\s*[^;]*;/gi;
  let m;
  while ((m = re.exec(source)) !== null) {
    urls.push((m[2] || m[4] || '').trim());
  }
  return urls;
}

/**
 * Stylesheet <link rel="stylesheet" href="..."> (and rel='stylesheet').
 * @param {string} source
 * @returns {string[]}
 */
export function extractStylesheetHrefs(source) {
  const urls = [];
  const re =
    /<link\b[^>]*\brel\s*=\s*(['"])stylesheet\1[^>]*\bhref\s*=\s*(['"])([^'"]+)\2[^>]*>|<link\b[^>]*\bhref\s*=\s*(['"])([^'"]+)\4[^>]*\brel\s*=\s*(['"])stylesheet\6[^>]*>/gi;
  let m;
  while ((m = re.exec(source)) !== null) {
    urls.push((m[3] || m[5] || '').trim());
  }
  return urls;
}

/**
 * Any url(...) that looks like a font file, outside @font-face (defensive).
 * @param {string} source
 * @returns {string[]}
 */
export function extractFontLikeUrls(source) {
  const urls = [];
  const re = /url\(\s*(['"]?)([^'")]+)\1\s*\)/gi;
  let m;
  while ((m = re.exec(source)) !== null) {
    const u = (m[2] ?? '').trim();
    if (/\.(?:woff2?|ttf|otf|eot)(?:$|\?)/i.test(u) || /(?:fonts?\.google|gstatic)/i.test(u)) {
      urls.push(u);
    }
  }
  return urls;
}

/**
 * @param {string} url
 * @param {'font' | 'stylesheet' | 'import'} kind
 * @returns {string | null} error message or null if ok
 */
export function validateLocalUrl(url, kind) {
  if (!url) return `${kind} URL is empty`;
  if (DATA_URI.test(url)) {
    return `${kind} rejects data: URI: ${url}`;
  }
  if (ABSOLUTE_OR_PROTOCOL_RELATIVE.test(url)) {
    return `${kind} rejects absolute/protocol-relative URL: ${url}`;
  }
  // Allow root-absolute and relative same-origin paths only.
  if (url.startsWith('/')) {
    if (kind === 'font' && !url.startsWith('/fonts/')) {
      return `font URL must be under /fonts/: ${url}`;
    }
    return null;
  }
  // Relative path (./tokens.css, ../x) — local only; still reject font escapes.
  if (kind === 'font') {
    return `font URL must be root-absolute under /fonts/: ${url}`;
  }
  if (url.includes('://') || url.startsWith('//')) {
    return `${kind} rejects remote URL: ${url}`;
  }
  return null;
}

/**
 * @param {string} rootDir
 * @returns {{ files: string[], errors: string[] }}
 */
export function scanLocalAssetOrigins(rootDir) {
  const files = enumerateSourceFiles(rootDir);
  const errors = [];

  for (const rel of files) {
    const source = readFileSync(join(rootDir, rel), 'utf8');

    for (const href of extractStylesheetHrefs(source)) {
      const err = validateLocalUrl(href, 'stylesheet');
      if (err) errors.push(`${rel}: ${err}`);
    }
    for (const href of extractImportUrls(source)) {
      const err = validateLocalUrl(href, 'import');
      if (err) errors.push(`${rel}: ${err}`);
    }
    for (const href of extractFontFaceUrls(source)) {
      const err = validateLocalUrl(href, 'font');
      if (err) errors.push(`${rel}: ${err}`);
    }
    for (const href of extractFontLikeUrls(source)) {
      const err = validateLocalUrl(href, 'font');
      if (err) errors.push(`${rel}: ${err}`);
    }

    // Hard reject classic remote font hosts and protocol-relative font URLs anywhere.
    if (/(?:https?:)?\/\/[^\s"'`)]*(?:fonts\.googleapis|fonts\.gstatic|fonts\.google)/i.test(source)) {
      errors.push(`${rel}: remote Google Fonts host reference`);
    }
    if (/(?:https?:)?\/\/[^\s"'`)]+\.(?:woff2?|ttf|otf|eot)/i.test(source)) {
      errors.push(`${rel}: remote/protocol-relative font file URL`);
    }
    if (/url\(\s*(['"]?)data:/i.test(source) && /@font-face/i.test(source)) {
      // Narrow: data: inside a file that also declares @font-face.
      const faces = extractFontFaceUrls(source);
      if (faces.some((u) => DATA_URI.test(u))) {
        errors.push(`${rel}: data: font source in @font-face`);
      }
    }
  }

  return { files, errors };
}
