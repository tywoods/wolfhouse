'use strict';
const https = require('https');
https.get('https://raw.githubusercontent.com/api-evangelist/aerodatabox/main/openapi/aerodatabox-openapi.yml', (res) => {
  let raw = '';
  res.on('data', (c) => { raw += c; });
  res.on('end', () => {
    const idx = raw.indexOf('FlightContract:');
    console.log(raw.slice(idx, idx + 2000));
    const idx2 = raw.indexOf('ListingAirportContract:');
    console.log('\n--- airport ---\n', raw.slice(idx2, idx2 + 800));
    const idx3 = raw.indexOf('DateTimeContract:');
    console.log('\n--- datetime ---\n', raw.slice(idx3, idx3 + 500));
    const idx4 = raw.indexOf('ErrorContract:');
    console.log('\n--- error ---\n', raw.slice(idx4, idx4 + 600));
  });
}).on('error', console.error);
