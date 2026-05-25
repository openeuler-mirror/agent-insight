import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export function ensureWorkspace(skillPath: string) {
  mkdirSync(skillPath, { recursive: true });
  mkdirSync(join(skillPath, "scripts"), { recursive: true });
  mkdirSync(join(skillPath, "references"), { recursive: true });
  mkdirSync(join(skillPath, "evals"), { recursive: true });
}

export async function loadSpecFromFile(path: string) {
  const content = readFileSync(path, "utf-8");
  return JSON.parse(content);
}
