import chalk from "chalk";
import { resolveProjectOrExit, printProject, wantsJsonOutput, type Command } from "./shared.js";
import { importProject, importBulk } from "../../../lib/import.js";

export function registerImportCommands(cmd: Command) {
  cmd
    .command("import <path>")
    .description("Import an existing directory as a project")
    .option("--tags <tags>", "Tags (comma-separated)")
    .option("--dry-run", "Show what would be imported without doing it")
    .option("-j, --json", "Output raw JSON")
    .action(async (path, opts) => {
      const { project, skipped, error } = await importProject(path, {
        dryRun: opts.dryRun,
        defaultTags: opts.tags ? opts.tags.split(",").map((t: string) => t.trim()) : [],
        onProgress: (msg) => console.log(chalk.dim(`  ${msg}`)),
      });
      if (wantsJsonOutput(opts)) {
        console.log(JSON.stringify({ project: project ?? null, skipped: skipped ?? null, error: error ?? null }, null, 2));
        if (error) process.exit(1);
        return;
      }
      if (error) { console.error(chalk.red(`Error: ${error}`)); process.exit(1); }
      if (skipped) { console.log(chalk.yellow(`Skipped: ${skipped}`)); return; }
      if (project) { console.log(chalk.green("✓ Imported")); printProject(project); }
    });

  cmd
    .command("import-bulk <dir>")
    .description("Import all subdirectories of a directory as projects")
    .option("--tags <tags>", "Tags to apply to all imported projects (comma-separated)")
    .option("--dry-run", "Show what would be imported without doing it")
    .option("-j, --json", "Output raw JSON")
    .action(async (dir, opts) => {
      const result = await importBulk(dir, {
        dryRun: opts.dryRun,
        defaultTags: opts.tags ? opts.tags.split(",").map((t: string) => t.trim()) : [],
        onProgress: (msg) => console.log(chalk.dim(`  ${msg}`)),
      });
      if (wantsJsonOutput(opts)) { console.log(JSON.stringify(result, null, 2)); return; }
      console.log(chalk.green(`✓ imported: ${result.imported.length}`));
      if (result.skipped.length) console.log(chalk.dim(`  skipped: ${result.skipped.length}`));
      if (result.errors.length) {
        console.log(chalk.red(`  errors: ${result.errors.length}`));
        result.errors.forEach((e) => console.log(`    ${chalk.red(e.error)} — ${e.path}`));
      }
    });
}
