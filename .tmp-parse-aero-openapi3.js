'use strict';
const https = require('https');
https.get('https://raw.githubusercontent.com/api-evangelist/aerodatabox/main/openapi/aerodatabox-openapi.yml', (res) => {
  let raw = '';
  res.on('data', (c) => { raw += c; });
  res.on('end', () => {
    for (const name of ['Flight', 'FlightDto', 'FlightStatus', 'FlightDeparture', 'FlightArrival']) {
      const idx = raw.indexOf(`${name}:`);
      if (idx >= 0) console.log(`found ${name} at ${idx}`);
    }
    const idx = raw.indexOf('dateLocalRole');
    console.log(raw.slice(idx - 200, idx + 800));
    const depIdx = raw.indexOf('departure:');
    console.log('\n--- departure schema ---\n', raw.slice(depIdx, depIdx + 1500));
    const respIdx = raw.indexOf('GetFlight_FlightOnSpecificDate');
    const resp200 = raw.indexOf('200:', respIdx);
    console.log('\n--- 200 response ---\n', raw.slice(resp200, resp200 + 800));
  });
}).on('error', console.error);
