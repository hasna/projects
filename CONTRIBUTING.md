# Contributing to @hasna/projects

Thanks for your interest in contributing.

## Development Setup

```bash
git clone https://github.com/hasna/projects.git
cd projects
bun install

bun test
bun run typecheck
bun run build
```

## Running in Development

```bash
bun run dev:cli -- --help
bun run dev:mcp
```

## Project Structure

```text
src/
  cli/       Commander.js CLI and prompt entrypoint
  db/        SQLite and optional remote storage data layer
  lib/       Project, tmux, GitHub, render, import, and agent logic
  mcp/       MCP server transports and tools
  types/     Project/workspace domain types
  index.ts   Public SDK exports
docs/        Product and migration contracts
```

## Testing

Tests use Bun's test runner and isolated local fixtures where possible.

```bash
bun test
bun test src/lib/project-start.test.ts
bun run typecheck
```

Run targeted tests for the files you change, then run the full suite before a
release or pull request.

## Making Changes

1. Fork and branch (`git checkout -b feature/my-feature`).
2. Make focused changes and add tests for new behavior.
3. Run `bun test`, `bun run typecheck`, and `bun run build`.
4. Commit with a clear Conventional Commit message when possible.
5. Open a pull request with the behavior change, validation, and any release
   notes needed for `CHANGELOG.md`.

## Code Style

- Use TypeScript strict mode.
- Prefer existing project/domain helpers over new abstractions.
- Validate external input with structured parsers or schemas.
- Keep command execution argument-based where possible; avoid shell-built
  command strings for user-controlled values.
- Keep local state under `~/.hasna/projects/` unless a feature explicitly needs
  a project-local artifact.

## Reporting Issues

Use [GitHub Issues](https://github.com/hasna/projects/issues) for bugs and
feature requests. Include repro steps, expected and actual behavior, the version
(`projects --version`), Bun version, tmux version when relevant, and your OS.
