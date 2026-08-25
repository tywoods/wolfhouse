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

function parseMigrationAllowlist(sql) {
  const text = String(sql || '');
  const begin = text.indexOf(ALLOWLIST_BEGIN);
  const end = text.indexOf(ALLOWLIST_END);
  if (begin < 0 || end < 0 || end <= begin) {
    throw new Error('096 missing pgcrypto 1.3 allowlist markers');
  }
  const block = text.slice(begin, end);
  const rows = [];
  const re = /\('([^']*)',\s*'([^']*)',\s*'([isv])',\s*(TRUE|FALSE),\s*(TRUE|FALSE)\)/g;
  let match = re.exec(block);
  while (match) {
    rows.push(freezeRow({
      proname: match[1],
      identityArgs: match[2],
      provolatile: match[3],
      proretset: match[4] === 'TRUE',
      proisstrict: match[5] === 'TRUE',
    }));
    match = re.exec(block);
  }
  return rows;
}

function assertMigrationAllowlistParity(sql) {
  const parsed = parseMigrationAllowlist(sql);
  if (parsed.length !== PGCRYPTO_1_3_FUNCTIONS.length) {
    throw new Error(
      `096 pgcrypto allowlist count ${parsed.length} != JS contract ${PGCRYPTO_1_3_FUNCTIONS.length}`,
    );
  }
  for (let i = 0; i < parsed.length; i += 1) {
    const got = parsed[i];
    const expected = PGCRYPTO_1_3_FUNCTIONS[i];
    if (
      got.proname !== expected.proname
      || got.identityArgs !== expected.identityArgs
      || got.provolatile !== expected.provolatile
      || got.proretset !== expected.proretset
      || got.proisstrict !== expected.proisstrict
    ) {
      throw new Error(
        `096 pgcrypto allowlist parity mismatch at ${i}: `
        + `${signatureOf(got.proname, got.identityArgs)} != ${signatureOf(expected.proname, expected.identityArgs)}`,
      );
    }
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
  parseMigrationAllowlist,
  assertMigrationAllowlistParity,
  provenPgcryptoResidualOidSql,
  publicExecuteResidualSignaturesSql,
  signatureOf,
};
