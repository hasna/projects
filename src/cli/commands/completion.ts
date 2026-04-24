import type { Command } from "commander";

const BASH_COMPLETION = `
# open-projects bash completion
_project_completion() {
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
complete -F _project_completion projects
`;

const ZSH_COMPLETION = `
# open-projects zsh completion
_project() {
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
  '      [ -n "$slug" ] && cd "$(projects open "$slug")"',
  "    else",
  "      projects list",
  "    fi",
  "  else",
  '    cd "$(projects open "$1")"',
  "  fi",
  "}",
  "",
  "# penv — load a project's .env into current shell",
  "# Usage: penv [slug]",
  "penv() {",
  '  eval "$(projects env "${1}")"',
  "}",
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
