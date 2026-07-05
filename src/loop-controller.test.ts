/**
 * Tests for loop-controller.ts (Task 1.5).
 *
 * TDD approach: these tests are written BEFORE the implementation exists.
 * Running them now should produce RED (module not found).
 *
 * Test strategy: all fake/injected functions via DI — no real SDK or subprocess calls.
 *
 * Core rules under test:
 *   - Core Rule 1: sensors (allPassed) are the SOLE authority on success.
 *   - Core Rule 2: capped retries; repair prompt is verbatim sensor failure output.
 */

import { describe, expect, it, vi } from "vitest";
import type { AgentAttemptResult } from "./agent-runner.js";
import type { SensorRunResult } from "./sensor-runner.js";
import type { TaskInput } from "./schema.js";
import { runLoop } from "./loop-controller.js";

// ---------------------------------------------------------------------------
// Helpers to build fake runners
// ---------------------------------------------------------------------------

const BASE_TASK: TaskInput = {
  taskId: "test-1",
  description: "Fix the bug",
  targetRepoPath: "/fake/repo",
  verifyCommands: ["npm test"],
};

/** Returns an AgentAttemptResult with ok=true by default. */
function makeAgentResult(overrides?: Partial<AgentAttemptResult>): AgentAttemptResult {
  return {
    ok: true,
    timedOut: false,
    output: "agent completed",
    ...overrides,
  };
}

/** Returns a SensorRunResult with allPassed=false and a failure output. */
function makeFailedSensorResult(output = "Tests failed: 2 failing"): SensorRunResult {
  return {
    allPassed: false,
    results: [
      {
        command: "npm test",
        exitCode: 1,
        passed: false,
        timedOut: false,
        output,
      },
    ],
  };
}

/** Returns a SensorRunResult with allPassed=true. */
function makePassedSensorResult(): SensorRunResult {
  return {
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
  };
}

// ---------------------------------------------------------------------------
// Test: fails twice then succeeds on 3rd attempt (Core Rule 2)
// ---------------------------------------------------------------------------

describe("runLoop — fails twice then succeeds on 3rd attempt", () => {
  it("returns status=passed, attempts.length=3, with correct repair prompts", async () => {
    const agentResults = [
      makeAgentResult({ output: "attempt 1 done" }),
      makeAgentResult({ output: "attempt 2 done" }),
      makeAgentResult({ output: "attempt 3 done" }),
    ];
    const sensorResults = [
      makeFailedSensorResult("Error: test suite failed on attempt 1"),
      makeFailedSensorResult("Error: test suite failed on attempt 2"),
      makePassedSensorResult(),
    ];

    let agentCallIdx = 0;
    const agentCalls: Array<{ repairPrompt: string | undefined }> = [];
    const fakeAgent = vi.fn((_task: TaskInput, opts?: { repairPrompt?: string }) => {
      agentCalls.push({ repairPrompt: opts?.repairPrompt });
      return Promise.resolve(agentResults[agentCallIdx++]!);
    });

    let sensorCallIdx = 0;
    const fakeSensor = vi.fn(() => Promise.resolve(sensorResults[sensorCallIdx++]!));

    const result = await runLoop(BASE_TASK, {
      runAgentAttemptFn: fakeAgent,
      runSensorsFn: fakeSensor,
    });

    // Final status is passed
    expect(result.status).toBe("passed");

    // Exactly 3 attempts recorded
    expect(result.attempts).toHaveLength(3);

    // Attempt 1: no repairPrompt on first call
    expect(agentCalls[0]!.repairPrompt).toBeUndefined();

    // Attempt 2: repairPrompt must contain attempt 1's sensor failure output verbatim
    expect(agentCalls[1]!.repairPrompt).toBeDefined();
    expect(agentCalls[1]!.repairPrompt).toContain(
      "Error: test suite failed on attempt 1",
    );

    // Attempt 3: repairPrompt must contain attempt 2's sensor failure output verbatim
    expect(agentCalls[2]!.repairPrompt).toBeDefined();
    expect(agentCalls[2]!.repairPrompt).toContain(
      "Error: test suite failed on attempt 2",
    );

    // Agent and sensor each called exactly 3 times
    expect(fakeAgent).toHaveBeenCalledTimes(3);
    expect(fakeSensor).toHaveBeenCalledTimes(3);

    // Each attempt record has the correct agent and sensor results
    expect(result.attempts[0]!.attempt).toBe(1);
    expect(result.attempts[0]!.agentResult.output).toBe("attempt 1 done");
    expect(result.attempts[0]!.sensorResult?.allPassed).toBe(false);

    expect(result.attempts[1]!.attempt).toBe(2);
    expect(result.attempts[1]!.agentResult.output).toBe("attempt 2 done");
    expect(result.attempts[1]!.sensorResult?.allPassed).toBe(false);

    expect(result.attempts[2]!.attempt).toBe(3);
    expect(result.attempts[2]!.agentResult.output).toBe("attempt 3 done");
    expect(result.attempts[2]!.sensorResult?.allPassed).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Test: never passes, stops exactly at maxAttempts (Core Rule 2 — retry cap)
// ---------------------------------------------------------------------------

describe("runLoop — never passes, stops exactly at maxAttempts=3", () => {
  it("returns status=escalated, attempts.length=3, agent and sensor called exactly 3 times", async () => {
    const fakeAgent = vi.fn(() => Promise.resolve(makeAgentResult()));
    const fakeSensor = vi.fn(() =>
      Promise.resolve(makeFailedSensorResult("persistent failure")),
    );

    const result = await runLoop(BASE_TASK, {
      runAgentAttemptFn: fakeAgent,
      runSensorsFn: fakeSensor,
    });

    expect(result.status).toBe("escalated");
    expect(result.attempts).toHaveLength(3);

    // Exactly 3 calls — never a 4th
    expect(fakeAgent).toHaveBeenCalledTimes(3);
    expect(fakeSensor).toHaveBeenCalledTimes(3);

    // All sensorResults are failed
    for (const att of result.attempts) {
      expect(att.sensorResult?.allPassed).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// Test: agent attempt itself fails (ok=false) — records attempt, continues
// ---------------------------------------------------------------------------

describe("runLoop — agent attempt fails (ok=false/timed out)", () => {
  it("records the failed attempt without sensorResult and continues to next attempt", async () => {
    const agentResults = [
      makeAgentResult({ ok: false, timedOut: true, output: "", error: "timed out" }),
      makeAgentResult({ output: "recovered" }),
      makeAgentResult({ output: "done" }),
    ];
    let agentCallIdx = 0;
    const fakeAgent = vi.fn(() => Promise.resolve(agentResults[agentCallIdx++]!));

    const sensorResults = [
      makeFailedSensorResult("still failing"),
      makePassedSensorResult(),
    ];
    let sensorCallIdx = 0;
    const fakeSensor = vi.fn(() => Promise.resolve(sensorResults[sensorCallIdx++]!));

    const result = await runLoop(BASE_TASK, {
      runAgentAttemptFn: fakeAgent,
      runSensorsFn: fakeSensor,
    });

    // First attempt: agent failed → no sensorResult
    expect(result.attempts[0]!.agentResult.ok).toBe(false);
    expect(result.attempts[0]!.sensorResult).toBeUndefined();

    // Second attempt: agent ok but sensor fails → sensorResult present
    expect(result.attempts[1]!.agentResult.ok).toBe(true);
    expect(result.attempts[1]!.sensorResult?.allPassed).toBe(false);

    // Third attempt: sensor passes → loop exits with passed
    expect(result.attempts[2]!.sensorResult?.allPassed).toBe(true);
    expect(result.status).toBe("passed");

    // Sensor NOT called for attempt 1 (agent failed), called for attempts 2 and 3
    expect(fakeSensor).toHaveBeenCalledTimes(2);
    expect(fakeAgent).toHaveBeenCalledTimes(3);
  });

  it("still respects maxAttempts cap even when agent failures dominate", async () => {
    const fakeAgent = vi.fn(() =>
      Promise.resolve(
        makeAgentResult({ ok: false, timedOut: false, output: "", error: "SDK error" }),
      ),
    );
    const fakeSensor = vi.fn(() => Promise.resolve(makePassedSensorResult()));

    const result = await runLoop(BASE_TASK, {
      runAgentAttemptFn: fakeAgent,
      runSensorsFn: fakeSensor,
    });

    // 3 attempts (default cap), all agent failures, sensor never called
    expect(result.status).toBe("escalated");
    expect(result.attempts).toHaveLength(3);
    expect(fakeSensor).toHaveBeenCalledTimes(0);
    expect(fakeAgent).toHaveBeenCalledTimes(3);
  });
});

// ---------------------------------------------------------------------------
// Test: custom maxAttempts (1 and 5) — cap honoured
// ---------------------------------------------------------------------------

describe("runLoop — custom maxAttempts", () => {
  it("stops after exactly 1 attempt when maxAttempts=1 and sensor fails", async () => {
    const fakeAgent = vi.fn(() => Promise.resolve(makeAgentResult()));
    const fakeSensor = vi.fn(() => Promise.resolve(makeFailedSensorResult("fail")));

    const taskWith1 = { ...BASE_TASK, maxAttempts: 1 };
    const result = await runLoop(taskWith1, {
      runAgentAttemptFn: fakeAgent,
      runSensorsFn: fakeSensor,
    });

    expect(result.status).toBe("escalated");
    expect(result.attempts).toHaveLength(1);
    expect(fakeAgent).toHaveBeenCalledTimes(1);
    expect(fakeSensor).toHaveBeenCalledTimes(1);
  });

  it("runs up to 5 attempts when maxAttempts=5 and sensor always fails", async () => {
    const fakeAgent = vi.fn(() => Promise.resolve(makeAgentResult()));
    const fakeSensor = vi.fn(() => Promise.resolve(makeFailedSensorResult("fail")));

    const taskWith5 = { ...BASE_TASK, maxAttempts: 5 };
    const result = await runLoop(taskWith5, {
      runAgentAttemptFn: fakeAgent,
      runSensorsFn: fakeSensor,
    });

    expect(result.status).toBe("escalated");
    expect(result.attempts).toHaveLength(5);
    expect(fakeAgent).toHaveBeenCalledTimes(5);
    expect(fakeSensor).toHaveBeenCalledTimes(5);
  });

  it("exits early with passed when sensor passes before hitting cap of 5", async () => {
    const sensorResults = [
      makeFailedSensorResult("fail 1"),
      makeFailedSensorResult("fail 2"),
      makePassedSensorResult(),
    ];
    let idx = 0;
    const fakeAgent = vi.fn(() => Promise.resolve(makeAgentResult()));
    const fakeSensor = vi.fn(() => Promise.resolve(sensorResults[idx++]!));

    const taskWith5 = { ...BASE_TASK, maxAttempts: 5 };
    const result = await runLoop(taskWith5, {
      runAgentAttemptFn: fakeAgent,
      runSensorsFn: fakeSensor,
    });

    // Passed on 3rd attempt, stops early — does not run all 5
    expect(result.status).toBe("passed");
    expect(result.attempts).toHaveLength(3);
    expect(fakeAgent).toHaveBeenCalledTimes(3);
    expect(fakeSensor).toHaveBeenCalledTimes(3);
  });
});

// ---------------------------------------------------------------------------
// Test: repair prompt contains verbatim sensor failure output (Core Rule 2)
// ---------------------------------------------------------------------------

describe("runLoop — repair prompt is verbatim sensor failure output", () => {
  it("passes sensor command and output verbatim into next repair prompt", async () => {
    const failureOutput = "FAIL src/foo.test.ts > foo > bar\nExpected: 1\nReceived: 2";
    const failedSensor: SensorRunResult = {
      allPassed: false,
      results: [
        {
          command: "npm run test",
          exitCode: 1,
          passed: false,
          timedOut: false,
          output: failureOutput,
        },
      ],
    };

    const capturedPrompts: Array<string | undefined> = [];
    const fakeAgent = vi.fn((_task: TaskInput, opts?: { repairPrompt?: string }) => {
      capturedPrompts.push(opts?.repairPrompt);
      return Promise.resolve(makeAgentResult());
    });

    let sensorCall = 0;
    const fakeSensor = vi.fn(() => {
      sensorCall++;
      return Promise.resolve(sensorCall === 1 ? failedSensor : makePassedSensorResult());
    });

    await runLoop(BASE_TASK, {
      runAgentAttemptFn: fakeAgent,
      runSensorsFn: fakeSensor,
    });

    // Attempt 1: no repair prompt
    expect(capturedPrompts[0]).toBeUndefined();

    // Attempt 2: repair prompt must contain the verbatim failure output (not paraphrased)
    const repairPrompt = capturedPrompts[1];
    expect(repairPrompt).toBeDefined();
    // The exact raw output from the sensor must appear in the repair prompt
    expect(repairPrompt).toContain(failureOutput);
    // The command that failed should also appear (so the agent knows which command)
    expect(repairPrompt).toContain("npm run test");
  });
});
