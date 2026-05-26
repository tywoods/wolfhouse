const fs = require('fs');
const path = require('path');

const dir = path.join(__dirname, '..', 'n8n');
const tableMap = {
  tblYWm3zKFafe4qu7: 'Bookings',
  tblO1ByvTMXS4SalB: 'Booking Beds',
  tblEkF4SG4TLaNmW4: 'Beds',
  tblrNdFnxdQvEnPuj: 'Rooms',
  tbllLFnkeriks575v: 'Conversations',
  tbl3oMbUtrUr0XWLt: 'Messages',
  tblWslWOfwbgoQGZy: 'Operator Room Release Request',
};

function walk(obj, out = new Set()) {
  if (!obj || typeof obj !== 'object') return out;
  if (Array.isArray(obj.columns)) {
    for (const c of obj.columns) {
      if (c?.fieldId) out.add(c.fieldId);
      if (c?.field) out.add(c.field);
      if (c?.value && typeof c.value === 'string' && !c.value.startsWith('fld')) out.add(c.value);
    }
  }
  if (obj.fields) {
    if (Array.isArray(obj.fields)) {
      for (const f of obj.fields) {
        if (typeof f === 'string') out.add(f);
        else if (f?.fieldId) out.add(f.fieldId);
        else if (f?.name) out.add(f.name);
      }
    } else if (typeof obj.fields === 'object') {
      Object.keys(obj.fields).forEach((k) => out.add(k));
    }
  }
  if (obj.filterByFormula) {
    const m = [...String(obj.filterByFormula).matchAll(/\{([^}]+)\}/g)];
    m.forEach((x) => out.add(x[1]));
  }
  for (const k of Object.keys(obj)) walk(obj[k], out);
  return out;
}

const report = {};
for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.json')).sort()) {
  const data = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
  const fieldsByTable = {};
  const codeNodes = [];
  const urls = new Set();
  const raw = fs.readFileSync(path.join(dir, f), 'utf8');
  for (const m of raw.matchAll(/https?:\/\/[^\s"\\]+/g)) {
    const u = m[0];
    if (
      u.includes('n8n') ||
      u.includes('webhook') ||
      u.includes('stripe') ||
      u.includes('facebook') ||
      u.includes('anthropic') ||
      u.includes('googleapis')
    ) {
      urls.add(u);
    }
  }
  for (const n of data.nodes || []) {
    const p = n.parameters || {};
    if (n.type.includes('code')) codeNodes.push({ name: n.name, chars: (p.jsCode || '').length });
    if (n.type.includes('airtable')) {
      const t = p.table?.value || 'unknown';
      const tn = tableMap[t] || t;
      const fields = [...walk(p)].filter((x) => x && x.length < 80 && !x.startsWith('fld'));
      if (!fieldsByTable[tn]) fieldsByTable[tn] = new Set();
      fields.forEach((x) => fieldsByTable[tn].add(x));
    }
  }
  report[data.name] = {
    file: f,
    fieldsByTable: Object.fromEntries(
      Object.entries(fieldsByTable).map(([k, v]) => [k, [...v].sort()])
    ),
    codeNodes,
    urls: [...urls].sort(),
  };
}
console.log(JSON.stringify(report, null, 2));
