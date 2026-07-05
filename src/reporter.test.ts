/**
 * Tests for reporter.ts (Task 1.6).
 *
 * TDD approach: these tests are written BEFORE the implementation exists.
 * Running them now should produce RED (module not found).
 *
 * Test strategy:
 *   - Inject a fake runLoopFn so tests never call the real loop controller.
 *   - Inject harnessDir pointing to a temp dir so tests never touch real .harness/.
 *   - Inject now() for deterministic timestamps.
 *   - Spy on console.log / console.error to verify exactly one status line is printed.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EscalationArtifact, StateFile, TaskInput } from "./schema.js";
import { runTaskToCompletion } from "./reporter.js";
import type { LoopResult } from "./loop-controller.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const BASE_TASK: TaskInput = {
  taskId: "test-task-1",
  description: "Write a passing implementation",
  targetRepoPath: "/fake/repo",
  verifyCommands: ["npm test"],
  maxAttempts: 3,
};

const FIXED_NOW = "2026-07-05T10:00:00.000Z";
const now = () => FIXED_NOW;

// ---------------------------------------------------------------------------
// Temp-dir lifecycle
// ---------------------------------------------------------------------------

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "harness-reporter-test-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Success path (DoD item a)
// ---------------------------------------------------------------------------

describe("runTaskToCompletion — passed result", () => {
  const passedResult: LoopResult = {
    status: "passed",
    attempts: [
      {
        attempt: 1,
        agentResult: { ok: true, timedOut: false, output: "done" },
        sensorResult: {
          allPassed: true,
          results: [{ command: "npm test", passed: true, timedOut: false, exitCode: 0, output: "PASS" }],
        },
      },
    ],
  };

  it("writes a StateFile with status: passed to the temp harnessDir", async () => {
    const runLoopFn = vi.fn().mockResolvedValue(passedResult);

    await runTaskToCompletion(BASE_TASK, { runLoopFn, harnessDir: tmpDir, now });

    const stateFilePath = path.join(tmpDir, "state", `${BASE_TASK.taskId}.json`);
    expect(fs.existsSync(stateFilePath)).toBe(true);

    const parsed = JSON.parse(fs.readFileSync(stateFilePath, "utf8")) as StateFile;
    expect(parsed.taskId).toBe(BASE_TASK.taskId);
    expect(parsed.status).toBe("passed");
    expect(parsed.attemptCount).toBe(1);
    expect(parsed.createdAt).toBe(FIXED_NOW);
    expect(parsed.updatedAt).toBe(FIXED_NOW);
  });

  it("prints EXACTLY ONE done line on success (DoD item a literal assertion)", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const runLoopFn = vi.fn().mockResolvedValue(passedResult);

    await runTaskToCompletion(BASE_TASK, { runLoopFn, harnessDir: tmpDir, now });

    // Exactly one console.log call that contains the task id and signals success
    const doneCalls = logSpy.mock.calls.filter(
      (call) => typeof call[0] === "string" && call[0].includes(BASE_TASK.taskId),
    );
    expect(doneCalls).toHaveLength(1);
    expect(doneCalls[0]![0]).toContain(BASE_TASK.taskId);
    // Must not be an error-level line
    expect(logSpy).toHaveBeenCalledTimes(1);
  });

  it("does NOT write an escalation file on success", async () => {
    const runLoopFn = vi.fn().mockResolvedValue(passedResult);
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    await runTaskToCompletion(BASE_TASK, { runLoopFn, harnessDir: tmpDir, now });

    const escFilePath = path.join(tmpDir, "escalations", `${BASE_TASK.taskId}.json`);
    expect(fs.existsSync(escFilePath)).toBe(false);
  });

  it("returns the original LoopResult unchanged", async () => {
    const runLoopFn = vi.fn().mockResolvedValue(passedResult);
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    const result = await runTaskToCompletion(BASE_TASK, { runLoopFn, harnessDir: tmpDir, now });

    expect(result).toEqual(passedResult);
  });
});

// ---------------------------------------------------------------------------
// Escalation path (DoD item b)
// ---------------------------------------------------------------------------

describe("runTaskToCompletion — escalated result", () => {
  const escalatedResult: LoopResult = {
    status: "escalated",
    attempts: [
      {
        attempt: 1,
        agentResult: { ok: true, timedOut: false, output: "attempt 1" },
        sensorResult: {
          allPassed: false,
          results: [{ command: "npm test", passed: false, timedOut: false, exitCode: 1, output: "FAIL: 2 tests failed" }],
        },
      },
      {
        attempt: 2,
        agentResult: { ok: true, timedOut: false, output: "attempt 2" },
        sensorResult: {
          allPassed: false,
          results: [{ command: "npm test", passed: false, timedOut: false, exitCode: 1, output: "FAIL: 1 test failed" }],
        },
      },
      {
        attempt: 3,
        agentResult: { ok: true, timedOut: false, output: "attempt 3" },
        sensorResult: {
          allPassed: false,
          results: [{ command: "npm test", passed: false, timedOut: false, exitCode: 1, output: "FAIL: still failing" }],
        },
      },
    ],
  };

  it("writes a StateFile with status: escalated to the temp harnessDir", async () => {
    const runLoopFn = vi.fn().mockResolvedValue(escalatedResult);
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    await runTaskToCompletion(BASE_TASK, { runLoopFn, harnessDir: tmpDir, now });

    const stateFilePath = path.join(tmpDir, "state", `${BASE_TASK.taskId}.json`);
    expect(fs.existsSync(stateFilePath)).toBe(true);

    const parsed = JSON.parse(fs.readFileSync(stateFilePath, "utf8")) as StateFile;
    expect(parsed.taskId).toBe(BASE_TASK.taskId);
    expect(parsed.status).toBe("escalated");
    expect(parsed.attemptCount).toBe(3);
  });

  it("writes a well-formed EscalationArtifact matching the schema (DoD item b)", async () => {
    const runLoopFn = vi.fn().mockResolvedValue(escalatedResult);
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    await runTaskToCompletion(BASE_TASK, { runLoopFn, harnessDir: tmpDir, now });

    const escFilePath = path.join(tmpDir, "escalations", `${BASE_TASK.taskId}.json`);
    expect(fs.existsSync(escFilePath)).toBe(true);

    const artifact = JSON.parse(fs.readFileSync(escFilePath, "utf8")) as EscalationArtifact;

    // Schema conformance checks
    expect(artifact.taskId).toBe(BASE_TASK.taskId);
    expect(artifact.finalStatus).toBe("escalated");
    expect(typeof artifact.reason).toBe("string");
    expect(artifact.reason.length).toBeGreaterThan(0);
    expect(Array.isArray(artifact.attemptHistory)).toBe(true);
    expect(artifact.attemptHistory).toHaveLength(3);

    for (const entry of artifact.attemptHistory) {
      expect(typeof entry.attempt).toBe("number");
      expect(typeof entry.sensorResult).toBe("string");
      expect(typeof entry.timestamp).toBe("string");
    }
  });

  it("prints a console escalation message (not console.log) on cap exceeded", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const runLoopFn = vi.fn().mockResolvedValue(escalatedResult);

    await runTaskToCompletion(BASE_TASK, { runLoopFn, harnessDir: tmpDir, now });

    expect(errorSpy).toHaveBeenCalledTimes(1);
    const message = errorSpy.mock.calls[0]![0] as string;
    expect(message).toContain(BASE_TASK.taskId);
  });

  it("does NOT print a success done line on escalation", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const runLoopFn = vi.fn().mockResolvedValue(escalatedResult);

    await runTaskToCompletion(BASE_TASK, { runLoopFn, harnessDir: tmpDir, now });

    expect(logSpy).not.toHaveBeenCalled();
  });

  it("returns the original LoopResult unchanged", async () => {
    const runLoopFn = vi.fn().mockResolvedValue(escalatedResult);
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    const result = await runTaskToCompletion(BASE_TASK, { runLoopFn, harnessDir: tmpDir, now });

    expect(result).toEqual(escalatedResult);
  });
});

// ---------------------------------------------------------------------------
// Default behaviour (uses real runLoop when runLoopFn not injected)
// ---------------------------------------------------------------------------

describe("runTaskToCompletion — real runLoop integration shim", () => {
  it("is exported and callable with no opts", () => {
    // We don't actually invoke it (no real agent/sensor available),
    // but confirm the export shape is correct.
    expect(typeof runTaskToCompletion).toBe("function");
  });
});
