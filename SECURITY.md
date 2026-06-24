# Security Policy

## Supported Versions

| Version | Supported |
|---------|-----------|
| 0.1.x   | Yes       |
| < 0.1   | No        |

## Reporting a Vulnerability

If you discover a security vulnerability, please report it responsibly:

1. Do not open a public GitHub issue.
2. Email hasna@hasna.com with details.
3. Include steps to reproduce if possible.
4. Allow reasonable time for a fix before public disclosure.

## Security Model

### Local-first project registry

`@hasna/projects` stores project records, roots, recipes, agents, tmux profiles,
events, and prompt-agent run metadata in a local SQLite database under
`~/.hasna/projects/` by default. Treat that directory as sensitive because it
can contain local paths, command history, project metadata, and integration
references.

### Optional external services

The CLI and SDK make no network calls for normal local registry operations.
Network access is used only when a command or configuration requests it, such as
GitHub import/publish flows, remote storage sync, or prompt mode through
OpenRouter. Prompt mode requires an OpenRouter API key from the environment or
the local secrets vault.

### Remote storage sync

Storage sync uses `HASNA_PROJECTS_DATABASE_URL` or `PROJECTS_DATABASE_URL` when
configured. Do not print database URLs, tokens, or secret-manager payloads in
issues, logs, or support requests.

### MCP and tmux operations

The MCP server uses stdio by default. Optional HTTP mode binds to `127.0.0.1`
unless configured otherwise. Project start commands can create tmux sessions and
run configured commands; only run saved project commands and tmux profiles that
you trust.

## Best Practices

- Keep `~/.hasna/projects/` on a filesystem with restricted permissions.
- Review saved project `start_command` and tmux profile commands before running
  `projects start`.
- Keep `HASNA_PROJECTS_DATABASE_URL`, `PROJECTS_DATABASE_URL`, and
  OpenRouter-related environment variables out of shell history and logs.
- Use `--dry-run` for project creation, GitHub import/publish, and tmux changes
  when reviewing a plan from untrusted input.
- Keep Bun and tmux current with your operating system security updates.
