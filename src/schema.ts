/**
 * Task input contract and state file schema definitions (Task 1.2).
 *
 * Exports three types drawn from spec.md "Data And Contracts":
 *   - TaskInput          (untrusted user input; runtime-validated)
 *   - StateFile          (harness-internal write; type-only)
 *   - EscalationArtifact (harness-internal write; type-only)
 *
 * Also exports `validateTaskInput`, the runtime guard for TaskInput which
 * includes path-confinement (Core Rule 6) via a path-separator-boundary check
 * to prevent prefix-hijack attacks (e.g. /allowed-repo-evil bypassing /allowed-repo).
 */

import path from "node:path";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** What the user/CLI provides as the task description. */
export interface TaskInput {
  taskId: string;
  description: string;
  /** Must resolve inside ALLOWED_ROOTS (Core Rule 6). */
  targetRepoPath: string;
  /** e.g. ["npm run lint", "npm run typecheck", "npm test"] */
  verifyCommands: string[];
  /** Default 3 when omitted. Must be a positive integer if present. */
  maxAttempts?: number;
}

/** Persisted to `.harness/state/<task-id>.json` after every attempt. */
export interface StateFile {
  taskId: string;
  attemptCount: number;
  status: "running" | "passed" | "escalated";
  /** Truncated/redacted sensor output. */
  lastSensorOutput: string;
  createdAt: string;
  updatedAt: string;
}

/** Written to `.harness/escalations/<task-id>.json` when cap is exceeded. */
export interface EscalationArtifact {
  taskId: string;
  attemptHistory: { attempt: number; sensorResult: string; timestamp: string }[];
  finalStatus: "escalated";
  reason: string;
}

// ---------------------------------------------------------------------------
// Discriminated result type
// ---------------------------------------------------------------------------

type ValidationResult =
  | { ok: true; value: TaskInput }
  | { ok: false; errors: string[] };

// ---------------------------------------------------------------------------
// Path confinement helper (Core Rule 6)
// ---------------------------------------------------------------------------

/**
 * Returns true if `candidate` is inside (or equal to) `root`.
 *
 * Uses a path-separator-boundary check rather than a naive `.startsWith()` to
 * prevent the prefix-hijack bypass: `/allowed-repo-evil` must not pass against
 * root `/allowed-repo`.
 *
 * Strategy:
 *   1. Resolve both paths with `path.resolve` so they are absolute and
 *      normalised (removes trailing slashes, resolves `.` / `..`).
 *   2. Normalised root must either equal candidate, or candidate must start
 *      with `<root>/` (with an explicit separator character appended).
 */
function isInsideAllowedRoot(candidate: string, root: string): boolean {
  const normCandidate = path.resolve(candidate);
  const normRoot = path.resolve(root);

  return (
    normCandidate === normRoot ||
    normCandidate.startsWith(normRoot + path.sep)
  );
}

// ---------------------------------------------------------------------------
// Runtime validation
// ---------------------------------------------------------------------------

/**
 * Validates an unknown value as a well-formed `TaskInput`.
 *
 * Checks:
 * - Input is a non-null object
 * - `taskId` is a non-empty string
 * - `description` is a non-empty string
 * - `targetRepoPath` is a string that resolves inside one of `allowedRoots`
 * - `verifyCommands` is a string[]
 * - `maxAttempts`, if present, is a positive integer
 *
 * Never throws. Always returns a discriminated result.
 *
 * @param input       The raw unknown value to validate.
 * @param allowedRoots  The `ALLOWED_ROOTS` list (comma-split absolute paths).
 */
export function validateTaskInput(
  input: unknown,
  allowedRoots: string[],
): ValidationResult {
  const errors: string[] = [];

  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    return { ok: false, errors: ["input must be a non-null object"] };
  }

  const obj = input as Record<string, unknown>;

  // taskId: non-empty string
  if (typeof obj["taskId"] !== "string" || obj["taskId"].length === 0) {
    errors.push("taskId must be a non-empty string");
  }

  // description: non-empty string
  if (typeof obj["description"] !== "string" || obj["description"].length === 0) {
    errors.push("description must be a non-empty string");
  }

  // targetRepoPath: string + path confinement
  if (typeof obj["targetRepoPath"] !== "string") {
    errors.push("targetRepoPath must be a string");
  } else {
    const targetPath = obj["targetRepoPath"];
    const confined = allowedRoots.some((root) => isInsideAllowedRoot(targetPath, root));
    if (!confined) {
      errors.push(
        `targetRepoPath "${targetPath}" is not inside any allowed root (ALLOWED_ROOTS: ${allowedRoots.join(", ")})`,
      );
    }
  }

  // verifyCommands: string[]
  if (!Array.isArray(obj["verifyCommands"])) {
    errors.push("verifyCommands must be a string array");
  } else {
    const cmds = obj["verifyCommands"] as unknown[];
    const allStrings = cmds.every((c) => typeof c === "string");
    if (!allStrings) {
      errors.push("verifyCommands must contain only strings");
    }
  }

  // maxAttempts: positive integer (optional)
  if ("maxAttempts" in obj && obj["maxAttempts"] !== undefined) {
    const ma = obj["maxAttempts"];
    if (
      typeof ma !== "number" ||
      !Number.isInteger(ma) ||
      ma <= 0
    ) {
      errors.push("maxAttempts must be a positive integer when provided");
    }
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  // At this point all fields are validated — safe cast.
  const taskInput: TaskInput = {
    taskId: obj["taskId"] as string,
    description: obj["description"] as string,
    targetRepoPath: obj["targetRepoPath"] as string,
    verifyCommands: obj["verifyCommands"] as string[],
  };

  if ("maxAttempts" in obj && obj["maxAttempts"] !== undefined) {
    taskInput.maxAttempts = obj["maxAttempts"] as number;
  }

  return { ok: true, value: taskInput };
}
