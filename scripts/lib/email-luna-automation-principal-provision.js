'use strict';

const {
  EMAIL_LUNA_AUTOMATION_PRINCIPAL_CONTRACT,
  ROLE_ATTRIBUTES,
  FORBIDDEN_DATABASE_NAMES,
  SUNSET_STAGING_TRUSTED_PRECREATED,
  FUNCTION_SIGNATURES,
  assertRoleName,
  assertUuid,
  assertLocationKey,
  assertKind,
  assertPassword,
  quoteIdent,
  quoteSqlIdent,
  createRoleSql,
  createRoleSqlPlan,
  executeFunctionsFor,
  deniedExecuteFunctionsFor,
} = require('./email-luna-automation-principal-contract');
const { provenPgcryptoResidualOidSql } = require('./email-luna-automation-pgcrypto-residual-contract');

const REDACTED = '***REDACTED***';
const TABLE_DENIED = EMAIL_LUNA_AUTOMATION_PRINCIPAL_CONTRACT.worker_table_denied;
const QUEUE_TABLE = 'tenant_email_luna_automation_queue';
const JOURNAL_TABLE = 'tenant_email_outbound_send_journal';
const PRINCIPAL_TABLE = 'tenant_email_luna_automation_principals';
const MATERIAL_TABLE = EMAIL_LUNA_AUTOMATION_PRINCIPAL_CONTRACT.issuance_material_table;
const INJECT_STEPS = Object.freeze(['create_role', 'grants', 'mapping', 'final_audit']);
const IDENTITY_SQL = 'SELECT current_database() AS database, session_user AS session_user';
const CREATE_ROLE_SQL_RE = /\bCREATE\s+ROLE\b/i;
const ALTER_ROLE_SQL_RE = /\bALTER\s+ROLE\b/i;
const PASSWORD_SQL_RE = /\bPASSWORD\b/i;

function fail(code, message, extra) {
  const error = new Error(message);
  error.code = code;
  if (extra) Object.assign(error, extra);
  return error;
}

function redactString(value, secrets) {
  let text = String(value);
  text = text.replace(/PASSWORD\s+'[^']*'/gi, `PASSWORD ${REDACTED}`);
  for (const secret of secrets || []) {
    if (secret) text = text.split(String(secret)).join(REDACTED);
  }
  return text;
}

function redact(value, secrets) {
  if (value == null) return value;
  if (typeof value === 'string') return redactString(value, secrets);
  if (Array.isArray(value)) return value.map((item) => redact(item, secrets));
  if (typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value)) {
      if (/password|secret|token/i.test(key)) {
        out[key] = REDACTED;
      } else {
        out[key] = redact(value[key], secrets);
      }
    }
    return out;
  }
  return value;
}

function redactError(err, secrets) {
  if (!err || typeof err !== 'object') return err;
  for (const key of ['message', 'detail', 'hint', 'query', 'where', 'schema', 'table']) {
    if (typeof err[key] === 'string') err[key] = redactString(err[key], secrets);
  }
  return err;
}

function requiredSpec(spec) {
  const src = spec && typeof spec === 'object' ? spec : {};
  const roleName = assertRoleName(src.roleName);
  const kind = assertKind(src.kind);
  const clientId = assertUuid(src.client_id, 'client_id');
  const locationId = assertUuid(src.location_id, 'location_id');
  const locationKey = assertLocationKey(src.location_key);
  const apply = src.apply === true;
  const trustedPrecreated = src.trustedPrecreated === true;
  const allowSunsetStagingTrustedPrecreated = src.allowSunsetStagingTrustedPrecreated === true;
  const injectFailAfter = src.injectFailAfter == null ? null : String(src.injectFailAfter);
  if (injectFailAfter && !INJECT_STEPS.includes(injectFailAfter)) {
    throw fail('EMAIL_LUNA_AUTOMATION_PRINCIPAL_INVALID', 'injectFailAfter is not a known test step');
  }
  if (allowSunsetStagingTrustedPrecreated) {
    if (trustedPrecreated !== true) {
      throw fail(
        'EMAIL_LUNA_AUTOMATION_PRINCIPAL_INVALID',
        'sunset staging trusted pre-creation requires trustedPrecreated',
      );
    }
    if (apply !== true) {
      throw fail(
        'EMAIL_LUNA_AUTOMATION_PRINCIPAL_INVALID',
        'sunset staging trusted pre-creation requires apply',
      );
    }
    if (src.password != null) {
      throw fail(
        'EMAIL_LUNA_AUTOMATION_PRINCIPAL_PASSWORD_REFUSED',
        'trusted pre-creation must not send a password through the provisioner',
      );
    }
    if (kind !== SUNSET_STAGING_TRUSTED_PRECREATED.kind) {
      throw fail(
        'EMAIL_LUNA_AUTOMATION_PRINCIPAL_INVALID',
        'sunset staging trusted pre-creation requires worker kind',
      );
    }
    if (locationKey !== SUNSET_STAGING_TRUSTED_PRECREATED.location_key) {
      throw fail(
        'EMAIL_LUNA_AUTOMATION_PRINCIPAL_INVALID',
        'sunset staging trusted pre-creation requires the approved Sunset location_key',
      );
    }
  }
  if (trustedPrecreated && src.password != null) {
    throw fail(
      'EMAIL_LUNA_AUTOMATION_PRINCIPAL_PASSWORD_REFUSED',
      'trusted pre-creation must not send a password through the provisioner',
    );
  }
  return {
    roleName,
    kind,
    clientId,
    locationId,
    locationKey,
    apply,
    trustedPrecreated,
    allowSunsetStagingTrustedPrecreated,
    injectFailAfter,
    password: src.password,
  };
}

function attributesMatch(row) {
  return ROLE_ATTRIBUTES.rolcanlogin === row.rolcanlogin
    && ROLE_ATTRIBUTES.rolsuper === row.rolsuper
    && ROLE_ATTRIBUTES.rolcreatedb === row.rolcreatedb
    && ROLE_ATTRIBUTES.rolcreaterole === row.rolcreaterole
    && ROLE_ATTRIBUTES.rolinherit === row.rolinherit
    && ROLE_ATTRIBUTES.rolreplication === row.rolreplication
    && ROLE_ATTRIBUTES.rolbypassrls === row.rolbypassrls;
}

function tablePrivilegeSql(roleIdent, table, privilege) {
  return `GRANT ${privilege} ON TABLE public.${table} TO ${roleIdent}`;
}

function assertExclusiveSession(session) {
  if (typeof session === 'function') {
    throw fail(
      'EMAIL_LUNA_AUTOMATION_PRINCIPAL_EXCLUSIVE_CLIENT_REQUIRED',
      'exclusive connect() is required; a query function may hop pool connections',
    );
  }
  if (!session || typeof session !== 'object' || typeof session.connect !== 'function') {
    throw fail(
      'EMAIL_LUNA_AUTOMATION_PRINCIPAL_EXCLUSIVE_CLIENT_REQUIRED',
      'exclusive connect() is required; a query function may hop pool connections',
    );
  }
}

async function readRows(query, sql, params) {
  const result = await query(sql, params || []);
  return result && Array.isArray(result.rows) ? result.rows : [];
}

function bindQuery(client) {
  if (!client || typeof client.query !== 'function') {
    throw fail(
      'EMAIL_LUNA_AUTOMATION_PRINCIPAL_EXCLUSIVE_CLIENT_REQUIRED',
      'connect() must return one exclusive client with query()',
    );
  }
  return async function query(sql, params) {
    if (arguments.length > 2) {
      throw fail(
        'EMAIL_LUNA_AUTOMATION_PRINCIPAL_PASSWORD_REFUSED',
        'query transport secret options are not a protective contract',
      );
    }
    return client.query(sql, params || []);
  };
}

async function resolveFunctionOids(query, signatures) {
  const oids = [];
  for (const signature of signatures) {
    const rows = await readRows(query, 'SELECT pg_catalog.to_regprocedure($1)::pg_catalog.oid::text AS oid', [`public.${signature}`]);
    const oid = rows[0] && rows[0].oid;
    if (!oid) {
      throw fail('EMAIL_LUNA_AUTOMATION_PRINCIPAL_MISSING_FUNCTION', `required function ${signature} is missing`);
    }
    oids.push(String(oid));
  }
  return oids;
}

async function resolvePresentFunctionSignatures(query, signatures) {
  const present = [];
  const oids = [];
  for (const signature of signatures) {
    const rows = await readRows(query, 'SELECT pg_catalog.to_regprocedure($1)::pg_catalog.oid::text AS oid', [`public.${signature}`]);
    const oid = rows[0] && rows[0].oid;
    if (oid) {
      present.push(signature);
      oids.push(String(oid));
    }
  }
  return { present, oids };
}

async function auditMemberships(query, roleName) {
  const rows = await readRows(query, `
    WITH RECURSIVE mem AS (
      SELECT m.roleid
        FROM pg_catalog.pg_auth_members m
        JOIN pg_catalog.pg_roles u ON u.oid = m.member
       WHERE u.rolname = $1
      UNION
      SELECT m.roleid
        FROM pg_catalog.pg_auth_members m
        JOIN mem ON mem.roleid = m.member
    )
    SELECT r.rolname AS member_of
      FROM mem
      JOIN pg_catalog.pg_roles r ON r.oid = mem.roleid
     ORDER BY 1
  `, [roleName]);
  if (rows.length) {
    throw fail('EMAIL_LUNA_AUTOMATION_PRINCIPAL_EXCESS_MEMBERSHIP', 'principal must have zero direct or transitive memberships', {
      excess: rows.map((row) => row.member_of),
    });
  }
}

function normalizeCatalogName(value) {
  return String(value || '').replace(/^pg_catalog\./, '');
}

function privilegeSet(rows) {
  return Array.from(new Set((rows || []).map((row) => String(row.privilege_type)))).sort();
}

function samePrivileges(actual, expected) {
  const left = Array.from(actual || []).map(String).sort();
  const right = Array.from(expected || []).map(String).sort();
  return left.length === right.length && left.every((name, index) => name === right[index]);
}

function describeShdepend(row) {
  return {
    catalog: normalizeCatalogName(row.catalog_name),
    dbid: row.dbid == null ? null : String(row.dbid),
    objid: row.objid == null ? null : String(row.objid),
    objsubid: row.objsubid == null ? 0 : Number(row.objsubid),
    database_name: row.database_name || null,
    schema_name: row.schema_name || null,
    relation_name: row.relation_name || null,
    relation_kind: row.relation_kind || null,
    function_oid: row.function_oid || null,
    function_name: row.function_name || null,
    privileges: row.privileges || [],
  };
}

async function auditOwnerDependencies(query, roleName) {
  const rows = await readRows(query, `
    SELECT
      d.dbid,
      d.classid::pg_catalog.regclass::text AS catalog_name,
      d.objid,
      d.objsubid
      FROM pg_catalog.pg_shdepend d
      JOIN pg_catalog.pg_roles r ON r.oid = d.refobjid
     WHERE r.rolname = $1
       AND d.refclassid = 'pg_catalog.pg_authid'::pg_catalog.regclass
       AND d.deptype = 'o'
     ORDER BY 2, 1, 3, 4
  `, [roleName]);
  if (rows.length) {
    throw fail(
      'EMAIL_LUNA_AUTOMATION_PRINCIPAL_OWNED_OBJECT',
      'principal must not own any cluster object (pg_shdepend owner dependencies)',
      { excess: rows },
    );
  }
}

async function explodeDirectPrivileges(query, roleName, row) {
  const catalog = normalizeCatalogName(row.catalog_name);
  const roleOidSql = `(SELECT oid FROM pg_catalog.pg_roles WHERE rolname = $1)`;
  if (catalog === 'pg_database') {
    return readRows(query, `
      SELECT a.privilege_type, a.is_grantable
        FROM pg_catalog.pg_database d
        JOIN LATERAL pg_catalog.aclexplode(d.datacl) a ON TRUE
       WHERE d.oid = $2::pg_catalog.oid
         AND a.grantee = ${roleOidSql}
       ORDER BY 1
    `, [roleName, String(row.objid)]);
  }
  if (catalog === 'pg_namespace') {
    return readRows(query, `
      SELECT a.privilege_type, a.is_grantable
        FROM pg_catalog.pg_namespace n
        JOIN LATERAL pg_catalog.aclexplode(n.nspacl) a ON TRUE
       WHERE n.oid = $2::pg_catalog.oid
         AND a.grantee = ${roleOidSql}
       ORDER BY 1
    `, [roleName, String(row.objid)]);
  }
  if (catalog === 'pg_class') {
    return readRows(query, `
      SELECT a.privilege_type, a.is_grantable
        FROM pg_catalog.pg_class c
        JOIN LATERAL pg_catalog.aclexplode(c.relacl) a ON TRUE
       WHERE c.oid = $2::pg_catalog.oid
         AND a.grantee = ${roleOidSql}
       ORDER BY 1
    `, [roleName, String(row.objid)]);
  }
  if (catalog === 'pg_proc') {
    return readRows(query, `
      SELECT a.privilege_type, a.is_grantable
        FROM pg_catalog.pg_proc p
        JOIN LATERAL pg_catalog.aclexplode(p.proacl) a ON TRUE
       WHERE p.oid = $2::pg_catalog.oid
         AND a.grantee = ${roleOidSql}
       ORDER BY 1
    `, [roleName, String(row.objid)]);
  }
  return null;
}

async function auditDirectAclDependencies(query, roleName, allowedFunctionOids, mode, kind) {
  const current = await readRows(query, `
    SELECT oid::text AS oid, datname
      FROM pg_catalog.pg_database
     WHERE datname = current_database()
  `);
  const currentDbOid = current[0] && String(current[0].oid);
  const currentDbName = current[0] && String(current[0].datname);
  if (!currentDbOid || !currentDbName) {
    throw fail('EMAIL_LUNA_AUTOMATION_PRINCIPAL_FORBIDDEN_DATABASE', 'current database identity is missing');
  }

  const rows = await readRows(query, `
    SELECT
      d.dbid,
      d.classid::pg_catalog.regclass::text AS catalog_name,
      d.objid,
      d.objsubid,
      db.datname AS database_name,
      n.nspname AS schema_name,
      c.relname AS relation_name,
      c.relkind AS relation_kind,
      p.oid::text AS function_oid,
      p.proname AS function_name
      FROM pg_catalog.pg_shdepend d
      JOIN pg_catalog.pg_roles r ON r.oid = d.refobjid
      LEFT JOIN pg_catalog.pg_database db
        ON db.oid = d.objid
       AND d.classid = 'pg_catalog.pg_database'::pg_catalog.regclass
      LEFT JOIN pg_catalog.pg_class c
        ON c.oid = d.objid
       AND d.classid = 'pg_catalog.pg_class'::pg_catalog.regclass
       AND d.dbid = $2::pg_catalog.oid
      LEFT JOIN pg_catalog.pg_proc p
        ON p.oid = d.objid
       AND d.classid = 'pg_catalog.pg_proc'::pg_catalog.regclass
       AND d.dbid = $2::pg_catalog.oid
      LEFT JOIN pg_catalog.pg_namespace n
        ON n.oid = CASE
          WHEN d.classid = 'pg_catalog.pg_namespace'::pg_catalog.regclass THEN d.objid
          WHEN d.classid = 'pg_catalog.pg_class'::pg_catalog.regclass THEN c.relnamespace
          WHEN d.classid = 'pg_catalog.pg_proc'::pg_catalog.regclass THEN p.pronamespace
          ELSE NULL
        END
     WHERE r.rolname = $1
       AND d.refclassid = 'pg_catalog.pg_authid'::pg_catalog.regclass
       AND d.deptype = 'a'
     ORDER BY 2, 1, 3, 4
  `, [roleName, currentDbOid]);

  if (mode === 'pregrant') {
    if (rows.length) {
      throw fail(
        'EMAIL_LUNA_AUTOMATION_PRINCIPAL_EXCESS_ACL',
        'trusted pre-creation requires zero direct ACL dependencies before mapping/grants',
        { excess: rows.map(describeShdepend) },
      );
    }
    return;
  }

  const allowed = new Set((allowedFunctionOids || []).map(String));
  const intended = {
    databaseConnect: false,
    schemaUsage: false,
    queueSelect: false,
    functions: new Set(),
  };

  for (const row of rows) {
    const catalog = normalizeCatalogName(row.catalog_name);
    const dbid = row.dbid == null ? '0' : String(row.dbid);
    const objid = String(row.objid);
    if (Number(row.objsubid) !== 0) {
      throw fail('EMAIL_LUNA_AUTOMATION_PRINCIPAL_EXCESS_ACL', 'principal retained a column-level ACL', {
        excess: [describeShdepend(row)],
      });
    }
    if (catalog === 'pg_database') {
      if (objid !== currentDbOid) {
        throw fail(
          'EMAIL_LUNA_AUTOMATION_PRINCIPAL_EXCESS_ACL',
          'principal retained a direct ACL grant on another database',
          { excess: [describeShdepend(row)] },
        );
      }
    } else if (dbid !== '0' && dbid !== currentDbOid) {
      throw fail(
        'EMAIL_LUNA_AUTOMATION_PRINCIPAL_EXCESS_ACL',
        'principal retained a direct ACL grant in another database',
        { excess: [describeShdepend(row)] },
      );
    }

    const exploded = await explodeDirectPrivileges(query, roleName, row);
    if (!exploded) {
      throw fail(
        'EMAIL_LUNA_AUTOMATION_PRINCIPAL_EXCESS_ACL',
        'principal retained a direct ACL on an unsupported object class',
        { excess: [describeShdepend(row)] },
      );
    }
    if (exploded.some((item) => item.is_grantable === true)) {
      throw fail('EMAIL_LUNA_AUTOMATION_PRINCIPAL_EXCESS_ACL', 'principal retained a grant option', {
        excess: [describeShdepend(row)],
      });
    }
    const privileges = privilegeSet(exploded);
    if (!privileges.length) {
      throw fail(
        'EMAIL_LUNA_AUTOMATION_PRINCIPAL_EXCESS_ACL',
        'pg_shdepend ACL row could not be resolved to the role ACL',
        { excess: [describeShdepend(row)] },
      );
    }

    let allowedObject = false;
    if (catalog === 'pg_database' && objid === currentDbOid) {
      if (!samePrivileges(privileges, ['CONNECT'])) {
        throw fail(
          'EMAIL_LUNA_AUTOMATION_PRINCIPAL_EXCESS_ACL',
          'principal retained a forbidden direct database privilege (direct TEMP is rejected even if PUBLIC has TEMP)',
          { excess: [{ ...describeShdepend(row), privileges }] },
        );
      }
      intended.databaseConnect = true;
      allowedObject = true;
    } else if (catalog === 'pg_namespace' && row.schema_name === 'public') {
      if (!samePrivileges(privileges, ['USAGE'])) {
        throw fail(
          'EMAIL_LUNA_AUTOMATION_PRINCIPAL_EXCESS_ACL',
          'principal retained a forbidden public schema privilege',
          { excess: [{ ...describeShdepend(row), privileges }] },
        );
      }
      intended.schemaUsage = true;
      allowedObject = true;
    } else if (
      catalog === 'pg_class'
      && row.schema_name === 'public'
      && row.relation_name === QUEUE_TABLE
      && row.relation_kind === 'r'
    ) {
      if (!samePrivileges(privileges, ['SELECT'])) {
        throw fail(
          'EMAIL_LUNA_AUTOMATION_PRINCIPAL_EXCESS_ACL',
          'principal retained a forbidden queue privilege',
          { excess: [{ ...describeShdepend(row), privileges }] },
        );
      }
      intended.queueSelect = true;
      allowedObject = true;
    } else if (catalog === 'pg_proc' && allowed.has(String(row.function_oid || objid))) {
      if (!samePrivileges(privileges, ['EXECUTE'])) {
        throw fail(
          'EMAIL_LUNA_AUTOMATION_PRINCIPAL_EXCESS_ACL',
          'principal retained a forbidden function privilege on an allowed OID',
          { excess: [{ ...describeShdepend(row), privileges }] },
        );
      }
      intended.functions.add(String(row.function_oid || objid));
      allowedObject = true;
    }

    if (!allowedObject) {
      throw fail(
        catalog === 'pg_proc'
          ? 'EMAIL_LUNA_AUTOMATION_PRINCIPAL_EXCESS_EXECUTE'
          : 'EMAIL_LUNA_AUTOMATION_PRINCIPAL_EXCESS_ACL',
        catalog === 'pg_proc'
          ? 'principal retained forbidden EXECUTE (including extra overloads)'
          : 'principal retained a forbidden direct ACL dependency',
        {
          excess: [{ ...describeShdepend(row), privileges }],
        },
      );
    }
  }

  if (!intended.databaseConnect) {
    throw fail('EMAIL_LUNA_AUTOMATION_PRINCIPAL_MISSING_CONNECT', 'principal must have database CONNECT');
  }
  if (!intended.schemaUsage) {
    throw fail('EMAIL_LUNA_AUTOMATION_PRINCIPAL_MISSING_USAGE', 'principal must have public schema USAGE');
  }
  if (kind === 'producer') {
    if (intended.queueSelect) {
      throw fail(
        'EMAIL_LUNA_AUTOMATION_PRINCIPAL_EXCESS_ACL',
        'producer must not have queue SELECT',
      );
    }
  } else if (!intended.queueSelect) {
    throw fail('EMAIL_LUNA_AUTOMATION_PRINCIPAL_MISSING_QUEUE_SELECT', 'principal must have queue SELECT');
  }
  for (const oid of allowed) {
    if (!intended.functions.has(String(oid))) {
      throw fail(
        'EMAIL_LUNA_AUTOMATION_PRINCIPAL_MISSING_EXECUTE',
        'principal is missing an exact allowed function EXECUTE grant',
      );
    }
  }
}

async function auditAmbientPublic(query, roleName, allowedFunctionOids) {
  const publicDb = await readRows(query, `
    SELECT a.privilege_type
      FROM pg_catalog.pg_database d
      JOIN LATERAL pg_catalog.aclexplode(
        COALESCE(d.datacl, pg_catalog.acldefault('d'::"char", d.datdba))
      ) a ON TRUE
     WHERE d.datname = current_database()
       AND a.grantee = 0
     ORDER BY 1
  `);
  const publicDbPrivs = privilegeSet(publicDb);
  const acceptedPublicDb = new Set(['CONNECT', 'TEMPORARY']);
  const excessDb = publicDbPrivs.filter((name) => !acceptedPublicDb.has(name));
  if (excessDb.length) {
    throw fail(
      'EMAIL_LUNA_AUTOMATION_PRINCIPAL_EXCESS_ACL',
      'PUBLIC current-database privileges must be CONNECT/TEMP only',
      { excess: excessDb },
    );
  }

  const schemas = await readRows(query, `
    SELECT n.oid::text AS oid, n.nspname
      FROM pg_catalog.pg_namespace n
     WHERE n.nspname <> 'pg_catalog'
       AND n.nspname NOT LIKE 'pg_toast%'
       AND n.nspname NOT LIKE 'pg_temp%'
       AND pg_catalog.has_schema_privilege($1, n.oid, 'USAGE')
     ORDER BY n.nspname
  `, [roleName]);
  if (!schemas.some((row) => row.nspname === 'public')) {
    throw fail('EMAIL_LUNA_AUTOMATION_PRINCIPAL_MISSING_USAGE', 'principal must have public schema USAGE');
  }
  for (const schema of schemas) {
    const createRows = await readRows(
      query,
      `SELECT pg_catalog.has_schema_privilege($1, $2::pg_catalog.oid, 'CREATE') AS ok`,
      [roleName, schema.oid],
    );
    if (createRows[0] && createRows[0].ok === true) {
      throw fail(
        'EMAIL_LUNA_AUTOMATION_PRINCIPAL_EXCESS_ACL',
        'principal must not have schema CREATE on any accessible schema',
        { excess: [schema.nspname] },
      );
    }
  }

  const allowed = new Set((allowedFunctionOids || []).map(String));
  const provenResidual = await readRows(query, provenPgcryptoResidualOidSql());
  const provenResidualOids = new Set(provenResidual.map((row) => String(row.oid)));
  const callable = await readRows(query, `
    SELECT p.oid::text AS oid,
           n.nspname AS schema_name,
           p.proname,
           pg_catalog.pg_get_function_identity_arguments(p.oid) AS args
      FROM pg_catalog.pg_proc p
      JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname NOT IN ('pg_catalog', 'information_schema')
       AND n.nspname NOT LIKE 'pg_toast%'
       AND n.nspname NOT LIKE 'pg_temp%'
       AND pg_catalog.has_schema_privilege($1, n.oid, 'USAGE')
       AND pg_catalog.has_function_privilege($1, p.oid, 'EXECUTE')
     ORDER BY n.nspname, p.proname, 4
  `, [roleName]);
  const excessExec = callable.filter((row) => (
    !allowed.has(String(row.oid)) && !provenResidualOids.has(String(row.oid))
  ));
  if (excessExec.length) {
    throw fail(
      'EMAIL_LUNA_AUTOMATION_PRINCIPAL_EXCESS_EXECUTE',
      'principal retained forbidden effective EXECUTE via ambient PUBLIC (direct ACL audit does not see PUBLIC)',
      { excess: excessExec.map((row) => `${row.schema_name}.${row.proname}(${row.args})`) },
    );
  }
}

async function auditPrincipal(query, parsed, database, allowedFunctionOids, mode) {
  await auditMemberships(query, parsed.roleName);
  await auditOwnerDependencies(query, parsed.roleName);
  await auditDirectAclDependencies(query, parsed.roleName, allowedFunctionOids, mode, parsed.kind);
  await auditAmbientPublic(query, parsed.roleName, allowedFunctionOids);
}

function planCreatesOrSetsPassword(plan) {
  const joined = (plan || []).join('\n');
  return CREATE_ROLE_SQL_RE.test(joined) || ALTER_ROLE_SQL_RE.test(joined) || PASSWORD_SQL_RE.test(joined);
}

async function provisionInTransaction(query, parsed) {
  const roleIdent = quoteIdent(parsed.roleName);
  const plan = [];
  const executed = [];

  const dbRows = await readRows(query, IDENTITY_SQL);
  const database = dbRows[0] && String(dbRows[0].database || '');
  const sessionUser = dbRows[0] && String(dbRows[0].session_user || '');
  if (parsed.allowSunsetStagingTrustedPrecreated) {
    if (database !== SUNSET_STAGING_TRUSTED_PRECREATED.database) {
      throw fail('EMAIL_LUNA_AUTOMATION_PRINCIPAL_FORBIDDEN_DATABASE', 'refusing live/staging product database');
    }
  } else if (!database || FORBIDDEN_DATABASE_NAMES.includes(database.toLowerCase())) {
    throw fail('EMAIL_LUNA_AUTOMATION_PRINCIPAL_FORBIDDEN_DATABASE', 'refusing live/staging product database');
  }
  const databaseIdent = quoteSqlIdent(database);

  const ownerRows = await readRows(query, `
    SELECT r.rolname AS table_owner
      FROM pg_catalog.pg_roles r
      JOIN pg_catalog.pg_class c ON c.relowner = r.oid
      JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public'
       AND c.relname = 'tenant_email_luna_automation_queue'
       AND c.relkind = 'r'
  `);
  const tableOwner = ownerRows[0] && ownerRows[0].table_owner;
  if (!tableOwner) {
    throw fail('EMAIL_LUNA_AUTOMATION_PRINCIPAL_MISSING_QUEUE', 'queue table owner missing');
  }
  if (parsed.allowSunsetStagingTrustedPrecreated) {
    if (!sessionUser || sessionUser !== tableOwner) {
      throw fail(
        'EMAIL_LUNA_AUTOMATION_PRINCIPAL_SESSION_NOT_OWNER',
        'sunset staging trusted pre-creation requires session_user to be the queue table owner',
      );
    }
  }
  if (parsed.roleName === tableOwner) {
    throw fail('EMAIL_LUNA_AUTOMATION_PRINCIPAL_REFUSE_OWNER', 'refusing to map the table owner as a runtime principal');
  }
  if (parsed.allowSunsetStagingTrustedPrecreated) {
    const bindRows = await readRows(query, `
      SELECT 1 AS ok
        FROM public.tenant_locations
        JOIN public.clients
          ON public.clients.id = public.tenant_locations.client_id
       WHERE public.tenant_locations.client_id = $1::uuid
         AND public.tenant_locations.id = $2::uuid
         AND public.tenant_locations.location_id = $3
         AND public.clients.slug = $4
    `, [
      parsed.clientId,
      parsed.locationId,
      SUNSET_STAGING_TRUSTED_PRECREATED.location_key,
      SUNSET_STAGING_TRUSTED_PRECREATED.client_slug,
    ]);
    if (bindRows.length !== 1) {
      throw fail(
        'EMAIL_LUNA_AUTOMATION_PRINCIPAL_INVALID',
        'sunset staging trusted pre-creation requires the approved Sunset client/location binding',
      );
    }
  }

  const materialTableRows = MATERIAL_TABLE ? await readRows(query, `
    SELECT 1 AS ok
      FROM pg_catalog.pg_class c
      JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public'
       AND c.relname = $1
       AND c.relkind = 'r'
  `, [MATERIAL_TABLE]) : [];
  const materialTablePresent = materialTableRows.length === 1;

  let allowedSignatures = [...executeFunctionsFor(parsed.kind)];
  let optionalGrantNames = [];
  let optionalDenyNames = [];
  if (parsed.kind === 'worker') {
    optionalGrantNames = [
      ...EMAIL_LUNA_AUTOMATION_PRINCIPAL_CONTRACT.issuance_material_worker_execute_functions,
      ...(EMAIL_LUNA_AUTOMATION_PRINCIPAL_CONTRACT.shadow_outcome_worker_execute_functions || []),
      ...(EMAIL_LUNA_AUTOMATION_PRINCIPAL_CONTRACT.scoped_claim_worker_execute_functions || []),
    ];
    optionalDenyNames = [
      ...EMAIL_LUNA_AUTOMATION_PRINCIPAL_CONTRACT.issuance_material_worker_denied_execute_functions,
    ];
    if (materialTablePresent) {
      const enqueueSig = FUNCTION_SIGNATURES.tenant_email_luna_automation_enqueue;
      allowedSignatures = allowedSignatures.filter((signature) => signature !== enqueueSig);
      optionalDenyNames.push(
        ...EMAIL_LUNA_AUTOMATION_PRINCIPAL_CONTRACT.issuance_material_worker_revoked_legacy_execute_functions,
      );
    }
  } else if (parsed.kind === 'producer') {
    optionalGrantNames = [];
    optionalDenyNames = [
      ...EMAIL_LUNA_AUTOMATION_PRINCIPAL_CONTRACT.issuance_material_producer_denied_execute_functions,
      ...(EMAIL_LUNA_AUTOMATION_PRINCIPAL_CONTRACT.shadow_outcome_producer_denied_execute_functions || []),
      ...(EMAIL_LUNA_AUTOMATION_PRINCIPAL_CONTRACT.scoped_claim_worker_execute_functions || []),
    ];
  } else {
    optionalGrantNames = [];
    optionalDenyNames = [
      ...EMAIL_LUNA_AUTOMATION_PRINCIPAL_CONTRACT.issuance_material_worker_execute_functions,
      ...EMAIL_LUNA_AUTOMATION_PRINCIPAL_CONTRACT.issuance_material_producer_execute_functions,
      ...(EMAIL_LUNA_AUTOMATION_PRINCIPAL_CONTRACT.shadow_outcome_worker_execute_functions || []),
      ...(EMAIL_LUNA_AUTOMATION_PRINCIPAL_CONTRACT.scoped_claim_worker_execute_functions || []),
    ];
  }
  const allowedFunctionOids = await resolveFunctionOids(query, allowedSignatures);
  const optionalGrantSignatures = (optionalGrantNames || []).map((name) => FUNCTION_SIGNATURES[name]).filter(Boolean);
  const optionalPresent = await resolvePresentFunctionSignatures(query, optionalGrantSignatures);
  for (const oid of optionalPresent.oids) allowedFunctionOids.push(oid);
  const grantSignatures = allowedSignatures.concat(optionalPresent.present);
  const optionalDenySignatures = (optionalDenyNames || []).map((name) => FUNCTION_SIGNATURES[name]).filter(Boolean);
  const optionalDenyPresent = await resolvePresentFunctionSignatures(query, optionalDenySignatures);

  const roleRows = await readRows(query, `
    SELECT rolname, rolcanlogin, rolsuper, rolcreatedb, rolcreaterole, rolinherit, rolreplication, rolbypassrls
      FROM pg_catalog.pg_roles
     WHERE rolname = $1
  `, [parsed.roleName]);

  const mappingRows = await readRows(query, `
    SELECT role_name::text AS role_name, principal_kind, client_id::text AS client_id,
           location_id::text AS location_id, location_key
      FROM public.tenant_email_luna_automation_principals
     WHERE role_name = $1
  `, [parsed.roleName]);

  let roleAction = 'verify_noop';
  let mappingAction = 'verify_noop';
  const mappingExact = mappingRows.length === 1
    && mappingRows[0].principal_kind === parsed.kind
    && mappingRows[0].client_id === parsed.clientId
    && mappingRows[0].location_id === parsed.locationId
    && mappingRows[0].location_key === parsed.locationKey;

  if (roleRows.length === 0) {
    if (parsed.trustedPrecreated) {
      throw fail('EMAIL_LUNA_AUTOMATION_PRINCIPAL_ROLE_MISSING', 'trusted pre-creation requires the role to already exist');
    }
    roleAction = 'create';
    mappingAction = 'insert';
    plan.push(createRoleSqlPlan(parsed.roleName));
  } else {
    if (!attributesMatch(roleRows[0])) {
      throw fail('EMAIL_LUNA_AUTOMATION_PRINCIPAL_INCONSISTENT_ROLE', 'existing role attributes are not the fail-closed LOGIN contract', {
        actual: redact(roleRows[0]),
      });
    }
    if (mappingRows.length === 0) {
      if (!parsed.trustedPrecreated) {
        throw fail(
          'EMAIL_LUNA_AUTOMATION_PRINCIPAL_ADOPTION_REFUSED',
          'refusing to adopt an arbitrary pre-existing unmapped role',
        );
      }
      roleAction = 'trusted_precreated';
      mappingAction = 'insert';
    } else if (!mappingExact) {
      throw fail('EMAIL_LUNA_AUTOMATION_PRINCIPAL_INCONSISTENT_MAPPING', 'existing mapping does not match requested principal');
    } else {
      roleAction = 'verify_noop';
      mappingAction = 'verify_noop';
    }
  }

  if (parsed.allowSunsetStagingTrustedPrecreated) {
    if (roleAction === 'create' || parsed.password != null) {
      throw fail(
        'EMAIL_LUNA_AUTOMATION_PRINCIPAL_ROLE_CREATE_REFUSED',
        'sunset staging trusted pre-creation must not create a role or set a password',
      );
    }
    if (roleAction !== 'trusted_precreated' && roleAction !== 'verify_noop') {
      throw fail(
        'EMAIL_LUNA_AUTOMATION_PRINCIPAL_ADOPTION_REFUSED',
        'sunset staging trusted pre-creation requires a trusted precreated or exact mapped role',
      );
    }
  }

  const grantSql = [];
  grantSql.push(`GRANT CONNECT ON DATABASE ${databaseIdent} TO ${roleIdent}`);
  grantSql.push(`REVOKE CREATE ON DATABASE ${databaseIdent} FROM ${roleIdent}`);
  grantSql.push(`GRANT USAGE ON SCHEMA public TO ${roleIdent}`);
  grantSql.push(`REVOKE CREATE ON SCHEMA public FROM ${roleIdent}`);
  if (parsed.kind !== 'producer') {
    grantSql.push(tablePrivilegeSql(roleIdent, QUEUE_TABLE, 'SELECT'));
  }
  for (const signature of grantSignatures) {
    grantSql.push(`GRANT EXECUTE ON FUNCTION public.${signature} TO ${roleIdent}`);
  }
  const revokeSql = [];
  for (const privilege of TABLE_DENIED) {
    revokeSql.push(`REVOKE ${privilege} ON TABLE public.${QUEUE_TABLE} FROM ${roleIdent}`);
    revokeSql.push(`REVOKE ${privilege} ON TABLE public.${JOURNAL_TABLE} FROM ${roleIdent}`);
    revokeSql.push(`REVOKE ${privilege} ON TABLE public.${PRINCIPAL_TABLE} FROM ${roleIdent}`);
    if (materialTablePresent) {
      revokeSql.push(`REVOKE ${privilege} ON TABLE public.${MATERIAL_TABLE} FROM ${roleIdent}`);
    }
  }
  revokeSql.push(`REVOKE SELECT ON TABLE public.${JOURNAL_TABLE} FROM ${roleIdent}`);
  revokeSql.push(`REVOKE SELECT ON TABLE public.${PRINCIPAL_TABLE} FROM ${roleIdent}`);
  revokeSql.push(`REVOKE ALL ON TABLE public.${PRINCIPAL_TABLE} FROM ${roleIdent}`);
  for (const signature of deniedExecuteFunctionsFor(parsed.kind)) {
    revokeSql.push(`REVOKE ALL ON FUNCTION public.${signature} FROM ${roleIdent}`);
  }
  for (const signature of optionalDenyPresent.present) {
    revokeSql.push(`REVOKE ALL ON FUNCTION public.${signature} FROM ${roleIdent}`);
  }

  plan.push(...grantSql, ...revokeSql);
  if (mappingAction === 'insert') {
    plan.push('INSERT mapping (role_name, principal_kind, client_id, location_id, location_key)');
  }

  if (parsed.allowSunsetStagingTrustedPrecreated && planCreatesOrSetsPassword(plan)) {
    throw fail(
      'EMAIL_LUNA_AUTOMATION_PRINCIPAL_ROLE_CREATE_REFUSED',
      'sunset staging trusted pre-creation must not create a role or set a password',
    );
  }

  if (!parsed.apply) {
    return {
      ok: true,
      apply: false,
      roleName: parsed.roleName,
      kind: parsed.kind,
      client_id: parsed.clientId,
      location_id: parsed.locationId,
      location_key: parsed.locationKey,
      roleAction,
      mappingAction,
      allowSunsetStagingTrustedPrecreated: parsed.allowSunsetStagingTrustedPrecreated === true,
      default_off: true,
      plan,
      executed,
      contract: EMAIL_LUNA_AUTOMATION_PRINCIPAL_CONTRACT.id,
      function_signatures: FUNCTION_SIGNATURES,
      password_transport: EMAIL_LUNA_AUTOMATION_PRINCIPAL_CONTRACT.password_transport,
      ambient_public_database_privileges: EMAIL_LUNA_AUTOMATION_PRINCIPAL_CONTRACT.ambient_public_database_privileges,
    };
  }

  if (parsed.allowSunsetStagingTrustedPrecreated && (roleAction === 'create' || parsed.password != null)) {
    throw fail(
      'EMAIL_LUNA_AUTOMATION_PRINCIPAL_ROLE_CREATE_REFUSED',
      'sunset staging trusted pre-creation must not create a role or set a password',
    );
  }

  if (roleAction === 'trusted_precreated') {
    await auditPrincipal(query, parsed, database, allowedFunctionOids, 'pregrant');
  }

  if (roleAction === 'create') {
    if (parsed.allowSunsetStagingTrustedPrecreated) {
      throw fail(
        'EMAIL_LUNA_AUTOMATION_PRINCIPAL_ROLE_CREATE_REFUSED',
        'sunset staging trusted pre-creation must not create a role or set a password',
      );
    }
    if (parsed.password == null) {
      throw fail('EMAIL_LUNA_AUTOMATION_PRINCIPAL_PASSWORD_REQUIRED', 'creating a LOGIN principal requires a password');
    }
    assertPassword(parsed.password);
    try {
      await query(createRoleSql(parsed.roleName, parsed.password), []);
    } catch (err) {
      const message = String(err && err.message ? err.message : err);
      if (/permission denied|must be superuser|CREATEROLE/i.test(message)) {
        throw fail('EMAIL_LUNA_AUTOMATION_PRINCIPAL_CREATEROLE_UNAVAILABLE', 'CREATE ROLE is unavailable; fail closed');
      }
      throw err;
    }
    executed.push(createRoleSqlPlan(parsed.roleName));
    if (parsed.injectFailAfter === 'create_role') {
      throw fail('EMAIL_LUNA_AUTOMATION_PRINCIPAL_INJECTED_FAILURE', 'injected failure after CREATE ROLE');
    }
  }

  for (const sql of grantSql.concat(revokeSql)) {
    await query(sql, []);
    executed.push(sql);
  }
  if (parsed.injectFailAfter === 'grants') {
    throw fail('EMAIL_LUNA_AUTOMATION_PRINCIPAL_INJECTED_FAILURE', 'injected failure after grants');
  }

  if (mappingAction === 'insert') {
    await query(`
      INSERT INTO public.tenant_email_luna_automation_principals
        (role_name, principal_kind, client_id, location_id, location_key)
      VALUES ($1, $2, $3::uuid, $4::uuid, $5)
    `, [parsed.roleName, parsed.kind, parsed.clientId, parsed.locationId, parsed.locationKey]);
    executed.push('INSERT mapping');
  }
  if (parsed.injectFailAfter === 'mapping') {
    throw fail('EMAIL_LUNA_AUTOMATION_PRINCIPAL_INJECTED_FAILURE', 'injected failure after mapping');
  }

  if (parsed.injectFailAfter === 'final_audit') {
    await query(`GRANT SELECT ON TABLE public.${JOURNAL_TABLE} TO ${roleIdent}`, []);
  }

  await auditPrincipal(query, parsed, database, allowedFunctionOids, 'postgrant');

  return {
    ok: true,
    apply: true,
    roleName: parsed.roleName,
    kind: parsed.kind,
    client_id: parsed.clientId,
    location_id: parsed.locationId,
    location_key: parsed.locationKey,
    roleAction,
    mappingAction,
    allowSunsetStagingTrustedPrecreated: parsed.allowSunsetStagingTrustedPrecreated === true,
    default_off: false,
    plan,
    executed,
    contract: EMAIL_LUNA_AUTOMATION_PRINCIPAL_CONTRACT.id,
    function_signatures: FUNCTION_SIGNATURES,
    password_transport: EMAIL_LUNA_AUTOMATION_PRINCIPAL_CONTRACT.password_transport,
    ambient_public_database_privileges: EMAIL_LUNA_AUTOMATION_PRINCIPAL_CONTRACT.ambient_public_database_privileges,
    ambient_callable_functions: EMAIL_LUNA_AUTOMATION_PRINCIPAL_CONTRACT.ambient_callable_functions,
    ambient_pgcrypto_residual: EMAIL_LUNA_AUTOMATION_PRINCIPAL_CONTRACT.ambient_pgcrypto_residual,
    worker_pgcrypto_residual_capability: EMAIL_LUNA_AUTOMATION_PRINCIPAL_CONTRACT.worker_pgcrypto_residual_capability,
  };
}

async function provisionEmailLunaAutomationPrincipal(session, spec) {
  assertExclusiveSession(session);
  const parsed = requiredSpec(spec);
  const secrets = parsed.password == null ? [] : [String(parsed.password)];
  const client = await session.connect();
  const query = bindQuery(client);
  let begun = false;
  try {
    await query('BEGIN');
    begun = true;
    const result = await provisionInTransaction(query, parsed);
    if (parsed.apply) {
      await query('COMMIT');
      begun = false;
    } else {
      await query('ROLLBACK');
      begun = false;
    }
    return redact(result, secrets);
  } catch (err) {
    if (begun) {
      try { await query('ROLLBACK'); } catch (_) { /* best-effort */ }
    }
    throw redactError(err, secrets);
  } finally {
    if (client && typeof client.release === 'function') {
      try { await client.release(); } catch (_) { /* best-effort */ }
    }
  }
}

module.exports = {
  provisionEmailLunaAutomationPrincipal,
  redact,
  REDACTED,
  IDENTITY_SQL,
};
