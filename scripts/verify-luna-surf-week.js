'use strict';

const assert = require('assert/strict');
const { factualForecastReply } = require('./lib/luna-stormglass-guest-turn');
const { buildGuestSurfReportReply, fetchGuestSurfReportData } = require('./lib/luna-guest-surf-report');

const days = Array.from({ length: 7 }, (_, index) => ({
  date: `2026-11-${String(index + 1).padStart(2, '0')}`,
  hourly: [{
    wave_height_m: 0.6 + (index * 0.1),
    swell_period_s: 7 + index,
    wind_speed_mps: 3 + index,
  }],
}));

const forecast = { location: { label: 'Somo' }, days };
const expectations = {
  en: ['7-day forecast for Somo', 'Wave height', 'Period', 'Wind', 'Good for beginners'],
  es: ['Previsión de 7 días para Somo', 'Olas', 'Período', 'Viento', 'Bien para principiantes'],
  it: ['Previsione di 7 giorni per Somo', 'Onde', 'Periodo', 'Vento', 'Buona per principianti'],
  de: ['7-Tage-Vorhersage für Somo', 'Wellen', 'Periode', 'Wind', 'Gut für Anfänger'],
  fr: ['Prévisions sur 7 jours pour Somo', 'Vagues', 'Période', 'Vent', 'Bien pour débuter'],
};

for (const [lang, required] of Object.entries(expectations)) {
  const reply = factualForecastReply(forecast, lang);
  assert.ok(reply, `${lang}: reply is present`);
  for (const text of required) assert.match(reply, new RegExp(text), `${lang}: includes ${text}`);
  assert.equal(reply.split('\n').filter((line) => /^2026-11-\d{2}:/.test(line)).length, 7, `${lang}: exposes every requested day`);
  assert.match(reply, /0\.6 m.*7 s.*3 m\/s/, `${lang}: includes first-day height, period, and wind`);
  assert.match(reply, /1\.2 m.*13 s.*9 m\/s/, `${lang}: includes seventh-day height, period, and wind`);
}

const guestReply = buildGuestSurfReportReply({
  client_slug: 'wolfhouse-somo',
  lang: 'fr',
  day: 'week',
  surf_data: { days, location: { label: 'Somo' }, source: 'stormglass' },
  preserve_booking_context: false,
});
assert.equal(guestReply.unavailable, false, 'structured seven-day provider data must not fall back');
assert.equal(guestReply.day, 'week');
assert.equal(guestReply.reply.split('\n').filter((line) => /^2026-11-\d{2}:/.test(line)).length, 7, 'guest data path preserves all seven raw days');

const oneDayLiveShape = {
  location: { label: 'Somo' },
  days: [days[0]],
  hourly: [{ wave_height_m: 0.6, wind_speed_mps: 3, air_temperature_c: 18 }],
};
const oneDayReply = factualForecastReply(oneDayLiveShape, 'en');
assert.match(oneDayReply, /^Forecast for Somo:/, 'one returned day retains the existing hourly sentence');
assert.doesNotMatch(oneDayReply, /1-day forecast/, 'one returned day must not use dated multi-day presentation');

fetchGuestSurfReportData({
  clientSlug: 'wolfhouse-somo',
  day: 'week',
  mock: { location: { label: 'Somo' }, days },
}).then((data) => {
  assert.equal(data.unavailable, false, 'weekly mock data is a valid forecast, not a fallback');
  assert.equal(data.days.length, 7, 'weekly fetch path retains all raw days');
  console.log('PASS verify-luna-surf-week (7 day raw forecast presentation)');
}).catch((err) => {
  console.error(err);
  process.exit(1);
});
