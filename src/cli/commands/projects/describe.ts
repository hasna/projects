import chalk from "chalk";
import {
  resolveProjectOrExit,
  wantsJsonOutput,
  timeAgo,
  type Command,
} from "./shared.js";
import { listWorkdirs } from "../../../db/workdirs.js";
import { listSyncLogs } from "../../../db/projects.js";
import { listSessions } from "../../../lib/tmux.js";

export function registerDescribeCommand(cmd: Command) {
  cmd
    .command("describe <id-or-slug>")
    .alias("desc")
    .description("Show full project details including integrations, workdirs, tmux sessions")
    .option("-j, --json", "Output raw JSON")
    .action((idOrSlug, opts) => {
      const project = resolveProjectOrExit(idOrSlug);
      const workdirs = listWorkdirs(project.id);
      const syncLogs = listSyncLogs(project.id, 5);
      let tmuxSession = null;
      try {
        const sessions = listSessions();
        tmuxSession = sessions.find((s) =>
          s.name.includes(project.slug) || s.name.includes(project.name.toLowerCase())
        ) || null;
      } catch {
        // tmux not available — ignore
      }

      if (wantsJsonOutput(opts)) {
        console.log(JSON.stringify({
          ...project,
          workdirs,
          recentSync: syncLogs,
          tmuxSession: tmuxSession || null,
        }, null, 2));
        return;
      }

      const statusBadge = project.status === "archived" ? chalk.yellow("[archived]") : chalk.green("[active]");
      console.log(`${chalk.bold(project.name)} ${chalk.dim(`(${project.slug})`)} ${statusBadge}`);
      console.log(`  ${chalk.dim("id:")}        ${project.id}`);
      console.log(`  ${chalk.dim("path:")}      ${project.path}`);
      if (project.description) console.log(`  ${chalk.dim("desc:")}      ${project.description}`);
      if (project.tags.length) console.log(`  ${chalk.dim("tags:")}      ${project.tags.join(", ")}`);
      if (project.git_remote) console.log(`  ${chalk.dim("remote:")}    ${project.git_remote}`);
      if (project.s3_bucket) console.log(`  ${chalk.dim("s3:")}        s3://${project.s3_bucket}/${project.s3_prefix ?? ""}`);

      // Integrations
      const intKeys = Object.entries(project.integrations).filter(([, v]) => v);
      if (intKeys.length) {
        console.log(`  ${chalk.dim("integrations:")}`);
        for (const [k, v] of intKeys) {
          console.log(`    ${chalk.dim(k)}: ${v}`);
        }
      }

      // Workdirs
      if (workdirs.length) {
        console.log(`  ${chalk.dim("workdirs:")}`);
        for (const w of workdirs) {
          const primary = w.is_primary ? chalk.green(" ●") : "";
          console.log(`    ${chalk.dim(w.path)}${primary} ${chalk.dim(`(${w.machine_id})`)}`);
        }
      }

      // Tmux
      if (tmuxSession) {
        console.log(`  ${chalk.dim("tmux:")}      ${chalk.green("●")} ${tmuxSession.name} (${tmuxSession.windows} windows)`);
      }

      // Sync
      if (syncLogs.length > 0) {
        const last = syncLogs[0]!;
        console.log(`  ${chalk.dim("last sync:")}  ${last.status} ${timeAgo(last.started_at)}`);
      }

      console.log(`  ${chalk.dim("created:")}   ${project.created_at}`);
      if (project.last_opened_at) {
        console.log(`  ${chalk.dim("opened:")}    ${timeAgo(project.last_opened_at)}`);
      }
    });
}
