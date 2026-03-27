import type { Command } from "commander";

const BASH_COMPLETION = `
# open-projects bash completion
_projects_completion() {
  local cur prev words cword
  _init_completion || return

  local commands="create list get update archive unarchive open sync sync-all sync-log git import import-bulk publish unpublish schedule completion"

  case "$prev" in
    projects)
      COMPREPLY=( $(compgen -W "$commands" -- "$cur") )
      return 0
      ;;
    get|update|archive|unarchive|open|sync|sync-log|git|publish|unpublish)
      # Complete with project slugs
      local slugs
      slugs=$(projects list 2>/dev/null | grep -v '^  ' | awk '{print $1}' 2>/dev/null)
      COMPREPLY=( $(compgen -W "$slugs" -- "$cur") )
      return 0
      ;;
    --direction)
      COMPREPLY=( $(compgen -W "push pull both" -- "$cur") )
      return 0
      ;;
    --interval)
      COMPREPLY=( $(compgen -W "hourly daily weekly" -- "$cur") )
      return 0
      ;;
    schedule)
      COMPREPLY=( $(compgen -W "set remove status" -- "$cur") )
      return 0
      ;;
    import|import-bulk)
      COMPREPLY=( $(compgen -d -- "$cur") )
      return 0
      ;;
  esac

  COMPREPLY=( $(compgen -W "$commands" -- "$cur") )
}
complete -F _projects_completion projects
`;

const ZSH_COMPLETION = `
# open-projects zsh completion
_projects() {
  local -a commands
  commands=(
    'create:Register a new project'
    'list:List all projects'
    'get:Get project details'
    'update:Update a project'
    'archive:Archive a project'
    'unarchive:Unarchive a project'
    'open:Print project path'
    'sync:Sync project to/from S3'
    'sync-all:Sync all projects'
    'sync-log:Show sync history'
    'git:Run git command in project'
    'import:Import a directory as project'
    'import-bulk:Import all subdirectories'
    'publish:Publish to GitHub'
    'unpublish:Remove GitHub remote'
    'schedule:Manage auto-sync schedule'
    'completion:Print shell completion script'
  )

  _describe 'command' commands
}

compdef _projects projects
`;

export function registerCompletionCommand(program: Command): void {
  program
    .command("completion")
    .description("Print shell completion script")
    .option("--shell <shell>", "Shell type: bash or zsh (default: bash)", "bash")
    .action((opts) => {
      if (opts.shell === "zsh") {
        console.log(ZSH_COMPLETION.trim());
        console.log('\n# Add to ~/.zshrc:\n# eval "$(projects completion --shell zsh)"');
      } else {
        console.log(BASH_COMPLETION.trim());
        console.log('\n# Add to ~/.bashrc:\n# eval "$(projects completion)"');
      }
    });
}
