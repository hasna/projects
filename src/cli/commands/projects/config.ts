import chalk from "chalk";
import { getConfig, saveConfig, type ProjectsConfig } from "../../../lib/config.js";
import type { Command } from "./shared.js";

export function registerConfigCommand(cmd: Command) {
  const configCmd = cmd
    .command("config")
    .description("View or update project creation defaults");

  configCmd
    .action((opts) => {
      const config = getConfig();
      console.log(chalk.bold("Current configuration:"));
      for (const [key, value] of Object.entries(config)) {
        console.log(`  ${chalk.dim(key)}: ${chalk.green(String(value))}`);
      }
    });

  configCmd
    .command("set <key> <value>")
    .description("Set a configuration value")
    .action((key: string, value: string) => {
      saveConfig({ [key]: value === "true" ? true : value === "false" ? false : value });
      console.log(chalk.green(`✓ ${key} = ${value}`));
    });

  configCmd
    .command("reset [key]")
    .description("Reset config (or a specific key) to defaults")
    .action((key?: string) => {
      if (key) {
        const config = getConfig();
        delete config[key];
        saveConfig(config);
        console.log(chalk.green(`✓ Reset ${key} to default`));
      } else {
        saveConfig({});
        console.log(chalk.green("✓ All config reset to defaults"));
      }
    });
}
