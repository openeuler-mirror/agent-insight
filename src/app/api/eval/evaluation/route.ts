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


import fs from 'fs';
import { NextResponse } from 'next/server';
import path from 'path';
import { resolveAgentInsightDataPath } from '@/lib/env';

const DATA_DIR = resolveAgentInsightDataPath();
const EVALUATION_FILE = path.join(DATA_DIR, 'evaluation_result.json');

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

export async function POST(request: Request) {
  try {
    const data = await request.json();
    
    // Validate input (should be a Record<string, number | string>)
    if (typeof data !== 'object' || data === null) {
         return NextResponse.json({ error: 'Invalid payload format' }, { status: 400 });
    }

    ensureDataDir();

    let currentResults: Record<string, any> = {};
    if (fs.existsSync(EVALUATION_FILE)) {
        try {
            currentResults = JSON.parse(fs.readFileSync(EVALUATION_FILE, 'utf-8'));
        } catch {
            // If corrupt, overwrite
        }
    }

    // Merge: New data overrides old
    const newResults = { ...currentResults, ...data };

    fs.writeFileSync(EVALUATION_FILE, JSON.stringify(newResults, null, 2));

    return NextResponse.json({ 
        success: true, 
        message: 'Evaluation results updated',
        count: Object.keys(newResults).length
    }, { status: 200 });

  } catch (error) {
    console.error('Evaluation Upload Error:', error);
    return NextResponse.json({ error: 'Failed to update evaluation results' }, { status: 500 });
  }
}
