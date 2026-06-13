'use strict';
const https = require('https');
https.get('https://raw.githubusercontent.com/api-evangelist/aerodatabox/main/openapi/aerodatabox-openapi.yml', (res) => {
  let raw = '';
  res.on('data', (c) => { raw += c; });
  res.on('end', () => {
    const idx = raw.indexOf('/flights/{searchBy}/{searchParam}/{dateLocal}:');
    console.log(raw.slice(idx, idx + 3500));
    const comp = raw.indexOf('components:');
    const flightSchema = raw.indexOf('FlightDto:', comp);
    console.log('\n--- FlightDto ---\n', raw.slice(flightSchema, flightSchema + 3500));
  });
}).on('error', console.error);
