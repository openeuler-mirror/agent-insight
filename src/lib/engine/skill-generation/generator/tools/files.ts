import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { createLogger } from "@/lib/logger";

const logger = createLogger("skill-generation:filesystem-tools");

export function createFilesystemTools(rootDir: string) {
  logger.debug("Creating filesystem tools", { rootDir });
  const skill_read_file = tool(
    async ({ path }: { path: string }) => {
      try {
        const fullPath = join(rootDir, path);
        logger.debug("Reading skill file", { rootDir, path, fullPath });
        const content = readFileSync(fullPath, "utf-8");
        logger.log("Read skill file success", { path, size: content.length });
        return content;
      } catch (error: any) {
        logger.error("Read skill file failed", { path, error: error.message });
        return `Error reading file: ${error.message}`;
      }
    },
    {
      name: "skill_read_file",
      description: "Read the content of a file from the workspace.",
      schema: z.object({
        path: z.string().describe("The path to the file relative to the workspace root."),
      }),
    }
  );

  const skill_write_file = tool(
    async ({ path, content }: { path: string; content: string }) => {
      try {
        const fullPath = join(rootDir, path);
        logger.debug("Writing skill file", { rootDir, path, fullPath, size: content.length });
        mkdirSync(dirname(fullPath), { recursive: true });
        writeFileSync(fullPath, content, "utf-8");
        logger.log("Write skill file success", { path, size: content.length });
        return `Successfully wrote to ${path}`;
      } catch (error: any) {
        logger.error("Write skill file failed", { path, error: error.message });
        return `Error writing file: ${error.message}`;
      }
    },
    {
      name: "skill_write_file",
      description: "Write content to a file in the workspace.",
      schema: z.object({
        path: z.string().describe("The path to the file relative to the workspace root."),
        content: z.string().describe("The content to write to the file."),
      }),
    }
  );

  return [skill_read_file, skill_write_file];
}
