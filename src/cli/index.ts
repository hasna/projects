#!/usr/bin/env bun
import { Command } from "commander";
import chalk from "chalk";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { registerWorkspaceCommands } from "./commands/workspaces.js";
import { registerCompletionCommand } from "./commands/completion.js";
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

function preparePromptFlags(): void {
  const firstArg = firstPositionalArg(process.argv);
  if (!firstArg) return;

  const commandNames = new Set<string>();
  for (const command of program.commands) {
    commandNames.add(command.name());
    for (const alias of command.aliases()) commandNames.add(alias);
  }
  if (commandNames.has(firstArg)) return;

  const nextArgv = process.argv.slice(0, 2);
  for (let i = 2; i < process.argv.length; i++) {
    const arg = process.argv[i]!;
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
      process.env["WORKSPACES_JSON"] = process.env["WORKSPACES_JSON"] || "1";
      continue;
    }
    nextArgv.push(arg);
  }
  process.argv = nextArgv;
}

program
  .name("projects")
  .description("Generic workspace orchestration CLI for AI agents")
  .version(getPackageVersion())
  .argument("[prompt...]", "Natural-language prompt for the workspace agent")
  .addHelpText("after", `

Prompt mode options:
  --yes                 Allow prompt-mode workspace mutations
  --dry-run             Force prompt mode to plan without writing
  --model <model>       OpenRouter model for prompt mode
  --max-steps <n>       Maximum AI SDK tool-call steps for prompt mode
  --agent <id-or-slug>  Existing agent to attribute prompt-mode workspace mutations to
  --root <id-or-slug>   Required root for prompt-mode workspace creation
  --recipe <id-or-slug> Required recipe for prompt-mode workspace creation
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

      if (process.env["WORKSPACES_JSON"]) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }

      console.log(result.text);
      for (const workspace of result.workspaces) {
        console.log(chalk.green(`✓ Workspace: ${workspace.slug}`));
        if (workspace.primary_path) console.log(`  ${chalk.dim("path:")} ${workspace.primary_path}`);
      }
      if (!result.approved && !result.dry_run) {
        console.log(chalk.dim("Run with --yes to allow workspace creation and tmux changes."));
      }
    } catch (err) {
      console.error(chalk.red(err instanceof Error ? err.message : String(err)));
      process.exit(1);
    }
  });

registerWorkspaceCommands(program);
registerCompletionCommand(program);

preparePromptFlags();
await program.parseAsync(process.argv);
