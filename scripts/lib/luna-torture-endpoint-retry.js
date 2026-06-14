'use strict';

/**
 * Stage 27test-s — Optional HTTP 500 / network retry for hosted torture/batch proof runs.
 */

const HTTP_500_RETRY_BACKOFF_MS = [500, 1500];

function isRetryableHttpStatus(status) {
  return status === 500 || status === 502 || status === 503 || status === 504;
}

function isRetryableNetworkError(err) {
  if (!err) return false;
  const code = String(err.code || '');
  return code === 'ECONNRESET'
    || code === 'ETIMEDOUT'
    || code === 'ECONNREFUSED'
    || code === 'EPIPE'
    || code === 'UND_ERR_CONNECT_TIMEOUT';
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * @param {() => Promise<{ http_status: number, body?: object }>} fn
 * @param {number} retryCount - extra attempts after the first (e.g. 2 => up to 3 tries)
 */
async function executeWithHttp500Retry(fn, retryCount) {
  const maxRetries = Math.max(0, Number(retryCount) || 0);
  const maxAttempts = maxRetries + 1;
  let attempt = 0;
  let sawInitial500 = false;

  while (attempt < maxAttempts) {
    try {
      const result = await fn();
      const status = result && result.http_status;
      if (isRetryableHttpStatus(status)) {
        if (attempt === 0) sawInitial500 = true;
        if (attempt < maxAttempts - 1) {
          await sleep(HTTP_500_RETRY_BACKOFF_MS[attempt] || 1500);
          attempt += 1;
          continue;
        }
        return {
          ...result,
          retry_meta: {
            initial_http_500: sawInitial500,
            recovered: false,
            attempts: attempt + 1,
          },
        };
      }
      return {
        ...result,
        retry_meta: {
          initial_http_500: sawInitial500,
          recovered: sawInitial500 && status === 200,
          attempts: attempt + 1,
        },
      };
    } catch (err) {
      if (isRetryableNetworkError(err) && attempt < maxAttempts - 1) {
        if (attempt === 0) sawInitial500 = true;
        await sleep(HTTP_500_RETRY_BACKOFF_MS[attempt] || 1500);
        attempt += 1;
        continue;
      }
      throw err;
    }
  }

  throw new Error('executeWithHttp500Retry exhausted attempts');
}

function buildTortureCorrelationHeaders(opts, fixtureId, turnIndex) {
  const runId = opts && opts.resolvedRunId ? opts.resolvedRunId : 'local';
  const fix = fixtureId || 'unknown';
  const turn = turnIndex != null ? `:t${turnIndex + 1}` : '';
  return {
    'X-Luna-Run-Id': runId,
    'X-Luna-Fixture-Id': fix,
    'X-Luna-Correlation-Id': `${runId}:${fix}${turn}`,
  };
}

function enrichTorturePayload(payload, opts, fixtureId) {
  const out = payload || {};
  if (opts && opts.resolvedRunId) out.torture_run_id = opts.resolvedRunId;
  if (fixtureId) out.fixture_id = fixtureId;
  return out;
}

function trackHttp500RetryMeta(report, meta) {
  if (!report || !meta || !meta.initial_http_500) return;
  report.initial_http_500_count = (report.initial_http_500_count || 0) + 1;
  if (meta.recovered) {
    report.recovered_http_500_count = (report.recovered_http_500_count || 0) + 1;
  } else {
    report.unrecovered_http_500_count = (report.unrecovered_http_500_count || 0) + 1;
  }
}

module.exports = {
  HTTP_500_RETRY_BACKOFF_MS,
  isRetryableHttpStatus,
  isRetryableNetworkError,
  executeWithHttp500Retry,
  buildTortureCorrelationHeaders,
  enrichTorturePayload,
  trackHttp500RetryMeta,
};
