# Projects Product Contract

## Product Boundary

Projects remains the app, package, and primary binary:

- App/product name: `Projects`
- Package name: `@hasna/projects`
- Canonical binary: `projects`
- Singular binary alias: not part of the current public contract

The public object is a project. A project is a high-level managed unit of work:

- repository
- app
- docs folder
- scaffold
- experiment
- remote-intended repository
- any local folder that should be tracked, launched, audited, or handed to an agent

Projects is not a task manager. Task execution, checklists, status boards, and sprint-level work belong in `todos`. Briefs, specs, and decision documents belong in `brief`. Projects can link to those systems through integrations, but it should not duplicate their domain.

## Public Language

Public CLI, MCP, SDK examples, prompt-agent copy, help text, README examples, and user-facing errors should say project unless a lower-level implementation detail is being deliberately exposed.

Target public CLI:

```bash
projects create
projects import
projects list
projects show
projects update
projects tag
projects untag
projects link
projects unlink
projects archive
projects unarchive
projects delete
projects start
```

Commands that accept an existing project target should resolve the same target
forms: id, slug, exact name, registered primary path, registered secondary
location, or a folder containing a valid `.project.json` marker. `projects
start` may additionally import an unknown folder when registration is allowed,
carrying explicit tags and metadata into the planned or applied project record.

The old workspace-first command group has been removed from the public interface.
Workspace naming is allowed only inside storage/runtime internals and should not be
documented or exposed as a normal CLI, MCP, SDK, or prompt-agent surface.

## Internal Model

The current internal storage can continue to use workspace-oriented tables and TypeScript types while the product contract is being corrected. Those names are acceptable internally only when they represent local execution context:

- `workspaces`
- `workspace_locations`
- `workspace_events`
- `workspace_locks`
- `.project.json`

Any remaining internal workspace naming must either be explicitly documented as storage/runtime terminology or migrated in a later storage pass. It should not appear in normal CLI help, MCP tool names, prompt-agent wording, or README quickstart examples.

## Project Responsibilities

Projects owns:

- project identity: id, slug, name, description
- lifecycle: active, archived, deleted
- type/kind: open source, internal app, docs, platform, generic, and similar
- paths and locations across machines
- roots and path templates for where projects usually live
- tags and metadata for discovery
- integrations: GitHub, todos, brief, mementos, conversations, files
- launch defaults: preferred agent, tmux profile, primary start command, session policy, start windows
- runtime events: created, imported, updated, started, archived, deleted
- agent attribution for all mutations and launch actions

## Metadata Taxonomy

Projects keeps task-level execution out of its storage, but it owns a small,
validated management taxonomy for project routing, launch, and handoff:

- `status`: lifecycle record status, one of `active`, `archived`, `deleted`
- `stage`: high-level lifecycle stage, one of `idea`, `planned`, `active`, `paused`, `shipped`, `maintenance`
- `priority`: project-level priority, one of `low`, `medium`, `high`, `critical`
- `owner`: accountable person or agent slug/name
- `launch_profile`: default tmux profile id or slug
- `start_agent`: default launch tool, one of `codewith`, `claude`, `opencode`, `cursor`, `none`
- `start_command`: optional command overriding the default launch command
- `start_session_policy`: default tmux session policy, one of `reuse`, `new`, `error-if-running`
- `start_windows`: deterministic tmux windows to add during `projects start`
- `todos_project_id` / `todos_task_list_id`: links to todos, not embedded tasks
- `brief_id` / `brief_path`: links to brief/spec artifacts, not embedded documents

Create and update entrypoints should normalize case for `stage`, `priority`, and
`start_agent`, and `start_session_policy`, trim string fields, reject unknown taxonomy values, and keep
arbitrary extra metadata separate from the first-class fields above.

Projects does not own:

- individual tasks or subtasks
- sprint planning
- task dependencies
- detailed task status
- brief/spec authoring
- source code generation beyond explicit project bootstrap/scaffold steps

## Start Contract

The daily terminal entrypoint is:

```bash
projects start <target>
```

`<target>` can be:

- registered project id
- registered project slug
- registered project name
- registered project location path
- absolute path
- relative path
- `.`

Default behavior:

1. Resolve an existing project by id, slug, name, path, or current directory.
2. Check registered primary paths, registered secondary locations, and `.project.json` markers before importing.
3. If the target is an unregistered folder and creation/import is allowed, register/import it.
4. Load saved launch defaults from the project record: `start_agent`, `start_command`, `start_session_policy`, `launch_profile`, and `start_windows`.
5. Create or reuse a tmux session in the project path.
6. Start the selected coding tool or saved command in a named window.
7. Apply saved tmux profile windows and saved start windows unless the command provides exact requested windows.
8. Reuse existing sessions/windows by default.
9. Record a project event with source, agent, session, selected tool, and reuse result.

Explicit `--reuse`, `--new`, and `--error-if-running` flags override the saved
`start_session_policy`; when no flag is passed, the project default is used.

Exact requested windows:

```bash
projects start <target> --windows-json '[{"name":"editor","command":"code ."},{"name":"server","command":"bun run dev"}]'
```

When exact windows are provided, the start/status operation creates or previews
that tmux window set by name instead of adding saved profile/default windows.
MCP and SDK callers use the `windows` array on `projects_start`.

Agent choices:

```text
codewith -> codewith
claude   -> claude
opencode -> opencode
cursor   -> cursor .
none     -> no startup command
```

Bulk start should be deterministic and non-interactive by default:

```bash
projects start --bulk app1 app2 app3 --no-attach
```

It should report created, reused, skipped, and failed projects.

## Prompt-Agent Contract

`projects <prompt>` is allowed to use an LLM, but project operations themselves should remain deterministic tools.

The prompt agent must receive inventory context for registered projects:

- slug
- name
- kind
- status
- path
- tags
- metadata
- integrations
- launch defaults

For create-like prompts, the agent must check existing projects first. For start/open/resume prompts, the agent should call the deterministic project start tool instead of creating a new project.

## MCP Contract

MCP tools should be project-first:

- `projects_list`
- `projects_show`
- `projects_locations_list`
- `projects_locations_add`
- `projects_create`
- `projects_import`
- `projects_update`
- `projects_tag`
- `projects_untag`
- `projects_link`
- `projects_unlink`
- `projects_archive`
- `projects_unarchive`
- `projects_delete`
- `projects_start`
- `projects_events_list`
- `projects_event_record`
- `projects_doctor`
- `projects_locks`

Roots, recipes, agents, and tmux profiles can remain as supporting concepts, but their descriptions should explain how they support project management and project launch behavior.

## Migration Strategy

1. Add project-first CLI commands while reusing current workspace internals.
2. Add the deterministic project resolver and `projects start`.
3. Move MCP and prompt-agent tools to project-first names.
4. Update docs, completion, tests, and README to project-first language.
5. Decide separately whether storage/files should be renamed from workspace to project.
6. Remove or hide eval fixtures from normal project lists.

This preserves the broad arbitrary-folder capability from the workspace migration while restoring the correct product model: Projects is a high-level project management and launcher app.
