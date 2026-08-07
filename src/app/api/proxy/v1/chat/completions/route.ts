import { NextResponse } from 'next/server';

const DISABLED_PROXY_RESPONSE = {
  error: 'OpenClaw model proxy is disabled',
  detail: 'Configure OpenClaw to call its model provider directly and export telemetry through OTLP.',
  otlpEndpoint: '/api/ingest/otel/v1/traces',
};

export async function POST(_request: Request) {
  return NextResponse.json(DISABLED_PROXY_RESPONSE, { status: 410 });
}
