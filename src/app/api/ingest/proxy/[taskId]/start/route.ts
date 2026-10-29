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


import { db } from '@/lib/storage/prisma';
import { startSession } from '@/lib/ingest/proxy-store';
import { NextResponse } from 'next/server';

export async function POST(
  request: Request,
  { params }: { params: Promise<{ taskId: string }> }
) {
  const taskId = (await params).taskId;
  let body: any = {};
  try {
      body = await request.json();
  } catch {
  }
  if (!body || typeof body !== 'object') body = {};
  
  const { searchParams } = new URL(request.url);
  let user = body.user || searchParams.get('user');

  const apiKey = request.headers.get('x-api-key') || body.apiKey;
  const model: string | undefined = body.model || searchParams.get('model') || undefined;

  if (apiKey) {
      try {
          const u = await db.findUserByApiKey(apiKey);
          if (u) {
              user = u.username;
          }
      } catch (e) {
          console.error('API Key Lookup Failed', e);
      }
  }
  const query = body.query || searchParams.get('query');

  let sanitizedQuery = query;
  if (sanitizedQuery && typeof sanitizedQuery === 'string') {
      sanitizedQuery = sanitizedQuery.trim().replace(/^['"]+|['"]+$/g, '').trim();
  }

  
  await startSession(taskId, body.label, sanitizedQuery, user, model);
  return NextResponse.json({ status: 'ok', task_id: taskId, label: body.label, query: sanitizedQuery, user, message: 'Session started' });
}
