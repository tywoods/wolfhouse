SELECT id, status, "workflowId", "startedAt", "stoppedAt"
FROM execution_entity
WHERE id > 1064
ORDER BY id ASC
LIMIT 10;
