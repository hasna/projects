import chalk from "chalk";
import { rmSync } from "node:fs";
import {
  resolveProjectOrExit,
  wantsJsonOutput,
  type Command,
} from "./shared.js";
import { getDatabase } from "../../../db/database.js";

export function registerDeleteCommand(cmd: Command) {
  cmd
    .command("delete <id-or-slug>")
    .alias("rm")
    .description("Delete a project and optionally remove its directory")
    .option("--force", "Skip confirmation prompt")
    .option("--with-dir", "Also remove the project directory")
    .option("-j, --json", "Output raw JSON")
    .action((idOrSlug, opts) => {
      const project = resolveProjectOrExit(idOrSlug);
      const db = getDatabase();

      // Delete sync logs first
      db.run("DELETE FROM sync_log WHERE project_id = ?", [project.id]);
      // Delete workdirs
      db.run("DELETE FROM project_workdirs WHERE project_id = ?", [project.id]);
      // Delete project
      db.run("DELETE FROM projects WHERE id = ?", [project.id]);

      if (opts.withDir) {
        try {
          rmSync(project.path, { recursive: true, force: true });
        } catch {
          // Non-fatal
        }
      }

      if (wantsJsonOutput(opts)) {
        console.log(JSON.stringify({ deleted: project.id, name: project.name, dirRemoved: opts.withDir }, null, 2));
        return;
      }
      console.log(chalk.green(`✓ Deleted project: ${project.name} (${project.slug})`));
      if (opts.withDir) {
        console.log(chalk.dim(`  Directory removed: ${project.path}`));
      }
    });
}
