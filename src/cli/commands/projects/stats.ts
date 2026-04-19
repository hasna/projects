import chalk from "chalk";
import { listProjects } from "../../../db/projects.js";
import { wantsJsonOutput, type Command } from "./shared.js";

export function registerSummaryCommand(cmd: Command) {
  cmd
    .command("summary")
    .description("Show project summary — total count, active/archived, top tags")
    .option("-j, --json", "Output raw JSON")
    .action((opts) => {
      const all = [
        ...listProjects({ status: "active", limit: 5000 }),
        ...listProjects({ status: "archived", limit: 5000 }),
      ];

      const active = all.filter((p) => p.status === "active").length;
      const archived = all.length - active;

      const tagCounts = new Map<string, number>();
      for (const p of all) {
        for (const t of p.tags) {
          tagCounts.set(t, (tagCounts.get(t) || 0) + 1);
        }
      }
      const topTags = [...tagCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);

      const stats = {
        total: all.length,
        active,
        archived,
        topTags: topTags.map(([tag, count]) => ({ tag, count })),
      };

      if (wantsJsonOutput(opts)) {
        console.log(JSON.stringify(stats, null, 2));
        return;
      }

      console.log(chalk.bold("Project Summary"));
      console.log(`  ${chalk.dim("total:")}     ${stats.total}`);
      console.log(`  ${chalk.green("active:")}    ${stats.active}`);
      console.log(`  ${chalk.yellow("archived:")}  ${stats.archived}`);
      if (topTags.length) {
        console.log(`  ${chalk.dim("top tags:")}`);
        for (const [tag, count] of topTags) {
          console.log(`    ${chalk.dim(tag)}: ${count}`);
        }
      }
    });
}
