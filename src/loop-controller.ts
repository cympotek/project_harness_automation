/**
 * Loop controller module (Task 1.5).
 *
 * Orchestrates the agent runner → sensor runner retry cycle.
 *
 * Core Rule 1 (spec.md): sensors (`sensorResult.allPassed`) are the SOLE authority
 * on whether an attempt succeeded. The agent's own `ok` flag or output text never
 * determines "done".
 *
 * Core Rule 2 (spec.md): retries are capped at `task.maxAttempts ?? 3`. On sensor
 * failure, the sensor's failure output is passed VERBATIM as `repairPrompt` to the
 * next agent call — not paraphrased, not summarised. The loop never retries past the
 * cap.
 *
 * Scope for Task 1.5: pure in-memory orchestration only. Disk persistence (Task 1.7)
 * and escalation/completion reporting (Task 1.6) are handled by other modules.
 */

import type { AgentAttemptResult, QueryFn } from "./agent-runner.js";
import { runAgentAttempt } from "./agent-runner.js";
import type { ExecCommandFn, SensorRunResult } from "./sensor-runner.js";
import { runSensors } from "./sensor-runner.js";
import type { TaskInput } from "./schema.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Record of a single attempt within the retry loop.
 *
 * `sensorResult` is absent when the agent attempt itself failed or timed out
 * (i.e. `agentResult.ok === false`). In that case, there is no point running
 * sensors against a broken/timed-out agent output.
 */
export interface LoopAttemptRecord {
  /** 1-indexed attempt number. */
  attempt: number;
  /** Result from the agent runner for this attempt. */
  agentResult: AgentAttemptResult;
  /**
   * Result from the sensor runner for this attempt.
   * Absent when `agentResult.ok === false` (agent failed/timed out).
   */
  sensorResult?: SensorRunResult;
}

/**
 * Final result of the retry loop.
 *
 * `status: "passed"` means a sensor run returned `allPassed: true` within the cap.
 * `status: "escalated"` means the cap was reached without a passing sensor run.
 */
export interface LoopResult {
  status: "passed" | "escalated";
  /** Full attempt history in order (1-indexed). */
  attempts: LoopAttemptRecord[];
}

// ---------------------------------------------------------------------------
// Dependency-injection types (mirror the real function signatures)
// ---------------------------------------------------------------------------

/**
 * Injectable agent-runner function type.
 * Matches the signature of `runAgentAttempt` from agent-runner.ts.
 */
export type RunAgentAttemptFn = (
  task: TaskInput,
  opts?: {
    timeoutMs?: number;
    repairPrompt?: string;
    queryFn?: QueryFn;
  },
) => Promise<AgentAttemptResult>;

/**
 * Injectable sensor-runner function type.
 * Matches the signature of `runSensors` from sensor-runner.ts.
 */
export type RunSensorsFn = (
  verifyCommands: string[],
  targetRepoPath: string,
  opts?: {
    timeoutMs?: number;
    execFn?: ExecCommandFn;
  },
) => Promise<SensorRunResult>;

// ---------------------------------------------------------------------------
// Repair-prompt builder
// ---------------------------------------------------------------------------

/**
 * Builds the repair prompt text from a failed sensor run.
 *
 * For each command that did not pass, we include the command string and the
 * sensor's output verbatim (already redacted by sensor-runner; we don't alter
 * it further). We label which command it came from so the agent has useful
 * context, but we do not paraphrase or summarise the output itself — the
 * "verbatim" requirement in Core Rule 2 means the sensor's actual output
 * passes through unchanged, not that we cannot add structural labels.
 */
function buildRepairPrompt(sensorResult: SensorRunResult): string {
  const failingParts: string[] = [];

  for (const cmdResult of sensorResult.results) {
    if (!cmdResult.passed) {
      failingParts.push(
        `Command: ${cmdResult.command}\nOutput:\n${cmdResult.output}`,
      );
    }
  }

  if (failingParts.length === 0) {
    // Should never happen (caller only calls this when allPassed=false),
    // but return a safe fallback rather than an empty string.
    return "The previous sensor run reported a failure but no specific command output was captured.";
  }

  return (
    "The following verification commands failed. Fix the issues and try again.\n\n" +
    failingParts.join("\n\n---\n\n")
  );
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

/**
 * Runs the agent → sensor retry loop for a given task.
 *
 * Loop invariants:
 *   1. Runs at most `task.maxAttempts ?? 3` iterations (Core Rule 2).
 *   2. On sensor failure, the failing commands' output is fed verbatim as
 *      `repairPrompt` to the next agent call (Core Rule 2).
 *   3. If `agentResult.ok === false`, skip the sensor run for that iteration
 *      (no point verifying a broken attempt) and move to the next iteration.
 *   4. `sensorResult.allPassed === true` is the only exit condition for
 *      `status: "passed"` (Core Rule 1). The agent's `ok` or `output` never
 *      determine success.
 *   5. Reaching the attempt cap without `allPassed === true` → `status: "escalated"`.
 *
 * @param task   Validated TaskInput.
 * @param opts   Optional DI overrides for testing (fake agent/sensor runners).
 */
export async function runLoop(
  task: TaskInput,
  opts?: {
    runAgentAttemptFn?: RunAgentAttemptFn;
    runSensorsFn?: RunSensorsFn;
  },
): Promise<LoopResult> {
  const agentFn: RunAgentAttemptFn = opts?.runAgentAttemptFn ?? runAgentAttempt;
  const sensorFn: RunSensorsFn = opts?.runSensorsFn ?? runSensors;

  const maxAttempts = task.maxAttempts ?? 3;
  const attempts: LoopAttemptRecord[] = [];

  // `repairPrompt` is undefined on the first attempt; set to the sensor failure
  // output after each failed sensor run for subsequent attempts.
  let repairPrompt: string | undefined = undefined;

  for (let attemptNumber = 1; attemptNumber <= maxAttempts; attemptNumber++) {
    // (a) Call the agent runner — pass the previous iteration's sensor failure
    // output as repairPrompt (undefined on the first iteration).
    // Under exactOptionalPropertyTypes, we must omit the property entirely
    // rather than passing `repairPrompt: undefined` when there is no repair
    // context yet.
    const agentResult = await agentFn(
      task,
      repairPrompt !== undefined ? { repairPrompt } : {},
    );

    // (b) If the agent call itself failed or timed out, record the attempt without
    // a sensorResult and move to the next iteration. No point running sensors
    // against a broken/timed-out attempt.
    if (!agentResult.ok) {
      attempts.push({ attempt: attemptNumber, agentResult });
      // Don't update repairPrompt — there's no sensor output to pass on.
      // The next attempt will reuse the same repairPrompt (or none, if this
      // was the first attempt).
      continue;
    }

    // (c) Agent completed cleanly — run the sensors.
    const sensorResult = await sensorFn(task.verifyCommands, task.targetRepoPath);
    attempts.push({ attempt: attemptNumber, agentResult, sensorResult });

    // (d) Sensors are the SOLE authority (Core Rule 1). If they all passed, done.
    if (sensorResult.allPassed) {
      return { status: "passed", attempts };
    }

    // (e) Sensor failed — build the verbatim repair prompt for the next iteration.
    // If this was the last allowed attempt, the loop exits and we return "escalated"
    // below without using repairPrompt again.
    repairPrompt = buildRepairPrompt(sensorResult);
  }

  // Cap exceeded without a passing sensor run.
  return { status: "escalated", attempts };
}
