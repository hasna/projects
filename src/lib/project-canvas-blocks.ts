import type {
  CreateProjectCanvasInput,
  ProjectCanvasEdge,
  ProjectCanvasNode,
} from "../db/project-store.js";
import type { JsonObject } from "../types/workspace.js";

export const PROJECT_CANVAS_BLOCK_SCHEMA = "hasna.projects_canvas_blocks.v1" as const;

export type ProjectCanvasBlockSize = "M" | "XL" | "XXL" | "4XL";
export type ProjectCanvasBlockTone = "neutral" | "good" | "warning" | "danger" | "info";
export type ProjectCanvasBlockDirection = "horizontal" | "vertical" | "grid";

export interface ProjectCanvasBlockMetric extends JsonObject {
  id?: string;
  label: string;
  value: string | number | boolean;
  tone?: ProjectCanvasBlockTone;
}

export interface ProjectCanvasBlockItem extends JsonObject {
  id: string;
  title: string;
  summary?: string | null;
  status?: string | null;
}

export interface ProjectCanvasBlockAction extends JsonObject {
  label: string;
  value: string;
  variant?: "primary" | "secondary" | "danger";
}

export interface ProjectCanvasBlockHandle extends JsonObject {
  id: string;
  type: "source" | "target";
  position: "left" | "right" | "top" | "bottom";
}

export interface ProjectCanvasBlock extends JsonObject {
  id: string;
  title: string;
  kind?: string;
  summary?: string | null;
  status?: string | null;
  component?: string;
  nodeType?: string;
  size?: ProjectCanvasBlockSize;
  position?: { x: number; y: number };
  width?: number;
  height?: number;
  metrics?: ProjectCanvasBlockMetric[];
  items?: ProjectCanvasBlockItem[];
  actions?: ProjectCanvasBlockAction[];
  handles?: ProjectCanvasBlockHandle[];
  columns?: string[];
  rows?: Array<Record<string, unknown>>;
  data?: JsonObject;
  metadata?: JsonObject;
}

export interface ProjectCanvasBlockLink extends JsonObject {
  id?: string;
  source: string;
  target: string;
  label?: string;
  type?: string;
  sourceHandle?: string;
  targetHandle?: string;
  data?: JsonObject;
}

export interface ProjectCanvasBlockLayout extends JsonObject {
  direction?: ProjectCanvasBlockDirection;
  columns?: number;
  origin?: { x: number; y: number };
  columnGap?: number;
  rowGap?: number;
}

export interface ProjectCanvasBlockSpec extends JsonObject {
  schema?: typeof PROJECT_CANVAS_BLOCK_SCHEMA | string;
  name?: string;
  slug?: string;
  description?: string;
  viewport?: JsonObject;
  layout?: ProjectCanvasBlockLayout;
  blocks: ProjectCanvasBlock[];
  links?: ProjectCanvasBlockLink[];
  data?: JsonObject;
  metadata?: JsonObject;
}

export interface ComposeProjectCanvasBlocksResult extends JsonObject {
  viewport: JsonObject;
  nodes: ProjectCanvasNode[];
  edges: ProjectCanvasEdge[];
  data: JsonObject;
  metadata: JsonObject;
}

export interface ProjectCanvasInputFromBlocksOptions {
  name?: string;
  slug?: string;
  description?: string | null;
}

function isObject(value: unknown): value is JsonObject {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function titleFromSlug(value: string): string {
  return value
    .replace(/[^a-zA-Z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ")
    .replace(/\b\w/g, (char) => char.toUpperCase()) || "Canvas";
}

function assertFinitePoint(value: unknown, label: string): { x: number; y: number } {
  if (!isObject(value)) throw new Error(`${label} must be an object with numeric x and y`);
  const x = value.x;
  const y = value.y;
  if (typeof x !== "number" || !Number.isFinite(x) || typeof y !== "number" || !Number.isFinite(y)) {
    throw new Error(`${label} must include finite numeric x and y`);
  }
  return { x, y };
}

function normalizeLayout(layout: ProjectCanvasBlockLayout | undefined): Required<ProjectCanvasBlockLayout> {
  const origin = layout?.origin ? assertFinitePoint(layout.origin, "layout.origin") : { x: 0, y: 0 };
  const direction = layout?.direction ?? "grid";
  if (!["horizontal", "vertical", "grid"].includes(direction)) {
    throw new Error(`layout.direction must be horizontal, vertical, or grid`);
  }
  return {
    direction,
    columns: Math.max(1, Math.floor(layout?.columns ?? 3)),
    origin,
    columnGap: Math.max(120, layout?.columnGap ?? 440),
    rowGap: Math.max(120, layout?.rowGap ?? 300),
  };
}

function generatedPosition(index: number, layout: Required<ProjectCanvasBlockLayout>): { x: number; y: number } {
  if (layout.direction === "horizontal") {
    return { x: layout.origin.x + index * layout.columnGap, y: layout.origin.y };
  }
  if (layout.direction === "vertical") {
    return { x: layout.origin.x, y: layout.origin.y + index * layout.rowGap };
  }
  const column = index % layout.columns;
  const row = Math.floor(index / layout.columns);
  return {
    x: layout.origin.x + column * layout.columnGap,
    y: layout.origin.y + row * layout.rowGap,
  };
}

function tableItems(block: ProjectCanvasBlock): ProjectCanvasBlockItem[] {
  if (!block.rows?.length) return [];
  const columns = block.columns?.length ? block.columns : Object.keys(block.rows[0] ?? {});
  return block.rows.slice(0, 8).map((row, index) => {
    const titleKey = columns.find((key) => typeof row[key] === "string") ?? columns[0];
    const title = titleKey && row[titleKey] != null ? String(row[titleKey]) : `Row ${index + 1}`;
    const summary = columns
      .filter((key) => key !== titleKey)
      .slice(0, 3)
      .map((key) => `${key}: ${String(row[key] ?? "")}`)
      .join(" | ");
    return {
      id: `${block.id}-row-${index + 1}`,
      title,
      summary: summary || null,
      status: null,
    };
  });
}

function blockNodeData(block: ProjectCanvasBlock): JsonObject {
  const data = block.data ?? {};
  const items = [
    ...(block.items ?? []),
    ...tableItems(block),
  ];
  return {
    id: block.id,
    title: block.title,
    description: block.summary ?? null,
    kind: block.kind ?? "block",
    provider: "projects",
    status: block.status ?? null,
    component: block.component ?? "ProjectCanvasCard",
    size: block.size ?? "XL",
    metrics: block.metrics ?? [],
    items,
    actions: block.actions ?? [],
    handles: block.handles ?? [],
    columns: block.columns ?? [],
    rows: block.rows ?? [],
    ...data,
  };
}

function blockToNode(block: ProjectCanvasBlock, index: number, layout: Required<ProjectCanvasBlockLayout>): ProjectCanvasNode {
  const position = block.position ? assertFinitePoint(block.position, `blocks[${index}].position`) : generatedPosition(index, layout);
  const node: ProjectCanvasNode = {
    id: block.id,
    type: block.nodeType ?? "projectPanel",
    position,
    data: blockNodeData(block),
  };
  if (block.width) node.width = block.width;
  if (block.height) node.height = block.height;
  return node;
}

function linkToEdge(link: ProjectCanvasBlockLink, index: number, blockIds: Set<string>): ProjectCanvasEdge {
  if (!blockIds.has(link.source)) throw new Error(`links[${index}].source does not match a block id: ${link.source}`);
  if (!blockIds.has(link.target)) throw new Error(`links[${index}].target does not match a block id: ${link.target}`);
  return {
    id: link.id ?? `edge-${link.source}-${link.target}-${index + 1}`,
    source: link.source,
    target: link.target,
    label: link.label,
    type: link.type,
    sourceHandle: link.sourceHandle,
    targetHandle: link.targetHandle,
    data: {
      kind: "canvas-block-link",
      ...(link.data ?? {}),
    },
  };
}

export function composeProjectCanvasBlocks(spec: ProjectCanvasBlockSpec): ComposeProjectCanvasBlocksResult {
  if (!Array.isArray(spec.blocks) || spec.blocks.length === 0) {
    throw new Error("Canvas block spec must include at least one block");
  }

  const ids = new Set<string>();
  for (const [index, block] of spec.blocks.entries()) {
    if (!block.id || typeof block.id !== "string") throw new Error(`blocks[${index}].id is required`);
    if (!block.title || typeof block.title !== "string") throw new Error(`blocks[${index}].title is required`);
    if (ids.has(block.id)) throw new Error(`Duplicate canvas block id: ${block.id}`);
    ids.add(block.id);
  }

  const layout = normalizeLayout(spec.layout);
  const links = spec.links ?? [];
  const nodes = spec.blocks.map((block, index) => blockToNode(block, index, layout));
  const edges = links.map((link, index) => linkToEdge(link, index, ids));

  return {
    viewport: spec.viewport ?? { x: 0, y: 0, zoom: 1 },
    nodes,
    edges,
    data: {
      ...(spec.data ?? {}),
      block_schema: spec.schema ?? PROJECT_CANVAS_BLOCK_SCHEMA,
      blocks: spec.blocks,
      links,
    },
    metadata: {
      ...(spec.metadata ?? {}),
      composed_from: "project-canvas-blocks",
      block_count: spec.blocks.length,
      link_count: links.length,
    },
  };
}

export function projectCanvasInputFromBlocks(
  spec: ProjectCanvasBlockSpec,
  options: ProjectCanvasInputFromBlocksOptions = {},
): CreateProjectCanvasInput {
  const slug = options.slug ?? spec.slug;
  const composed = composeProjectCanvasBlocks(spec);
  return {
    name: options.name ?? spec.name ?? titleFromSlug(slug ?? "canvas"),
    slug,
    description: options.description === undefined ? spec.description : options.description ?? undefined,
    viewport: composed.viewport,
    nodes: composed.nodes,
    edges: composed.edges,
    data: composed.data,
    metadata: composed.metadata,
  };
}
