/**
 * State-store module (Task 1.6, extended in Task 1.7).
 *
 * Provides focused disk I/O for two artifact types defined in schema.ts:
 *   - StateFile   → .harness/state/<taskId>.json
 *   - EscalationArtifact → .harness/escalations/<taskId>.json
 *
 * Design choices:
 *   - Synchronous fs calls: fine for this single-process CLI at MVP scale.
 *   - `harnessDir` parameter defaults to `path.join(process.cwd(), ".harness")`
 *     but can be overridden — primary testability hook.
 *
 * Task 1.7 additions:
 *   - `readStateFile`: reads an existing state file; returns null on ENOENT or
 *     corrupt JSON (graceful degradation to fresh start, not a throw).
 *   - `writeStateFile` is now ATOMIC: writes to a temp file in the same directory
 *     then renames over the target (POSIX rename is atomic on same filesystem).
 *   - `writeStateFile` PRESERVES `createdAt` from any existing state file so that
 *     repeated mid-loop writes do not reset the task's creation timestamp.
 *   - `writeEscalationFile` also uses atomic write for consistency/safety.
 *
 * Core Rules satisfied:
 *   - Core Rule 3 (spec.md): escalation artifact at `.harness/escalations/<task-id>.json`.
 *   - Core Rule 5 (spec.md): state file at `.harness/state/<task-id>.json` after every
 *     attempt, with crash-safe writes and resume-friendly persisted attempt count.
 */

import fs from "node:fs";
import path from "node:path";
import type { EscalationArtifact, StateFile } from "./schema.js";

// ---------------------------------------------------------------------------
// Default base dir
// ---------------------------------------------------------------------------

function defaultHarnessDir(): string {
  return path.join(process.cwd(), ".harness");
}

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

/**
 * Returns the absolute file path for a state file.
 *
 * @param taskId     The task identifier (used as the filename stem).
 * @param harnessDir Base harness directory. Defaults to `.harness` relative to
 *                   `process.cwd()`. Pass an absolute temp dir in tests.
 */
export function stateFilePath(taskId: string, harnessDir?: string): string {
  const base = harnessDir ?? defaultHarnessDir();
  return path.join(base, "state", `${taskId}.json`);
}

/**
 * Returns the absolute file path for an escalation artifact.
 *
 * @param taskId     The task identifier (used as the filename stem).
 * @param harnessDir Base harness directory. Defaults to `.harness` relative to
 *                   `process.cwd()`. Pass an absolute temp dir in tests.
 */
export function escalationFilePath(taskId: string, harnessDir?: string): string {
  const base = harnessDir ?? defaultHarnessDir();
  return path.join(base, "escalations", `${taskId}.json`);
}

// ---------------------------------------------------------------------------
// Read helpers (Task 1.7)
// ---------------------------------------------------------------------------

/**
 * Reads the persisted StateFile for a task.
 *
 * Returns `null` when:
 *   - The file does not exist (ENOENT) — treated as "no prior state".
 *   - The file contains invalid/corrupt JSON — treated as "no valid prior state"
 *     (graceful degradation: resume falls back to a fresh start instead of crashing).
 *
 * @param taskId     The task identifier.
 * @param harnessDir Base harness directory. Defaults to `.harness` relative to cwd.
 */
export function readStateFile(taskId: string, harnessDir?: string): StateFile | null {
  const filePath = stateFilePath(taskId, harnessDir);
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    return JSON.parse(raw) as StateFile;
  } catch {
    // ENOENT (file not found) and SyntaxError (corrupt JSON) both return null.
    return null;
  }
}

// ---------------------------------------------------------------------------
// Write helpers
// ---------------------------------------------------------------------------

/**
 * Atomically writes a StateFile to disk at `.harness/state/<taskId>.json`.
 *
 * Atomic strategy (Task 1.7):
 *   1. Write JSON to a uniquely-named temp file in the SAME directory as the
 *      target (same filesystem → POSIX rename is atomic).
 *   2. `fs.renameSync` over the real path.
 *   This prevents a crash-mid-write from leaving a truncated/corrupt JSON file.
 *
 * createdAt preservation (Task 1.7):
 *   Reads any existing state file first. If one exists, its `createdAt` field
 *   overrides the value in `state` so that only `updatedAt` advances on
 *   subsequent writes for the same taskId during a task's lifetime.
 *
 * @param state      The StateFile object to persist.
 * @param harnessDir Base harness directory. Defaults to `.harness` relative to cwd.
 */
export function writeStateFile(state: StateFile, harnessDir?: string): void {
  const filePath = stateFilePath(state.taskId, harnessDir);
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });

  // Preserve createdAt from any existing state for this task.
  const existing = readStateFile(state.taskId, harnessDir);
  const stateToWrite: StateFile =
    existing !== null
      ? { ...state, createdAt: existing.createdAt }
      : state;

  // Atomic write: temp file in same directory, then rename.
  const tmpPath = path.join(
    dir,
    `.${path.basename(filePath)}.tmp-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  try {
    fs.writeFileSync(tmpPath, JSON.stringify(stateToWrite, null, 2), "utf8");
    fs.renameSync(tmpPath, filePath);
  } catch (err) {
    // Best-effort cleanup of the temp file; ignore secondary errors.
    try {
      fs.unlinkSync(tmpPath);
    } catch {
      // ignore
    }
    throw err;
  }
}

/**
 * Atomically writes an EscalationArtifact to disk at
 * `.harness/escalations/<taskId>.json`.
 *
 * Uses the same temp-file + rename pattern as writeStateFile for crash safety.
 * (EscalationArtifact has no createdAt field so no preservation logic is needed.)
 *
 * @param artifact   The EscalationArtifact object to persist.
 * @param harnessDir Base harness directory. Defaults to `.harness` relative to cwd.
 */
export function writeEscalationFile(
  artifact: EscalationArtifact,
  harnessDir?: string,
): void {
  const filePath = escalationFilePath(artifact.taskId, harnessDir);
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });

  const tmpPath = path.join(
    dir,
    `.${path.basename(filePath)}.tmp-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  try {
    fs.writeFileSync(tmpPath, JSON.stringify(artifact, null, 2), "utf8");
    fs.renameSync(tmpPath, filePath);
  } catch (err) {
    try {
      fs.unlinkSync(tmpPath);
    } catch {
      // ignore
    }
    throw err;
  }
}
