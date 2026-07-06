/**
 * Reporter module (Task 1.6, extended in Task 1.7).
 *
 * Orchestrates the reporting and persistence wrapper around runLoop.
 * This module is responsible for "what to persist/print" — the retry logic
 * itself lives in loop-controller.ts.
 *
 * Task 1.7 resume behaviour:
 *   Before calling runLoop, reads any existing state file for the task.
 *   - If `status: "passed"` is found, the task already completed (process crashed
 *     after onAttempt wrote the passing state). Short-circuit: skip runLoop and
 *     return {status:"passed",attempts:[]} immediately.
 *   - If `status: "running"` is found, computes `startAttempt = priorState.attemptCount + 1`
 *     and seeds the first resumed attempt's repair prompt from priorState.lastSensorOutput.
 *   - Otherwise (no prior state, or prior status "escalated"), starts fresh at attempt 1.
 *
 *   An `onAttempt` callback (injected into runLoop) writes state after every attempt:
 *     - `status: "passed"` if the attempt's sensor allPassed === true (closes the
 *       crash-after-final-attempt window — the file accurately reflects a pass the
 *       instant it happens).
 *     - `status: "running"` otherwise (mid-loop crash recovery marker).
 *
 * On final `status: "passed"` (loop returns normally):
 *   - Writes a StateFile with `status: "passed"` (final authoritative write).
 *   - `attemptCount` = actual attempt number of the last attempt (correct across resumes).
 *   - Prints EXACTLY ONE console.log line (Core Rule 10).
 *
 * On final `status: "escalated"`:
 *   - Builds an EscalationArtifact. When this is a resumed run (startAttempt > 1),
 *     prepends a synthetic marker entry so readers know the history is partial.
 *   - Writes the EscalationArtifact and a StateFile (status: escalated).
 *   - Prints ONE console.error message (Core Rule 3 dual-channel).
 *
 * Returns the original LoopResult unchanged (or a synthetic {status:"passed",attempts:[]}
 * for the already-completed short-circuit path).
 *
 * Injectable opts for testability:
 *   - `runLoopFn`: fake loop that returns a pre-baked LoopResult (backward compat).
 *   - `runAgentAttemptFn` / `runSensorsFn`: injected into the real runLoop.
 *   - `harnessDir`: points tests at a temp dir.
 *   - `now`: returns a fixed ISO timestamp for deterministic tests.
 */

import type { LoopAttemptRecord, LoopResult, RunAgentAttemptFn, RunSensorsFn } from "./loop-controller.js";
import { runLoop } from "./loop-controller.js";
import type { EscalationArtifact, StateFile, TaskInput } from "./schema.js";
import { readStateFile, writeEscalationFile, writeStateFile } from "./state-store.js";

// ---------------------------------------------------------------------------
// Injectable runLoop type alias (extended for Task 1.7 opts)
// ---------------------------------------------------------------------------

type RunLoopFn = (
  task: TaskInput,
  opts?: {
    startAttempt?: number;
    onAttempt?: (record: LoopAttemptRecord) => void;
    initialRepairPrompt?: string;
    runAgentAttemptFn?: RunAgentAttemptFn;
    runSensorsFn?: RunSensorsFn;
  },
) => Promise<LoopResult>;

// ---------------------------------------------------------------------------
// Helper: serialise sensor result for EscalationArtifact
// ---------------------------------------------------------------------------

function serializeSensorResult(
  sensorResult: LoopResult["attempts"][number]["sensorResult"],
): string {
  if (sensorResult === undefined) {
    return "no sensor result (agent attempt failed or timed out)";
  }
  return JSON.stringify(sensorResult);
}

// ---------------------------------------------------------------------------
// Helper: extract last sensor output string from a LoopResult
// ---------------------------------------------------------------------------

function extractLastSensorOutput(result: LoopResult): string {
  for (let i = result.attempts.length - 1; i >= 0; i--) {
    const attempt = result.attempts[i];
    if (attempt?.sensorResult !== undefined) {
      if (attempt.sensorResult.allPassed) {
        return "all checks passed";
      }
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
// Helper: extract sensor output from a single attempt record (for onAttempt)
// ---------------------------------------------------------------------------

function extractSensorOutputFromRecord(record: LoopAttemptRecord): string {
  if (record.sensorResult === undefined) {
    return "no sensor result (agent attempt failed or timed out)";
  }
  if (record.sensorResult.allPassed) {
    return "all checks passed";
  }
  const failingOutputs = record.sensorResult.results
    .filter((r) => !r.passed)
    .map((r) => `[${r.command}]: ${r.output}`)
    .join("\n");
  return failingOutputs || "sensor run failed (no output captured)";
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

/**
 * Resume-aware entry point: reads prior state, runs the loop (from the right
 * attempt), persists state after every attempt, and writes the final artifact.
 *
 * @param task    Validated TaskInput.
 * @param opts    Injectable dependencies for testability.
 * @returns       The original LoopResult (unchanged — reporter is a wrapper).
 */
export async function runTaskToCompletion(
  task: TaskInput,
  opts?: {
    /** Fake loop function for tests. When provided, runAgentAttemptFn/runSensorsFn are ignored. */
    runLoopFn?: RunLoopFn;
    /** Injected agent runner — passed through to the real runLoop when runLoopFn is absent. */
    runAgentAttemptFn?: RunAgentAttemptFn;
    /** Injected sensor runner — passed through to the real runLoop when runLoopFn is absent. */
    runSensorsFn?: RunSensorsFn;
    /** Base harness directory. Defaults to .harness relative to cwd. */
    harnessDir?: string;
    /** Timestamp factory. Defaults to () => new Date().toISOString(). */
    now?: () => string;
  },
): Promise<LoopResult> {
  const loopFn: RunLoopFn = opts?.runLoopFn ?? runLoop;
  const harnessDir = opts?.harnessDir;
  const now = opts?.now ?? (() => new Date().toISOString());

  // (a) Resume: read any persisted state for this task.
  const priorState = readStateFile(task.taskId, harnessDir);

  // Fix 1b: if prior state is already "passed" (process crashed after the final
  // attempt's onAttempt wrote the passing state, before runLoop returned), short-
  // circuit without calling the agent or sensors again.
  if (priorState?.status === "passed") {
    console.log(
      `✓ task ${task.taskId} done — already completed (resumed from prior state: passed)`,
    );
    return { status: "passed", attempts: [] };
  }

  const startAttempt =
    priorState?.status === "running" ? priorState.attemptCount + 1 : 1;

  // (b) Mid-loop persistence (Core Rule 5): write state after every attempt.
  //     Fix 1a: write status:"passed" when allPassed===true (not always "running").
  //     This closes the crash window between onAttempt and runLoop returning.
  const onAttempt = (record: LoopAttemptRecord): void => {
    const ts = now();
    // Accurately reflect the attempt outcome in the persisted status:
    //   passed  → onAttempt fires before runLoop returns; a crash here must not
    //             report a passed task as "running" on resume.
    //   running → normal mid-loop checkpoint; crash here triggers startAttempt+1.
    const midStatus: StateFile["status"] =
      record.sensorResult?.allPassed === true ? "passed" : "running";
    const midState: StateFile = {
      taskId: task.taskId,
      attemptCount: record.attempt,
      status: midStatus,
      lastSensorOutput: extractSensorOutputFromRecord(record),
      createdAt: ts,   // writeStateFile preserves existing createdAt automatically
      updatedAt: ts,
    };
    writeStateFile(midState, harnessDir);
  };

  // (c) Run the loop (real or fake) with resume + persistence hooks.
  //     Fix 2: seed the first resumed attempt's repair prompt from prior state.
  //     Omit optional fields that are undefined under exactOptionalPropertyTypes.
  const loopResult = await loopFn(task, {
    startAttempt,
    onAttempt,
    ...(startAttempt > 1 && priorState?.lastSensorOutput !== undefined
      ? { initialRepairPrompt: priorState.lastSensorOutput }
      : {}),
    ...(opts?.runAgentAttemptFn !== undefined
      ? { runAgentAttemptFn: opts.runAgentAttemptFn }
      : {}),
    ...(opts?.runSensorsFn !== undefined
      ? { runSensorsFn: opts.runSensorsFn }
      : {}),
  });

  const timestamp = now();

  // (d) Determine the actual total attempt count (last attempt's number, not array length).
  //     When resuming, attempts in this run start at N+1, so .length underestimates total.
  const lastRecord = loopResult.attempts[loopResult.attempts.length - 1];
  const totalAttemptCount = lastRecord?.attempt ?? startAttempt - 1;

  if (loopResult.status === "passed") {
    const state: StateFile = {
      taskId: task.taskId,
      attemptCount: totalAttemptCount,
      status: "passed",
      lastSensorOutput: extractLastSensorOutput(loopResult),
      createdAt: timestamp,   // writeStateFile preserves prior createdAt if file exists
      updatedAt: timestamp,
    };
    writeStateFile(state, harnessDir);

    console.log(
      `✓ task ${task.taskId} done — passed after ${totalAttemptCount} attempt(s)`,
    );
  } else {
    // status === "escalated"
    const maxAttempts = task.maxAttempts ?? 3;

    // Fix 3: when resuming (startAttempt > 1), prepend a synthetic marker entry so
    // that a human reading the escalation artifact knows the history is partial and
    // why — not silently seeing a history that starts at attempt 2 with no explanation.
    const resumeMarker: EscalationArtifact["attemptHistory"][number] | null =
      startAttempt > 1
        ? {
            attempt: 0,
            sensorResult:
              `[resumed run] attempts 1..${startAttempt - 1} occurred in a prior` +
              ` process invocation before a crash/restart; last known sensor output:` +
              ` ${priorState?.lastSensorOutput ?? "unknown"}`,
            timestamp: priorState?.updatedAt ?? timestamp,
          }
        : null;

    const currentAttemptHistory: EscalationArtifact["attemptHistory"] =
      loopResult.attempts.map((rec) => ({
        attempt: rec.attempt,
        sensorResult: serializeSensorResult(rec.sensorResult),
        timestamp,
      }));

    const attemptHistory: EscalationArtifact["attemptHistory"] =
      resumeMarker !== null
        ? [resumeMarker, ...currentAttemptHistory]
        : currentAttemptHistory;

    const artifact: EscalationArtifact = {
      taskId: task.taskId,
      attemptHistory,
      finalStatus: "escalated",
      reason: "max attempts exceeded",
    };

    writeEscalationFile(artifact, harnessDir);

    const state: StateFile = {
      taskId: task.taskId,
      attemptCount: totalAttemptCount,
      status: "escalated",
      lastSensorOutput: extractLastSensorOutput(loopResult),
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    writeStateFile(state, harnessDir);

    console.error(
      `✗ task ${task.taskId} escalated — exceeded ${maxAttempts} attempt(s) without passing sensors`,
    );
  }

  return loopResult;
}
