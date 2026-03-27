import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Project } from "../types/index.js";

function parseEnvFile(content: string): Record<string, string> {
  const vars: Record<string, string> = {};
  for (const raw of content.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    // Strip surrounding quotes
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (key) vars[key] = val;
  }
  return vars;
}

export function loadProjectEnv(project: Project): Record<string, string> {
  const envPath = join(project.path, ".env");
  if (!existsSync(envPath)) return {};
  return parseEnvFile(readFileSync(envPath, "utf-8"));
}

export function printExportStatements(vars: Record<string, string>): void {
  for (const [k, v] of Object.entries(vars)) {
    // Escape single quotes in value
    const safe = v.replace(/'/g, "'\\''");
    console.log(`export ${k}='${safe}'`);
  }
}

export function listEnvKeys(vars: Record<string, string>): void {
  for (const k of Object.keys(vars)) {
    console.log(k);
  }
}
