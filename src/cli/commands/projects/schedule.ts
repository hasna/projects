import chalk from "chalk";
import { getScheduleConfig, saveScheduleConfig, installCron, removeCron } from "../../../lib/scheduler.js";
import { type Command } from "./shared.js";

export function registerScheduleCommands(cmd: Command) {
  const scheduleCmd = cmd.command("schedule").description("Manage auto-sync schedule");

  scheduleCmd
    .command("set")
    .description("Enable scheduled sync")
    .option("--interval <n>", "hourly, daily, or weekly (default: daily)", "daily")
    .option("--direction <dir>", "push, pull, or both (default: both)", "both")
    .action((opts) => {
      const config = { enabled: true, interval: opts.interval, direction: opts.direction };
      saveScheduleConfig(config);
      try {
        installCron(config);
        console.log(chalk.green(`✓ Scheduled: ${opts.interval} sync (${opts.direction})`));
      } catch (err: unknown) {
        console.log(chalk.yellow("Config saved, but crontab install failed:"), err instanceof Error ? err.message : String(err));
      }
    });

  scheduleCmd
    .command("remove")
    .description("Disable scheduled sync")
    .action(() => {
      const config = getScheduleConfig();
      saveScheduleConfig({ ...config, enabled: false });
      removeCron();
      console.log(chalk.yellow("✓ Schedule removed"));
    });

  scheduleCmd
    .command("status")
    .description("Show schedule configuration")
    .action(() => {
      const config = getScheduleConfig();
      console.log(`enabled:  ${config.enabled ? chalk.green("yes") : chalk.dim("no")}`);
      console.log(`interval: ${config.interval}`);
      console.log(`direction: ${config.direction}`);
      if (config.last_run) console.log(`last run: ${config.last_run}`);
    });
}
