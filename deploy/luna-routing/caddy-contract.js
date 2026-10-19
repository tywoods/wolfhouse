'use strict';

const fs = require('fs');

const LEGACY_SITE = 'lunabox.lunafrontdesk.com';
const FRANCE_STAGING_SITE = 'whatsapp-staging.lunafrontdesk.com';
const SITE_POLICIES = Object.freeze({
  [LEGACY_SITE]: Object.freeze({ broadRouteRequired: true, activeRouteImport: true }),
  [FRANCE_STAGING_SITE]: Object.freeze({ broadRouteRequired: false, activeRouteImport: false }),
});
const BEGIN = '# BEGIN luna-routing-contract';
const END = '# END luna-routing-contract';
const PUBLIC = '/_internal/luna-routing/v1/routes/meta-whatsapp-verified-webhook';
const PROOF = '/whatsapp/routing-proof';
const IMPORT = '/var/lib/luna-routing/luna-number-route.caddy';

function uncomment(line) { return line.replace(/#.*/, ''); }
function settings(options = {}) {
  if (typeof options === 'boolean') options = { update: options };
  const site = options.site || LEGACY_SITE;
  const policy = Object.hasOwn(SITE_POLICIES, site) ? SITE_POLICIES[site] : null;
  if (!policy) throw new Error(`routing site is not allowlisted: ${site}`);
  return { site, policy, update: options.update === true };
}
function locate(text, options = {}) {
  const allowAbsent = options.allowAbsent === true;
  const { site: siteName, policy } = settings(options);
  const lines = String(text).split('\n');
  const escapedSite = siteName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  let depth = 0;
  const sites = [];
  let selectedLabels = 0;
  let active = null;
  for (let i = 0; i < lines.length; i += 1) {
    const code = uncomment(lines[i]);
    if (depth === 0) {
      const header = /^\s*([^{}]+?)\s*\{\s*$/.exec(code);
      if (header) {
        const labels = header[1].split(',').map((label) => label.trim().replace(/^https?:\/\//, '').replace(/:\d+$/, ''));
        if (labels.includes(siteName)) selectedLabels += 1;
      }
    }
    if (depth === 0 && new RegExp(`^\\s*${escapedSite}\\s*\\{\\s*$`).test(code)) active = { start: i, depth: 1 };
    const opens = (code.match(/{/g) || []).length;
    const closes = (code.match(/}/g) || []).length;
    depth += opens - closes;
    if (active && depth === 0) { active.end = i; sites.push(active); active = null; }
  }
  if (!active && sites.length === 0 && selectedLabels === 0 && allowAbsent) return null;
  if (active || sites.length !== 1 || selectedLabels !== 1) throw new Error(`expected exactly one unambiguous ${siteName} site block`);
  const site = sites[0];
  const rows = lines.slice(site.start + 1, site.end);
  if (siteName === FRANCE_STAGING_SITE) {
    const withoutContract = rows.join('\n').replace(/^\s*# BEGIN luna-routing-contract\s*$[\s\S]*?^\s*# END luna-routing-contract\s*$/gm, '');
    if (withoutContract.split('\n').some((line) => uncomment(line).trim())) {
      throw new Error('France staging site must retain the reviewed non-delivery shape');
    }
  }
  let local = 0;
  const broad = [];
  for (let i = 0; i < rows.length; i += 1) {
    const code = uncomment(rows[i]);
    if (local === 0 && /^\s*reverse_proxy\s+\/whatsapp\/\*\s+[^\s{}]+\s*$/.test(code)) broad.push(i);
    local += (code.match(/{/g) || []).length - (code.match(/}/g) || []).length;
  }
  if (policy.broadRouteRequired && broad.length !== 1) throw new Error(`expected exactly one broad WhatsApp route in ${siteName} site`);
  if (!policy.broadRouteRequired && broad.length !== 0) throw new Error(`broad WhatsApp route is forbidden in ${siteName} site`);
  const index = policy.broadRouteRequired ? site.start + 1 + broad[0] : site.end;
  return { lines, site, index };
}
function block(indent = '', options = {}) {
  const { policy } = settings(options);
  const rows = [
    BEGIN,
    `handle ${PUBLIC} {`,
    '  rewrite * /v1/routes/meta-whatsapp-verified-webhook',
    '  reverse_proxy 127.0.0.1:8096',
    '}',
    `handle ${PROOF} {`,
    '  reverse_proxy 127.0.0.1:8094',
    '}',
  ];
  if (policy.activeRouteImport) rows.push(`import ${IMPORT}`);
  rows.push(END);
  return rows.map((row) => indent + row).join('\n');
}
function verify(text, options = {}) {
  const found = locate(text, options);
  const begins = [...String(text).matchAll(/^\s*# BEGIN luna-routing-contract\s*$/gm)];
  const ends = [...String(text).matchAll(/^\s*# END luna-routing-contract\s*$/gm)];
  if (begins.length !== 1 || ends.length !== 1) throw new Error('contract markers missing or duplicated');
  const expectedRows = block('', options).split('\n');
  const first = found.lines.findIndex((line) => /^\s*# BEGIN luna-routing-contract\s*$/.test(line));
  const indent = /^\s*/.exec(found.lines[first])[0];
  const actual = found.lines.slice(first, first + expectedRows.length).join('\n');
  if (actual !== block(indent, options)) throw new Error('routing contract is not canonical');
  if (first + expectedRows.length !== found.index) throw new Error('routing contract is not at its canonical site position');
  return true;
}
function transform(text, options = {}) {
  const resolved = settings(options);
  let source = String(text);
  const marker = /^\s*# BEGIN luna-routing-contract\s*$[\s\S]*?^\s*# END luna-routing-contract\s*\n?/gm;
  const matches = [...source.matchAll(marker)];
  if (matches.length) {
    if (matches.length !== 1) throw new Error('duplicate contract markers');
    const owner = locate(source, resolved);
    const markerLine = source.slice(0, matches[0].index).split('\n').length - 1;
    if (markerLine <= owner.site.start || markerLine >= owner.site.end) throw new Error('routing contract is owned by another site');
    if (!resolved.update) { verify(source, resolved); return source; }
    source = source.replace(marker, '');
  }
  if (new RegExp(PUBLIC.replaceAll('/', '\\/')).test(source)
    || new RegExp(PROOF.replaceAll('/', '\\/')).test(source)
    || source.includes(IMPORT)
    || /^\s*# (?:BEGIN|END) luna-routing-contract/m.test(source)) throw new Error('partial or misleading routing contract');
  const found = locate(source, { ...resolved, allowAbsent: resolved.site === FRANCE_STAGING_SITE });
  if (!found) {
    const separator = source.length === 0 || source.endsWith('\n\n') ? '' : source.endsWith('\n') ? '\n' : '\n\n';
    return `${source}${separator}${resolved.site} {\n${block('  ', resolved)}\n}\n`;
  }
  const indent = `${/^\s*/.exec(found.lines[found.site.start])[0]}  `;
  found.lines.splice(found.index, 0, ...block(indent, resolved).split('\n'));
  return found.lines.join('\n');
}

if (require.main === module) {
  const [mode, input, output, siteArg] = process.argv.slice(2);
  const site = siteArg || process.env.LUNA_ROUTING_SITE || LEGACY_SITE;
  const text = fs.readFileSync(input, 'utf8');
  if (mode === 'verify') verify(text, { site });
  else fs.writeFileSync(output, transform(text, { site, update: mode === 'update' }));
}

module.exports = { LEGACY_SITE, FRANCE_STAGING_SITE, SITE_POLICIES, transform, verify, block };
