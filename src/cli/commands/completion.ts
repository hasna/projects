import type { Command } from "commander";

const BASH_COMPLETION = `
# projects bash completion
_projects_completion() {
  local cur prev words cword
  _init_completion || return

  local commands="start status sessions create cleanup-create cleanup-evals import import-github scan-roots sync-roots list show events update tag untag labels label link unlink publish unpublish archive unarchive delete lock locks unlock doctor agent-eval context next why handoff runs store locations roots recipes agents tmux-profiles storage completion"
  local store_commands="inspect ensure migrate"
  local label_commands="list add remove rm"
  local location_commands="add list"
  local event_commands="list record"
  local root_commands="add list show update delete match"
  local recipe_commands="add list built-ins seed-defaults"
  local agent_commands="add list assign"
  local tmux_profile_commands="add window-add list show apply"

  case "$prev" in
    projects)
      COMPREPLY=( $(compgen -W "$commands" -- "$cur") )
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
    start|status|cleanup-create|show|update|tag|untag|add|remove|rm|link|unlink|publish|unpublish|archive|unarchive|delete|lock|doctor|context|next|why|handoff|list|record|inspect|ensure|migrate)
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

const ZSH_COMPLETION = `
# projects zsh completion
_project() {
  local -a commands
  commands=(
    'start:Start a project tmux session'
    'status:Show project launch and tmux status'
    'sessions:Report project start sessions and rename status'
    'create:Create or plan a project'
    'cleanup-create:Clean up files and DB rows from a project creation run'
    'cleanup-evals:Preview or remove prompt-agent eval fixture records'
    'import:Import an existing folder as a project'
    'import-github:Import a GitHub repository as a project'
    'scan-roots:Dry-run import plans for configured GitHub roots'
    'sync-roots:Import repositories from configured GitHub roots'
    'list:List registered projects'
    'show:Show project details'
    'events:Inspect and record project audit events'
    'update:Update project metadata'
    'tag:Add project tags'
    'untag:Remove project tags'
    'labels:Manage project labels'
    'link:Link external integrations'
    'unlink:Clear external integrations'
    'publish:Plan or publish a project to GitHub'
    'unpublish:Remove local GitHub publication metadata from a project'
    'archive:Archive a project'
    'unarchive:Unarchive a project'
    'delete:Delete a project'
    'lock:Acquire a project mutation lock'
    'locks:List active project mutation locks'
    'unlock:Release a project mutation lock'
    'doctor:Validate project records'
    'agent-eval:Run project prompt-agent eval cases'
    'context:Emit an agent-priming bundle for a project'
    'next:Suggest high-leverage next actions for a project'
    'why:Explain how a project target resolves'
    'handoff:Emit a cross-agent handoff bundle'
    'runs:Inspect prompt-agent run ledger entries'
    'store:Inspect, ensure, and migrate canonical project stores'
    'locations:Manage project folder locations'
    'roots:Manage project root folders'
    'recipes:Manage project recipes'
    'agents:Manage project agents'
    'tmux-profiles:Manage project tmux profiles'
    'storage:Storage sync commands'
    'completion:Print shell completion script'
  )

  _describe 'command' commands
}

compdef _project projects
`;

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
