ALTER TABLE benchmark_artifacts
  DROP CONSTRAINT benchmark_artifacts_size_bounds,
  ADD CONSTRAINT benchmark_artifacts_size_bounds CHECK (size_bytes BETWEEN 0 AND 67108864);
