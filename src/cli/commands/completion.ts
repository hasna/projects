import type { Command } from "commander";

const BASH_COMPLETION = `
# open-projects bash completion
_workspace_completion() {
  local cur prev words cword
  _init_completion || return

  local commands="workspaces roots recipes agents tmux-profiles completion"
  local workspace_commands="create cleanup-create import import-github scan-roots publish unpublish link list show update archive unarchive delete doctor lock unlock locks migrate-legacy"
  local root_commands="add list show update delete match"
  local recipe_commands="add list built-ins seed-defaults"
  local agent_commands="add list"
  local tmux_profile_commands="add window-add list show apply"

  case "$prev" in
    projects)
      COMPREPLY=( $(compgen -W "$commands" -- "$cur") )
      return 0
      ;;
    workspaces)
      COMPREPLY=( $(compgen -W "$workspace_commands" -- "$cur") )
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
    show|update|archive|unarchive|delete|doctor|lock)
      # Complete with workspace slugs
      local slugs
      slugs=$(projects workspaces list 2>/dev/null | grep -v '^  ' | awk '{print $1}' 2>/dev/null)
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
complete -F _workspace_completion projects
`;

const ZSH_COMPLETION = `
# open-projects zsh completion
_project() {
  local -a commands
  commands=(
    'workspaces:Manage generic workspaces'
    'roots:Manage workspace root folders'
    'recipes:Manage workspace recipes'
    'agents:Manage workspace agents'
    'tmux-profiles:Manage tmux profiles'
    'completion:Print shell completion script'
  )

  _describe 'command' commands
}

compdef _project projects
`;

const WORKON_FUNCTION = [
  "",
  "# workon — cd into a workspace directory",
  "# Usage: workon [slug]   (no arg = interactive fzf picker if available)",
  "workon() {",
  '  if [ -z "$1" ]; then',
  "    if command -v fzf >/dev/null 2>&1; then",
      "      local slug",
  '      slug=$(projects workspaces list 2>/dev/null | grep -v \'^  \' | awk \'{print $1}\' | fzf --prompt="workspace> ")',
  '      [ -n "$slug" ] && cd "$(projects workspaces show "$slug" --json | bun -e \'const fs=require("fs"); const input=JSON.parse(fs.readFileSync(0,"utf8")); console.log(input.workspace.primary_path || ".")\')"',
  "    else",
      "      projects workspaces list",
  "    fi",
  "  else",
  '    cd "$(projects workspaces show "$1" --json | bun -e \'const fs=require("fs"); const input=JSON.parse(fs.readFileSync(0,"utf8")); console.log(input.workspace.primary_path || ".")\')"',
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
      if (opts.shell === "zsh") {
        console.log(ZSH_COMPLETION.trim());
        console.log(WORKON_FUNCTION.trim());
        console.log('\n# Add to ~/.zshrc:\n# eval "$(projects completion --shell zsh)"');
      } else {
        console.log(BASH_COMPLETION.trim());
        console.log(WORKON_FUNCTION.trim());
        console.log('\n# Add to ~/.bashrc:\n# eval "$(projects completion)"');
      }
    });
}
