'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { checkQuoteBookSchema } = require('./lib/model-led-luna/staff-request-contract');
const target = path.join(__dirname, '..', 'docker', 'hermes-luna-v3', 'contracts', 'check_quote_book.schema.json');
const rendered = `${JSON.stringify(checkQuoteBookSchema, null, 2)}\n`;
if (process.argv.includes('--check')) {
  if (!fs.existsSync(target) || fs.readFileSync(target, 'utf8') !== rendered) {
    console.error(`contract drift: regenerate ${path.relative(process.cwd(), target)}`); process.exit(1);
  }
  console.log('luna v3 Staff contract artifact: CURRENT');
} else { fs.writeFileSync(target, rendered); console.log(`generated ${target}`); }
