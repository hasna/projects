import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";

/**
 * open-projects MCP transport/port boilerplate.
 * Keep this local and dependency-free so the published CLI can build without
 * an unpublished workspace-only MCP harness package.
 */

export const MCP_HTTP_HOST = "127.0.0.1";
export const DEFAULT_MCP_HTTP_PORT = 8871;

export function isHttpMode(args: readonly string[] = process.argv): boolean {
  return args.includes("--http") || process.env["MCP_HTTP"] === "1";
}
export function isStdioMode(args: readonly string[] = process.argv): boolean {
  return args.includes("--stdio") || process.env["MCP_STDIO"] === "1";
}
export function resolveMcpHttpPort(args: readonly string[] = process.argv): number {
  const portIndex = args.indexOf("--port");
  if (portIndex >= 0 && args[portIndex + 1]) {
    return parseInt(args[portIndex + 1]!, 10);
  }
  if (process.env["MCP_HTTP_PORT"]) {
    return parseInt(process.env["MCP_HTTP_PORT"], 10);
  }
  return DEFAULT_MCP_HTTP_PORT;
}
export async function handleMcpRequest(
  req: Request,
  buildServer: () => McpServer,
): Promise<Response> {
  const server = buildServer();
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
  });
  await server.connect(transport);
  return transport.handleRequest(req);
}
export function startMcpHttpServer(options: {
  name: string;
  port: number;
  buildServer: () => McpServer;
}): { port: number; stop: () => void } {
  const server = Bun.serve({
    hostname: MCP_HTTP_HOST,
    port: options.port,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/health" && req.method === "GET") {
        return Response.json({ status: "ok", name: options.name });
      }
      if (url.pathname === "/mcp") {
        return handleMcpRequest(req, options.buildServer);
      }
      return new Response("Not Found", { status: 404 });
    },
  });
  process.stderr.write(
    `${options.name}-mcp HTTP listening on http://${MCP_HTTP_HOST}:${server.port}/mcp\n`,
  );
  return { port: server.port ?? options.port, stop: () => server.stop(true) };
}
