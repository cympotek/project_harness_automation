/**
 * Sensor runner module (Task 1.4).
 *
 * Core Rule 1 (spec.md): sensors are the SOLE authority on whether an attempt
 * succeeded — never LLM judgment, only deterministic command exit codes.
 *
 * Core Rule 7 (spec.md): every sensor command runs with an explicit timeout.
 * A timeout counts as a failed attempt and must never hang the loop.
 *
 * ---
 * ## Execution order: sequential
 *
 * Commands run one at a time, in the order provided. Rationale: sensor suites
 * are typically ordered by dependency (lint → typecheck → test). Sequential
 * execution lets an earlier failure be observed before spending time on later
 * commands. Parallel execution would complicate resource accounting and is not
 * needed for the MVP single-task walking skeleton.
 *
 * ---
 * ## Process-kill safety (process-group kill)
 *
 * Each command is executed via Node's `child_process.spawn` with
 * `{ shell: true, detached: true }`. `detached: true` causes the shell to start
 * a new process group — the shell PID becomes the process group ID, and every
 * grandchild process (e.g. test workers spawned by `npm test`) joins the same
 * group. On timeout:
 *
 *   1. `SIGTERM` is sent to the entire process GROUP (on POSIX: via
 *      `process.kill(-pid, 'SIGTERM')`, where a negative pid targets the group).
 *      This ensures grandchildren die along with the shell wrapper — plain
 *      `child.kill()` only signals the immediate shell child, not descendants.
 *   2. After `SIGKILL_GRACE_MS` (500 ms), `SIGKILL` is sent to the process group
 *      unconditionally — terminates any process that ignored SIGTERM.
 *
 * On Windows, `detached: true` behaves differently (no real POSIX process groups).
 * We fall back to plain `child.kill()` on Windows; see `killProcessGroup()` below.
 * TODO: for complete Windows support, use `taskkill /T /PID <pid>`.
 *
 * The promise resolves only from the `close` event, which Node fires only after
 * the child process has exited AND all stdio streams are fully closed. This is
 * the authoritative "process is dead" signal — not `exit` (which fires before
 * stdio may be fully flushed) and not the kill call itself.
 *
 * ---
 * ## Redaction rule (spec.md "Data And Contracts")
 *
 * All captured stdout+stderr is passed through `redactOutput()` before being
 * stored in `SensorCommandResult.output`. This prevents secrets from leaking
 * into state files, escalation artifacts, or repair prompts.
 *
 * `redactOutput` is exported independently so it can be tested in isolation
 * and called by the loop controller (Task 1.5) on any other string that needs
 * the same treatment.
 *
 * **Critical ordering**: redaction is applied to the full raw string FIRST,
 * then truncation is applied to the (already-redacted) result. This ensures
 * fixed-length patterns like `AKIA[0-9A-Z]{16}` (exactly 16 chars) are never
 * split by truncation before the regex can match them.
 *
 * ---
 * ## Output truncation limit: 10 000 chars
 *
 * 10 000 characters is chosen to be large enough to capture meaningful error
 * output (a typical failing test suite is well under 10 k chars) while small
 * enough to avoid bloating state and escalation files with verbose output.
 */

import { spawn } from "node:child_process";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default per-command timeout (1 minute). Overridable via opts.timeoutMs. */
const DEFAULT_SENSOR_TIMEOUT_MS = 60_000;

/**
 * After sending SIGTERM on timeout, wait this long before escalating to SIGKILL.
 * 500 ms is generous enough for clean shutdown but short enough to not slow
 * timeouts noticeably in tests.
 */
const SIGKILL_GRACE_MS = 500;

/**
 * Max length (chars) of captured stdout+stderr before truncation.
 *
 * Rationale: large test output can be MBs; truncating at 10 000 chars is
 * sufficient to see the failure summary while keeping state files small.
 */
const MAX_OUTPUT_CHARS = 10_000;

/**
 * Secret patterns to redact from captured output (spec.md "Redaction rule").
 *
 * This list is intentionally small and clearly documented. It covers the three
 * highest-risk patterns for leaked secrets in CI/CD output:
 *
 * 1. OpenAI-style API keys   — "sk-" followed by 20+ alphanumeric characters
 * 2. GitHub personal tokens  — "ghp_" followed by 36+ alphanumeric characters
 * 3. AWS access key IDs      — "AKIA" followed by exactly 16 uppercase
 *                              alphanumeric characters
 *
 * The list is not exhaustive; new patterns should be added as real-world
 * leakage risks are identified.
 */
const REDACTION_PATTERNS: readonly RegExp[] = [
  /sk-[A-Za-z0-9]{20,}/g,
  /ghp_[A-Za-z0-9]{36,}/g,
  /AKIA[0-9A-Z]{16}/g,
];

const REDACTION_PLACEHOLDER = "[REDACTED]";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * The result of running one sensor command.
 */
export interface SensorCommandResult {
  /** The original command string, exactly as provided by the caller. */
  command: string;

  /**
   * Process exit code, or `null` if the process was forcibly killed before it
   * could produce an exit code (i.e., when `timedOut === true`).
   */
  exitCode: number | null;

  /**
   * `true` only when the process exited cleanly with `exitCode === 0`.
   * Always `false` when `timedOut === true`.
   */
  passed: boolean;

  /** `true` when the process was killed because it exceeded `timeoutMs`. */
  timedOut: boolean;

  /**
   * Combined stdout+stderr from the process, truncated to `MAX_OUTPUT_CHARS`
   * and scrubbed for known secret patterns before being stored here.
   * Never contains raw secrets.
   */
  output: string;
}

/**
 * The aggregate result of running all sensor commands for one attempt.
 */
export interface SensorRunResult {
  /**
   * `true` only when every command's `passed` field is `true`.
   * One timed-out or non-zero-exit command makes this `false`.
   */
  allPassed: boolean;

  /**
   * Per-command results, in the same order as the input `verifyCommands` array.
   */
  results: SensorCommandResult[];
}

/**
 * Injectable exec function type. Production code uses the default real-spawn
 * implementation. Pass a custom function via `opts.execFn` to substitute a
 * controlled implementation in integration tests that need precise control over
 * subprocess behaviour (e.g. testing SIGKILL escalation paths).
 */
export type ExecCommandFn = (
  command: string,
  cwd: string,
  timeoutMs: number,
) => Promise<SensorCommandResult>;

// ---------------------------------------------------------------------------
// Redaction helper (exported for independent testability)
// ---------------------------------------------------------------------------

/**
 * Scrubs known secret patterns from `raw`, then truncates to `MAX_OUTPUT_CHARS`.
 *
 * **Step order: REDACT first, TRUNCATE second.**
 *
 * Why this order matters:
 *   Some patterns in `REDACTION_PATTERNS` are fixed-length (e.g. `AKIA[0-9A-Z]{16}`
 *   requires exactly 16 chars after "AKIA"). If we truncated first, a key that
 *   straddles the truncation boundary would be split into a partial token shorter
 *   than the regex minimum — it would no longer match, leaking the key prefix in
 *   cleartext. Redacting the full raw string before truncation eliminates this
 *   class of boundary-split leaks entirely.
 *
 * Steps:
 *   1. Redact — each regex in `REDACTION_PATTERNS` is replaced globally with
 *      `[REDACTED]`. Applied to the full `raw` string so no boundary split occurs.
 *   2. Truncate — if the redacted result still exceeds `MAX_OUTPUT_CHARS`, keep
 *      the first `MAX_OUTPUT_CHARS` chars (where error summaries appear) and
 *      append a "[truncated N chars]" marker.
 *
 * This function is pure (no I/O) and safe to call on any string.
 */
export function redactOutput(raw: string): string {
  // Step 1: apply each redaction pattern to the full raw string.
  // Each pattern uses the /g flag; reset lastIndex before each call to avoid
  // stale state from a previous invocation.
  let output = raw;
  for (const pattern of REDACTION_PATTERNS) {
    pattern.lastIndex = 0;
    output = output.replace(pattern, REDACTION_PLACEHOLDER);
  }

  // Step 2: truncate the already-redacted result.
  if (output.length > MAX_OUTPUT_CHARS) {
    const excess = output.length - MAX_OUTPUT_CHARS;
    output =
      output.slice(0, MAX_OUTPUT_CHARS) + `\n...[truncated ${excess} chars]`;
  }

  return output;
}

// ---------------------------------------------------------------------------
// Default subprocess implementation
// ---------------------------------------------------------------------------

/**
 * Sends a signal to the process GROUP of `child` on POSIX, falling back to
 * the direct child signal on Windows.
 *
 * Why process-group kill:
 *   `spawn(command, { shell: true })` forks a shell, which may fork further
 *   grandchildren (e.g. test workers, bundlers). `child.kill(signal)` only
 *   signals the immediate shell process. On POSIX, sending to `-pid` (negative
 *   PID) addresses the entire process group, ensuring all descendants receive
 *   the signal. Combined with `detached: true` (which starts the shell as a new
 *   process group leader), this prevents orphaned grandchildren after timeout.
 *
 * Windows note:
 *   `detached: true` on Windows does NOT create a POSIX-style process group.
 *   `process.kill(-pid, signal)` would be misinterpreted. We fall back to
 *   `child.kill(signal)` on Windows; a full Windows fix would use
 *   `taskkill /T /PID <pid>` (out of scope for the POSIX-first MVP).
 */
function killProcessGroup(
  child: ReturnType<typeof spawn>,
  signal: "SIGTERM" | "SIGKILL",
): void {
  const pid = child.pid;

  if (process.platform !== "win32" && pid !== undefined) {
    // POSIX: kill entire process group. -pid = "send to the process group
    // whose ID is pid" (POSIX kill(2) semantics).
    try {
      process.kill(-pid, signal);
    } catch {
      // ESRCH: process group already gone — safe to ignore.
      // EPERM: restricted environment — best-effort fallback to direct kill.
      try {
        child.kill(signal);
      } catch {
        // Process is already dead; nothing to do.
      }
    }
  } else {
    // Windows fallback (or no PID — spawn failed before we got a PID).
    // TODO: for full Windows process-tree kill use `taskkill /T /PID <pid>`.
    try {
      child.kill(signal);
    } catch {
      // Already dead.
    }
  }
}

/**
 * Runs one shell command with an explicit timeout, captures combined
 * stdout+stderr, and returns a structured result.
 *
 * Process lifecycle:
 *   - `spawn(command, { shell: true, cwd, detached: true })` starts the command
 *     in a new process group (via `detached: true`) so killing the group also
 *     terminates grandchildren (e.g. test workers spawned by `npm test`).
 *   - After `timeoutMs`: SIGTERM is sent to the process GROUP and `timedOut` is
 *     set to `true`.
 *   - After `SIGKILL_GRACE_MS` more ms: SIGKILL is sent to the process group
 *     unconditionally.
 *   - The promise resolves from the `close` event, which fires only after the
 *     child process has exited AND all stdio streams are fully closed — this is
 *     the authoritative "process is dead" signal.
 *   - If the process exits before the timeout fires, all pending timers are
 *     cancelled inside `settle()`.
 */
function defaultExecCommand(
  command: string,
  cwd: string,
  timeoutMs: number,
): Promise<SensorCommandResult> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let timedOut = false;
    let settled = false;

    // sigkillTimer is set inside the timeout callback; declared here so
    // settle() can cancel it regardless of call order.
    let sigkillTimer: ReturnType<typeof setTimeout> | undefined = undefined;

    // `detached: true` starts the shell in a new process group so that
    // killProcessGroup() can signal all descendants, not just the shell itself.
    const child = spawn(command, { shell: true, cwd, detached: true });

    // Collect stdout and stderr into a shared buffer. The streams are async, so
    // interleaving order is not guaranteed — but combined diagnostic output is
    // sufficient for error reporting and repair prompts.
    child.stdout.on("data", (chunk: Buffer) => {
      chunks.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      chunks.push(chunk);
    });

    /**
     * Finalise the result exactly once. Guards against double-settle if both
     * `close` and `error` fire (which can happen in some edge cases on older
     * Node versions when ENOENT is raised before stdio is set up).
     */
    const settle = (exitCode: number | null): void => {
      if (settled) return;
      settled = true;

      // Cancel both timers — whichever is still pending.
      clearTimeout(timeoutTimer);
      clearTimeout(sigkillTimer);

      const rawOutput = Buffer.concat(chunks).toString("utf8");

      resolve({
        command,
        // exitCode is set to null when the process was killed by us (timedOut),
        // because the exit code in that case is signal-derived (e.g. -2 or 143)
        // and not a meaningful application exit code.
        exitCode: timedOut ? null : exitCode,
        passed: !timedOut && exitCode === 0,
        timedOut,
        output: redactOutput(rawOutput),
      });
    };

    // `close` fires after process exit AND stdio fully closed — preferred over
    // `exit` (which fires before stdio may be flushed).
    child.on("close", (code) => {
      settle(code);
    });

    // `error` covers ENOENT (command not found), EACCES, etc.
    child.on("error", () => {
      settle(null);
    });

    // Timeout: SIGTERM to the process group first, then SIGKILL after grace
    // period. `timeoutTimer` is a const; it is captured by the `settle` closure.
    const timeoutTimer = setTimeout(() => {
      timedOut = true;
      killProcessGroup(child, "SIGTERM");

      // Belt-and-suspenders: SIGKILL fires if any process in the group ignored
      // SIGTERM (e.g. a shell script that traps it).
      sigkillTimer = setTimeout(() => {
        killProcessGroup(child, "SIGKILL");
      }, SIGKILL_GRACE_MS);
    }, timeoutMs);
  });
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

/**
 * Runs each verify command in `verifyCommands` against `targetRepoPath`,
 * applying an explicit per-command timeout and redacting all output before
 * returning.
 *
 * Commands run SEQUENTIALLY (see module-level docs for rationale).
 *
 * @param verifyCommands  Shell command strings to execute.
 *                        E.g. `["npm run lint", "npm run typecheck", "npm test"]`.
 * @param targetRepoPath  Working directory (`cwd`) for every command.
 * @param opts.timeoutMs  Per-command wall-clock timeout in ms.
 *                        Default: `DEFAULT_SENSOR_TIMEOUT_MS` (60 000 ms).
 * @param opts.execFn     Injectable exec implementation. Defaults to the real
 *                        subprocess implementation above. Pass a custom function
 *                        only when you need precise control over subprocess
 *                        behaviour in an integration test.
 */
export async function runSensors(
  verifyCommands: string[],
  targetRepoPath: string,
  opts?: {
    timeoutMs?: number;
    execFn?: ExecCommandFn;
  },
): Promise<SensorRunResult> {
  const timeoutMs = opts?.timeoutMs ?? DEFAULT_SENSOR_TIMEOUT_MS;
  const execFn = opts?.execFn ?? defaultExecCommand;

  const results: SensorCommandResult[] = [];

  for (const command of verifyCommands) {
    // Await each command before starting the next (sequential execution).
    const result = await execFn(command, targetRepoPath, timeoutMs);
    results.push(result);
  }

  return {
    // `Array.prototype.every` returns true on empty arrays (vacuous truth),
    // so an empty verifyCommands list is treated as "all passed".
    allPassed: results.every((r) => r.passed),
    results,
  };
}
