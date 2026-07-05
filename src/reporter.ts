/**
 * Reporter module (Task 1.6).
 *
 * Orchestrates the reporting and persistence wrapper around runLoop.
 * This module is responsible for "what to persist/print" — the retry logic
 * itself lives in loop-controller.ts.
 *
 * On `status: "passed"`:
 *   - Writes a StateFile with `status: "passed"` and `attemptCount` = number
 *     of attempts taken.
 *   - `lastSensorOutput`: the last attempt's sensor output joined as a string,
 *     or "all checks passed" if the last attempt had no sensor failures.
 *   - Prints EXACTLY ONE console.log line (Core Rule 10: small declarative
 *     status lines). No per-attempt lines from this function.
 *
 * On `status: "escalated"`:
 *   - Builds an EscalationArtifact from loopResult.attempts:
 *       - attemptHistory entries map each attempt's sensorResult to a string
 *         via JSON.stringify (consistent serialization; documents the full
 *         SensorRunResult shape for human inspection).
 *       - timestamp is the injected `now()` value for all entries (deterministic
 *         in tests; real wall-clock in production).
 *   - Writes the EscalationArtifact via writeEscalationFile.
 *   - ALSO writes a StateFile with `status: "escalated"`.
 *   - Prints ONE console.error escalation message (dual-channel per Core Rule 3).
 *
 * Returns the original LoopResult unchanged (reporter is a wrapper, not a
 * replacement for the loop result).
 *
 * Injectable opts for testability:
 *   - `runLoopFn`: fake loop that returns a pre-baked LoopResult.
 *   - `harnessDir`: points tests at a temp dir, never the real .harness/.
 *   - `now`: returns a fixed ISO timestamp so tests don't depend on wall-clock.
 */

import type { LoopResult } from "./loop-controller.js";
import { runLoop } from "./loop-controller.js";
import type { EscalationArtifact, StateFile, TaskInput } from "./schema.js";
import { writeEscalationFile, writeStateFile } from "./state-store.js";

// ---------------------------------------------------------------------------
// Injectable runLoop type alias
// ---------------------------------------------------------------------------

type RunLoopFn = (task: TaskInput) => Promise<LoopResult>;

// ---------------------------------------------------------------------------
// Helper: summarize sensor result to string
// ---------------------------------------------------------------------------

/**
 * Serializes a SensorRunResult (or undefined) to a string for use in
 * EscalationArtifact.attemptHistory[].sensorResult (which is typed as string).
 *
 * Uses JSON.stringify for consistency — provides the full shape for inspection.
 * Falls back to "no sensor result" when sensorResult is absent (agent timed out).
 */
function serializeSensorResult(
  sensorResult: LoopResult["attempts"][number]["sensorResult"],
): string {
  if (sensorResult === undefined) {
    return "no sensor result (agent attempt failed or timed out)";
  }
  return JSON.stringify(sensorResult);
}

// ---------------------------------------------------------------------------
// Helper: extract last sensor output string for StateFile.lastSensorOutput
// ---------------------------------------------------------------------------

function extractLastSensorOutput(result: LoopResult): string {
  // Walk attempts from last to first to find the last one with a sensor result.
  for (let i = result.attempts.length - 1; i >= 0; i--) {
    const attempt = result.attempts[i];
    if (attempt?.sensorResult !== undefined) {
      if (attempt.sensorResult.allPassed) {
        return "all checks passed";
      }
      // Collect failing command outputs.
      const failingOutputs = attempt.sensorResult.results
        .filter((r) => !r.passed)
        .map((r) => `[${r.command}]: ${r.output}`)
        .join("\n");
      return failingOutputs || "sensor run failed (no output captured)";
    }
  }
  return "no sensor result captured";
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

/**
 * Calls runLoop (or the injected fake) and handles persistence/reporting.
 *
 * @param task    Validated TaskInput.
 * @param opts    Injectable dependencies for testability.
 * @returns       The original LoopResult (unchanged — reporter is a wrapper).
 */
export async function runTaskToCompletion(
  task: TaskInput,
  opts?: {
    /** Fake loop function for tests. Defaults to the real runLoop. */
    runLoopFn?: RunLoopFn;
    /** Base harness directory. Defaults to .harness relative to cwd. */
    harnessDir?: string;
    /** Timestamp factory. Defaults to () => new Date().toISOString(). */
    now?: () => string;
  },
): Promise<LoopResult> {
  const loopFn = opts?.runLoopFn ?? runLoop;
  const harnessDir = opts?.harnessDir;
  const now = opts?.now ?? (() => new Date().toISOString());

  const loopResult = await loopFn(task);
  const timestamp = now();

  if (loopResult.status === "passed") {
    // --- Persist state file ---
    const state: StateFile = {
      taskId: task.taskId,
      attemptCount: loopResult.attempts.length,
      status: "passed",
      lastSensorOutput: extractLastSensorOutput(loopResult),
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    writeStateFile(state, harnessDir);

    // --- Print EXACTLY ONE done line (Core Rule 10 / DoD item a) ---
    console.log(
      `✓ task ${task.taskId} done — passed after ${loopResult.attempts.length} attempt(s)`,
    );
  } else {
    // status === "escalated"
    const maxAttempts = task.maxAttempts ?? 3;

    // --- Build EscalationArtifact ---
    const attemptHistory: EscalationArtifact["attemptHistory"] =
      loopResult.attempts.map((rec) => ({
        attempt: rec.attempt,
        sensorResult: serializeSensorResult(rec.sensorResult),
        timestamp,
      }));

    const artifact: EscalationArtifact = {
      taskId: task.taskId,
      attemptHistory,
      finalStatus: "escalated",
      reason: "max attempts exceeded",
    };

    // --- Write escalation file (Core Rule 3: dual-channel) ---
    writeEscalationFile(artifact, harnessDir);

    // --- ALSO write state file with status: escalated (Core Rule 5) ---
    const state: StateFile = {
      taskId: task.taskId,
      attemptCount: loopResult.attempts.length,
      status: "escalated",
      lastSensorOutput: extractLastSensorOutput(loopResult),
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    writeStateFile(state, harnessDir);

    // --- Print escalation message to console.error (Core Rule 3 / DoD item b) ---
    console.error(
      `✗ task ${task.taskId} escalated — exceeded ${maxAttempts} attempt(s) without passing sensors`,
    );
  }

  return loopResult;
}
