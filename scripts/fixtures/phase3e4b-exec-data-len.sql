SELECT "executionId", length(data::text) AS data_len
FROM execution_data
WHERE "executionId" IN (1078, 1079, 1080);
