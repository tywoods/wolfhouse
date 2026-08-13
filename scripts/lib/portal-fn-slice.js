'use strict';

/**
 * Slice browser functions out of the portal source so offline gates can run them.
 *
 * Several gates execute a real portal owner in a `vm` sandbox by locating
 * `function <name>(` in the portal source, slicing to the matching brace, and
 * eval'ing the slice. That works only while every helper the slice *calls* is
 * also in scope. When the front-end is split into new scripts/browser modules,
 * or a new helper is added next to an existing one, a hand-maintained list of
 * names silently stops covering the slice's dependencies and the gate dies with
 * `ReferenceError: <helper> is not defined` before asserting anything.
 *
 * `collectPortalFunctions` closes over that: it walks the call graph from the
 * requested roots and pulls in every callee that the sandbox does not already
 * provide. Names it cannot find anywhere are returned in `missing` so a gate can
 * fail with a named assertion instead of crashing.
 *
 * Sources should come from lib/staff-portal-ui-source.js (template plus injected
 * modules) or from the rendered /staff/ui document, not staff-query-api.js alone.
 *
 * @module portal-fn-slice
 */

const vm = require('vm');

/** Keywords that look like calls (`if (`, `catch (`) but never name a function. */
const KEYWORDS = new Set([
  'if', 'for', 'while', 'switch', 'catch', 'return', 'typeof', 'function',
  'new', 'delete', 'void', 'in', 'of', 'do', 'else', 'case', 'try', 'await',
  'yield', 'instanceof', 'throw', 'this', 'super', 'var', 'let', 'const',
]);

/** Globals a browser sandbox gets for free; never candidates for slicing. */
const AMBIENT_GLOBALS = new Set([
  'Array', 'Boolean', 'Date', 'Error', 'Function', 'Infinity', 'Intl', 'JSON',
  'Map', 'Math', 'NaN', 'Number', 'Object', 'Promise', 'Proxy', 'RegExp', 'Set',
  'String', 'Symbol', 'TypeError', 'URL', 'URLSearchParams', 'WeakMap', 'WeakSet',
  'AbortController', 'AbortSignal', 'Blob', 'FormData', 'Headers', 'Request',
  'Response', 'Event', 'CustomEvent', 'MouseEvent', 'KeyboardEvent', 'Element',
  'HTMLElement', 'Node', 'Image', 'Audio', 'File', 'FileReader', 'DOMParser',
  'MutationObserver', 'IntersectionObserver', 'ResizeObserver', 'XMLHttpRequest',
  'alert', 'atob', 'btoa', 'clearInterval', 'clearTimeout', 'confirm', 'console',
  'crypto', 'decodeURI', 'decodeURIComponent', 'encodeURI', 'encodeURIComponent',
  'fetch', 'getComputedStyle', 'globalThis', 'history', 'isFinite', 'isNaN',
  'localStorage', 'location', 'matchMedia', 'navigator', 'parseFloat', 'parseInt',
  'performance', 'prompt', 'queueMicrotask', 'requestAnimationFrame',
  'sessionStorage', 'setInterval', 'setTimeout', 'structuredClone', 'undefined',
  'window', 'document',
]);

/**
 * Slice one function declaration out of `src` by brace matching.
 *
 * @param {string} src source to search
 * @param {string} name function name
 * @returns {string|null} the declaration source, `async` prefix included, or null
 */
function slicePortalFunction(src, name) {
  const needle = `function ${name}(`;
  const start = src.indexOf(needle);
  if (start < 0) return null;
  const brace = src.indexOf('{', start);
  if (brace < 0) return null;
  let depth = 0;
  for (let i = brace; i < src.length; i += 1) {
    if (src[i] === '{') depth += 1;
    else if (src[i] === '}') {
      depth -= 1;
      if (depth === 0) {
        const asyncAt = start - 'async '.length;
        const from = src.slice(asyncAt, start) === 'async ' ? asyncAt : start;
        return src.slice(from, i + 1);
      }
    }
  }
  return null;
}

/**
 * Blank out comments, string/template literals and regex literals so identifier
 * scanning does not trip over prose. Prose is the loud failure mode here: a
 * comment like `// Reject fractions (1.5)` otherwise reads as a call to
 * `fractions`. Replaced spans keep their length so offsets stay meaningful.
 */
function blankNonCode(code) {
  const out = code.split('');
  let i = 0;
  let prevSignificant = '';
  const blank = (from, to) => {
    for (let k = from; k < to && k < out.length; k += 1) {
      if (out[k] !== '\n') out[k] = ' ';
    }
  };
  while (i < code.length) {
    const c = code[i];
    const next = code[i + 1];
    if (c === '/' && next === '/') {
      let j = i;
      while (j < code.length && code[j] !== '\n') j += 1;
      blank(i, j);
      i = j;
    } else if (c === '/' && next === '*') {
      const end = code.indexOf('*/', i + 2);
      const j = end < 0 ? code.length : end + 2;
      blank(i, j);
      i = j;
    } else if (c === '"' || c === "'" || c === '`') {
      let j = i + 1;
      while (j < code.length) {
        if (code[j] === '\\') { j += 2; continue; }
        if (code[j] === c) { j += 1; break; }
        j += 1;
      }
      blank(i + 1, j - 1);
      i = j;
    } else if (c === '/' && prevSignificant && !/[\w$)\]]/.test(prevSignificant)) {
      // Division never follows an operator or `(`, so this opens a regex literal.
      let j = i + 1;
      let inClass = false;
      while (j < code.length && code[j] !== '\n') {
        if (code[j] === '\\') { j += 2; continue; }
        if (code[j] === '[') inClass = true;
        else if (code[j] === ']') inClass = false;
        else if (code[j] === '/' && !inClass) { j += 1; break; }
        j += 1;
      }
      blank(i + 1, j - 1);
      i = j;
    } else {
      if (!/\s/.test(c)) prevSignificant = c;
      i += 1;
    }
  }
  return out.join('');
}

/** Identifiers used in call position inside `code` (`foo(`, not `x.foo(`). */
function calledIdentifiers(code) {
  const out = new Set();
  const re = /(^|[^\w$.])([A-Za-z_$][\w$]*)\s*\(/g;
  let m;
  const scan = blankNonCode(code);
  while ((m = re.exec(scan))) {
    const name = m[2];
    if (!KEYWORDS.has(name)) out.add(name);
    re.lastIndex = m.index + m[0].length - 1;
  }
  return out;
}

/**
 * Names bound inside `code` itself — parameters, locals, catch bindings.
 *
 * Without this a slice that does `new Promise(function(resolve){ resolve(x); })`
 * reads as a call to a global `resolve`, and a local named like a real portal
 * helper would drag that helper in and shadow the intended local.
 */
function locallyBoundIdentifiers(code) {
  const out = new Set();
  const scan = blankNonCode(code);
  const addList = (raw) => String(raw || '')
    .split(',')
    .map((p) => p.trim().replace(/^\.\.\./, '').split(/[=:]/)[0].trim())
    .filter((p) => /^[A-Za-z_$][\w$]*$/.test(p))
    .forEach((p) => out.add(p));

  let m;
  const params = /(?:function\s*[A-Za-z_$][\w$]*\s*|function\s*|catch\s*)\(([^)]*)\)/g;
  while ((m = params.exec(scan))) addList(m[1]);
  const arrowList = /\(([^)]*)\)\s*=>/g;
  while ((m = arrowList.exec(scan))) addList(m[1]);
  const arrowOne = /(^|[^\w$.])([A-Za-z_$][\w$]*)\s*=>/g;
  while ((m = arrowOne.exec(scan))) out.add(m[2]);
  const decls = /\b(?:var|let|const)\s+([^;\n]*)/g;
  while ((m = decls.exec(scan))) {
    // Only the declared names, not the initialiser expressions.
    m[1].split(',').forEach((part) => {
      const name = part.trim().split(/[=\s]/)[0];
      if (/^[A-Za-z_$][\w$]*$/.test(name)) out.add(name);
    });
  }
  return out;
}

/** Every identifier read in `code`, excluding property names and keywords. */
function referencedIdentifiers(code) {
  const out = new Set();
  const re = /(^|[^\w$.])([A-Za-z_$][\w$]*)/g;
  let m;
  const scan = blankNonCode(code);
  while ((m = re.exec(scan))) {
    const name = m[2];
    if (!KEYWORDS.has(name)) out.add(name);
  }
  return out;
}

/**
 * A module-level `var NAME = <literal>;` declaration, if `src` has one.
 *
 * Anchored at column 0 because injected scripts/browser modules keep their own
 * indentation, so an indented match would be a local inside some other function.
 * Only literal initialisers qualify: state seeds are safe to replay in any order,
 * computed ones are not.
 */
function sliceStateVar(src, name) {
  const re = new RegExp(
    `^(?:var|let)\\s+${name}\\s*=\\s*(null|true|false|-?\\d+(?:\\.\\d+)?|''|""|\\[\\]|\\{\\}|'[^'\\n]*'|"[^"\\n]*")\\s*;`,
    'm',
  );
  const m = re.exec(src);
  return m ? `var ${name} = ${m[1]};` : null;
}

/** Names the code only calls behind a `typeof x === 'function'` style guard. */
function guardedIdentifiers(code) {
  const out = new Set();
  const re = /typeof\s+([A-Za-z_$][\w$]*)\s*[=!]==?\s*['"](?:function|undefined)['"]/g;
  let m;
  while ((m = re.exec(code))) out.add(m[1]);
  return out;
}

function firstSlice(sources, name) {
  for (const src of sources) {
    const code = slicePortalFunction(src, name);
    if (code) return code;
  }
  return null;
}

function firstStateVar(sources, name) {
  for (const src of sources) {
    const code = sliceStateVar(src, name);
    if (code) return code;
  }
  return null;
}

/**
 * Slice `roots` and every helper they transitively call.
 *
 * @param {string|string[]} sources portal source(s), searched in order
 * @param {string[]} roots function names the gate wants to execute
 * @param {object} [options]
 * @param {Iterable<string>} [options.provided] names the sandbox already defines
 *   (typically `Object.keys(ctx)` plus any prelude `var`s) — these are neither
 *   sliced nor reported missing, so gate stubs keep winning over production code
 * @param {boolean} [options.followDependencies=true] set false for the old
 *   hand-listed behaviour
 * @param {boolean} [options.omitProvided=false] walk the roots for dependencies
 *   but leave anything already in `provided` out of the emitted code — for a
 *   gate that has loaded its own set and only wants the dangling remainder
 * @returns {{code: string, resolved: string[], missing: string[], optional: string[],
 *   unparsable: string[]}} `code` is every slice newline-joined; `missing` are
 *   called names found neither in the sources nor in `provided` — the crash
 *   class; `optional` are the same but only ever called behind a
 *   `typeof x === 'function'` guard, so they degrade instead of throwing;
 *   `unparsable` are slices that do not compile (brace matching confused by a
 *   brace inside a string or regex)
 */
function collectPortalFunctions(sources, roots, options) {
  const opts = options || {};
  const srcList = Array.isArray(sources) ? sources : [sources];
  const provided = new Set(opts.provided || []);
  const follow = opts.followDependencies !== false;
  const omitProvided = opts.omitProvided === true;

  const resolved = new Map();
  const stateVars = new Map();
  const unresolved = new Set();
  const guarded = new Set();
  const unparsable = new Set();
  const seen = new Set();
  const seenState = new Set();
  const queue = roots.slice();

  while (queue.length) {
    const name = queue.shift();
    if (seen.has(name)) continue;
    seen.add(name);

    const code = firstSlice(srcList, name);
    if (!code) {
      // Roots are the gate's own list — a missing root is a stale anchor, which
      // verify-gate-anchors already covers. Missing callees are the scope rot.
      if (!provided.has(name) && !roots.includes(name)) unresolved.add(name);
      continue;
    }
    try {
      new vm.Script(code, { filename: `portal-fn-slice:${name}.js` });
    } catch (_e) {
      unparsable.add(name);
      continue;
    }
    resolved.set(name, code);
    if (!follow) continue;
    guardedIdentifiers(code).forEach((n) => guarded.add(n));
    const local = locallyBoundIdentifiers(code);
    const external = (n) => !local.has(n) && !provided.has(n) && !AMBIENT_GLOBALS.has(n);
    for (const dep of calledIdentifiers(code)) {
      if (seen.has(dep) || !external(dep)) continue;
      queue.push(dep);
    }
    // Module-level state the slice reads (schedulePortalQuotePriceBlocked and
    // friends) rots the same way a helper does — resolve it from the source
    // rather than making every gate hand-maintain a prelude.
    for (const ref of referencedIdentifiers(code)) {
      if (seenState.has(ref) || !external(ref)) continue;
      seenState.add(ref);
      const decl = firstStateVar(srcList, ref);
      if (decl) stateVars.set(ref, decl);
    }
  }

  const emitNames = Array.from(resolved.keys())
    .filter((n) => !(omitProvided && provided.has(n)));
  // Functions may be declared before the state they close over; vars run first.
  const emitted = Array.from(stateVars.values())
    .concat(emitNames.map((n) => resolved.get(n)));
  const missing = Array.from(unresolved)
    .filter((n) => !guarded.has(n) && !stateVars.has(n));
  const optional = Array.from(unresolved).filter((n) => guarded.has(n));
  return {
    code: emitted.join('\n'),
    resolved: emitNames,
    stateVars: Array.from(stateVars.keys()),
    missing,
    optional,
    unparsable: Array.from(unparsable),
  };
}

module.exports = {
  slicePortalFunction,
  sliceStateVar,
  blankNonCode,
  calledIdentifiers,
  referencedIdentifiers,
  locallyBoundIdentifiers,
  collectPortalFunctions,
  AMBIENT_GLOBALS,
  KEYWORDS,
};
