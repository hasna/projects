// Re-export from modular structure for backward compatibility
// All commands are now in src/cli/commands/projects/
export { registerProjectCommands } from "./projects/index.js";
export { timeAgo, suppressSslWarnings, wantsJsonOutput, parsePositiveIntOrExit, exitProjectNotFound, resolveProjectOrExit, requireProject, printProject } from "./projects/shared.js";
