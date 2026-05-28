-- Phase 3e.4a read-only preflight (n8n DB)
SELECT w."webhookPath", w.method, we.name AS workflow_name, we.id AS workflow_id, we.active
FROM webhook_entity w
JOIN workflow_entity we ON we.id = w."workflowId"
WHERE w."webhookPath" IN (
  'booking-assistant',
  'reassign-booking-beds',
  'assign-beds-to-booking',
  'cancel-booking-beds'
)
ORDER BY w."webhookPath", we.active DESC, we.name;

SELECT we.id, we.name, we.active, MAX(e.id) AS latest_execution_id
FROM workflow_entity we
LEFT JOIN execution_entity e ON e."workflowId" = we.id
WHERE we.id IN (
  'RBfGNtVgrAkvhBHJ',
  'B3c3ReassignLocal01',
  'B3c2AssignLocalPg01',
  'KchhRC9b3MIdkzPT',
  'gxivKRJexzTCw9x6',
  'KZUQvwR6SPWpvaZ5',
  'esuDIT96iPT63OaQ',
  'whCreatePaymentStubLocal01'
)
GROUP BY we.id, we.name, we.active
ORDER BY we.name;

SELECT w."webhookPath", COUNT(*) AS mapping_count
FROM webhook_entity w
WHERE w."webhookPath" IN (
  'booking-assistant',
  'reassign-booking-beds',
  'assign-beds-to-booking',
  'cancel-booking-beds'
)
GROUP BY w."webhookPath"
HAVING COUNT(*) > 1;
