'use strict';

/**
 * Iris sample telemetry for the Crowsnest Spyglass preview.
 *
 * THIS IS SAMPLE / DEMO DATA ONLY — it exists so operators can see the shape of
 * the Spyglass dashboard before Pupil wires real sources. It is NOT live
 * telemetry. Every consumer must render it behind an explicit "sample data"
 * label so it can never be mistaken for real usage, cost, or billing numbers.
 *
 * No secrets, no guest/operator content, no real amounts. Numbers are invented
 * illustrative placeholders keyed to the static client list.
 */

const SAMPLE_WINDOW_LABEL = 'Last 7 days · sample';

// Per-client operational metrics (sample). Keyed by client id from
// crowsnest-clients.js. `live: false` marks clients not yet reporting.
function getSampleClientMetrics() {
  return {
    'wolfhouse-somo': {
      live: true,
      conversations: 128,
      messages_per_day: 342,
      needs_human: 5,
      last_active: '2m ago',
    },
    'sunset-somo': {
      live: true,
      conversations: 74,
      messages_per_day: 210,
      needs_human: 2,
      last_active: '11m ago',
    },
    'sunset-sardinero': {
      live: false,
      conversations: 0,
      messages_per_day: 0,
      needs_human: 0,
      last_active: '—',
    },
  };
}

// Aggregated AI usage (sample) for the full-width Spyglass panel.
function getSampleAiUsage() {
  return {
    sample: true,
    window_label: SAMPLE_WINDOW_LABEL,
    totals: {
      requests: 18432,
      input_tokens: 6120000,
      output_tokens: 2480000,
      total_tokens: 8600000,
      cost_usd: 41.72,
      avg_latency_ms: 640,
      success_rate: 0.987,
    },
    by_provider: [
      { provider: 'openai', requests: 15230, total_tokens: 6900000, cost_usd: 28.4, share: 0.68 },
      { provider: 'anthropic', requests: 3202, total_tokens: 1700000, cost_usd: 13.32, share: 0.32 },
    ],
    by_client: [
      { id: 'wolfhouse-somo', name: 'Wolfhouse Somo', requests: 11800, total_tokens: 5400000, cost_usd: 25.9 },
      { id: 'sunset-somo', name: 'Sunset Somo', requests: 6632, total_tokens: 3200000, cost_usd: 15.82 },
      { id: 'sunset-sardinero', name: 'Sunset Sardinero', requests: 0, total_tokens: 0, cost_usd: 0 },
    ],
    // 7-day request trend (sample) for the sparkline.
    daily_requests: [2100, 2450, 2380, 2720, 2610, 2890, 3282],
  };
}

module.exports = {
  SAMPLE_WINDOW_LABEL,
  getSampleClientMetrics,
  getSampleAiUsage,
};
