ALTER TABLE benchmark_artifacts DROP CONSTRAINT benchmark_artifacts_size_bytes_check;

ALTER TABLE benchmark_artifacts ADD CONSTRAINT benchmark_artifacts_size_bytes_check CHECK (size_bytes BETWEEN 0 AND 67108864);
