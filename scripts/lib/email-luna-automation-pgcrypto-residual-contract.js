'use strict';

/**
 * Frozen stock pgcrypto 1.3 computational residual for Ch4 Slice C1.
 *
 * Azure Database for PostgreSQL Flexible Server 15 (Sunset staging) ships
 * contrib pgcrypto 1.3 whose public-schema members are owned by an internal
 * role the queue owner cannot revoke. 096 may leave only this residual.
 *
 * Pin extversion 1.3: that is the stock contrib script
 * contrib/pgcrypto/pgcrypto--1.3.sql (36 functions). pgcrypto 1.4 adds
 * fips_mode() and is not this residual. Do not trust owner name, search_path,
 * env, or caller input. Membership is pg_depend deptype=e onto
 * pg_extension.extname=pgcrypto.
 *
 * gen_random_uuid honesty: public.gen_random_uuid() is a pgcrypto 1.3
 * LANGUAGE c wrapper and is exempt only as a catalog-proven extension member.
 * pg_catalog.gen_random_uuid() is core PG13+ LANGUAGE internal; ambient audit
 * excludes pg_catalog and must not treat core as pgcrypto. A public
 * gen_random_uuid() that is not an extension member is not exempt.
 *
 * Identity arguments are input-only pg_catalog.oidvectortypes(proargtypes).
 * OUT parameters (pgp_armor_headers) are omitted so PG15 Azure and PG18
 * stock compare equal. Do not match on pg_get_function_identity_arguments:
 * some engines include OUT names there.
 *
 * This residual is computational only: no database read/write authority.
 */

const objectFreeze = Object.freeze;

function freezeRow(row) {
  return objectFreeze({
    proname: row.proname,
    identityArgs: row.identityArgs,
    provolatile: row.provolatile,
    proretset: row.proretset === true,
    proisstrict: row.proisstrict === true,
  });
}

const PGCRYPTO_1_3_FUNCTIONS = objectFreeze([
  freezeRow({ proname: 'armor', identityArgs: 'bytea', provolatile: 'i', proretset: false, proisstrict: true }),
  freezeRow({ proname: 'armor', identityArgs: 'bytea, text[], text[]', provolatile: 'i', proretset: false, proisstrict: true }),
  freezeRow({ proname: 'crypt', identityArgs: 'text, text', provolatile: 'i', proretset: false, proisstrict: true }),
  freezeRow({ proname: 'dearmor', identityArgs: 'text', provolatile: 'i', proretset: false, proisstrict: true }),
  freezeRow({ proname: 'decrypt', identityArgs: 'bytea, bytea, text', provolatile: 'i', proretset: false, proisstrict: true }),
  freezeRow({ proname: 'decrypt_iv', identityArgs: 'bytea, bytea, bytea, text', provolatile: 'i', proretset: false, proisstrict: true }),
  freezeRow({ proname: 'digest', identityArgs: 'bytea, text', provolatile: 'i', proretset: false, proisstrict: true }),
  freezeRow({ proname: 'digest', identityArgs: 'text, text', provolatile: 'i', proretset: false, proisstrict: true }),
  freezeRow({ proname: 'encrypt', identityArgs: 'bytea, bytea, text', provolatile: 'i', proretset: false, proisstrict: true }),
  freezeRow({ proname: 'encrypt_iv', identityArgs: 'bytea, bytea, bytea, text', provolatile: 'i', proretset: false, proisstrict: true }),
  freezeRow({ proname: 'gen_random_bytes', identityArgs: 'integer', provolatile: 'v', proretset: false, proisstrict: true }),
  freezeRow({ proname: 'gen_random_uuid', identityArgs: '', provolatile: 'v', proretset: false, proisstrict: false }),
  freezeRow({ proname: 'gen_salt', identityArgs: 'text', provolatile: 'v', proretset: false, proisstrict: true }),
  freezeRow({ proname: 'gen_salt', identityArgs: 'text, integer', provolatile: 'v', proretset: false, proisstrict: true }),
  freezeRow({ proname: 'hmac', identityArgs: 'bytea, bytea, text', provolatile: 'i', proretset: false, proisstrict: true }),
  freezeRow({ proname: 'hmac', identityArgs: 'text, text, text', provolatile: 'i', proretset: false, proisstrict: true }),
  freezeRow({ proname: 'pgp_armor_headers', identityArgs: 'text', provolatile: 'i', proretset: true, proisstrict: true }),
  freezeRow({ proname: 'pgp_key_id', identityArgs: 'bytea', provolatile: 'i', proretset: false, proisstrict: true }),
  freezeRow({ proname: 'pgp_pub_decrypt', identityArgs: 'bytea, bytea', provolatile: 'i', proretset: false, proisstrict: true }),
  freezeRow({ proname: 'pgp_pub_decrypt', identityArgs: 'bytea, bytea, text', provolatile: 'i', proretset: false, proisstrict: true }),
  freezeRow({ proname: 'pgp_pub_decrypt', identityArgs: 'bytea, bytea, text, text', provolatile: 'i', proretset: false, proisstrict: true }),
  freezeRow({ proname: 'pgp_pub_decrypt_bytea', identityArgs: 'bytea, bytea', provolatile: 'i', proretset: false, proisstrict: true }),
  freezeRow({ proname: 'pgp_pub_decrypt_bytea', identityArgs: 'bytea, bytea, text', provolatile: 'i', proretset: false, proisstrict: true }),
  freezeRow({ proname: 'pgp_pub_decrypt_bytea', identityArgs: 'bytea, bytea, text, text', provolatile: 'i', proretset: false, proisstrict: true }),
  freezeRow({ proname: 'pgp_pub_encrypt', identityArgs: 'text, bytea', provolatile: 'v', proretset: false, proisstrict: true }),
  freezeRow({ proname: 'pgp_pub_encrypt', identityArgs: 'text, bytea, text', provolatile: 'v', proretset: false, proisstrict: true }),
  freezeRow({ proname: 'pgp_pub_encrypt_bytea', identityArgs: 'bytea, bytea', provolatile: 'v', proretset: false, proisstrict: true }),
  freezeRow({ proname: 'pgp_pub_encrypt_bytea', identityArgs: 'bytea, bytea, text', provolatile: 'v', proretset: false, proisstrict: true }),
  freezeRow({ proname: 'pgp_sym_decrypt', identityArgs: 'bytea, text', provolatile: 'i', proretset: false, proisstrict: true }),
  freezeRow({ proname: 'pgp_sym_decrypt', identityArgs: 'bytea, text, text', provolatile: 'i', proretset: false, proisstrict: true }),
  freezeRow({ proname: 'pgp_sym_decrypt_bytea', identityArgs: 'bytea, text', provolatile: 'i', proretset: false, proisstrict: true }),
  freezeRow({ proname: 'pgp_sym_decrypt_bytea', identityArgs: 'bytea, text, text', provolatile: 'i', proretset: false, proisstrict: true }),
  freezeRow({ proname: 'pgp_sym_encrypt', identityArgs: 'text, text', provolatile: 'v', proretset: false, proisstrict: true }),
  freezeRow({ proname: 'pgp_sym_encrypt', identityArgs: 'text, text, text', provolatile: 'v', proretset: false, proisstrict: true }),
  freezeRow({ proname: 'pgp_sym_encrypt_bytea', identityArgs: 'bytea, text', provolatile: 'v', proretset: false, proisstrict: true }),
  freezeRow({ proname: 'pgp_sym_encrypt_bytea', identityArgs: 'bytea, text, text', provolatile: 'v', proretset: false, proisstrict: true }),
]);

const PGCRYPTO_1_3_SIGNATURES = objectFreeze(
  PGCRYPTO_1_3_FUNCTIONS.map((row) => `${row.proname}(${row.identityArgs})`),
);

const ALLOWLIST_BEGIN = 'NIGHTWATCH_PGCRYPTO_1_3_ALLOWLIST_BEGIN';
const ALLOWLIST_END = 'NIGHTWATCH_PGCRYPTO_1_3_ALLOWLIST_END';
const PRIOR_096_CANONICAL_SHA256 = '06b32e0f46d04d6dba3cfbda3f4e61caaf44226147d44c8531dc1a1c9bded03c';

const PGCRYPTO_1_3_RESIDUAL = objectFreeze({
  id: 'email-luna-automation-pgcrypto-1.3-residual.v1',
  extension: 'pgcrypto',
  extversion: '1.3',
  extversionJustification:
    'Sunset Azure Flexible Server 15 ships contrib pgcrypto 1.3 (pgcrypto--1.3.sql, 36 computational functions). pgcrypto 1.4 adds fips_mode() and is not this residual.',
  functionCount: PGCRYPTO_1_3_FUNCTIONS.length,
  functions: PGCRYPTO_1_3_FUNCTIONS,
  signatures: PGCRYPTO_1_3_SIGNATURES,
  membership: 'pg_depend_deptype_e_pg_extension',
  routineKind: 'f',
  language: 'c',
  securityDefiner: false,
  dangerousConfig: false,
  notTrusted: objectFreeze(['owner_name', 'search_path', 'env', 'caller_input']),
  genRandomUuid: objectFreeze({
    publicPgcryptoMember: 'public.gen_random_uuid() exempt only as catalog-proven pgcrypto 1.3 LANGUAGE c member',
    corePgCatalog: 'pg_catalog.gen_random_uuid() is core PG13+ LANGUAGE internal and is outside this public-schema residual',
  }),
  capability: objectFreeze({
    computationalOnly: true,
    databaseRead: false,
    databaseWrite: false,
    tableDml: false,
    schemaCreate: false,
  }),
  prior096CanonicalSha256: PRIOR_096_CANONICAL_SHA256,
  prior096LedgerNote:
    '096 is merged but was never ledgered on Sunset (atomic rollback). Updating 096 in place changes the canonical hash. Do not store the prior hash as legacySha256: that would treat the old fail-all residual semantics as equivalent. Any database that applied and ledgered the prior bytes must fail reconcile rather than be accepted as this residual-exempt 096.',
});

function sqlLiteral(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function allowlistValuesSql() {
  return PGCRYPTO_1_3_FUNCTIONS.map((row) => (
    `(${sqlLiteral(row.proname)}, ${sqlLiteral(row.identityArgs)}, ${sqlLiteral(row.provolatile)}, ${row.proretset ? 'TRUE' : 'FALSE'}, ${row.proisstrict ? 'TRUE' : 'FALSE'})`
  )).join(',\n    ');
}

function signatureOf(proname, identityArgs) {
  return `${proname}(${identityArgs})`;
}

function countOccurrences(text, token) {
  if (!token) return 0;
  let count = 0;
  let from = 0;
  const haystack = String(text || '');
  while (from < haystack.length) {
    const index = haystack.indexOf(token, from);
    if (index < 0) break;
    count += 1;
    from = index + token.length;
  }
  return count;
}

function isWholeLineMarkerComment(line, marker) {
  const trimmed = String(line || '').trim();
  return trimmed === `-- ${marker}` || trimmed === `--${marker}`;
}

function normalizeLineEndings(sql) {
  return String(sql || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

/**
 * Whitespace-only normalization for allowlist VALUES comparison.
 * Line endings become LF; leading/trailing horizontal space per line is
 * trimmed; empty lines are dropped. Internal spaces, quotes, commas,
 * booleans, casts, and concatenation are preserved so valid extra SQL
 * cannot be omitted.
 */
function normalizeAllowlistSql(sql) {
  return normalizeLineEndings(sql)
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/g, '').replace(/^[ \t]+/g, ''))
    .filter((line) => line.length > 0)
    .join('\n');
}

function assertAllowlistBlockHasNoComments(block) {
  const lines = normalizeLineEndings(block).split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (trimmed.includes('--') || trimmed.includes('/*') || trimmed.includes('*/')) {
      throw new Error('096 pgcrypto allowlist VALUES block must not contain comments');
    }
  }
}

function extractMigrationAllowlistValuesSql(sql) {
  const text = normalizeLineEndings(sql);
  if (countOccurrences(text, ALLOWLIST_BEGIN) !== 1 || countOccurrences(text, ALLOWLIST_END) !== 1) {
    throw new Error('096 pgcrypto allowlist markers must appear exactly once each');
  }
  const lines = text.split('\n');
  const begins = [];
  const ends = [];
  for (let i = 0; i < lines.length; i += 1) {
    if (isWholeLineMarkerComment(lines[i], ALLOWLIST_BEGIN)) begins.push(i);
    if (isWholeLineMarkerComment(lines[i], ALLOWLIST_END)) ends.push(i);
  }
  if (begins.length !== 1 || ends.length !== 1) {
    throw new Error('096 pgcrypto allowlist markers must be unique whole-line comments');
  }
  if (ends[0] <= begins[0]) {
    throw new Error('096 pgcrypto allowlist markers out of order');
  }
  return lines.slice(begins[0] + 1, ends[0]).join('\n');
}

function assertMigrationAllowlistParity(sql) {
  const extracted = extractMigrationAllowlistValuesSql(sql);
  assertAllowlistBlockHasNoComments(extracted);
  const got = normalizeAllowlistSql(extracted);
  const expected = normalizeAllowlistSql(allowlistValuesSql());
  if (!got || got !== expected) {
    throw new Error(
      '096 pgcrypto allowlist VALUES block does not match canonical allowlistValuesSql()',
    );
  }
  return true;
}

function provenPgcryptoResidualOidSql() {
  return `
SELECT p.oid::text AS oid
  FROM pg_catalog.pg_proc p
  JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
  JOIN pg_catalog.pg_language l ON l.oid = p.prolang
  JOIN pg_catalog.pg_depend d
    ON d.objid = p.oid
   AND d.classid = 'pg_catalog.pg_proc'::pg_catalog.regclass
   AND d.refclassid = 'pg_catalog.pg_extension'::pg_catalog.regclass
   AND d.deptype = 'e'
  JOIN pg_catalog.pg_extension e ON e.oid = d.refobjid
  JOIN (VALUES
    ${allowlistValuesSql()}
  ) AS allowlist(proname, identity_args, provolatile, proretset, proisstrict)
    ON allowlist.proname = p.proname
   AND allowlist.identity_args = pg_catalog.oidvectortypes(p.proargtypes)
   AND allowlist.provolatile = p.provolatile
   AND allowlist.proretset IS NOT DISTINCT FROM p.proretset
   AND allowlist.proisstrict IS NOT DISTINCT FROM p.proisstrict
 WHERE n.nspname = 'public'
   AND e.extname = ${sqlLiteral(PGCRYPTO_1_3_RESIDUAL.extension)}
   AND e.extversion = ${sqlLiteral(PGCRYPTO_1_3_RESIDUAL.extversion)}
   AND p.prokind = 'f'
   AND p.prosecdef = false
   AND COALESCE(pg_catalog.cardinality(p.proconfig), 0) = 0
   AND l.lanname = 'c'
`;
}

function publicExecuteResidualSignaturesSql() {
  return `
SELECT p.proname || '(' || pg_catalog.oidvectortypes(p.proargtypes) || ')' AS signature
  FROM pg_catalog.pg_proc p
  JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
  JOIN LATERAL pg_catalog.aclexplode(
    COALESCE(p.proacl, pg_catalog.acldefault('f'::"char", p.proowner))
  ) a ON TRUE
 WHERE n.nspname = 'public'
   AND a.grantee = 0
   AND a.privilege_type = 'EXECUTE'
 ORDER BY 1
`;
}

module.exports = {
  PGCRYPTO_1_3_RESIDUAL,
  PGCRYPTO_1_3_FUNCTIONS,
  PGCRYPTO_1_3_SIGNATURES,
  ALLOWLIST_BEGIN,
  ALLOWLIST_END,
  PRIOR_096_CANONICAL_SHA256,
  allowlistValuesSql,
  extractMigrationAllowlistValuesSql,
  normalizeAllowlistSql,
  assertMigrationAllowlistParity,
  provenPgcryptoResidualOidSql,
  publicExecuteResidualSignaturesSql,
  signatureOf,
};
