'use strict';
const https = require('https');
https.get('https://raw.githubusercontent.com/api-evangelist/aerodatabox/main/openapi/aerodatabox-openapi.yml', (res) => {
  let raw = '';
  res.on('data', (c) => { raw += c; });
  res.on('end', () => {
    const idx = raw.indexOf('FlightAirportMovementContract:');
    console.log(raw.slice(idx, idx + 2500));
    const idx2 = raw.indexOf('FlightAirlineContract:');
    console.log('\n--- airline ---\n', raw.slice(idx2, idx2 + 600));
    // find response schema reference for single date flight
    const op = raw.indexOf('operationId: GetFlight_FlightOnSpecificDate');
    const responses = raw.indexOf('responses:', op);
    console.log('\n--- responses ---\n', raw.slice(responses, responses + 1200));
  });
}).on('error', console.error);
