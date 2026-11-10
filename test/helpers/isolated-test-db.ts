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

import path from "node:path"
import { createIsolatedDatabase } from "./isolated-database"

export function isolateTestDatabase(_tag: string): { dir: string; dbFile: string; databaseUrl: string } {
  const database = createIsolatedDatabase()
  const dbFile = path.join(database.home, "test.db")
  const databaseUrl = `file:${dbFile.replaceAll("\\", "/")}`
  process.env.DATABASE_URL = databaseUrl
  process.once("exit", database.dispose)
  return { dir: database.home, dbFile, databaseUrl }
}
