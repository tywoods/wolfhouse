'use strict';

const fs = require('fs');
const path = require('path');
const { buildWolfhouseFinanceCreatorFixtures } = require('./lib/wolfhouse-finance-creator-fixtures');

const outputDir = path.join(__dirname, '..', 'fixtures', 'wolfhouse-finance-creator-data');
const fixtures = buildWolfhouseFinanceCreatorFixtures();
for (const [name, fixture] of Object.entries(fixtures)) {
  fs.writeFileSync(path.join(outputDir, name), `${JSON.stringify(fixture, null, 2)}\n`, 'utf8');
}
console.log(`generated ${Object.keys(fixtures).length} Wolfhouse Finance creator fixtures`);
