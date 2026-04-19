import chalk from "chalk";
import { resolveProjectOrExit, type Command } from "./shared.js";
import { existsSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const SHELL_INTEGRATION = `# projects CLI shell integration
# Adds 'pcd <slug>' to cd into a project directory
pcd() {
  local path
  path="$(projects open "$1" 2>/dev/null)"
  if [ $? -eq 0 ] && [ -n "$path" ]; then
    cd "$path"
  fi
}`;

function shellFilePath(): string | null {
  const shell = process.env.SHELL || "";
  if (shell.includes("zsh")) {
    return join(homedir(), ".zshrc");
  }
  if (shell.includes("bash")) {
    // Check for .bash_profile first (macOS), then .bashrc
    const bashProfile = join(homedir(), ".bash_profile");
    if (existsSync(bashProfile)) return bashProfile;
    return join(homedir(), ".bashrc");
  }
  return null;
}

export function registerShellCommand(cmd: Command) {
  cmd
    .command("cd <id-or-slug>")
    .description("Change directory to a project (use via eval or shell alias: pcd <slug>)")
    .action((idOrSlug) => {
      const project = resolveProjectOrExit(idOrSlug);
      // Output shell eval script
      console.log(`cd ${project.path}`);
    });

  cmd
    .command("alias")
    .description("Add shell integration (pcd alias) to your shell config")
    .option("--dry-run", "Show what would be added without writing")
    .option("--remove", "Remove shell integration")
    .option("-j, --json", "Output raw JSON")
    .action((opts) => {
      const filePath = shellFilePath();
      if (!filePath) {
        console.error(chalk.red("Unsupported shell. Add this to your shell config:"));
        console.log(SHELL_INTEGRATION);
        process.exit(1);
      }

      const fileExists = existsSync(filePath);
      const content = fileExists ? readFileSync(filePath, "utf-8") : "";

      if (opts.remove) {
        const marker = "# projects CLI shell integration";
        if (content.includes(marker)) {
          // Remove the integration block (everything from marker to the closing brace pattern)
          const lines = content.split("\n");
          const startIdx = lines.findIndex((l) => l.includes(marker));
          let endIdx = startIdx;
          for (let i = startIdx; i < lines.length; i++) {
            if (i > startIdx && lines[i]?.trim().startsWith("}")) {
              endIdx = i;
              break;
            }
          }
          const newContent = [...lines.slice(0, startIdx), ...lines.slice(endIdx + 1)].join("\n").replace(/\n{3,}/g, "\n\n");
          writeFileSync(filePath, newContent);
          console.log(chalk.green(`✓ Removed shell integration from ${filePath}`));
        } else {
          console.log(chalk.dim("Shell integration not found — nothing to remove."));
        }
        return;
      }

      const alreadyIntegrated = content.includes("# projects CLI shell integration");

      if (opts.dryRun) {
        if (alreadyIntegrated) {
          console.log(chalk.dim("Already integrated in ") + chalk.underline(filePath));
          return;
        }
        console.log(chalk.dim("Would append to ") + chalk.underline(filePath));
        console.log(SHELL_INTEGRATION);
        return;
      }

      if (alreadyIntegrated) {
        console.log(chalk.dim(`Shell integration already in ${filePath}`));
        return;
      }

      appendFileSync(filePath, `\n${SHELL_INTEGRATION}\n`);
      console.log(chalk.green(`✓ Added shell integration to ${filePath}`));
      console.log(chalk.dim("  Run `source ${filePath}` or restart your terminal to activate."));
    });
}
