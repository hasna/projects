import type { Command } from "commander";

interface TopLevelCommand {
  name: string;
  aliases: string[];
  description: string;
}

/**
 * Enumerate the real, user-facing top-level commands from the live commander
 * program so completion scripts never drift from the actual CLI surface.
 * Hidden commands and the auto-generated `help` command are excluded.
 */
function collectTopLevelCommands(program: Command): TopLevelCommand[] {
  const commands: TopLevelCommand[] = [];
  for (const command of program.commands) {
    const name = command.name();
    if (name === "help") continue;
    // commander marks hidden commands via the internal `_hidden` flag.
    if ((command as unknown as { _hidden?: boolean })._hidden) continue;
    commands.push({
      name,
      aliases: command.aliases(),
      description: command.description(),
    });
  }
  return commands;
}

/** All completion tokens (primary names + aliases) in registration order. */
function completionTokens(commands: TopLevelCommand[]): string[] {
  const tokens: string[] = [];
  for (const command of commands) {
    tokens.push(command.name);
    for (const alias of command.aliases) tokens.push(alias);
  }
  return tokens;
}

function buildBashCompletion(commands: TopLevelCommand[]): string {
  const commandList = completionTokens(commands).join(" ");
  return `
# projects bash completion
_projects_completion() {
  local cur prev words cword
  _init_completion || return

  local commands="${commandList}"
  local oss_commands="matrix"
  local store_commands="inspect ensure migrate"
  local canvas_commands="create list show upsert compose"
  local loop_commands="link list"
  local label_commands="list add remove rm"
  local location_commands="add list"
  local event_commands="list record"
  local root_commands="add list show update delete match"
  local recipe_commands="add list built-ins seed-defaults"
  local agent_commands="add list assign"
  local tmux_profile_commands="add window-add list show apply"
  local report_commands="serve"

  case "$prev" in
    projects)
      COMPREPLY=( $(compgen -W "$commands" -- "$cur") )
      return 0
      ;;
    oss)
      COMPREPLY=( $(compgen -W "$oss_commands" -- "$cur") )
      return 0
      ;;
    locations)
      COMPREPLY=( $(compgen -W "$location_commands" -- "$cur") )
      return 0
      ;;
    store)
      COMPREPLY=( $(compgen -W "$store_commands" -- "$cur") )
      return 0
      ;;
    canvases)
      COMPREPLY=( $(compgen -W "$canvas_commands" -- "$cur") )
      return 0
      ;;
    loops)
      COMPREPLY=( $(compgen -W "$loop_commands" -- "$cur") )
      return 0
      ;;
    labels|label)
      COMPREPLY=( $(compgen -W "$label_commands" -- "$cur") )
      return 0
      ;;
    events)
      COMPREPLY=( $(compgen -W "$event_commands" -- "$cur") )
      return 0
      ;;
    roots)
      COMPREPLY=( $(compgen -W "$root_commands" -- "$cur") )
      return 0
      ;;
    recipes)
      COMPREPLY=( $(compgen -W "$recipe_commands" -- "$cur") )
      return 0
      ;;
    agents)
      COMPREPLY=( $(compgen -W "$agent_commands" -- "$cur") )
      return 0
      ;;
    tmux-profiles)
      COMPREPLY=( $(compgen -W "$tmux_profile_commands" -- "$cur") )
      return 0
      ;;
    reports)
      COMPREPLY=( $(compgen -W "$report_commands" -- "$cur") )
      return 0
      ;;
    start|status|cleanup-create|show|update|tag|untag|add|remove|rm|link|unlink|publish|unpublish|archive|unarchive|delete|lock|doctor|context|next|why|channel|handoff|list|record|inspect|ensure|migrate)
      # Complete with project slugs
      local slugs
      slugs=$(projects list 2>/dev/null | grep -v '^  ' | awk '{print $1}' 2>/dev/null)
      COMPREPLY=( $(compgen -W "$slugs" -- "$cur") )
      return 0
      ;;
    import)
      COMPREPLY=( $(compgen -d -- "$cur") )
      return 0
      ;;
    --kind)
      COMPREPLY=( $(compgen -W "open-source internal-app platform company-website scaffold project experiment docs remote-only generic" -- "$cur") )
      return 0
      ;;
    --status)
      COMPREPLY=( $(compgen -W "active archived deleted" -- "$cur") )
      return 0
      ;;
  esac

  COMPREPLY=( $(compgen -W "$commands" -- "$cur") )
}
complete -F _projects_completion projects
`;
}

/** Escape a description so it is safe inside a single-quoted zsh `_describe` entry. */
function zshEscape(value: string): string {
  // Only the single quotes that wrap the entry need escaping. In `_describe`
  // only the first colon separates name from description, so colons in the
  // description itself are safe (command names never contain colons).
  return value.replace(/'/g, "'\\''");
}

function buildZshCompletion(commands: TopLevelCommand[]): string {
  const entries = commands.map((command) => `    '${command.name}:${zshEscape(command.description)}'`).join("\n");
  return `
# projects zsh completion
_project() {
  local -a commands
  commands=(
${entries}
  )

  _describe 'command' commands
}

compdef _project projects
`;
}

const WORKON_FUNCTION = [
  "",
  "# workon — cd into a project directory",
  "# Usage: workon [slug]   (no arg = interactive fzf picker if available)",
  "workon() {",
  '  if [ -z "$1" ]; then',
  "    if command -v fzf >/dev/null 2>&1; then",
      "      local slug",
  '      slug=$(projects list 2>/dev/null | grep -v \'^  \' | awk \'{print $1}\' | fzf --prompt="project> ")',
  '      [ -n "$slug" ] && cd "$(projects show "$slug" --json | bun -e \'const fs=require("fs"); const input=JSON.parse(fs.readFileSync(0,"utf8")); console.log(input.project.primary_path || ".")\')"',
  "    else",
      "      projects list",
  "    fi",
  "  else",
  '    cd "$(projects show "$1" --json | bun -e \'const fs=require("fs"); const input=JSON.parse(fs.readFileSync(0,"utf8")); console.log(input.project.primary_path || ".")\')"',
  "  fi",
  "}",
  "",
].join("\n");

export function registerCompletionCommand(program: Command): void {
  program
    .command("completion")
    .description("Print shell completion script")
    .option("--shell <shell>", "Shell type: bash or zsh (default: bash)", "bash")
    .action((opts) => {
      // Read the live command surface at invocation time so completion always
      // reflects the commands actually registered on the program.
      const commands = collectTopLevelCommands(program);
      if (opts.shell === "zsh") {
        console.log(buildZshCompletion(commands).trim());
        console.log(WORKON_FUNCTION.trim());
        console.log('\n# Add to ~/.zshrc:\n# eval "$(projects completion --shell zsh)"');
      } else {
        console.log(buildBashCompletion(commands).trim());
        console.log(WORKON_FUNCTION.trim());
        console.log('\n# Add to ~/.bashrc:\n# eval "$(projects completion)"');
      }
    });
}
