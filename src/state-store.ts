/**
 * State-store module (Task 1.6).
 *
 * Provides focused disk I/O for two artifact types defined in schema.ts:
 *   - StateFile   → .harness/state/<taskId>.json
 *   - EscalationArtifact → .harness/escalations/<taskId>.json
 *
 * Design choices:
 *   - Synchronous fs calls (fs.mkdirSync / fs.writeFileSync): fine for this
 *     single-process CLI at MVP scale and keeps call-sites simple.
 *   - `harnessDir` parameter defaults to `path.join(process.cwd(), ".harness")`
 *     but can be overridden with any absolute base dir — this is the primary
 *     testability hook so tests can point at a temp dir instead of the real
 *     project's .harness/ folder.
 *
 * Core Rules satisfied:
 *   - Core Rule 3 (spec.md): escalation artifact written to
 *     `.harness/escalations/<task-id>.json`.
 *   - Core Rule 5 (spec.md): state file written to
 *     `.harness/state/<task-id>.json` after every attempt.
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
// Write helpers
// ---------------------------------------------------------------------------

/**
 * Writes a StateFile to disk at `.harness/state/<taskId>.json`.
 *
 * Creates the `state/` directory (and any parent directories) if missing.
 * Overwrites an existing file atomically (writeFileSync is atomic within the
 * OS buffer flush boundary — sufficient for single-process MVP use).
 *
 * @param state      The StateFile object to persist.
 * @param harnessDir Base harness directory. Defaults to `.harness` relative to
 *                   `process.cwd()`. Pass an absolute temp dir in tests.
 */
export function writeStateFile(state: StateFile, harnessDir?: string): void {
  const filePath = stateFilePath(state.taskId, harnessDir);
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(state, null, 2), "utf8");
}

/**
 * Writes an EscalationArtifact to disk at
 * `.harness/escalations/<taskId>.json`.
 *
 * Creates the `escalations/` directory (and any parent directories) if missing.
 *
 * @param artifact   The EscalationArtifact object to persist.
 * @param harnessDir Base harness directory. Defaults to `.harness` relative to
 *                   `process.cwd()`. Pass an absolute temp dir in tests.
 */
export function writeEscalationFile(
  artifact: EscalationArtifact,
  harnessDir?: string,
): void {
  const filePath = escalationFilePath(artifact.taskId, harnessDir);
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(artifact, null, 2), "utf8");
}
