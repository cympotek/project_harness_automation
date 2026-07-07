/**
 * verify-detect.ts (Task 2.2)
 *
 * Given a resolved repo path, reads `<repoPath>/package.json` and detects
 * which of the standard verification scripts are present.  Returns them as
 * `["npm run <name>", ...]` in a fixed order: lint → typecheck/type-check →
 * test.
 *
 * Error behaviour: returns [] (does not throw) for:
 *   - missing package.json
 *   - malformed JSON
 *   - no `scripts` key
 *   - none of the relevant script keys present
 *
 * Pure function — the only I/O is a synchronous file read.
 */

import fs from "node:fs";
import path from "node:path";

/**
 * Detect which standard verify commands are configured in the repo's
 * package.json.
 *
 * Detection order (fixed):
 *   1. `scripts.lint`            → "npm run lint"
 *   2. `scripts.typecheck`       → "npm run typecheck"
 *      OR `scripts["type-check"]`→ "npm run type-check"  (if typecheck absent)
 *   3. `scripts.test`            → "npm run test"
 *
 * @param repoPath - Absolute path to the root of the target repository.
 * @returns Array of npm run commands for each detected script, in the order
 *          defined above.  Returns an empty array on any read / parse error.
 */
export function detectVerifyCommands(repoPath: string): string[] {
  const pkgPath = path.join(repoPath, "package.json");

  // Read the file — return [] if it does not exist or cannot be read.
  let raw: string;
  try {
    raw = fs.readFileSync(pkgPath, "utf8");
  } catch {
    return [];
  }

  // Parse — return [] on malformed JSON.
  let pkg: unknown;
  try {
    pkg = JSON.parse(raw);
  } catch {
    return [];
  }

  // Validate shape — must be a non-null object with a `scripts` object.
  if (typeof pkg !== "object" || pkg === null) {
    return [];
  }

  const scripts: unknown = (pkg as Record<string, unknown>)["scripts"];
  if (typeof scripts !== "object" || scripts === null) {
    return [];
  }

  const s = scripts as Record<string, unknown>;
  const commands: string[] = [];

  // 1. lint
  if (typeof s["lint"] === "string") {
    commands.push("npm run lint");
  }

  // 2. typecheck (preferred) or type-check (fallback)
  if (typeof s["typecheck"] === "string") {
    commands.push("npm run typecheck");
  } else if (typeof s["type-check"] === "string") {
    commands.push("npm run type-check");
  }

  // 3. test
  if (typeof s["test"] === "string") {
    commands.push("npm run test");
  }

  return commands;
}
