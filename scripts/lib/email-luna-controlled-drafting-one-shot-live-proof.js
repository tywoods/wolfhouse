'use strict';

/**
 * FULL SAIL Stage 2 CONTROLLED DRAFTING Chapter 4C — offline simulation harness.
 * Operator-controlled, default dry-run, refuses production/Wolfhouse.
 * This is not an operator live harness and cannot prove OAuth, Graph, or 098.
 * Fake / in-memory / stock-PG mode never emits live provider/DB evidence.
 * Live Azure mode is structurally absent until a later reviewed chapter owns
 * live operations. A compatibility wrapper may keep the old CLI name; output
 * still says simulation.
 *
 * @module email-luna-controlled-drafting-one-shot-live-proof
 */

const {
  ownData,
  isCanonUuid,
} = require('./email-luna-controlled-drafting-closed-data');
const {
  EMAIL_LUNA_CONTROLLED_DRAFTING_CAPABILITY_MANIFEST,
  EMAIL_MS_CONTROLLED_DRAFTING_SCOPE_PROFILE,
} = require('./email-luna-controlled-drafting-provider-contract');
const {
  REQUESTED_SCOPE,
  SCOPE_PROFILE_ID,
} = require('./email-luna-controlled-drafting-token-loan');

const uncurryThis = (fn) => Function.prototype.call.bind(fn);
const objectFreeze = Object.freeze;
const objectCreate = Object.create;
const stringTrim = uncurryThis(String.prototype.trim);
const stringToLowerCase = uncurryThis(String.prototype.toLowerCase);

const ERROR_CODE = 'EMAIL_LUNA_CONTROLLED_DRAFTING_ONE_SHOT_LIVE_PROOF_INVALID';
const ERROR_MESSAGE = 'Email Luna controlled drafting one-shot live proof failed.';
const SUNSET_DEPLOYMENT = 'sunset-staging';
const SUNSET_TENANT = 'sunset';
const SUNSET_LOCATION_KEY = 'sunset-somo';
const LIVE_DEPLOY_SHA_ALLOWLIST = objectFreeze([]);
const COMMANDS = objectFreeze([
  'preflight',
  'plan-activation',
  'prepare-authorization',
  'enable-runtime',
  'enable-composition',
  'enable-intake',
  'enable-tick',
  'enable-live-provider',
  'capture-evidence',
  'abort',
]);
const ACTIVATION_ORDER = objectFreeze([
  'prepare-authorization',
  'enable-runtime',
  'enable-composition',
  'enable-intake',
  'enable-tick',
  'enable-live-provider',
]);
const PRODUCTION_MARKERS = objectFreeze([
  'production', 'prod', 'luna_prod', 'wolfhouse_prod', 'sunset_prod', 'wolfhouse',
]);
const FLAG_ORDER = objectFreeze([
  'EMAIL_LUNA_CONTROLLED_DRAFTING_RUNTIME_ENABLED',
  'EMAIL_LUNA_CONTROLLED_DRAFTING_RUNTIME_COMPOSITION_ENABLED',
  'EMAIL_LUNA_CONTROLLED_DRAFTING_PRODUCER_INTAKE_ENABLED',
  'EMAIL_LUNA_CONTROLLED_DRAFTING_WORKER_TICK_ENABLED',
  'EMAIL_LUNA_CONTROLLED_DRAFTING_LIVE_PROVIDER_DRAFT_ENABLED',
]);
const RECIPIENT_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function failure() {
  const error = new Error(ERROR_MESSAGE);
  error.code = ERROR_CODE;
  objectFreeze(error);
  return error;
}

function output(pairs) {
  const obj = objectCreate(null);
  for (let i = 0; i < pairs.length; i += 1) {
    obj[pairs[i][0]] = pairs[i][1];
  }
  return objectFreeze(obj);
}

function parseArgs(argv) {
  const args = Array.isArray(argv) ? argv.slice() : [];
  const seen = objectCreate(null);
  const flags = objectCreate(null);
  flags.apply = false;
  flags.target = 'fake';
  flags.command = 'preflight';
  flags.authorizationId = null;
  flags.operationId = null;
  flags.issuanceId = null;
  flags.recipientAddress = null;
  flags.confirmRecipient = null;
  flags.deploySha = null;
  flags.invalid = false;
  flags.invalidReason = null;
  function markSeen(name) {
    if (seen[name] === true) {
      flags.invalid = true;
      flags.invalidReason = 'duplicate_arg';
      return false;
    }
    seen[name] = true;
    return true;
  }
  function takeValue(name, i) {
    const value = args[i + 1];
    if (typeof value !== 'string' || value.length < 1 || value.startsWith('--')) {
      flags.invalid = true;
      flags.invalidReason = 'missing_arg_value';
      return i;
    }
    if (!markSeen(name)) return i + 1;
    flags[name] = value;
    return i + 1;
  }
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--apply') {
      if (!markSeen('apply')) continue;
      flags.apply = true;
    } else if (arg === '--target') {
      i = takeValue('target', i);
    } else if (arg === '--authorization-id') {
      i = takeValue('authorizationId', i);
    } else if (arg === '--operation-id') {
      i = takeValue('operationId', i);
    } else if (arg === '--issuance-id') {
      i = takeValue('issuanceId', i);
    } else if (arg === '--recipient-address') {
      i = takeValue('recipientAddress', i);
    } else if (arg === '--confirm-recipient') {
      i = takeValue('confirmRecipient', i);
    } else if (arg === '--deploy-sha') {
      i = takeValue('deploySha', i);
    } else if (arg && !arg.startsWith('--') && COMMANDS.includes(arg)) {
      if (!markSeen('command')) continue;
      flags.command = arg;
    } else {
      flags.invalid = true;
      flags.invalidReason = 'unknown_or_hostile_arg';
    }
  }
  return objectFreeze({
    apply: flags.apply === true,
    target: flags.target,
    command: flags.command,
    authorizationId: flags.authorizationId,
    operationId: flags.operationId,
    issuanceId: flags.issuanceId,
    recipientAddress: flags.recipientAddress,
    confirmRecipient: flags.confirmRecipient,
    deploySha: flags.deploySha,
    invalid: flags.invalid === true,
    invalidReason: flags.invalidReason,
  });
}

function refusedProduction(env) {
  const deployment = ownData(env, 'LUNA_DEPLOYMENT');
  const tenant = ownData(env, 'DEFAULT_CLIENT_SLUG');
  if (typeof deployment === 'string' && PRODUCTION_MARKERS.includes(stringToLowerCase(deployment))) return true;
  if (typeof tenant === 'string' && PRODUCTION_MARKERS.includes(stringToLowerCase(tenant))) return true;
  return false;
}

function liveModeAllowed(sha) {
  if (typeof sha !== 'string' || sha.length !== 40 || !/^[0-9a-f]{40}$/.test(sha)) return false;
  return LIVE_DEPLOY_SHA_ALLOWLIST.includes(sha);
}

function normalizeRecipient(value) {
  if (typeof value !== 'string') return null;
  const next = stringToLowerCase(stringTrim(value));
  if (!RECIPIENT_RE.test(next)) return null;
  return next;
}

function capabilitySendAbsent() {
  const caps = EMAIL_LUNA_CONTROLLED_DRAFTING_CAPABILITY_MANIFEST.capabilities;
  return caps.send === false
    && caps.send_draft === false
    && caps.send_mail === false
    && EMAIL_MS_CONTROLLED_DRAFTING_SCOPE_PROFILE.graph_delegated.join(' ') === 'User.Read Mail.ReadWrite';
}

function createFakeHarnessState(seed) {
  const state = seed && typeof seed === 'object' ? seed : {};
  return {
    revision: ownData(state, 'revision') || 'de94c687801bdabc0aad4b8483326ed9f7b746c3',
    replica: ownData(state, 'replica') || 1,
    flags: Object.assign({
      EMAIL_LUNA_CONTROLLED_DRAFTING_RUNTIME_ENABLED: 'false',
      EMAIL_LUNA_CONTROLLED_DRAFTING_RUNTIME_COMPOSITION_ENABLED: 'false',
      EMAIL_LUNA_CONTROLLED_DRAFTING_PRODUCER_INTAKE_ENABLED: 'false',
      EMAIL_LUNA_CONTROLLED_DRAFTING_WORKER_TICK_ENABLED: 'false',
      EMAIL_LUNA_CONTROLLED_DRAFTING_LIVE_PROVIDER_DRAFT_ENABLED: 'false',
    }, ownData(state, 'flags') || {}),
    checksum097: ownData(state, 'checksum097') || 'canonical_lf_v1',
    checksum098: ownData(state, 'checksum098') || 'canonical_lf_v1',
    loginsReady: ownData(state, 'loginsReady') !== false,
    authorizationPresent: ownData(state, 'authorizationPresent') === true,
    authorizationId: ownData(state, 'authorizationId') || null,
    operationId: ownData(state, 'operationId') || null,
    issuanceId: ownData(state, 'issuanceId') || null,
    recipientAddress: ownData(state, 'recipientAddress') || null,
    serverSyntheticEvidence: false,
    ops097: Number(ownData(state, 'ops097') || 0),
    rows098: Number(ownData(state, 'rows098') || 0),
    journalUnchanged: ownData(state, 'journalUnchanged') !== false,
    wouldRequireProviderIsDraft: ownData(state, 'wouldRequireProviderIsDraft'),
    wouldConsume098: ownData(state, 'wouldConsume098') === true,
    wouldCallGraph: ownData(state, 'wouldCallGraph') === true,
    guestWithoutMarker: ownData(state, 'guestWithoutMarker') === true,
  };
}

function preflightFromState(state, parsed) {
  const blockers = [];
  if (state.replica !== 1) blockers.push('replica_not_1');
  if (state.checksum097 !== 'canonical_lf_v1') blockers.push('checksum_097');
  if (state.checksum098 !== 'canonical_lf_v1') blockers.push('checksum_098');
  if (state.loginsReady !== true) blockers.push('logins_not_ready');
  if (!capabilitySendAbsent()) blockers.push('send_capability_present');
  const flags = state.flags;
  for (let i = 0; i < FLAG_ORDER.length; i += 1) {
    if (flags[FLAG_ORDER[i]] === 'true' && i > 0 && flags[FLAG_ORDER[i - 1]] !== 'true') {
      blockers.push('flags_out_of_order');
      break;
    }
  }
  return output([
    ['ok', blockers.length === 0],
    ['command', 'preflight'],
    ['target', parsed.target],
    ['apply', false],
    ['revision', state.revision],
    ['replica', state.replica],
    ['checksum_097', state.checksum097],
    ['checksum_098', state.checksum098],
    ['logins_ready', state.loginsReady === true],
    ['configured_contract_only', capabilitySendAbsent()],
    ['token_returned', false],
    ['would_call_graph', false],
    ['live_evidence', false],
    ['simulation', true],
    ['authorization_present', state.authorizationPresent === true],
    ['ops_097', state.ops097],
    ['rows_098', state.rows098],
    ['server_synthetic_evidence', false],
    ['send_allowed', false],
    ['mail_send_in_scope_profile', false],
    ['scope_profile_id', SCOPE_PROFILE_ID],
    ['requested_scopes', REQUESTED_SCOPE],
    ['blockers', objectFreeze(blockers.slice())],
  ]);
}

function requireTypedIds(parsed) {
  if (!isCanonUuid(parsed.authorizationId)
      || !isCanonUuid(parsed.operationId)
      || !isCanonUuid(parsed.issuanceId)) {
    return 'missing_or_invalid_ids';
  }
  const expected = normalizeRecipient(parsed.recipientAddress);
  const confirm = normalizeRecipient(parsed.confirmRecipient);
  if (!expected || !confirm || expected !== confirm) return 'recipient_mismatch';
  return null;
}

function runOfflineSimulation(input) {
  const parsed = input && input.parsed ? input.parsed : parseArgs(input && input.argv);
  const env = (input && input.env) || {};
  if (parsed && parsed.invalid === true) {
    return output([
      ['ok', false],
      ['command', parsed.command],
      ['reason', parsed.invalidReason || 'unknown_or_hostile_arg'],
      ['apply', false],
      ['simulation', true],
      ['live_evidence', false],
    ]);
  }
  if (refusedProduction(env)) {
    return output([
      ['ok', false],
      ['command', parsed.command],
      ['reason', 'production_or_wolfhouse_refused'],
      ['apply', false],
      ['server_synthetic_evidence', false],
    ]);
  }
  if (parsed.target === 'live' || parsed.target === 'azure' || parsed.target === 'sunset-live') {
    if (!liveModeAllowed(parsed.deploySha)) {
      return output([
        ['ok', false],
        ['command', parsed.command],
        ['reason', 'live_mode_structurally_absent_until_reviewed_sha'],
        ['apply', false],
        ['allowlist_size', LIVE_DEPLOY_SHA_ALLOWLIST.length],
        ['server_synthetic_evidence', false],
      ]);
    }
  }
  if (parsed.target !== 'fake' && parsed.target !== 'stock-pg') {
    return output([
      ['ok', false],
      ['command', parsed.command],
      ['reason', 'target_not_fake_or_stock_pg'],
      ['apply', false],
      ['server_synthetic_evidence', false],
    ]);
  }

  const state = input && input.state ? input.state : createFakeHarnessState();
  if (parsed.command === 'preflight') {
    return preflightFromState(state, parsed);
  }
  if (parsed.command === 'plan-activation') {
    return output([
      ['ok', true],
      ['command', 'plan-activation'],
      ['apply', false],
      ['order', ACTIVATION_ORDER],
      ['human_apply_boundaries', ACTIVATION_ORDER.length],
      ['combined_irreversible', false],
      ['server_synthetic_evidence', false],
    ]);
  }

  if (parsed.command === 'enable-runtime'
      || parsed.command === 'enable-composition'
      || parsed.command === 'enable-intake'
      || parsed.command === 'enable-tick'
      || parsed.command === 'enable-live-provider'
      || parsed.command === 'prepare-authorization'
      || parsed.command === 'capture-evidence'
      || parsed.command === 'abort') {
    if (parsed.command !== 'abort' && parsed.command !== 'plan-activation') {
      const idErr = parsed.command === 'enable-runtime' || parsed.command === 'enable-composition'
        ? null
        : requireTypedIds(parsed);
      if (parsed.command === 'prepare-authorization' || parsed.command === 'enable-intake'
          || parsed.command === 'enable-tick' || parsed.command === 'enable-live-provider'
          || parsed.command === 'capture-evidence') {
        if (idErr) {
          return output([
            ['ok', false],
            ['command', parsed.command],
            ['reason', idErr],
            ['apply', false],
            ['server_synthetic_evidence', false],
          ]);
        }
      }
    }
    if (state.replica !== 1) {
      return output([
        ['ok', false], ['command', parsed.command], ['reason', 'replica_not_1'],
        ['apply', false], ['server_synthetic_evidence', false],
      ]);
    }
    if (state.revision && input && input.expectedRevision && state.revision !== input.expectedRevision) {
      return output([
        ['ok', false], ['command', parsed.command], ['reason', 'stale_revision'],
        ['apply', false], ['server_synthetic_evidence', false],
      ]);
    }
    if (parsed.command === 'prepare-authorization' && parsed.apply === true) {
      if (state.authorizationPresent !== true && state.guestWithoutMarker === true) {
        return output([
          ['ok', false], ['command', parsed.command], ['reason', 'guest_row_without_098_marker'],
          ['apply', false], ['server_synthetic_evidence', false],
        ]);
      }
    }
    if (parsed.command === 'enable-live-provider') {
      const flags = state.flags;
      if (flags.EMAIL_LUNA_CONTROLLED_DRAFTING_RUNTIME_ENABLED !== 'true'
          || flags.EMAIL_LUNA_CONTROLLED_DRAFTING_RUNTIME_COMPOSITION_ENABLED !== 'true'
          || flags.EMAIL_LUNA_CONTROLLED_DRAFTING_PRODUCER_INTAKE_ENABLED !== 'true'
          || flags.EMAIL_LUNA_CONTROLLED_DRAFTING_WORKER_TICK_ENABLED !== 'true') {
        return output([
          ['ok', false], ['command', parsed.command], ['reason', 'flags_out_of_order'],
          ['apply', false], ['server_synthetic_evidence', false],
        ]);
      }
      if (state.authorizationPresent !== true) {
        return output([
          ['ok', false], ['command', parsed.command], ['reason', 'missing_098'],
          ['apply', false], ['server_synthetic_evidence', false],
        ]);
      }
      if (!capabilitySendAbsent()) {
        return output([
          ['ok', false], ['command', parsed.command], ['reason', 'send_capability_present'],
          ['apply', false], ['server_synthetic_evidence', false],
        ]);
      }
    }
    if (parsed.command === 'capture-evidence') {
      if (state.journalUnchanged !== true) {
        return output([
          ['ok', false], ['command', parsed.command], ['reason', 'journal_changed'],
          ['apply', false], ['server_synthetic_evidence', false],
        ]);
      }
      if (state.wouldRequireProviderIsDraft === false) {
        return output([
          ['ok', false], ['command', parsed.command], ['reason', 'provider_is_draft_false'],
          ['apply', false], ['server_synthetic_evidence', false], ['simulation', true],
          ['live_evidence', false],
        ]);
      }
      if (state.wouldCallGraph === true) {
        return output([
          ['ok', false], ['command', parsed.command], ['reason', 'graph_send_called'],
          ['apply', false], ['server_synthetic_evidence', false], ['simulation', true],
          ['live_evidence', false],
        ]);
      }
    }
    if (parsed.apply !== true) {
      return output([
        ['ok', true],
        ['command', parsed.command],
        ['apply', false],
        ['dry_run', true],
        ['would_change', parsed.command],
        ['server_synthetic_evidence', false],
        ['send_allowed', false],
      ]);
    }
    if (parsed.command === 'abort') {
      state.flags.EMAIL_LUNA_CONTROLLED_DRAFTING_LIVE_PROVIDER_DRAFT_ENABLED = 'false';
      state.flags.EMAIL_LUNA_CONTROLLED_DRAFTING_PRODUCER_INTAKE_ENABLED = 'false';
      state.flags.EMAIL_LUNA_CONTROLLED_DRAFTING_WORKER_TICK_ENABLED = 'false';
      state.flags.EMAIL_LUNA_CONTROLLED_DRAFTING_RUNTIME_ENABLED = 'false';
      return output([
        ['ok', true],
        ['command', 'abort'],
        ['apply', true],
        ['order', objectFreeze(['live', 'intake_tick', 'runtime'])],
        ['evidence_preserved', true],
        ['server_synthetic_evidence', false],
        ['send_allowed', false],
        ['simulation', true],
        ['live_evidence', false],
      ]);
    }
    if (parsed.command === 'enable-live-provider') {
      state.flags.EMAIL_LUNA_CONTROLLED_DRAFTING_LIVE_PROVIDER_DRAFT_ENABLED = 'true';
      state.wouldRequireProviderIsDraft = true;
      state.wouldConsume098 = true;
      state.flags.EMAIL_LUNA_CONTROLLED_DRAFTING_LIVE_PROVIDER_DRAFT_ENABLED = 'false';
      state.flags.EMAIL_LUNA_CONTROLLED_DRAFTING_PRODUCER_INTAKE_ENABLED = 'false';
      state.flags.EMAIL_LUNA_CONTROLLED_DRAFTING_WORKER_TICK_ENABLED = 'false';
      return output([
        ['ok', true],
        ['command', 'enable-live-provider'],
        ['apply', true],
        ['simulated_transition', true],
        ['would_require_provider_is_draft', true],
        ['would_consume_098', true],
        ['journal_unchanged', true],
        ['would_call_graph', false],
        ['live_disabled_after', true],
        ['server_synthetic_evidence', false],
        ['send_allowed', false],
        ['token_returned', false],
        ['simulation', true],
        ['live_evidence', false],
      ]);
    }
    return output([
      ['ok', true],
      ['command', parsed.command],
      ['apply', true],
      ['server_synthetic_evidence', false],
      ['send_allowed', false],
    ]);
  }

  return output([
    ['ok', false],
    ['command', parsed.command],
    ['reason', 'unknown_command'],
    ['apply', false],
    ['server_synthetic_evidence', false],
  ]);
}

function runOneShotLiveProof(input) {
  return runOfflineSimulation(input);
}

module.exports = objectFreeze({
  ERROR_CODE,
  ERROR_MESSAGE,
  SUNSET_DEPLOYMENT,
  SUNSET_TENANT,
  LIVE_DEPLOY_SHA_ALLOWLIST,
  COMMANDS,
  ACTIVATION_ORDER,
  FLAG_ORDER,
  parseArgs,
  refusedProduction,
  liveModeAllowed,
  createFakeHarnessState,
  runOfflineSimulation,
  runOneShotLiveProof,
});
