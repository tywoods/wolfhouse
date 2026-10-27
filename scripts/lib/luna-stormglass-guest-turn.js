'use strict';

/**
 * Guest-turn Stormglass boundary. The model may phrase the answer, but it
 * cannot choose the location, invent a missing number, or authorize public
 * research when Stormglass already covers the asked facts.
 */

const { getStormglassForecastLocation } = require('./staff-stormglass-config');

function askedFields(message) {
  const q = String(message || '').toLowerCase();
  const fields = [];
  const add = (field, pattern) => {
    if (pattern.test(q) && !fields.includes(field)) fields.push(field);
  };
  add('wave_height_m', /\b(?:waves?|surf|olas|onde|wellen)\b/);
  add('swell_height_m', /\bswell\b/);
  add('wind_speed_mps', /\b(?:wind|viento)\b/);
  add('precipitation_mm_per_h', /\b(?:rain|raining|llueve|lluvia|precip)\b/);
  add('air_temperature_c', /\b(?:temp|temperature|temperatura)\b/);
  add('cloud_cover_pct', /\b(?:cloud|clouds|nubes)\b/);
  add('tide_height_m', /\b(?:tide|tides|marea)\b/);
  add('current_speed_mps', /\b(?:current|corriente)\b/);
  return fields;
}

function resolveBoundLocation(tenant, locationId) {
  const id = tenant === 'sunset' ? String(locationId || '').trim() : String(locationId || tenant || '').trim();
  const location = getStormglassForecastLocation(id);
  if (!location) return { error: 'UNSUPPORTED_LOCATION' };
  if (tenant === 'sunset' && location.client_slug !== 'sunset') return { error: 'UNSUPPORTED_LOCATION' };
  if (tenant === 'wolfhouse-somo' && location.location_id !== 'wolfhouse-somo') return { error: 'UNSUPPORTED_LOCATION' };
  return { location };
}

function publicResearchDecision({ coverage, missing, asked, intelligenceEnabled, outcome }) {
  if (outcome) {
    if (intelligenceEnabled !== true) return { calls: 0, fields: [], reason: 'intelligence_off' };
    return { calls: asked.length ? 1 : 0, fields: asked, reason: outcome };
  }
  const uncovered = (asked || []).filter((field) => (missing || []).includes(field));
  if (coverage === 'complete' || uncovered.length === 0) {
    return { calls: 0, fields: [], reason: 'stormglass_complete' };
  }
  if (intelligenceEnabled !== true) return { calls: 0, fields: [], reason: 'intelligence_off' };
  return { calls: 1, fields: uncovered, reason: 'missing_fields' };
}

/**
 * One ordinary guest turn: Stormglass tool first, then at most the uncovered
 * fields. Booking truth is copied through, never rewritten from the forecast.
 */
async function runStormglassGuestTurn(input) {
  const inp = input || {};
  const bound = resolveBoundLocation(inp.tenant, inp.locationId);
  const tools = ['get_surf_report'];
  const booking = inp.booking || null;
  const base = {
    needs_human: false,
    invented_forecast: false,
    booking_truth: booking,
    forecast: null,
  };
  if (bound.error) {
    return {
      ...base,
      trace: {
        tools,
        public_research_calls: 0,
        public_research_fields: [],
        coverage: 'unavailable',
        outcome: bound.error,
        location: null,
        provenance: null,
        fallback_reason: bound.error,
      },
    };
  }
  const asked = askedFields(inp.message);
  if (inp.forecastError) {
    const decision = publicResearchDecision({
      coverage: 'unavailable',
      missing: [],
      asked,
      intelligenceEnabled: inp.intelligenceEnabled,
      outcome: inp.forecastError.code || 'UPSTREAM_ERROR',
    });
    if (decision.calls) tools.push('search_public_info');
    return {
      ...base,
      trace: {
        tools,
        public_research_calls: decision.calls,
        public_research_fields: decision.fields,
        coverage: 'unavailable',
        outcome: inp.forecastError.code || 'UPSTREAM_ERROR',
        location: bound.location,
        provenance: { source: 'stormglass', retrieved_at: null, cache_hit: false },
        fallback_reason: decision.reason,
      },
    };
  }
  const forecast = inp.forecast || {};
  const decision = publicResearchDecision({
    coverage: forecast.coverage,
    missing: forecast.missing_fields || [],
    asked,
    intelligenceEnabled: inp.intelligenceEnabled,
    outcome: null,
  });
  if (decision.calls) tools.push('search_public_info');
  return {
    ...base,
    forecast,
    trace: {
      tools,
      public_research_calls: decision.calls,
      public_research_fields: decision.fields,
      coverage: forecast.coverage,
      outcome: forecast.coverage === 'complete' ? 'ok' : forecast.coverage,
      location: forecast.location || bound.location,
      provenance: {
        source: forecast.source || 'stormglass',
        retrieved_at: forecast.retrieved_at || null,
        cache_hit: forecast.cache_hit === true,
      },
      fallback_reason: decision.reason,
    },
  };
}

function forecastLocale(lang) {
  const code = String(lang || '').toLowerCase();
  if (code.startsWith('es')) return 'es';
  if (code.startsWith('it')) return 'it';
  if (code.startsWith('de')) return 'de';
  if (code.startsWith('fr')) return 'fr';
  return 'en';
}

function averageDayField(hourly, field) {
  const values = (hourly || []).map((row) => Number(row && row[field])).filter(Number.isFinite);
  if (!values.length) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function multiDayVerdict(waveHeight, windSpeed, locale) {
  const copy = {
    en: ['Good for beginners', 'Fun conditions', 'Solid surf', 'Windy / challenging'],
    es: ['Bien para principiantes', 'Condiciones divertidas', 'Surf sólido', 'Viento / condiciones exigentes'],
    it: ['Buona per principianti', 'Condizioni divertenti', 'Surf solido', 'Vento / condizioni impegnative'],
    de: ['Gut für Anfänger', 'Schöne Bedingungen', 'Kräftige Wellen', 'Windig / anspruchsvoll'],
    fr: ['Bien pour débuter', 'Bonnes conditions', 'Bon surf', 'Venteux / difficile'],
  }[locale];
  if (windSpeed != null && windSpeed >= 10) return copy[3];
  if (waveHeight == null) return copy[1];
  if (waveHeight < 0.8) return copy[0];
  if (waveHeight <= 1.8) return copy[1];
  return copy[2];
}

function multiDayForecastReply(forecast, locale) {
  const location = forecast && forecast.location;
  const days = forecast && Array.isArray(forecast.days) ? forecast.days.slice(0, 7) : [];
  if (!location || !days.length) return null;
  const copy = {
    en: { head: (count) => `${count}-day forecast for`, wave: 'Wave height', period: 'Period', wind: 'Wind', unavailable: 'not reported' },
    es: { head: (count) => `Previsión de ${count} días para`, wave: 'Olas', period: 'Período', wind: 'Viento', unavailable: 'sin datos' },
    it: { head: (count) => `Previsione di ${count} giorni per`, wave: 'Onde', period: 'Periodo', wind: 'Vento', unavailable: 'dati non disponibili' },
    de: { head: (count) => `${count}-Tage-Vorhersage für`, wave: 'Wellen', period: 'Periode', wind: 'Wind', unavailable: 'keine Daten' },
    fr: { head: (count) => `Prévisions sur ${count} jours pour`, wave: 'Vagues', period: 'Période', wind: 'Vent', unavailable: 'données indisponibles' },
  }[locale];
  const format = (value, unit) => (value == null ? copy.unavailable : `${Number(value.toFixed(1))} ${unit}`);
  const rows = days.map((day) => {
    const wave = averageDayField(day.hourly, 'wave_height_m');
    const period = averageDayField(day.hourly, 'swell_period_s');
    const wind = averageDayField(day.hourly, 'wind_speed_mps');
    const date = String(day.date || '').slice(0, 10) || copy.unavailable;
    return `${date}: ${copy.wave} ${format(wave, 'm')} · ${copy.period} ${format(period, 's')} · ${copy.wind} ${format(wind, 'm/s')} — ${multiDayVerdict(wave, wind, locale)}.`;
  });
  return `${copy.head(days.length)} ${location.label}:\n${rows.join('\n')}`;
}

function factualForecastReply(forecast, lang) {
  const location = forecast && forecast.location;
  const locale = forecastLocale(lang);
  const multiDay = multiDayForecastReply(forecast, locale);
  if (multiDay) return multiDay;
  const hour = forecast && Array.isArray(forecast.hourly) ? forecast.hourly[0] : null;
  if (!location || !hour) return null;
  const copy = {
    en: {
      head: 'Forecast for', empty: 'not enough reported data',
      waves: 'waves', rain: 'rain', wind: 'wind', air: 'air', cloud: 'cloud', tide: 'tide',
    },
    es: {
      head: 'Previsión de', empty: 'sin datos suficientes',
      waves: 'olas', rain: 'lluvia', wind: 'viento', air: 'aire', cloud: 'nubes', tide: 'marea',
    },
    it: {
      head: 'Previsione di', empty: 'senza dati sufficienti',
      waves: 'onde', rain: 'pioggia', wind: 'vento', air: 'aria', cloud: 'nuvole', tide: 'marea',
    },
    de: {
      head: 'Vorhersage für', empty: 'nicht genügend Daten',
      waves: 'Wellen', rain: 'Regen', wind: 'Wind', air: 'Luft', cloud: 'Wolken', tide: 'Gezeiten',
    },
    fr: {
      head: 'Prévisions pour', empty: 'données insuffisantes',
      waves: 'vagues', rain: 'pluie', wind: 'vent', air: 'air', cloud: 'nuages', tide: 'marée',
    },
  }[locale];
  const bits = [];
  const add = (value, key, unit) => {
    if (value == null || value === '') return;
    bits.push(`${copy[key]} ${value}${unit}`);
  };
  add(hour.wave_height_m, 'waves', ' m');
  add(hour.precipitation_mm_per_h, 'rain', ' mm/h');
  add(hour.wind_speed_mps, 'wind', ' m/s');
  add(hour.air_temperature_c, 'air', ' °C');
  add(hour.cloud_cover_pct, 'cloud', '%');
  add(hour.tide_height_m, 'tide', ' m');
  const head = `${copy.head} ${location.label}`;
  if (!bits.length) return `${head}: ${copy.empty}.`;
  return `${head}: ${bits.join(', ')}.`;
}

module.exports = {
  askedFields,
  resolveBoundLocation,
  publicResearchDecision,
  runStormglassGuestTurn,
  factualForecastReply,
};
