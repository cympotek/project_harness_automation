#!/usr/bin/env node
/**
 * harness CLI entrypoint (Task 1.1 scaffold, wired to pipeline in Task 1.7).
 *
 * Parses `harness run` arguments, validates the task input (Core Rule 6 path
 * confinement via validateTaskInput), then calls the resume-aware entry point
 * (runTaskToCompletion).
 *
 * Exit codes:
 *   0 — status: "passed"
 *   1 — status: "escalated" or validation error
 *
 * ALLOWED_ROOTS (Core Rule 6):
 *   Resolved via `resolveAllowedRoots()`. When `ALLOWED_ROOTS` env var is unset or
 *   empty, falls back to `[resolvedRepo]` and logs a warning that path confinement is
 *   effectively disabled. Production deployments should set ALLOWED_ROOTS explicitly.
 */

import fs from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { Command } from "commander";
import { runTaskToCompletion } from "./reporter.js";
import { validateTaskInput } from "./schema.js";

// ---------------------------------------------------------------------------
// Pure helper: resolve ALLOWED_ROOTS — exported for unit testing (Fix 4)
// ---------------------------------------------------------------------------

/**
 * Resolves the list of allowed root paths for path confinement (Core Rule 6).
 *
 * When `envValue` is a non-empty string, splits on "," and trims/filters blanks.
 * When `envValue` is undefined or empty, falls back to `[repoPath]` and calls
 * `console.warn` so the fall-through is always visible in logs.
 *
 * @param repoPath  Absolute resolved path of the target repository.
 * @param envValue  Value of the `ALLOWED_ROOTS` environment variable, or `undefined`.
 */
export function resolveAllowedRoots(
  repoPath: string,
  envValue: string | undefined,
): string[] {
  if (envValue !== undefined && envValue.trim().length > 0) {
    return envValue
      .split(",")
      .map((r) => r.trim())
      .filter((r) => r.length > 0);
  }
  console.warn(
    "harness: ALLOWED_ROOTS env var not set or empty — path confinement is " +
      "effectively disabled (falling back to the target repo path itself). " +
      "Set ALLOWED_ROOTS for anything beyond local solo-dev use.",
  );
  return [repoPath];
}

// ---------------------------------------------------------------------------
// CLI setup
// ---------------------------------------------------------------------------

const program = new Command();

program
  .name("harness")
  .description(
    "Self-driving coding-agent harness: run → verify → loop → done or escalate.",
  )
  .version("0.1.0");

const runCmd = program
  .command("run")
  .description("Run the harness loop against a target repository.")
  .requiredOption("--task <id>", "Unique task identifier")
  .requiredOption("--repo <path>", "Absolute path to the target repository")
  .option(
    "--verify <cmd>",
    "Verification command to run after each agent attempt (repeatable)",
    (value: string, previous: string[]) => {
      return [...previous, value];
    },
    [] as string[],
  )
  .option(
    "--max-attempts <n>",
    "Maximum number of agent attempts before escalation (default: 3)",
    "3",
  )
  .action((opts: { task: string; repo: string; verify: string[]; maxAttempts: string }) => {
    const maxAttempts = parseInt(opts.maxAttempts, 10);
    if (isNaN(maxAttempts) || maxAttempts < 1) {
      console.error("Error: --max-attempts must be a positive integer");
      process.exit(1);
    }

    const resolvedRepo = path.resolve(opts.repo);
    const allowedRoots = resolveAllowedRoots(resolvedRepo, process.env["ALLOWED_ROOTS"]);

    const rawInput = {
      taskId: opts.task,
      description: `harness run: ${opts.task}`,
      targetRepoPath: resolvedRepo,
      verifyCommands: opts.verify,
      maxAttempts,
    };

    const validation = validateTaskInput(rawInput, allowedRoots);
    if (!validation.ok) {
      for (const err of validation.errors) {
        console.error(`Error: ${err}`);
      }
      process.exit(1);
    }

    const task = validation.value;

    runTaskToCompletion(task).then((result) => {
      process.exit(result.status === "passed" ? 0 : 1);
    }).catch((err: unknown) => {
      console.error("harness: unexpected error:", err);
      process.exit(1);
    });
  });

// Ensure --help on `run` subcommand also works cleanly.
void runCmd;

// Guard top-level parse so that importing this module for unit testing
// (e.g. to access resolveAllowedRoots) does not trigger argument parsing.
//
// fs.realpathSync is required here: npm's bin mechanism invokes this script
// through a symlink, so process.argv[1] is the symlink path. path.resolve()
// does NOT follow symlinks, so a plain resolve() comparison would always be
// false when invoked via `harness` (the npm bin symlink) — silently making
// the CLI a no-op in production. fs.realpathSync resolves the symlink before
// comparing, making both direct and symlinked invocations work correctly.
const isMain =
  process.argv[1] !== undefined &&
  fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  program.parse(process.argv);
}
