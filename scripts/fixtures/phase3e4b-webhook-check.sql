SELECT w."webhookPath", w.method, we.id AS workflow_id, we.name, we.active
FROM webhook_entity w
JOIN workflow_entity we ON we.id = w."workflowId"
WHERE w."webhookPath" IN (
  'booking-assistant',
  'reassign-booking-beds',
  'assign-beds-to-booking',
  'cancel-booking-beds'
)
ORDER BY w."webhookPath";
