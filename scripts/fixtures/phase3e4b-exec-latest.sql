SELECT id, status, "workflowId", "startedAt"
FROM execution_entity
ORDER BY id DESC
LIMIT 15;

SELECT id, status, "workflowId", "startedAt"
FROM execution_entity
WHERE "workflowId" = 'RBfGNtVgrAkvhBHJ'
ORDER BY id DESC
LIMIT 5;

SELECT id, status, "workflowId"
FROM execution_entity
WHERE id > 1077
ORDER BY id;
