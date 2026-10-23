'use strict';

const { buildStaffToolRequest } = require('./contracts');

function createStaffClient(runtime, options = {}) {
  const fetchImpl = options.fetchImpl || global.fetch;
  if (typeof fetchImpl !== 'function') throw new Error('fetch is unavailable');
  return Object.freeze({
    async call(name, input) {
      const request = buildStaffToolRequest(name, input, runtime);
      const response = await fetchImpl(request.url, {
        method: request.method,
        headers: request.headers,
        body: JSON.stringify(request.body),
        signal: AbortSignal.timeout(options.timeoutMs || 15000),
      });
      const body = await response.json().catch(() => null);
      if (!response.ok || !body || body.ok === false) {
        return {
          ok: false,
          status: response.status,
          code: body && body.code ? body.code : 'staff_tool_failed',
          error: body && body.error ? body.error : 'Staff tool failed',
          outcome_unknown: response.status >= 500,
        };
      }
      return body;
    },
  });
}

module.exports = { createStaffClient };
