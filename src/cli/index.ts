#!/usr/bin/env bun
import { Command } from "commander";
import chalk from "chalk";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { registerProjectCommands } from "./commands/projects.js";
import { registerCompletionCommand } from "./commands/completion.js";

function getPackageVersion(): string {
  try {
    const pkgPath = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "package.json");
    return JSON.parse(readFileSync(pkgPath, "utf-8")).version || "0.0.0";
  } catch {
    return "0.0.0";
  }
}

const program = new Command();

program
  .name("projects")
  .description("Project management CLI for AI agents")
  .version(getPackageVersion());

registerProjectCommands(program);
registerCompletionCommand(program);

program.parse(process.argv);
