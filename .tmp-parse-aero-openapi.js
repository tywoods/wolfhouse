'use strict';
const fs = require('fs');
const https = require('https');
https.get('https://raw.githubusercontent.com/api-evangelist/aerodatabox/main/openapi/aerodatabox-openapi.yml', (res) => {
  let raw = '';
  res.on('data', (c) => { raw += c; });
  res.on('end', () => {
    console.log('servers block:\n', raw.match(/servers:[\s\S]{0,400}/)?.[0]);
    const paths = [...raw.matchAll(/\/flights\/[^\n"' ]+/g)].slice(0, 25).map((x) => x[0]);
    console.log('\npaths sample:', paths);
    const idx = raw.indexOf('/flights/{searchBy}/{searchParam}/{dateFromLocal}/{dateToLocal}');
    console.log('\nendpoint slice:\n', raw.slice(idx, idx + 2500));
    const schemaIdx = raw.indexOf('Flight:');
    console.log('\nFlight schema slice:\n', raw.slice(schemaIdx, schemaIdx + 2000));
  });
}).on('error', console.error);
