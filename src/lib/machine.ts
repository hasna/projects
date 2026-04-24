import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir, hostname, platform, type } from "node:os";
import { join } from "node:path";

export interface MachineProfile {
  hostname: string;
  platform: NodeJS.Platform;
  os: string;
  workspaceRoot: string;
  knownRole: "apple-laptop" | "apple-desktop" | "spark-server" | "unknown";
  isCurrentMachine: true;
}

const SPARK_MACHINES = new Set(["spark01", "spark02"]);

export function getMachineProfile(): MachineProfile {
  const host = (process.env["HOSTNAME"] || hostname()).split(".")[0] || hostname();
  const currentPlatform = platform();
  const workspaceRoot = currentPlatform === "darwin"
    ? join(homedir(), "Workspace")
    : join(homedir(), "workspace");

  return {
    hostname: host,
    platform: currentPlatform,
    os: type(),
    workspaceRoot,
    knownRole: classifyMachine(host, currentPlatform),
    isCurrentMachine: true,
  };
}

export interface CommandAvailability {
  command: string;
  available: boolean;
  path: string | null;
  version: string | null;
}

export function commandAvailability(command: string, versionArgs: string[] = ["--version"]): CommandAvailability {
  let commandPath: string | null = null;
  try {
    commandPath = execFileSync("bash", ["-lc", `command -v ${command}`], { encoding: "utf-8", stdio: "pipe" }).trim() || null;
  } catch {
    return { command, available: false, path: null, version: null };
  }

  let version: string | null = null;
  try {
    version = execFileSync(command, versionArgs, { encoding: "utf-8", stdio: "pipe" })
      .trim()
      .split("\n")[0] || null;
  } catch {
    version = null;
  }

  return { command, available: true, path: commandPath, version };
}

export function pathExists(path: string): boolean {
  return existsSync(path);
}

function classifyMachine(host: string, currentPlatform: NodeJS.Platform): MachineProfile["knownRole"] {
  if (host === "apple01") return "apple-laptop";
  if (host === "apple03") return "apple-desktop";
  if (SPARK_MACHINES.has(host)) return "spark-server";
  if (currentPlatform === "darwin") return "apple-laptop";
  return "unknown";
}
