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

function factualForecastReply(forecast, lang) {
  const location = forecast && forecast.location;
  const hour = forecast && Array.isArray(forecast.hourly) ? forecast.hourly[0] : null;
  if (!location || !hour) return null;
  const es = String(lang || '').toLowerCase().startsWith('es');
  const bits = [];
  const add = (value, en, esLabel, unit) => {
    if (value == null || value === '') return;
    bits.push(es ? `${esLabel} ${value}${unit}` : `${en} ${value}${unit}`);
  };
  add(hour.wave_height_m, 'waves', 'olas', ' m');
  add(hour.precipitation_mm_per_h, 'rain', 'lluvia', ' mm/h');
  add(hour.wind_speed_mps, 'wind', 'viento', ' m/s');
  add(hour.air_temperature_c, 'air', 'aire', ' °C');
  add(hour.cloud_cover_pct, 'cloud', 'nubes', '%');
  add(hour.tide_height_m, 'tide', 'marea', ' m');
  const head = es ? `Previsión de ${location.label}` : `Forecast for ${location.label}`;
  if (!bits.length) return `${head}: ${es ? 'sin datos suficientes' : 'not enough reported data'}.`;
  return `${head}: ${bits.join(', ')}.`;
}

module.exports = {
  askedFields,
  resolveBoundLocation,
  publicResearchDecision,
  runStormglassGuestTurn,
  factualForecastReply,
};
