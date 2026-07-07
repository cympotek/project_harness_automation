/**
 * harness-loop MCP server entrypoint (Task 2.1 scaffold).
 *
 * Starts a stdio MCP server with zero tools registered.  Later tasks (2.2+)
 * wire the `harness_run` tool to the existing `runTaskToCompletion()` pipeline.
 *
 * Exit behaviour:
 *   - When stdin reaches EOF (client disconnects) the server closes cleanly
 *     and the process exits with code 0.
 *   - Unhandled errors are logged to stderr and the process exits with code 1.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

async function main(): Promise<void> {
  const server = new McpServer({
    name: "harness-loop",
    version: "0.1.0",
  });

  const transport = new StdioServerTransport();

  // Connect the server to stdio transport.  The SDK handles MCP initialization
  // handshake automatically; no tools are registered yet (Task 2.1 scaffold).
  await server.connect(transport);

  // StdioServerTransport does not listen for stdin's 'end' event on its own.
  // Wire it here so the process exits cleanly when the client closes stdin.
  process.stdin.on("end", () => {
    server.close().catch((err: unknown) => {
      console.error("harness mcp-server: error closing server", err);
    });
  });
}

main().catch((err: unknown) => {
  console.error("harness mcp-server: fatal error", err);
  process.exit(1);
});
