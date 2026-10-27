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

import { config as dotenvConfig } from "dotenv";
dotenvConfig({ override: true });

function cleanEnvValue(value: string | undefined, defaultValue: string): string {
  if (!value) return defaultValue;
  return value.replace(/^["']|["']$/g, "").trim() || defaultValue;
}

const rawPublicKey = cleanEnvValue(process.env.LANGFUSE_PUBLIC_KEY, "");
const rawSecretKey = cleanEnvValue(process.env.LANGFUSE_SECRET_KEY, "");

export const config = {
  defaultModel: "claude-3-5-sonnet-20241022",
  maxIterations: 3,
  workspaceRoot: "./workspace/skills",
  evalRoot: "./workspace/evals",
  langfuse: {
    enabled: Boolean(rawPublicKey && rawSecretKey),
    publicKey: rawPublicKey,
    secretKey: rawSecretKey,
    baseUrl: cleanEnvValue(process.env.LANGFUSE_BASE_URL, "https://cloud.langfuse.com"),
  },
};
