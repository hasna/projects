#!/usr/bin/env bun
import { Command } from "commander";
import { registerEventsCommands } from "@hasna/events/commander";
import chalk from "chalk";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { registerWorkspaceCommands } from "./commands/workspaces.js";
import { registerCompletionCommand } from "./commands/completion.js";
import { registerStorageCommands } from "./commands/storage.js";
import { runWorkspaceAgentPrompt } from "../lib/workspace-agent.js";

function getPackageVersion(): string {
  try {
    const pkgPath = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "package.json");
    return JSON.parse(readFileSync(pkgPath, "utf-8")).version || "0.0.0";
  } catch {
    return "0.0.0";
  }
}

const program = new Command();
const promptOptions: {
  yes?: boolean;
  dryRun?: boolean;
  model?: string;
  maxSteps?: string;
  agent?: string;
  root?: string;
  recipe?: string;
  tmux?: boolean;
} = {};

function firstPositionalArg(argv: string[]): string | undefined {
  const optionsWithValues = new Set(["--model", "--max-steps", "--agent", "--root", "--recipe"]);
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--") return argv[i + 1];
    if (optionsWithValues.has(arg)) {
      i++;
      continue;
    }
    if (arg.startsWith("-")) continue;
    return arg;
  }
  return undefined;
}

function hasAnyFlag(argv: string[], flags: string[]): boolean {
  return argv.slice(2).some((arg) => flags.includes(arg));
}

function shouldRouteToCommand(firstArg: string, argv: string[]): boolean {
  if (argv.includes("--")) return false;
  if (hasAnyFlag(argv, ["--yes", "--model", "--max-steps", "--no-tmux"])) return false;
  if (firstArg === "create" && !hasAnyFlag(argv, ["--name"])) return false;
  return true;
}

function preparePromptFlags(): void {
  const firstArg = firstPositionalArg(process.argv);
  if (!firstArg) return;

  const commandNames = new Set<string>();
  for (const command of program.commands) {
    commandNames.add(command.name());
    for (const alias of command.aliases()) commandNames.add(alias);
  }
  if (commandNames.has(firstArg) && shouldRouteToCommand(firstArg, process.argv)) return;

  const nextArgv = process.argv.slice(0, 2);
  const promptStartsWithCommand = commandNames.has(firstArg);
  const promptParts: string[] = [];
  for (let i = 2; i < process.argv.length; i++) {
    const arg = process.argv[i]!;
    if (arg === "--") continue;
    if (arg === "--yes") {
      promptOptions.yes = true;
      continue;
    }
    if (arg === "--dry-run") {
      promptOptions.dryRun = true;
      continue;
    }
    if (arg === "--model") {
      promptOptions.model = process.argv[++i];
      continue;
    }
    if (arg === "--max-steps") {
      promptOptions.maxSteps = process.argv[++i];
      continue;
    }
    if (arg === "--agent") {
      promptOptions.agent = process.argv[++i];
      continue;
    }
    if (arg === "--root") {
      promptOptions.root = process.argv[++i];
      continue;
    }
    if (arg === "--recipe") {
      promptOptions.recipe = process.argv[++i];
      continue;
    }
    if (arg === "--no-tmux") {
      promptOptions.tmux = false;
      continue;
    }
    if (arg === "--json" || arg === "-j") {
      process.env["PROJECTS_JSON"] = process.env["PROJECTS_JSON"] || "1";
      continue;
    }
    if (promptStartsWithCommand) promptParts.push(arg);
    else nextArgv.push(arg);
  }
  if (promptStartsWithCommand) nextArgv.push(promptParts.join(" "));
  process.argv = nextArgv;
}

program
  .name("projects")
  .description("High-level project management and launcher CLI for AI agents")
  .version(getPackageVersion())
  .argument("[prompt...]", "Natural-language prompt for the Projects agent")
  .addHelpText("after", `

Prompt mode options:
  --yes                 Allow prompt-mode project mutations
  --dry-run             Force prompt mode to plan without writing
  --model <model>       OpenRouter model for prompt mode
  --max-steps <n>       Maximum AI SDK tool-call steps for prompt mode
  --agent <id-or-slug>  Existing agent to attribute prompt-mode project mutations to
  --root <id-or-slug>   Required root for prompt-mode project creation
  --recipe <id-or-slug> Required recipe for prompt-mode project creation
  --no-tmux             Disable tmux planning and tmux changes in prompt mode`)
  .action(async (promptParts: string[]) => {
    if (!promptParts.length) {
      program.help();
      return;
    }

    const maxSteps = promptOptions.maxSteps ? Number.parseInt(promptOptions.maxSteps, 10) : undefined;
    if (promptOptions.maxSteps && (!Number.isInteger(maxSteps) || maxSteps! <= 0)) {
      console.error(chalk.red("--max-steps must be a positive integer"));
      process.exit(1);
    }

    try {
      const result = await runWorkspaceAgentPrompt({
        prompt: promptParts.join(" "),
        model: promptOptions.model,
        maxSteps,
        dryRun: promptOptions.dryRun,
        approve: promptOptions.yes,
        agent: promptOptions.agent,
        root: promptOptions.root,
        recipe: promptOptions.recipe,
        tmux: promptOptions.tmux,
      });

      if (process.env["PROJECTS_JSON"] || process.env["WORKSPACES_JSON"]) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }

      console.log(result.text);
      for (const project of result.projects) {
        console.log(chalk.green(`✓ Project: ${project.slug}`));
        if (project.primary_path) console.log(`  ${chalk.dim("path:")} ${project.primary_path}`);
      }
      if (!result.approved && !result.dry_run) {
        console.log(chalk.dim("Run with --yes to allow project creation and tmux changes."));
      }
    } catch (err) {
      console.error(chalk.red(err instanceof Error ? err.message : String(err)));
      process.exit(1);
    }
  });

registerWorkspaceCommands(program);
registerStorageCommands(program);
registerCompletionCommand(program);
registerEventsCommands(program, { source: "projects", eventsCommandName: "hasna-events" });

preparePromptFlags();
await program.parseAsync(process.argv);
