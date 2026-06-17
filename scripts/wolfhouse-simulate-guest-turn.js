#!/usr/bin/env node
'use strict';

/**
 * Laptop/CI wrapper: docker exec hermes-luna simulate-guest-turn.
 *
 *   node scripts/wolfhouse-simulate-guest-turn.js --thread 490000009999 --text "Ciao" --json
 *   node scripts/wolfhouse-simulate-guest-turn.js --thread sim:golden-01 --text "Hi" --reset --json
 */

const { execSync } = require('child_process');
const { resetHermesGuestSession } = require('./lib/luna-hermes-guest-session-reset');

function parseArgs(argv) {
  const out = { thread: null, text: null, lang: null, json: false, allowWrites: false, reset: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--thread') out.thread = argv[++i];
    else if (a === '--text') out.text = argv[++i];
    else if (a === '--lang') out.lang = argv[++i];
    else if (a === '--json') out.json = true;
    else if (a === '--allow-writes') out.allowWrites = true;
    else if (a === '--reset') out.reset = true;
    else if (a === '--help' || a === '-h') out.help = true;
  }
  return out;
}

function usage() {
  console.log(`Usage: node scripts/wolfhouse-simulate-guest-turn.js --thread <id> --text "<message>" [options]

Options:
  --lang <code>       Language hint (it, de, es, en)
  --json              Print full JSON from Luna
  --allow-writes      Enable Staff API writes + Stripe TEST links (still no WhatsApp)
  --reset             Hard fresh-start the thread phone before the turn (via HTTP)

Environment:
  WOLFHOUSE_HERMES_DOCKER_CONTAINER   default: hermes-luna
`);
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.help || !args.thread || !args.text) {
    usage();
    process.exit(args.help ? 0 : 1);
  }

  if (args.reset) {
    const phone = args.thread.startsWith('sim:') ? null : args.thread;
    if (phone) {
      const reset = await resetHermesGuestSession(phone, { hard_delete: true });
      if (!reset.ok) {
        console.error('fresh-start failed:', reset.reason || 'unknown');
        process.exit(1);
      }
    }
  }

  const container = process.env.WOLFHOUSE_HERMES_DOCKER_CONTAINER || 'hermes-luna';
  const parts = [
    'docker', 'exec',
    '-e', 'PYTHONPATH=/etc/hermes-staging',
    container,
    'python3', '-m', 'wolfhouse.simulate_guest_turn',
    '--thread', args.thread,
    '--text', args.text,
  ];
  if (args.lang) parts.push('--lang', args.lang);
  if (args.allowWrites) parts.push('--allow-writes');
  if (args.json) parts.push('--json');

  try {
    const out = execSync(parts.map((p) => (/\s/.test(p) ? `"${p.replace(/"/g, '\\"')}"` : p)).join(' '), {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: true,
    });
    process.stdout.write(out);
  } catch (err) {
    const msg = (err.stdout || err.stderr || err.message || '').toString();
    process.stderr.write(msg);
    process.exit(err.status || 1);
  }
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
