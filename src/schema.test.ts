/**
 * Tests for task input contract + state file schema (Task 1.2).
 * TDD: these tests are written FIRST and must fail before implementation exists.
 */
import { describe, it, expect } from "vitest";
import { validateTaskInput } from "./schema.js";
import type { StateFile, EscalationArtifact } from "./schema.js";

// ---------------------------------------------------------------------------
// Type-level smoke tests: verify the exported shapes compile correctly.
// These are compile-time only; the runtime checks are in validateTaskInput.
// ---------------------------------------------------------------------------
const _stateFileShape: StateFile = {
  taskId: "t1",
  attemptCount: 1,
  status: "running",
  lastSensorOutput: "",
  createdAt: "2026-07-05T00:00:00.000Z",
  updatedAt: "2026-07-05T00:00:00.000Z",
};

const _escalationArtifactShape: EscalationArtifact = {
  taskId: "t1",
  attemptHistory: [
    { attempt: 1, sensorResult: "lint failed", timestamp: "2026-07-05T00:00:00.000Z" },
  ],
  finalStatus: "escalated",
  reason: "max attempts exceeded",
};

// Suppress "unused variable" lint errors — these exist only to prove types compile.
void _stateFileShape;
void _escalationArtifactShape;

// ---------------------------------------------------------------------------
// Runtime validation tests for validateTaskInput
// ---------------------------------------------------------------------------

const ALLOWED = ["/workspace/repo-a", "/workspace/repo-b"];

describe("validateTaskInput", () => {
  // -------------------------------------------------------------------------
  // 1. Well-formed input passes
  // -------------------------------------------------------------------------
  it("accepts a well-formed input", () => {
    const input: unknown = {
      taskId: "task-1",
      description: "Fix the bug",
      targetRepoPath: "/workspace/repo-a",
      verifyCommands: ["npm run lint", "npm test"],
      maxAttempts: 5,
    };
    const result = validateTaskInput(input, ALLOWED);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.taskId).toBe("task-1");
      expect(result.value.description).toBe("Fix the bug");
      expect(result.value.targetRepoPath).toBe("/workspace/repo-a");
      expect(result.value.verifyCommands).toEqual(["npm run lint", "npm test"]);
      expect(result.value.maxAttempts).toBe(5);
    }
  });

  it("accepts a well-formed input without optional maxAttempts", () => {
    const input: unknown = {
      taskId: "task-2",
      description: "Add feature",
      targetRepoPath: "/workspace/repo-b",
      verifyCommands: ["npm test"],
    };
    const result = validateTaskInput(input, ALLOWED);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.maxAttempts).toBeUndefined();
    }
  });

  // -------------------------------------------------------------------------
  // 2. Malformed inputs are rejected with error messages
  // -------------------------------------------------------------------------
  it("rejects null input", () => {
    const result = validateTaskInput(null, ALLOWED);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.length).toBeGreaterThan(0);
    }
  });

  it("rejects input missing taskId", () => {
    const input: unknown = {
      description: "Fix the bug",
      targetRepoPath: "/workspace/repo-a",
      verifyCommands: ["npm test"],
    };
    const result = validateTaskInput(input, ALLOWED);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.toLowerCase().includes("taskid"))).toBe(true);
    }
  });

  it("rejects input with empty taskId", () => {
    const input: unknown = {
      taskId: "",
      description: "Fix the bug",
      targetRepoPath: "/workspace/repo-a",
      verifyCommands: ["npm test"],
    };
    const result = validateTaskInput(input, ALLOWED);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.toLowerCase().includes("taskid"))).toBe(true);
    }
  });

  it("rejects input missing description", () => {
    const input: unknown = {
      taskId: "task-1",
      targetRepoPath: "/workspace/repo-a",
      verifyCommands: ["npm test"],
    };
    const result = validateTaskInput(input, ALLOWED);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.toLowerCase().includes("description"))).toBe(true);
    }
  });

  it("rejects input with empty description", () => {
    const input: unknown = {
      taskId: "task-1",
      description: "",
      targetRepoPath: "/workspace/repo-a",
      verifyCommands: ["npm test"],
    };
    const result = validateTaskInput(input, ALLOWED);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.toLowerCase().includes("description"))).toBe(true);
    }
  });

  it("rejects input where verifyCommands is not an array", () => {
    const input: unknown = {
      taskId: "task-1",
      description: "Fix it",
      targetRepoPath: "/workspace/repo-a",
      verifyCommands: "npm test",
    };
    const result = validateTaskInput(input, ALLOWED);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.toLowerCase().includes("verifycommands"))).toBe(true);
    }
  });

  it("rejects input where verifyCommands contains a non-string element", () => {
    const input: unknown = {
      taskId: "task-1",
      description: "Fix it",
      targetRepoPath: "/workspace/repo-a",
      verifyCommands: ["npm test", 42],
    };
    const result = validateTaskInput(input, ALLOWED);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.toLowerCase().includes("verifycommands"))).toBe(true);
    }
  });

  it("rejects input where maxAttempts is zero", () => {
    const input: unknown = {
      taskId: "task-1",
      description: "Fix it",
      targetRepoPath: "/workspace/repo-a",
      verifyCommands: ["npm test"],
      maxAttempts: 0,
    };
    const result = validateTaskInput(input, ALLOWED);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.toLowerCase().includes("maxattempts"))).toBe(true);
    }
  });

  it("rejects input where maxAttempts is a non-integer", () => {
    const input: unknown = {
      taskId: "task-1",
      description: "Fix it",
      targetRepoPath: "/workspace/repo-a",
      verifyCommands: ["npm test"],
      maxAttempts: 1.5,
    };
    const result = validateTaskInput(input, ALLOWED);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.toLowerCase().includes("maxattempts"))).toBe(true);
    }
  });

  // -------------------------------------------------------------------------
  // 3. Path confinement: targetRepoPath outside ALLOWED_ROOTS is rejected
  // -------------------------------------------------------------------------
  it("rejects a targetRepoPath outside ALLOWED_ROOTS", () => {
    const input: unknown = {
      taskId: "task-1",
      description: "Fix it",
      targetRepoPath: "/evil/path",
      verifyCommands: ["npm test"],
    };
    const result = validateTaskInput(input, ALLOWED);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.toLowerCase().includes("allowed"))).toBe(true);
    }
  });

  it("rejects a sibling-directory path that shares a prefix with an allowed root (boundary bypass attempt)", () => {
    // /workspace/repo-a-evil shares the prefix /workspace/repo-a but is NOT inside it.
    // A naive .startsWith('/workspace/repo-a') check would incorrectly allow this.
    const input: unknown = {
      taskId: "task-1",
      description: "Fix it",
      targetRepoPath: "/workspace/repo-a-evil",
      verifyCommands: ["npm test"],
    };
    const result = validateTaskInput(input, ALLOWED);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.toLowerCase().includes("allowed"))).toBe(true);
    }
  });

  it("accepts a targetRepoPath that equals an allowed root exactly", () => {
    const input: unknown = {
      taskId: "task-1",
      description: "Fix it",
      targetRepoPath: "/workspace/repo-a",
      verifyCommands: ["npm test"],
    };
    const result = validateTaskInput(input, ["/workspace/repo-a"]);
    expect(result.ok).toBe(true);
  });

  it("accepts a targetRepoPath that is a subdirectory of an allowed root", () => {
    const input: unknown = {
      taskId: "task-1",
      description: "Fix it",
      targetRepoPath: "/workspace/repo-a/sub/dir",
      verifyCommands: ["npm test"],
    };
    const result = validateTaskInput(input, ["/workspace/repo-a"]);
    expect(result.ok).toBe(true);
  });

  it("returns never-throws even when input is completely wrong type", () => {
    expect(() => validateTaskInput(42, ALLOWED)).not.toThrow();
    expect(() => validateTaskInput("string", ALLOWED)).not.toThrow();
    expect(() => validateTaskInput(undefined, ALLOWED)).not.toThrow();
  });
});
