/**
 * Unit tests for resolveRepoPath (Task 2.3).
 *
 * Each test covers exactly one fallback branch in isolation so that
 * precedence is documented and verifiable independently.
 */

import { describe, it, expect, vi } from "vitest";
import * as path from "node:path";
import { resolveRepoPath } from "./repo-detect.js";

describe("resolveRepoPath", () => {
  // ── Branch 1: explicit repo wins ─────────────────────────────────────

  it("returns an absolute path from explicitRepo when given a relative path", async () => {
    const result = await resolveRepoPath({
      explicitRepo: "some/relative/dir",
      listRoots: () => Promise.resolve(["/other/root"]),
      env: { CLAUDE_PROJECT_DIR: "/env/dir" },
    });
    expect(path.isAbsolute(result)).toBe(true);
    expect(result).toBe(path.resolve("some/relative/dir"));
  });

  it("returns the absolute path unchanged when explicitRepo is already absolute", async () => {
    const result = await resolveRepoPath({
      explicitRepo: "/my/absolute/repo",
      listRoots: () => Promise.resolve(["/other/root"]),
      env: { CLAUDE_PROJECT_DIR: "/env/dir" },
    });
    expect(result).toBe("/my/absolute/repo");
  });

  it("explicit repo wins even when listRoots and env are also set", async () => {
    const listRoots = vi.fn(() => Promise.resolve(["/from-mcp"]));
    const result = await resolveRepoPath({
      explicitRepo: "/explicit/path",
      listRoots,
      env: { CLAUDE_PROJECT_DIR: "/env/dir" },
    });
    expect(result).toBe("/explicit/path");
    expect(listRoots).not.toHaveBeenCalled();
  });

  // ── Branch 2: MCP roots/list ──────────────────────────────────────────

  it("returns first MCP root when no explicitRepo but listRoots is provided", async () => {
    const result = await resolveRepoPath({
      listRoots: () => Promise.resolve(["/mcp/root/one", "/mcp/root/two"]),
      env: { CLAUDE_PROJECT_DIR: "/env/dir" },
    });
    expect(result).toBe("/mcp/root/one");
  });

  it("listRoots wins over env when no explicitRepo", async () => {
    const result = await resolveRepoPath({
      listRoots: () => Promise.resolve(["/mcp/root"]),
      env: { CLAUDE_PROJECT_DIR: "/env/dir" },
    });
    expect(result).toBe("/mcp/root");
  });

  // ── Branch 3: CLAUDE_PROJECT_DIR env ─────────────────────────────────

  it("uses CLAUDE_PROJECT_DIR when listRoots returns an empty array", async () => {
    const result = await resolveRepoPath({
      listRoots: () => Promise.resolve([]),
      env: { CLAUDE_PROJECT_DIR: "/from-env" },
    });
    expect(result).toBe("/from-env");
  });

  it("uses CLAUDE_PROJECT_DIR when listRoots is not provided", async () => {
    const result = await resolveRepoPath({
      env: { CLAUDE_PROJECT_DIR: "/from-env-only" },
    });
    expect(result).toBe("/from-env-only");
  });

  // ── Branch 4: no resolution — must throw ─────────────────────────────

  it("throws a clear error when no source resolves a path", async () => {
    await expect(
      resolveRepoPath({
        listRoots: () => Promise.resolve([]),
        env: {},
      }),
    ).rejects.toThrow(
      "harness: could not resolve a target repo path — no explicit repo given, no MCP roots available, and CLAUDE_PROJECT_DIR is unset",
    );
  });

  it("throws when listRoots is omitted and CLAUDE_PROJECT_DIR is unset", async () => {
    await expect(
      resolveRepoPath({
        env: {},
      }),
    ).rejects.toThrow("harness: could not resolve a target repo path");
  });

  it("treats an empty string CLAUDE_PROJECT_DIR as unset", async () => {
    await expect(
      resolveRepoPath({
        env: { CLAUDE_PROJECT_DIR: "" },
      }),
    ).rejects.toThrow("harness: could not resolve a target repo path");
  });

  it("does NOT silently fall back to process.cwd()", async () => {
    const cwd = process.cwd();
    await expect(
      resolveRepoPath({
        env: {},
      }),
    ).rejects.toThrow();
    // The rejection message must not be the empty string (i.e., a real error)
    // and the cwd-as-path expectation is confirmed by the throw itself.
    void cwd; // suppress unused-variable lint warning
  });
});
