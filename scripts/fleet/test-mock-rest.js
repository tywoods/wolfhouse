#!/usr/bin/env node
'use strict';
/*
 * Test-only mock of the GitHub REST API for scripts/fleet/task.test.js.
 * Invoked by task.js (REST backend) as: node <this> <METHOD> <apiPath> [<jsonBody>]
 * Records the call to $REST_LOG and returns canned JSON driven by env:
 *   MOCK_ACTOR       -> login for GET /user
 *   MOCK_ISSUE_JSON  -> {labels:[...]} for GET /repos/:r/issues/:n  (labels merged in)
 *   MOCK_COMMENTS_JSON -> [...] for GET .../comments
 *   MOCK_LIST_JSON   -> [...] for GET .../issues?...
 * Mutations (POST/PATCH/DELETE) just log and return {}.
 */
const fs = require('fs');
const [method, apiPath, body] = process.argv.slice(2);
if (process.env.REST_LOG) fs.appendFileSync(process.env.REST_LOG, method + ' ' + apiPath + '\n');
if (process.env.REST_BODY_LOG && body) fs.appendFileSync(process.env.REST_BODY_LOG, method + ' ' + apiPath + ' ' + body + '\n');
function out(o) { process.stdout.write(JSON.stringify(o)); process.exit(0); }
if (method === 'GET' && apiPath === '/user') out({ login: process.env.MOCK_ACTOR || 'someuser' });
if (method === 'GET' && /\/issues\/\d+$/.test(apiPath)) {
  const iss = JSON.parse(process.env.MOCK_ISSUE_JSON || '{}');
  out({ number: 5, title: 'mock', labels: iss.labels || [], assignees: [] });
}
if (method === 'GET' && /\/issues\/\d+\/comments$/.test(apiPath)) out(JSON.parse(process.env.MOCK_COMMENTS_JSON || '[]'));
if (method === 'GET' && /\/issues\?/.test(apiPath)) out(JSON.parse(process.env.MOCK_LIST_JSON || '[]'));
// POST create issue
if (method === 'POST' && /\/issues$/.test(apiPath)) out({ number: 99, html_url: 'https://github.com/test/repo/issues/99' });
// mutations: log-only
process.stdout.write('{}');
process.exit(0);
