import { readFileSync } from "node:fs";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getDbPath } from "../db/database.js";
import { commandAvailability, getMachineProfile, pathExists } from "./machine.js";

export type SetupCheckStatus = "ok" | "warn" | "error";

export interface SetupCheck {
  code: string;
  label: string;
  status: SetupCheckStatus;
  message: string;
  fixable?: boolean;
  fixed?: boolean;
}

export interface SetupMachineOptions {
  fix?: boolean;
  dryRun?: boolean;
}

export interface SetupMachineReport {
  machine: ReturnType<typeof getMachineProfile>;
  version: string;
  dryRun: boolean;
  checks: SetupCheck[];
  ok: boolean;
}

export function setupMachineReport(options: SetupMachineOptions = {}): SetupMachineReport {
  const machine = getMachineProfile();
  const dryRun = options.dryRun !== false;
  const checks: SetupCheck[] = [];
  const dbDir = dirname(getDbPath());
  const cloudConfig = join(process.env["HOME"] || "~", ".hasna", "cloud", "config.json");

  checks.push(pathCheck("PROJECTS_DATA_DIR", "projects data dir", dbDir, options));
  checks.push(pathCheck("WORKSPACE_ROOT", "workspace root", machine.workspaceRoot, options));
  checks.push(commandCheck("bun", ["--version"], "Bun runtime"));
  checks.push(commandCheck("tmux", ["-V"], "tmux"));
  checks.push(commandCheck("git", ["--version"], "git"));
  checks.push(commandCheck("gh", ["--version"], "GitHub CLI", "warn"));
  checks.push(commandCheck("aws", ["--version"], "AWS CLI", "warn"));
  checks.push(commandCheck("projects", ["--version"], "projects CLI"));
  checks.push(commandCheck("projects-mcp", ["--version"], "projects MCP"));
  checks.push({
    code: "CLOUD_CONFIG",
    label: "cloud config",
    status: pathExists(cloudConfig) ? "ok" : "warn",
    message: pathExists(cloudConfig) ? cloudConfig : "not found; cloud sync may be unavailable",
  });

  return {
    machine,
    version: packageVersion(),
    dryRun,
    checks,
    ok: checks.every((check) => check.status !== "error"),
  };
}

function pathCheck(code: string, label: string, path: string, options: SetupMachineOptions): SetupCheck {
  if (pathExists(path)) {
    return { code, label, status: "ok", message: path };
  }

  const check: SetupCheck = {
    code,
    label,
    status: "warn",
    message: `missing: ${path}`,
    fixable: true,
  };

  if (options.fix && options.dryRun === false) {
    mkdirSync(path, { recursive: true });
    check.fixed = true;
    check.message = `created: ${path}`;
  }

  return check;
}

function commandCheck(
  command: string,
  versionArgs: string[],
  label: string,
  missingStatus: SetupCheckStatus = "error",
): SetupCheck {
  const availability = commandAvailability(command, versionArgs);
  if (!availability.available) {
    return {
      code: `COMMAND_${command.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}`,
      label,
      status: missingStatus,
      message: `${command} not found in PATH`,
    };
  }

  return {
    code: `COMMAND_${command.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}`,
    label,
    status: "ok",
    message: [availability.path, availability.version].filter(Boolean).join(" | "),
  };
}

function packageVersion(): string {
  try {
    const pkgPath = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "package.json");
    return (JSON.parse(readFileSync(pkgPath, "utf-8")) as { version?: string }).version || "0.0.0";
  } catch {
    return "0.0.0";
  }
}
