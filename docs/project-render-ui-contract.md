# Project Render UI Contract

Open Projects currently ships CLI, MCP, SDK, storage, and JSON Render surfaces.
It does not yet ship a browser frontend. The first UI-ready backend contract is
the per-project canvas store plus JSON Render `Canvas` component emitted by:

- `projects canvases list <project> --render-spec`
- `projects canvases show <project> <canvas> --render-spec`
- MCP `projects_render_canvas`
- SDK `buildProjectCanvasPayload`

## Storage

The global registry remains `~/.hasna/projects/projects.db`.

Project-specific app data lives under:

```text
~/.hasna/projects/by-id/<project_id>/
├── project.db
├── assets/
└── canvases/
```

`project.db` stores:

- `project_canvases`: multiple React Flow-compatible canvases per project
- `project_data_models`: custom JSON model definitions and render hints
- `project_data_records`: project-specific custom records
- `project_loop_links`: links to `@hasna/loops` loop ids or names

## Frontend Contract

The intended frontend stack is:

- TypeScript React
- Tailwind CSS
- shadcn/ui primitives
- React Flow for infinite canvases
- `@json-render/core` for validating and dispatching render specs

`Canvas` component props include:

- `project`: project identity and status
- `canvas`: canvas identity and status
- `engine`: currently `react-flow`
- `viewport`: React Flow viewport object
- `nodes`: React Flow-compatible nodes
- `edges`: React Flow-compatible edges
- `data`: project-specific canvas data
- `capabilities`: flags such as `infinite_canvas` and `multiple_canvases_per_project`
- `ui_contract`: stack metadata for TypeScript React, Tailwind, shadcn, and React Flow

## Next Feature Slices

1. Build a frontend package or app shell that loads project render specs from
   MCP/SDK and maps JSON Render `Canvas`, `Table`, `Actions`, and `Badge`
   components to shadcn/Tailwind components.
2. Add React Flow editing controls for creating, moving, connecting, and saving
   canvas nodes back into `project_canvases`.
3. Add typed CRUD commands/MCP tools for `project_data_models` and
   `project_data_records`, then render records inside canvas nodes.
4. Add live OpenLoops status refresh for linked loops when `@hasna/loops` is
   installed, with a clear unavailable state when it is not.
