import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import matter from "gray-matter";
import { createLogger } from "@/lib/logger";

const logger = createLogger("skill-generation:structure-linter");

export async function runStructureLint(skillPath: string) {
  logger.log("Starting structure lint", { skillPath });
  const issues: Array<{ severity: 'error' | 'warning'; message: string; path?: string }> = [];
  
  // 1. Check SKILL.md existence
  const skillMdPath = join(skillPath, "SKILL.md");
  if (!existsSync(skillMdPath)) {
    logger.warn("SKILL.md is missing", { skillMdPath });
    issues.push({ severity: 'error', message: "SKILL.md is missing", path: "SKILL.md" });
    return { passed: false, issues };
  }

  // 2. Parse SKILL.md frontmatter
  try {
    const content = readFileSync(skillMdPath, "utf-8");
    const { data } = matter(content);

    if (!data.name) {
      issues.push({ severity: 'error', message: "Frontmatter 'name' is missing", path: "SKILL.md" });
    }
    if (!data.description) {
      issues.push({ severity: 'error', message: "Frontmatter 'description' is missing", path: "SKILL.md" });
    }

    // Line count check (recommended < 500)
    const lineCount = content.split("\n").length;
    if (lineCount > 500) {
      issues.push({ severity: 'warning', message: `SKILL.md is too long (${lineCount} lines), recommended < 500`, path: "SKILL.md" });
    }
  } catch (err) {
    logger.error("Failed to parse SKILL.md", {
      skillMdPath,
      error: (err as Error).message,
    });
    issues.push({ severity: 'error', message: `Failed to parse SKILL.md: ${(err as Error).message}`, path: "SKILL.md" });
  }

  // 3. Check recommended directories
  const directories = ["scripts", "references"];
  for (const dir of directories) {
    if (!existsSync(join(skillPath, dir))) {
      issues.push({ severity: 'warning', message: `Recommended directory '${dir}/' is missing`, path: dir });
    }
  }

  const result = {
    passed: issues.filter(i => i.severity === 'error').length === 0,
    issues,
  };
  logger.log("Completed structure lint", {
    skillPath,
    passed: result.passed,
    issueCount: issues.length,
  });
  return result;
}
