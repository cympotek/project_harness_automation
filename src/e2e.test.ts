/**
 * End-to-end smoke test (Task 1.8).
 *
 * Exercises the FULL CLI pipeline via subprocess: schema validation → agent runner
 * → sensor runner → loop controller → reporter → state persistence — all wired
 * together exactly as a real user invocation would run them.
 *
 * Fake agent (HARNESS_FAKE_AGENT):
 *   The subprocess is started with `HARNESS_FAKE_AGENT=fix-failing-test` in its
 *   environment. This activates a deterministic fake agent path inside
 *   `src/agent-runner.ts` (see that file for full documentation) that:
 *     - Attempt 1 (no repair prompt): writes a wrong value ("0") to the fixture's
 *       `answer.txt`, so the check script still fails.
 *     - Attempt 2+ (repair prompt present — "The following verification commands
 *       failed" is present in the combined prompt): writes the correct value ("42"),
 *       so the check script passes for real.
 *   This means the test genuinely exercises the full retry + repair-prompt-feedback
 *   path: attempt 1 fails, the sensor output is fed back verbatim, attempt 2 reads
 *   the repair context and succeeds.
 *
 * Fixture repo (created fresh per test, never committed):
 *   - `answer.txt`: starts with "41" (wrong value; the check expects "42").
 *   - `check.js`:   CJS script — reads `answer.txt`, exits 0 if content is "42",
 *                   exits 1 otherwise. Dependency-free: no package.json, no npm install.
 *
 * Build approach:
 *   `beforeAll` always invokes `npm run build` to guarantee the subprocess runs the
 *   latest compiled `dist/cli.js`. The standard CI sequence is `npm run build &&
 *   npm test`, so this is a fast no-op when called after a fresh build; locally it
 *   makes `npm test` self-contained after any source change.
 *
 * Real-SDK opt-in:
 *   A second `describe` block (guarded by `HARNESS_E2E_REAL_SDK=1` in the
 *   environment) contains a test that omits `HARNESS_FAKE_AGENT` and thus invokes
 *   the real Anthropic SDK. This is **skipped by default** (the DoD requirement is
 *   mocked-SDK only). Set `HARNESS_E2E_REAL_SDK=1` locally if you want to run a
 *   real-SDK smoke test.
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/** Worktree root — one level up from src/. */
const PROJECT_ROOT = path.resolve(__dirname, "..");

/** Compiled CLI entry point. */
const CLI_PATH = path.join(PROJECT_ROOT, "dist", "cli.js");

// ---------------------------------------------------------------------------
// Build (beforeAll — always rebuild so test tracks latest compiled code)
// ---------------------------------------------------------------------------

beforeAll(() => {
  const buildResult = spawnSync("npm", ["run", "build"], {
    cwd: PROJECT_ROOT,
    shell: true,
    // Inherit stderr so TypeScript compile errors appear in test output.
    stdio: ["ignore", "pipe", "inherit"],
    timeout: 120_000,
  });
  if (buildResult.status !== 0) {
    throw new Error(
      "npm run build failed — cannot run e2e tests without a built dist/cli.js.\n" +
        (buildResult.stdout?.toString() ?? ""),
    );
  }
}, 120_000);

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

/** Absolute path to the fixture directory for the current test. */
let fixtureDir: string;

const TASK_ID = "e2e-smoke-1";

/** Content that makes check.js FAIL (initial broken state). */
const ANSWER_BROKEN = "41";

/** check.js — CJS, no npm install needed, dependency-free. */
const CHECK_SCRIPT = `
// check.js — fixture check script for task-1.8 e2e test.
// Reads answer.txt and exits 0 if its trimmed content is "42", else exits 1.
const fs = require('fs');
const answer = fs.readFileSync('answer.txt', 'utf8').trim();
if (answer === '42') {
  process.stdout.write('PASS: answer is 42\\n');
  process.exit(0);
} else {
  process.stderr.write('FAIL: expected 42, got ' + answer + '\\n');
  process.exit(1);
}
`.trimStart();

beforeEach(() => {
  fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), "harness-e2e-"));
  fs.writeFileSync(path.join(fixtureDir, "answer.txt"), ANSWER_BROKEN, "utf8");
  fs.writeFileSync(path.join(fixtureDir, "check.js"), CHECK_SCRIPT, "utf8");
});

afterEach(() => {
  fs.rmSync(fixtureDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Mocked-SDK e2e test (DoD requirement — always runs in CI)
// ---------------------------------------------------------------------------

describe("e2e smoke: mocked-SDK path (HARNESS_FAKE_AGENT)", () => {
  it(
    "runs the full CLI loop; fake agent fails on attempt 1, fixes on attempt 2; exits 0 and writes status:passed",
    () => {
      // Build the child env: inherit everything, override/add our keys.
      const childEnv: Record<string, string> = {};
      for (const [k, v] of Object.entries(process.env)) {
        if (v !== undefined) {
          childEnv[k] = v;
        }
      }
      // Activate the fake agent (TEST-ONLY escape hatch in agent-runner.ts).
      childEnv["HARNESS_FAKE_AGENT"] = "fix-failing-test";
      // Confine the harness to the fixture dir (Core Rule 6).
      childEnv["ALLOWED_ROOTS"] = fixtureDir;
      // Unset real API key — the fake agent never calls the SDK, but being
      // explicit here prevents any accidental real Anthropic call if the
      // escape-hatch logic were ever bypassed.
      delete childEnv["ANTHROPIC_API_KEY"];

      const result = spawnSync(
        process.execPath,
        [
          CLI_PATH,
          "run",
          "--task",
          TASK_ID,
          "--repo",
          fixtureDir,
          "--verify",
          "node check.js",
          "--max-attempts",
          "3",
        ],
        {
          cwd: fixtureDir,
          env: childEnv,
          timeout: 30_000,
          encoding: "utf8",
        },
      );

      // (a) CLI must exit 0 (status: "passed").
      expect(
        result.status,
        `CLI exited ${result.status ?? "null"}.\nstdout: ${result.stdout}\nstderr: ${result.stderr}`,
      ).toBe(0);

      // (b) State file must exist with status: "passed".
      const stateFilePath = path.join(
        fixtureDir,
        ".harness",
        "state",
        `${TASK_ID}.json`,
      );
      expect(
        fs.existsSync(stateFilePath),
        `State file not found at ${stateFilePath}`,
      ).toBe(true);

      const stateRaw = fs.readFileSync(stateFilePath, "utf8");
      const state = JSON.parse(stateRaw) as {
        taskId: string;
        status: string;
        attemptCount: number;
      };
      expect(state.status).toBe("passed");

      // (c) Must have taken at least 2 attempts — confirms the retry loop and
      //     repair-prompt-feedback path were genuinely exercised (not a trivial
      //     first-attempt pass).
      expect(
        state.attemptCount,
        `Expected at least 2 attempts (to exercise retry loop), got ${state.attemptCount}`,
      ).toBeGreaterThanOrEqual(2);

      // (d) answer.txt must now contain "42" — confirms the fake agent made a
      //     real file-system change, not a fake/no-op "pretend it passed".
      const finalAnswer = fs.readFileSync(
        path.join(fixtureDir, "answer.txt"),
        "utf8",
      );
      expect(finalAnswer.trim()).toBe("42");
    },
    30_000,
  );
});

// ---------------------------------------------------------------------------
// Real-SDK opt-in test (NOT part of DoD; skipped by default)
// ---------------------------------------------------------------------------

describe.skipIf(process.env["HARNESS_E2E_REAL_SDK"] !== "1")(
  "e2e smoke: real-SDK path (opt-in, set HARNESS_E2E_REAL_SDK=1 to run locally)",
  () => {
    it(
      "spawns CLI without HARNESS_FAKE_AGENT — real Anthropic SDK call (requires auth)",
      () => {
        // This test is intentionally minimal: just confirm the CLI starts,
        // runs at least one attempt, and either passes or escalates (both are
        // valid — the fixture repo has no CLAUDE.md and the real SDK may or may
        // not fix the file in one shot).
        const childEnv: Record<string, string> = {};
        for (const [k, v] of Object.entries(process.env)) {
          if (v !== undefined) {
            childEnv[k] = v;
          }
        }
        childEnv["ALLOWED_ROOTS"] = fixtureDir;
        // Do NOT set HARNESS_FAKE_AGENT — the real SDK will be used.

        const result = spawnSync(
          process.execPath,
          [
            CLI_PATH,
            "run",
            "--task",
            TASK_ID,
            "--repo",
            fixtureDir,
            "--verify",
            "node check.js",
            "--max-attempts",
            "2",
          ],
          {
            cwd: fixtureDir,
            env: childEnv,
            timeout: 120_000,
            encoding: "utf8",
          },
        );

        // Exit code 0 (passed) or 1 (escalated) are both acceptable outcomes.
        expect(result.status === 0 || result.status === 1).toBe(true);

        // State file must exist regardless of outcome.
        const stateFilePath = path.join(
          fixtureDir,
          ".harness",
          "state",
          `${TASK_ID}.json`,
        );
        expect(fs.existsSync(stateFilePath)).toBe(true);
      },
      120_000,
    );
  },
);
