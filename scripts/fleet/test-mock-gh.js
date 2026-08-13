#!/usr/bin/env node
'use strict';
/*
 * Test-only mock of the GitHub CLI for scripts/fleet/task.test.js.
 * Records every argv line to $GH_LOG and returns canned output driven by env:
 *   MOCK_ACTOR       -> login printed for 'gh api user'
 *   MOCK_ISSUE_JSON  -> JSON printed for 'gh issue view ... --json ...'
 *   MOCK_LIST_JSON   -> JSON printed for 'gh issue list ...'
 * Everything else exits 0 with no output (edit/comment/close/create succeed).
 */
const fs = require('fs');
const args = process.argv.slice(2);
if (process.env.GH_LOG) fs.appendFileSync(process.env.GH_LOG, args.join(' ') + '\n');
if (args[0] === 'api' && args.includes('user')) { process.stdout.write(process.env.MOCK_ACTOR || 'someuser'); process.exit(0); }
if (args[0] === 'issue' && args[1] === 'view') { process.stdout.write(process.env.MOCK_ISSUE_JSON || '{}'); process.exit(0); }
if (args[0] === 'issue' && args[1] === 'list') { process.stdout.write(process.env.MOCK_LIST_JSON || '[]'); process.exit(0); }
process.exit(0);
