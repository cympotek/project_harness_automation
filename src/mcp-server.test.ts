/**
 * Smoke test for the MCP server entrypoint (Task 2.1 DoD).
 *
 * DoD: `node dist/mcp-server.js` starts and exits cleanly on stdin close.
 *
 * Strategy: spawn `dist/mcp-server.js` as a child process, immediately close
 * its stdin (simulating a client disconnect), and assert the process exits with
 * code 0 within a reasonable timeout.
 */

import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST_ENTRY = path.resolve(__dirname, "../dist/mcp-server.js");

describe("mcp-server entrypoint (task 2.1)", () => {
  it("exits with code 0 when stdin is closed", async () => {
    const exitCode = await new Promise<number | null>((resolve, reject) => {
      const child = spawn(process.execPath, [DIST_ENTRY], {
        stdio: ["pipe", "pipe", "pipe"],
      });

      // Give the process a timeout so the test doesn't hang forever.
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new Error("mcp-server did not exit within 5 s after stdin close"));
      }, 5_000);

      child.on("exit", (code) => {
        clearTimeout(timer);
        resolve(code);
      });

      child.on("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });

      // Close stdin immediately — server should detect EOF and exit cleanly.
      child.stdin?.end();
    });

    expect(exitCode).toBe(0);
  });
});
