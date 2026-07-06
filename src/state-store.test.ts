/**
 * Tests for state-store.ts (Task 1.6).
 *
 * TDD approach: these tests are written BEFORE the implementation exists.
 * Running them now should produce RED (module not found).
 *
 * Test strategy: use fs.mkdtempSync for an isolated harnessDir — tests never
 * touch the real project's .harness/ folder.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { EscalationArtifact, StateFile } from "./schema.js";
import {
  escalationFilePath,
  readStateFile,
  stateFilePath,
  writeEscalationFile,
  writeStateFile,
} from "./state-store.js";

// ---------------------------------------------------------------------------
// Temp-dir lifecycle
// ---------------------------------------------------------------------------

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "harness-test-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// stateFilePath / escalationFilePath
// ---------------------------------------------------------------------------

describe("stateFilePath", () => {
  it("returns .harness/state/<taskId>.json relative to harnessDir", () => {
    const result = stateFilePath("task-abc", "/base/harness");
    expect(result).toBe("/base/harness/state/task-abc.json");
  });

  it("defaults harnessDir to .harness relative to process.cwd()", () => {
    const result = stateFilePath("my-task");
    expect(result).toBe(path.join(process.cwd(), ".harness", "state", "my-task.json"));
  });
});

describe("escalationFilePath", () => {
  it("returns .harness/escalations/<taskId>.json relative to harnessDir", () => {
    const result = escalationFilePath("task-xyz", "/base/harness");
    expect(result).toBe("/base/harness/escalations/task-xyz.json");
  });

  it("defaults harnessDir to .harness relative to process.cwd()", () => {
    const result = escalationFilePath("esc-task");
    expect(result).toBe(path.join(process.cwd(), ".harness", "escalations", "esc-task.json"));
  });
});

// ---------------------------------------------------------------------------
// writeStateFile
// ---------------------------------------------------------------------------

describe("writeStateFile", () => {
  it("writes StateFile JSON to the correct path and creates directories", () => {
    const state: StateFile = {
      taskId: "task-1",
      attemptCount: 2,
      status: "passed",
      lastSensorOutput: "all checks passed",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:05:00.000Z",
    };

    writeStateFile(state, tmpDir);

    const expectedPath = path.join(tmpDir, "state", "task-1.json");
    expect(fs.existsSync(expectedPath)).toBe(true);

    const parsed = JSON.parse(fs.readFileSync(expectedPath, "utf8")) as StateFile;
    expect(parsed).toEqual(state);
  });

  it("creates the state directory if it does not exist", () => {
    const stateDir = path.join(tmpDir, "state");
    expect(fs.existsSync(stateDir)).toBe(false);

    const state: StateFile = {
      taskId: "auto-dir",
      attemptCount: 1,
      status: "running",
      lastSensorOutput: "",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };

    writeStateFile(state, tmpDir);

    expect(fs.existsSync(stateDir)).toBe(true);
  });

  it("round-trips a StateFile with status: escalated", () => {
    const state: StateFile = {
      taskId: "esc-task",
      attemptCount: 3,
      status: "escalated",
      lastSensorOutput: "npm test failed: 2 tests failed",
      createdAt: "2026-02-01T10:00:00.000Z",
      updatedAt: "2026-02-01T10:15:00.000Z",
    };

    writeStateFile(state, tmpDir);

    const filePath = path.join(tmpDir, "state", "esc-task.json");
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as StateFile;
    expect(parsed).toEqual(state);
    expect(parsed.status).toBe("escalated");
  });

  it("overwrites an existing state file", () => {
    const stateV1: StateFile = {
      taskId: "update-task",
      attemptCount: 1,
      status: "running",
      lastSensorOutput: "attempt 1",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:01:00.000Z",
    };
    const stateV2: StateFile = {
      taskId: "update-task",
      attemptCount: 2,
      status: "passed",
      lastSensorOutput: "all passed",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:02:00.000Z",
    };

    writeStateFile(stateV1, tmpDir);
    writeStateFile(stateV2, tmpDir);

    const filePath = path.join(tmpDir, "state", "update-task.json");
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as StateFile;
    expect(parsed).toEqual(stateV2);
  });
});

// ---------------------------------------------------------------------------
// writeEscalationFile
// ---------------------------------------------------------------------------

describe("writeEscalationFile", () => {
  it("writes EscalationArtifact JSON to the correct path and creates directories", () => {
    const artifact: EscalationArtifact = {
      taskId: "esc-1",
      attemptHistory: [
        { attempt: 1, sensorResult: "lint failed", timestamp: "2026-01-01T00:01:00.000Z" },
        { attempt: 2, sensorResult: "test failed: 3 assertions", timestamp: "2026-01-01T00:02:00.000Z" },
      ],
      finalStatus: "escalated",
      reason: "max attempts exceeded",
    };

    writeEscalationFile(artifact, tmpDir);

    const expectedPath = path.join(tmpDir, "escalations", "esc-1.json");
    expect(fs.existsSync(expectedPath)).toBe(true);

    const parsed = JSON.parse(fs.readFileSync(expectedPath, "utf8")) as EscalationArtifact;
    expect(parsed).toEqual(artifact);
    expect(parsed.finalStatus).toBe("escalated");
  });

  it("creates the escalations directory if it does not exist", () => {
    const escDir = path.join(tmpDir, "escalations");
    expect(fs.existsSync(escDir)).toBe(false);

    const artifact: EscalationArtifact = {
      taskId: "dir-test",
      attemptHistory: [],
      finalStatus: "escalated",
      reason: "cap exceeded",
    };

    writeEscalationFile(artifact, tmpDir);

    expect(fs.existsSync(escDir)).toBe(true);
  });

  it("round-trips an EscalationArtifact with full attempt history", () => {
    const artifact: EscalationArtifact = {
      taskId: "full-history",
      attemptHistory: [
        { attempt: 1, sensorResult: '{"allPassed":false}', timestamp: "T1" },
        { attempt: 2, sensorResult: '{"allPassed":false}', timestamp: "T2" },
        { attempt: 3, sensorResult: '{"allPassed":false}', timestamp: "T3" },
      ],
      finalStatus: "escalated",
      reason: "max attempts exceeded",
    };

    writeEscalationFile(artifact, tmpDir);

    const filePath = path.join(tmpDir, "escalations", "full-history.json");
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as EscalationArtifact;
    expect(parsed).toEqual(artifact);
    expect(parsed.attemptHistory).toHaveLength(3);
  });
});

// ---------------------------------------------------------------------------
// readStateFile (Task 1.7)
// ---------------------------------------------------------------------------

describe("readStateFile", () => {
  it("returns null when the state file does not exist", () => {
    const result = readStateFile("no-such-task", tmpDir);
    expect(result).toBeNull();
  });

  it("returns the parsed StateFile for an existing file", () => {
    const state: StateFile = {
      taskId: "read-task",
      attemptCount: 2,
      status: "running",
      lastSensorOutput: "tests failed",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:02:00.000Z",
    };
    writeStateFile(state, tmpDir);

    const result = readStateFile("read-task", tmpDir);
    expect(result).toEqual(state);
  });

  it("returns null (not throw) when the file contains corrupt JSON", () => {
    const dir = path.join(tmpDir, "state");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "corrupt-task.json"), "{ not valid json >>>", "utf8");

    let result: StateFile | null | undefined = undefined;
    expect(() => {
      result = readStateFile("corrupt-task", tmpDir);
    }).not.toThrow();
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// writeStateFile — createdAt preservation (Task 1.7)
// ---------------------------------------------------------------------------

describe("writeStateFile — createdAt preservation", () => {
  it("preserves createdAt from first write on subsequent writes to same taskId", () => {
    const stateV1: StateFile = {
      taskId: "preserve-task",
      attemptCount: 1,
      status: "running",
      lastSensorOutput: "attempt 1 failed",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:01:00.000Z",
    };
    // V2 has a DIFFERENT createdAt — writeStateFile must ignore it and preserve V1's
    const stateV2: StateFile = {
      taskId: "preserve-task",
      attemptCount: 2,
      status: "passed",
      lastSensorOutput: "all checks passed",
      createdAt: "2026-12-31T23:59:59.000Z",
      updatedAt: "2026-01-01T00:02:00.000Z",
    };

    writeStateFile(stateV1, tmpDir);
    writeStateFile(stateV2, tmpDir);

    const filePath = path.join(tmpDir, "state", "preserve-task.json");
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as StateFile;

    // createdAt is preserved from V1, NOT stateV2's different value
    expect(parsed.createdAt).toBe("2026-01-01T00:00:00.000Z");
    // updatedAt comes from V2
    expect(parsed.updatedAt).toBe("2026-01-01T00:02:00.000Z");
    // Other V2 fields
    expect(parsed.attemptCount).toBe(2);
    expect(parsed.status).toBe("passed");
  });

  it("uses the passed createdAt when no prior file exists (fresh first write)", () => {
    const state: StateFile = {
      taskId: "fresh-task",
      attemptCount: 1,
      status: "running",
      lastSensorOutput: "",
      createdAt: "2026-06-15T12:00:00.000Z",
      updatedAt: "2026-06-15T12:00:00.000Z",
    };
    writeStateFile(state, tmpDir);

    const result = readStateFile("fresh-task", tmpDir);
    expect(result?.createdAt).toBe("2026-06-15T12:00:00.000Z");
  });
});
