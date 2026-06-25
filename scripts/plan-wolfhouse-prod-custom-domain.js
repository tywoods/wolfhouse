'use strict';

/**
 * Wolfhouse prod Staff API custom domain — DRY-RUN planner.
 *
 * Prints the exact proposed az / dig / curl commands to bind the custom domain
 * wolfhouse.lunafrontdesk.com to wh-prod-staff-api. It is DRY-RUN ONLY:
 *   - executes NOTHING (no az, no dig, no curl),
 *   - changes no DNS, binds no domain, creates no certificate,
 *   - prints suggested commands as TEXT for a human to run after approval.
 *
 * There is no apply flag. Passing --apply is explicitly refused (not implemented).
 *
 * Names mirror docs/clients/wolfhouse/PROD-APP-DEPLOY-RECORD.md.
 */

const N = {
  app: 'wh-prod-staff-api',
  resourceGroup: 'wh-prod-rg',
  containerAppsEnv: 'wh-prod-env',
  targetHostname: 'wolfhouse.lunafrontdesk.com',
  generatedFqdn: 'wh-prod-staff-api.victoriousmushroom-8be40d6f.northeurope.azurecontainerapps.io',
  targetPort: '3036',
};

if (process.argv.slice(2).includes('--apply')) {
  console.error('--apply is NOT implemented. This is a dry-run planner only; it executes nothing.');
  console.error('DNS changes, domain binding, and certificate creation are manual, approval-gated steps.');
  process.exit(2);
}

function line(s) { console.log(s); }
function hr() { line('─'.repeat(72)); }

hr();
line('  Wolfhouse PROD Staff API — custom domain plan (DRY-RUN, nothing executed)');
hr();
line(`  app            : ${N.app}`);
line(`  resource group : ${N.resourceGroup}`);
line(`  target host    : ${N.targetHostname}`);
line(`  generated FQDN : ${N.generatedFqdn}`);
line(`  target port    : ${N.targetPort}`);
line('');
line('  DRY-RUN ONLY. No az/dig/curl is executed. No DNS change, no domain bind, no');
line('  certificate. Commands below are TEXT to review and run after explicit approval.');
hr();

line('\n0) PRE-FLIGHT — verify app health on the GENERATED FQDN before any DNS:');
line(`    curl -fsS -D - -o /dev/null "https://${N.generatedFqdn}/staff/ui"`);
line('    # expect HTTP/2 200 and  x-powered-by: wolfhouse-staff-api');

line('\n1) GET the Azure custom-domain verification ID (needed for the TXT record):');
line(`    az containerapp show --name ${N.app} --resource-group ${N.resourceGroup} \\`);
line('      --query "properties.customDomainVerificationId" -o tsv');
line(`    # (env-level alternative) az containerapp env show --name ${N.containerAppsEnv} \\`);
line(`    #   --resource-group ${N.resourceGroup} --query "properties.customDomainConfiguration.customDomainVerificationId" -o tsv`);

line('\n2) DNS RECORDS to create at the lunafrontdesk.com DNS provider (NOT done here):');
line(`    CNAME  ${N.targetHostname}        ->  ${N.generatedFqdn}`);
line(`    TXT    asuid.${N.targetHostname}  ->  <customDomainVerificationId from step 1>`);
line('    # asuid TXT proves domain ownership to Azure Container Apps. Use the exact');
line('    # value from step 1. (A managed cert needs the CNAME resolving first.)');

line('\n3) VERIFY DNS has propagated before binding:');
line(`    dig +short CNAME ${N.targetHostname}`);
line(`    #   expect: ${N.generatedFqdn}`);
line(`    dig +short TXT asuid.${N.targetHostname}`);
line('    #   expect: the customDomainVerificationId value');

line('\n4) BIND the hostname + provision a managed certificate (Container Apps):');
line(`    az containerapp hostname add --name ${N.app} --resource-group ${N.resourceGroup} \\`);
line(`      --hostname ${N.targetHostname}`);
line(`    az containerapp hostname bind --name ${N.app} --resource-group ${N.resourceGroup} \\`);
line(`      --hostname ${N.targetHostname} --environment ${N.containerAppsEnv} --validation-method CNAME`);
line('    # --validation-method CNAME lets Container Apps issue a free managed certificate.');

line('\n5) VERIFY the custom domain serves over HTTPS:');
line(`    curl -fsS -D - -o /dev/null "https://${N.targetHostname}/staff/ui"`);
line('    # expect HTTP/2 200 and  x-powered-by: wolfhouse-staff-api');

line('\nAPPROVAL GATES (must NOT proceed without explicit sign-off):');
line('    [ ] DNS record creation (CNAME + asuid TXT) — approval required');
line('    [ ] hostname bind + managed certificate — approval required');
line(`    [ ] This plan binds ONLY ${N.targetHostname} — NOT staff.lunafrontdesk.com`);

line('\nROLLBACK (if needed, after a real bind):');
line(`    az containerapp hostname delete --name ${N.app} --resource-group ${N.resourceGroup} \\`);
line(`      --hostname ${N.targetHostname}`);
line('    # then remove the CNAME + asuid TXT records at the DNS provider (or point back).');
line(`    # The app stays reachable on its generated FQDN (${N.generatedFqdn}).`);

line('\nOUT OF SCOPE for this plan:');
line('    - NO staff.lunafrontdesk.com binding.');
line('    - NO Meta / WhatsApp / Stripe changes.');
line('    - NO database migrations.');
line('    - NO Hermes/Luna app deploy.');

hr();
line('  DRY-RUN COMPLETE — no az/dig/curl executed; no DNS, domain, or cert changes.');
hr();
process.exit(0);
