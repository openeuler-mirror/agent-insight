/*
 * Copyright (c) 2026 Huawei Technologies Co., Ltd.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { NextResponse } from 'next/server';

const DISABLED_PROXY_RESPONSE = {
  error: 'OpenClaw model proxy is disabled',
  detail: 'Configure OpenClaw to call its model provider directly and export telemetry through OTLP.',
  otlpEndpoint: '/api/ingest/otel/v1/traces',
};

export async function POST(_request: Request) {
  return NextResponse.json(DISABLED_PROXY_RESPONSE, { status: 410 });
}
