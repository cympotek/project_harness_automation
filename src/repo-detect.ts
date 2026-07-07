/**
 * repo-detect.ts — Task 2.3
 *
 * Resolves the target repository path using the following precedence:
 *
 *   1. opts.explicitRepo  — explicit CLI / API input always wins
 *   2. opts.listRoots()   — first entry from MCP roots/list
 *   3. opts.env.CLAUDE_PROJECT_DIR  — fallback environment variable
 *   4. throws             — never silently falls back to process.cwd()
 *
 * Design note: `listRoots` is injected as an async function so the real
 * MCP `roots/list` call can be wired in by a later task (2.4) without
 * changing this module, and so each fallback branch can be tested in
 * complete isolation.
 */

import * as path from "node:path";

export interface ResolveRepoPathOptions {
  /** An explicit repository path supplied by the caller (highest precedence). */
  explicitRepo?: string;
  /**
   * Async function that returns an ordered list of workspace roots.
   * In production this wraps the MCP `roots/list` request; in tests it is
   * replaced by a simple stub.  If the list is empty the next fallback is tried.
   */
  listRoots?: () => Promise<string[]>;
  /**
   * The environment variable map to inspect.  Defaults to `process.env`.
   * Injected explicitly so tests never depend on the ambient process env.
   */
  env?: NodeJS.ProcessEnv;
}

/**
 * Resolves the target repository path.
 *
 * @throws {Error} when no source can provide a path.
 */
export async function resolveRepoPath(
  opts: ResolveRepoPathOptions,
): Promise<string> {
  const { explicitRepo, listRoots, env = process.env } = opts;

  // 1. Explicit input wins unconditionally.
  if (explicitRepo !== undefined && explicitRepo !== "") {
    return path.resolve(explicitRepo);
  }

  // 2. MCP roots/list — use the first root returned.
  if (listRoots !== undefined) {
    const roots = await listRoots();
    if (roots.length > 0 && roots[0] !== undefined && roots[0] !== "") {
      return roots[0];
    }
  }

  // 3. CLAUDE_PROJECT_DIR environment variable.
  const fromEnv = env["CLAUDE_PROJECT_DIR"];
  if (fromEnv !== undefined && fromEnv !== "") {
    return fromEnv;
  }

  // 4. No source resolved — throw a clear, actionable error.
  throw new Error(
    "harness: could not resolve a target repo path — no explicit repo given, " +
      "no MCP roots available, and CLAUDE_PROJECT_DIR is unset",
  );
}
