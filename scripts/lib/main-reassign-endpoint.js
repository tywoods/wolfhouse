/**
 * Phase 3e.2 — Main local fork reassign webhook URL (worker-reachable, not hosted).
 */
const HOSTED_N8N_CLOUD = 'tywoods.app.n8n.cloud';
const HOSTED_REASSIGN_PATH = '/webhook/reassign-booking-beds';
const HOSTED_REASSIGN_URL = `https://${HOSTED_N8N_CLOUD}${HOSTED_REASSIGN_PATH}`;

/** Queue mode: workers resolve n8n-main (compose container_name) on the Docker network. */
const DEFAULT_REASSIGN_BOOKING_BEDS_URL = 'http://n8n-main:5678/webhook/reassign-booking-beds';

const REASSIGN_HTTP_URL_EXPR = `={{ String($env.N8N_REASSIGN_BOOKING_BEDS_URL || '${DEFAULT_REASSIGN_BOOKING_BEDS_URL}').trim() }}`;

const BOOKING_BEDS_WRITE_PATTERNS = [
  /\bINSERT\s+INTO\s+booking_beds\b/i,
  /\bUPDATE\s+booking_beds\b/i,
  /\bDELETE\s+FROM\s+booking_beds\b/i,
];

function listNodes(workflow) {
  return workflow?.nodes || [];
}

function scanHostedReassignUrls(workflow) {
  const hits = [];
  for (const node of listNodes(workflow)) {
    const blob = JSON.stringify(node.parameters || {});
    if (blob.includes(HOSTED_REASSIGN_URL) || blob.includes(HOSTED_N8N_CLOUD)) {
      if (blob.includes('reassign-booking-beds')) {
        hits.push(node.name);
      }
    }
  }
  return [...new Set(hits)];
}

function isWorkerReachableReassignUrl(url) {
  const s = String(url || '');
  if (s.includes('N8N_REASSIGN_BOOKING_BEDS_URL')) return true;
  if (/localhost|127\.0\.0\.1/i.test(s)) return false;
  return (
    s.includes('n8n-main:5678/webhook/reassign-booking-beds') ||
    s.includes('n8n:5678/webhook/reassign-booking-beds')
  );
}

function scanLocalReassignEndpoint(workflow) {
  const httpNodes = [];
  const badLocalhost = [];
  for (const node of listNodes(workflow)) {
    const name = node.name || '';
    const blob = JSON.stringify(node.parameters || {});
    const isReassign =
      name.includes('Call Reassign') ||
      (node.type === 'n8n-nodes-base.httpRequest' && blob.includes('reassign-booking-beds'));
    if (!isReassign) continue;
    if (node.type !== 'n8n-nodes-base.httpRequest') continue;
    const url = String(node.parameters?.url || '');
    httpNodes.push({ name, url });
    if (/localhost|127\.0\.0\.1/i.test(url) && !url.includes('N8N_REASSIGN_BOOKING_BEDS_URL')) {
      badLocalhost.push(name);
    }
  }
  const okCount = httpNodes.filter((n) => isWorkerReachableReassignUrl(n.url)).length;
  return {
    httpNodes,
    badLocalhost,
    ok: httpNodes.length >= 1 && okCount === httpNodes.length && badLocalhost.length === 0,
    expectedMinNodes: 2,
  };
}

function scanMainBookingBedsWrites(workflow) {
  const hits = [];
  for (const node of listNodes(workflow)) {
    const blob = JSON.stringify(node.parameters || {});
    for (const pattern of BOOKING_BEDS_WRITE_PATTERNS) {
      if (pattern.test(blob)) {
        hits.push({ node: node.name, pattern: pattern.source });
        break;
      }
    }
  }
  return hits;
}

/**
 * @param {object} workflow
 * @returns {{ patched: number, nodeNames: string[] }}
 */
function applyLocalReassignWebhookRemap(workflow) {
  const nodeNames = [];
  let patched = 0;
  for (const node of listNodes(workflow)) {
    const name = node.name || '';
    const blob = JSON.stringify(node.parameters || {});
    const isReassignHttp =
      node.type === 'n8n-nodes-base.httpRequest' &&
      (name.includes('Call Reassign') || blob.includes('reassign-booking-beds'));
    if (!isReassignHttp || !node.parameters) continue;
    const before = String(node.parameters.url || '');
    if (
      before.includes(HOSTED_N8N_CLOUD) ||
      before.includes(HOSTED_REASSIGN_PATH) ||
      name.includes('Call Reassign')
    ) {
      node.parameters.url = REASSIGN_HTTP_URL_EXPR;
      if (before !== REASSIGN_HTTP_URL_EXPR) patched++;
      nodeNames.push(name);
    }
  }
  return { patched, nodeNames: [...new Set(nodeNames)] };
}

function analyzeReassignContract(workflow) {
  const hostedNodes = scanHostedReassignUrls(workflow);
  const localScan = scanLocalReassignEndpoint(workflow);
  const bookingBedsWrites = scanMainBookingBedsWrites(workflow);
  return {
    hosted_url: HOSTED_REASSIGN_URL,
    local_default_url: DEFAULT_REASSIGN_BOOKING_BEDS_URL,
    hosted_nodes: hostedNodes,
    local_scan: localScan,
    booking_beds_write_hits: bookingBedsWrites,
    local_ok: hostedNodes.length === 0 && localScan.ok,
  };
}

module.exports = {
  HOSTED_N8N_CLOUD,
  HOSTED_REASSIGN_PATH,
  HOSTED_REASSIGN_URL,
  DEFAULT_REASSIGN_BOOKING_BEDS_URL,
  REASSIGN_HTTP_URL_EXPR,
  scanHostedReassignUrls,
  scanLocalReassignEndpoint,
  scanMainBookingBedsWrites,
  applyLocalReassignWebhookRemap,
  analyzeReassignContract,
  isWorkerReachableReassignUrl,
};
