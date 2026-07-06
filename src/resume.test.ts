/**
 * Core DoD test for Task 1.7: Progress persistence and resume.
 *
 * Tests the "process killed after attempt 1's state write" scenario.
 *
 * Strategy:
 *   - Phase 1: call runTaskToCompletion with a fake runLoopFn that simulates the
 *     loop calling onAttempt for attempt 1, then throws (simulating a kill). The
 *     onAttempt callback writes a state file with status: "running", attemptCount: 1.
 *   - Phase 2: re-invoke runTaskToCompletion (same taskId, same harnessDir). It reads
 *     the persisted state, computes startAttempt=2, passes it to runLoop. The fake
 *     agent/sensor are called only for attempt 2 (not attempt 1 again). Loop passes.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LoopAttemptRecord, LoopResult } from "./loop-controller.js";
import { runTaskToCompletion } from "./reporter.js";
import { readStateFile, writeStateFile } from "./state-store.js";
import type { TaskInput } from "./schema.js";

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "harness-resume-test-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

const RESUME_TASK: TaskInput = {
  taskId: "resume-dod-task",
  description: "Task used to test resume behaviour",
  targetRepoPath: "/fake/repo",
  verifyCommands: ["npm test"],
  maxAttempts: 3,
};

// ---------------------------------------------------------------------------
// Core DoD test
// ---------------------------------------------------------------------------

describe("resume — core DoD: process killed after attempt 1, resumes at attempt 2", () => {
  it(
    "Phase 1 writes status:running/attemptCount:1; Phase 2 starts at attempt 2 and completes",
    async () => {
      // ===== Phase 1: simulate kill after attempt 1 =====
      //
      // We inject a fake runLoopFn that:
      //   a) calls onAttempt once (for attempt 1) to trigger the mid-loop state write
      //   b) returns a rejected promise to simulate process termination before the loop
      //      returns normally. Because runTaskToCompletion propagates the rejection, no
      //      final state write (status: passed/escalated) occurs — only the onAttempt
      //      write survives.

      const fakeRunLoopPhase1 = vi.fn(
        (
          _task: TaskInput,
          loopOpts?: {
            onAttempt?: (record: LoopAttemptRecord) => void;
            startAttempt?: number;
          },
        ): Promise<LoopResult> => {
          // Simulate attempt 1: agent ok, sensor fails
          const record: LoopAttemptRecord = {
            attempt: 1,
            agentResult: { ok: true, timedOut: false, output: "attempt 1 output" },
            sensorResult: {
              allPassed: false,
              results: [
                {
                  command: "npm test",
                  exitCode: 1,
                  passed: false,
                  timedOut: false,
                  output: "FAIL: 3 tests failed",
                },
              ],
            },
          };
          loopOpts?.onAttempt?.(record);

          // Simulate process kill — reject the promise before the loop returns
          return Promise.reject(new Error("simulated process kill after attempt 1"));
        },
      );

      // Phase 1 call: catch the rejection (the "kill")
      let phase1Threw = false;
      try {
        vi.spyOn(console, "log").mockImplementation(() => undefined);
        vi.spyOn(console, "error").mockImplementation(() => undefined);
        await runTaskToCompletion(RESUME_TASK, {
          runLoopFn: fakeRunLoopPhase1,
          harnessDir: tmpDir,
          now: () => "2026-01-01T00:01:00.000Z",
        });
      } catch {
        phase1Threw = true;
      }
      expect(phase1Threw).toBe(true);

      // The state file must exist with status: "running" and attemptCount: 1
      const priorState = readStateFile(RESUME_TASK.taskId, tmpDir);
      expect(priorState).not.toBeNull();
      expect(priorState!.status).toBe("running");
      expect(priorState!.attemptCount).toBe(1);
      expect(priorState!.taskId).toBe(RESUME_TASK.taskId);

      vi.restoreAllMocks();

      // ===== Phase 2: re-invoke (fresh process) — should resume at attempt 2 =====
      //
      // Use real runLoop with injected fake agent/sensor.
      // The resume-aware wrapper must pass startAttempt=2 to runLoop so the agent
      // is only called for attempt 2+ (not attempt 1 again).

      const fakeAgent = vi.fn(
        (): Promise<{ ok: true; timedOut: false; output: string }> =>
          Promise.resolve({ ok: true as const, timedOut: false as const, output: "attempt 2 done" }),
      );
      const fakeSensor = vi.fn(
        (): Promise<{
          allPassed: boolean;
          results: { command: string; exitCode: number; passed: boolean; timedOut: boolean; output: string }[];
        }> =>
          Promise.resolve({
            allPassed: true,
            results: [
              {
                command: "npm test",
                exitCode: 0,
                passed: true,
                timedOut: false,
                output: "All tests passed",
              },
            ],
          }),
      );

      vi.spyOn(console, "log").mockImplementation(() => undefined);

      const result2 = await runTaskToCompletion(RESUME_TASK, {
        runAgentAttemptFn: fakeAgent,
        runSensorsFn: fakeSensor,
        harnessDir: tmpDir,
        now: () => "2026-01-01T00:02:00.000Z",
      });

      // (a) Agent called ONCE — for attempt 2 only, not attempt 1 again
      expect(fakeAgent).toHaveBeenCalledTimes(1);
      expect(fakeSensor).toHaveBeenCalledTimes(1);

      // (b) Loop completed correctly (passed on attempt 2)
      expect(result2.status).toBe("passed");

      // (c) Final state file reflects total attempt count (2) and status passed
      const finalState = readStateFile(RESUME_TASK.taskId, tmpDir);
      expect(finalState).not.toBeNull();
      expect(finalState!.status).toBe("passed");
      expect(finalState!.attemptCount).toBe(2);

      // (d) createdAt from Phase 1 is preserved through Phase 2
      expect(finalState!.createdAt).toBe("2026-01-01T00:01:00.000Z");
    },
  );
});

// ---------------------------------------------------------------------------
// Additional resume edge cases
// ---------------------------------------------------------------------------

describe("resume — fresh start when no prior state exists", () => {
  it("starts at attempt 1 when no state file exists", async () => {
    let capturedStartAttempt: number | undefined;
    const fakeRunLoop = vi.fn(
      (
        _task: TaskInput,
        loopOpts?: {
          startAttempt?: number;
          onAttempt?: (record: LoopAttemptRecord) => void;
        },
      ): Promise<LoopResult> => {
        capturedStartAttempt = loopOpts?.startAttempt;
        const record: LoopAttemptRecord = {
          attempt: loopOpts?.startAttempt ?? 1,
          agentResult: { ok: true, timedOut: false, output: "done" },
          sensorResult: { allPassed: true, results: [] },
        };
        loopOpts?.onAttempt?.(record);
        return Promise.resolve({ status: "passed", attempts: [record] });
      },
    );

    vi.spyOn(console, "log").mockImplementation(() => undefined);

    await runTaskToCompletion(RESUME_TASK, {
      runLoopFn: fakeRunLoop,
      harnessDir: tmpDir,
      now: () => "T0",
    });

    // startAttempt must be 1 when no prior state
    expect(capturedStartAttempt).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Fix 1 boundary: crash after final passing attempt's onAttempt fires
// ---------------------------------------------------------------------------

describe("resume — Fix 1: onAttempt writes 'passed' status + short-circuit on resume", () => {
  it(
    "onAttempt writes status:'passed' when allPassed=true (1a); " +
    "resume short-circuits without calling agent (1b)",
    async () => {
      // Phase 1: the last attempt passes. onAttempt fires (writes "passed"), then
      // the process crashes before runLoop returns normally.
      const crashFakeRunLoop = vi.fn(
        (
          _task: TaskInput,
          loopOpts?: { onAttempt?: (r: LoopAttemptRecord) => void },
        ): Promise<LoopResult> => {
          const passingRecord: LoopAttemptRecord = {
            attempt: 3,
            agentResult: { ok: true, timedOut: false, output: "done" },
            sensorResult: { allPassed: true, results: [] },
          };
          // onAttempt fires — Fix 1a: must write status:"passed", not "running"
          loopOpts?.onAttempt?.(passingRecord);
          // Process crash before runLoop returns
          return Promise.reject(new Error("simulated crash after final passing attempt"));
        },
      );

      vi.spyOn(console, "log").mockImplementation(() => undefined);
      vi.spyOn(console, "error").mockImplementation(() => undefined);

      let crashed = false;
      try {
        await runTaskToCompletion(RESUME_TASK, {
          runLoopFn: crashFakeRunLoop,
          harnessDir: tmpDir,
          now: () => "2026-01-01T00:03:00.000Z",
        });
      } catch {
        crashed = true;
      }
      expect(crashed).toBe(true);

      // State file must show "passed" (Fix 1a: onAttempt wrote correct status)
      const midState = readStateFile(RESUME_TASK.taskId, tmpDir);
      expect(midState).not.toBeNull();
      expect(midState!.status).toBe("passed");
      expect(midState!.attemptCount).toBe(3);

      vi.restoreAllMocks();

      // Phase 2: resume — must NOT call runLoop (Fix 1b short-circuit)
      const phase2RunLoop = vi.fn((): Promise<LoopResult> =>
        Promise.resolve({ status: "passed", attempts: [] }),
      );

      vi.spyOn(console, "log").mockImplementation(() => undefined);

      const result2 = await runTaskToCompletion(RESUME_TASK, {
        runLoopFn: phase2RunLoop,
        harnessDir: tmpDir,
        now: () => "2026-01-01T00:04:00.000Z",
      });

      // runLoop NOT called (short-circuit on prior "passed" state)
      expect(phase2RunLoop).not.toHaveBeenCalled();
      expect(result2.status).toBe("passed");
    },
  );
});

// ---------------------------------------------------------------------------
// Fix 2: repair-prompt continuity across resume
// ---------------------------------------------------------------------------

describe("resume — Fix 2: prior sensor output seeded as initialRepairPrompt", () => {
  it("resumed attempt's agent call receives prior sensor failure as repair context", async () => {
    // Pre-write "running" state with a specific sensor failure text
    writeStateFile(
      {
        taskId: RESUME_TASK.taskId,
        attemptCount: 1,
        status: "running",
        lastSensorOutput: "[npm test]: FAIL: 5 tests failed in prior run",
        createdAt: "2026-01-01T00:01:00.000Z",
        updatedAt: "2026-01-01T00:01:00.000Z",
      },
      tmpDir,
    );

    // Capture the initialRepairPrompt that reporter passes to runLoop
    let capturedInitialRepairPrompt: string | undefined;
    const fakeRunLoop = vi.fn(
      (
        _task: TaskInput,
        loopOpts?: {
          startAttempt?: number;
          initialRepairPrompt?: string;
          onAttempt?: (r: LoopAttemptRecord) => void;
        },
      ): Promise<LoopResult> => {
        capturedInitialRepairPrompt = loopOpts?.initialRepairPrompt;
        const record: LoopAttemptRecord = {
          attempt: 2,
          agentResult: { ok: true, timedOut: false, output: "done" },
          sensorResult: { allPassed: true, results: [] },
        };
        loopOpts?.onAttempt?.(record);
        return Promise.resolve({ status: "passed", attempts: [record] });
      },
    );

    vi.spyOn(console, "log").mockImplementation(() => undefined);

    await runTaskToCompletion(RESUME_TASK, {
      runLoopFn: fakeRunLoop,
      harnessDir: tmpDir,
      now: () => "2026-01-01T00:02:00.000Z",
    });

    // Fix 2: initialRepairPrompt must contain the prior state's lastSensorOutput
    expect(capturedInitialRepairPrompt).toBeDefined();
    expect(capturedInitialRepairPrompt).toContain("FAIL: 5 tests failed in prior run");
  });
});

// ---------------------------------------------------------------------------
// Fix 3: escalation artifact includes synthetic marker for pre-crash history
// ---------------------------------------------------------------------------

describe("resume — Fix 3: escalation artifact has synthetic marker when resumed", () => {
  it("when startAttempt=2, attemptHistory[0] is a synthetic marker for prior crash", async () => {
    // Pre-write "running" state (crash happened after attempt 1)
    writeStateFile(
      {
        taskId: RESUME_TASK.taskId,
        attemptCount: 1,
        status: "running",
        lastSensorOutput: "npm test: FAIL in prior run",
        createdAt: "2026-01-01T00:01:00.000Z",
        updatedAt: "2026-01-01T00:01:30.000Z",
      },
      tmpDir,
    );

    // Resumed loop escalates (attempts 2 and 3 both fail; maxAttempts=3)
    const fakeAgent = vi.fn(
      (): Promise<{ ok: true; timedOut: false; output: string }> =>
        Promise.resolve({ ok: true as const, timedOut: false as const, output: "done" }),
    );
    const fakeSensor = vi.fn(
      (): Promise<{
        allPassed: boolean;
        results: { command: string; exitCode: number; passed: boolean; timedOut: boolean; output: string }[];
      }> =>
        Promise.resolve({
          allPassed: false,
          results: [
            { command: "npm test", exitCode: 1, passed: false, timedOut: false, output: "FAIL" },
          ],
        }),
    );

    vi.spyOn(console, "error").mockImplementation(() => undefined);

    await runTaskToCompletion(RESUME_TASK, {
      runAgentAttemptFn: fakeAgent,
      runSensorsFn: fakeSensor,
      harnessDir: tmpDir,
      now: () => "2026-01-01T00:02:00.000Z",
    });

    // Read escalation artifact
    const escPath = `${tmpDir}/escalations/${RESUME_TASK.taskId}.json`;
    const artifactJson = fs.readFileSync(escPath, "utf8");
    const artifact = JSON.parse(artifactJson) as {
      attemptHistory: { attempt: number; sensorResult: string; timestamp: string }[];
    };

    // Fix 3: first entry must be the synthetic marker (attempt 0)
    expect(artifact.attemptHistory.length).toBeGreaterThanOrEqual(1);
    expect(artifact.attemptHistory[0]!.attempt).toBe(0);
    expect(artifact.attemptHistory[0]!.sensorResult).toContain("resumed run");
    expect(artifact.attemptHistory[0]!.sensorResult).toContain("npm test: FAIL in prior run");

    // Subsequent entries are the actual resumed attempts (2 and 3)
    expect(artifact.attemptHistory[1]!.attempt).toBe(2);
    expect(artifact.attemptHistory[2]!.attempt).toBe(3);
  });
});

describe("resume — short-circuit when prior state is 'passed'", () => {
  it("does NOT call runLoop when prior state is 'passed' and returns passed (Fix 1b)", async () => {
    // Pre-write a "passed" state file (simulates a prior successful run whose final
    // state was written by onAttempt before the process crashed).
    writeStateFile(
      {
        taskId: RESUME_TASK.taskId,
        attemptCount: 2,
        status: "passed",
        lastSensorOutput: "all checks passed",
        createdAt: "OLD_CREATED",
        updatedAt: "OLD_UPDATED",
      },
      tmpDir,
    );

    let runLoopCalled = false;
    const fakeRunLoop = vi.fn((): Promise<LoopResult> => {
      runLoopCalled = true;
      return Promise.resolve({ status: "passed", attempts: [] });
    });

    vi.spyOn(console, "log").mockImplementation(() => undefined);

    const result = await runTaskToCompletion(RESUME_TASK, {
      runLoopFn: fakeRunLoop,
      harnessDir: tmpDir,
      now: () => "T_NEW",
    });

    // Fix 1b: prior "passed" state must cause short-circuit — runLoop never called
    expect(runLoopCalled).toBe(false);
    expect(fakeRunLoop).not.toHaveBeenCalled();
    // Result still reports passed
    expect(result.status).toBe("passed");
  });
});
