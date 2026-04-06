import { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

// Lightweight MCP client for calling other MCP servers (open-todos, open-mementos, open-conversations)
// Uses stdio to communicate with sibling MCP servers

interface McpClient {
  callTool(name: string, args: Record<string, unknown>): Promise<CallToolResult>;
}

let _client: McpClient | null = null;

export function getMcpClient(): McpClient {
  if (_client) return _client;

  // Lazy import to avoid circular deps
  // In production, this would use @modelcontextprotocol/sdk to create an MCP client
  // For now, we use a simple stdio-based approach
  _client = new SimpleMcpClient();
  return _client;
}

class SimpleMcpClient implements McpClient {
  private async callMcpServer(serverCommand: string, toolName: string, args: Record<string, unknown>): Promise<CallToolResult> {
    const { spawn } = await import("node:child_process");

    return new Promise((resolve) => {
      // Build JSON-RPC request
      const request = {
        jsonrpc: "2.0",
        id: Date.now(),
        method: "tools/call",
        params: {
          name: toolName,
          arguments: args,
        },
      };

      const child = spawn(serverCommand, ["--stdio"], {
        stdio: ["pipe", "pipe", "pipe"],
      });

      let stdout = "";
      let stderr = "";
      let settled = false;

      const settle = (result: CallToolResult) => {
        if (settled) return;
        settled = true;
        child.kill();
        resolve(result);
      };

      child.stdout?.on("data", (data) => {
        stdout += data.toString();
        // Try to parse complete JSON-RPC responses
        try {
          const lines = stdout.split("\n").filter(Boolean);
          for (const line of lines) {
            const parsed = JSON.parse(line);
            if (parsed.result || parsed.error) {
              settle(parsed.result ? parsed : { content: [{ type: "text", text: parsed.error?.message || "Unknown error" }], isError: true });
              return;
            }
          }
        } catch { /* incomplete, wait for more */ }
      });

      child.stderr?.on("data", (data) => { stderr += data.toString(); });

      child.on("close", () => {
        if (!stdout && stderr) {
          settle({ content: [{ type: "text", text: stderr }], isError: true });
        }
      });

      // Send request
      child.stdin?.write(JSON.stringify(request) + "\n");
      child.stdin?.end();

      // Short timeout for CLI usage - don't block user
      setTimeout(() => {
        settle({ content: [{ type: "text", text: "Timeout calling MCP server" }], isError: true });
      }, 2000);
    });
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<CallToolResult> {
    // Map tool names to their MCP server commands
    const serverMap: Record<string, string> = {
      // open-todos tools
      todos_create_project: "todos-mcp",
      todos_create_task: "todos-mcp",
      todos_get_project: "todos-mcp",

      // open-mementos tools
      mementos_register_project: "mementos-mcp",
      mementos_memory_save: "mementos-mcp",
      mementos_memory_list: "mementos-mcp",

      // open-conversations tools
      conversations_create_space: "conversations-mcp",
      conversations_send_message: "conversations-mcp",
    };

    const serverCmd = serverMap[name];
    if (!serverCmd) {
      return { content: [{ type: "text", text: `Unknown tool: ${name}` }], isError: true };
    }

    try {
      return await this.callMcpServer(serverCmd, name, args);
    } catch (err) {
      return {
        content: [{ type: "text", text: `Failed to call ${name}: ${err instanceof Error ? err.message : String(err)}` }],
        isError: true,
      };
    }
  }
}
