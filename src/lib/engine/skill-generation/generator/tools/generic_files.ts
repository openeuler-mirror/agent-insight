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

import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { createLogger } from "@/lib/logger";

const logger = createLogger("skill-generation:generic-filesystem-tools");

export function createGenericFilesystemTools() {
  logger.debug("Creating generic filesystem tools");
  const skill_read_file = tool(
    async ({ path }: { path: string }) => {
      try {
        logger.debug("Reading file", { path });
        const content = readFileSync(path, "utf-8");
        logger.log("Read file success", { path, size: content.length });
        return content;
      } catch (error: any) {
        logger.error("Read file failed", { path, error: error.message });
        return `Error reading file: ${error.message}`;
      }
    },
    {
      name: "skill_read_file",
      description: "Read the content of a file.",
      schema: z.object({
        path: z.string().describe("The absolute path to the file."),
      }),
    }
  );

  const skill_write_file = tool(
    async ({ path, content }: { path: string; content: string }) => {
      try {
        logger.debug("Writing file", { path, size: content.length });
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, content, "utf-8");
        logger.log("Write file success", { path, size: content.length });
        return `Successfully wrote to ${path}`;
      } catch (error: any) {
        logger.error("Write file failed", { path, error: error.message });
        return `Error writing file: ${error.message}`;
      }
    },
    {
      name: "skill_write_file",
      description: "Write content to a file.",
      schema: z.object({
        path: z.string().describe("The absolute path to the file."),
        content: z.string().describe("The content to write to the file."),
      }),
    }
  );

  return [skill_read_file, skill_write_file];
}
