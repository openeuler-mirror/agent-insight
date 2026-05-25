import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  basePath: process.env.NEXT_PUBLIC_URL_PREFIX || '',
  output: 'standalone',
  serverExternalPackages: ["node-fetch", "pg"],
  experimental: {
      serverActions: {
          allowedOrigins: ["*"] //
      }
  },
  async rewrites() {
    const urlPrefix = process.env.NEXT_PUBLIC_URL_PREFIX || '';

    // OTel ingestion at root (so OTel collectors can post to /v1/traces directly)
    const baseRewrites: { source: string; destination: string }[] = [
      { source: '/v1/traces',  destination: '/api/ingest/otel/v1/traces' },
      { source: '/v1/logs',    destination: '/api/ingest/otel/v1/logs' },
      { source: '/v1/metrics', destination: '/api/ingest/otel/v1/metrics' },
    ];

    // Backward-compat aliases: after the layered restructure, legacy flat
    // /api/* URLs continue to resolve to the new ingest/observe/eval/* paths.
    // External clients (uploaders, watchers, OpenCode plugins, OTel collectors)
    // and any cached frontend code may still hit the old paths.
    const legacyAliases: { source: string; destination: string }[] = [
      // ingest layer
      { source: '/api/otel/v1/:path*',         destination: '/api/ingest/otel/v1/:path*' },
      { source: '/api/proxy/:taskId/:path*',   destination: '/api/ingest/proxy/:taskId/:path*' },
      { source: '/api/proxy/:taskId',          destination: '/api/ingest/proxy/:taskId' },
      { source: '/api/upload',                 destination: '/api/ingest/upload' },
      { source: '/api/parse-document',         destination: '/api/ingest/parse-document' },
      { source: '/api/setup',                  destination: '/api/ingest/setup' },
      { source: '/api/setup/:path*',           destination: '/api/ingest/setup/:path*' },
      { source: '/api/sync/:path*',            destination: '/api/ingest/sync/:path*' },
      { source: '/api/v1/:path*',              destination: '/api/ingest/v1/:path*' },

      // observe layer
      { source: '/api/data',                   destination: '/api/observe/data' },
      { source: '/api/session',                destination: '/api/observe/session' },
      { source: '/api/executions/:path*',      destination: '/api/observe/executions/:path*' },
      { source: '/api/task-stats',             destination: '/api/observe/task-stats' },

      // eval layer
      { source: '/api/settings',               destination: '/api/eval/settings' },
      { source: '/api/settings/test',          destination: '/api/eval/settings/test' },
      { source: '/api/rejudge',                destination: '/api/eval/rejudge' },
      { source: '/api/evaluation',             destination: '/api/eval/evaluation' },
      { source: '/api/config',                 destination: '/api/eval/config' },
      { source: '/api/config/:path*',          destination: '/api/eval/config/:path*' },
    ];

    const rewrites = [...baseRewrites, ...legacyAliases];

    if (urlPrefix) {
      rewrites.push({
        source: `${urlPrefix}/api/:path*`,
        destination: '/api/:path*',
      });
    }

    return rewrites;
  },
};

export default nextConfig;
