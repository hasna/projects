import type { Command } from "commander";

// Shared utilities
export * from "./shared.js";

// Command modules - each registers its own commands on the program
import { registerCreateCommand, registerRenameCommand, registerArchiveCommands, registerTagCommands } from "./create.js";
import { registerListCommands, registerGetCommand } from "./list.js";
import { registerUpdateCommand } from "./update.js";
import { registerOpenCommand } from "./open.js";
import { registerSyncCommands } from "./sync.js";
import { registerWorkdirCommands } from "./workdir.js";
import { registerPublishCommands } from "./publish.js";
import { registerImportCommands } from "./import.js";
import { registerGitCommand } from "./git.js";
import { registerScheduleCommands } from "./schedule.js";
import { registerCloudCommands } from "./cloud.js";
import { registerDoctorCommands, registerSyncLogCommand } from "./doctor.js";
import { registerEnvCommand } from "./env.js";
import { registerConfigCommand } from "./config.js";
import { registerTmuxCommands } from "./tmux.js";

export function registerProjectCommands(program: Command): void {
  const cmd = program;

  // Core CRUD
  registerCreateCommand(cmd);
  registerGetCommand(cmd);
  registerUpdateCommand(cmd);
  registerRenameCommand(cmd);
  registerArchiveCommands(cmd);
  registerTagCommands(cmd);

  // Listing & discovery
  registerListCommands(cmd);
  registerOpenCommand(cmd);
  registerEnvCommand(cmd);

  // Health & stats
  registerDoctorCommands(cmd);
  registerSyncLogCommand(cmd);

  // Sync & storage
  registerSyncCommands(cmd);
  registerScheduleCommands(cmd);
  registerWorkdirCommands(cmd);

  // GitHub
  registerPublishCommands(cmd);

  // Import
  registerImportCommands(cmd);

  // Git passthrough
  registerGitCommand(cmd);

  // Cloud sync
  registerCloudCommands(cmd);

  // Config
  registerConfigCommand(cmd);

  // tmux management
  registerTmuxCommands(cmd);
}
