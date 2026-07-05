/**
 * Tests for agent-runner.ts (Task 1.3).
 *
 * TDD approach: tests were written before the implementation exists.
 *
 * All tests use injected fake queryFn — no live Anthropic API calls,
 * no ANTHROPIC_API_KEY or subscription auth required.
 *
 * The "fixture repo" is a real temp directory created with fs.mkdtempSync,
 * so cwd wiring is exercised against a real filesystem path.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runAgentAttempt } from "./agent-runner.js";
import type { QueryFn, SdkStreamMessage } from "./agent-runner.js";
import type { TaskInput } from "./schema.js";

// ---------------------------------------------------------------------------
// Iterator helpers
// ---------------------------------------------------------------------------

/**
 * Creates an AsyncGenerator<SdkStreamMessage, void> from a custom `next`
 * function. Using explicit iterator protocol (instead of `async function*`)
 * avoids `require-yield` / `require-await` lint errors on intentionally-
 * degenerate fakes (hanging generators, immediate-throw fakes, etc.).
 */
function makeIterator(
  nextFn: () => Promise<IteratorResult<SdkStreamMessage, void>>,
): AsyncGenerator<SdkStreamMessage, void> {
  return {
    next: nextFn,
    return: (): Promise<IteratorResult<SdkStreamMessage, void>> =>
      Promise.resolve({ done: true, value: undefined }),
    throw: (err?: unknown): Promise<IteratorResult<SdkStreamMessage, void>> => {
      const error = err instanceof Error ? err : new Error("unknown iterator throw");
      return Promise.reject(error);
    },
    [Symbol.asyncIterator]() {
      return this;
    },
  };
}

// ---------------------------------------------------------------------------
// Fake queryFn factories
// ---------------------------------------------------------------------------

/** Returns a fake queryFn that immediately yields a success result. */
function makeSuccessQueryFn(resultText: string): QueryFn {
  return function (params) {
    void params;
    const messages: SdkStreamMessage[] = [
      { type: "result", subtype: "success", result: resultText },
    ];
    let idx = 0;
    return makeIterator(async () => {
      await Promise.resolve(); // allow microtasks to tick
      if (idx < messages.length) {
        const value = messages[idx++]!;
        return { done: false, value };
      }
      return { done: true, value: undefined };
    });
  };
}

/**
 * Returns a fake queryFn whose `next()` hangs until the AbortController
 * fires. The timeout in runAgentAttempt triggers the abort, so the iterator
 * resolves promptly once the timeout fires — keeping the test fast.
 */
function makeHangingQueryFn(): QueryFn {
  return function (params) {
    const signal = params.options?.abortController?.signal;
    return makeIterator(
      () =>
        new Promise<IteratorResult<SdkStreamMessage, void>>((resolve) => {
          if (signal) {
            // Resolves as soon as the AbortController fires.
            signal.addEventListener("abort", () => resolve({ done: true, value: undefined }), {
              once: true,
            });
          }
          // If no signal provided, hangs indefinitely (tests always pass a signal).
        }),
    );
  };
}

/**
 * Returns a fake queryFn whose `next()` rejects immediately, simulating an
 * SDK error (e.g. network failure, auth error).
 */
function makeThrowingQueryFn(message: string): QueryFn {
  return function (params) {
    void params;
    return makeIterator(
      (): Promise<IteratorResult<SdkStreamMessage, void>> =>
        Promise.reject(new Error(message)),
    );
  };
}

// ---------------------------------------------------------------------------
// Fixture repo
// ---------------------------------------------------------------------------

let fixtureRepoPath: string;

beforeEach(() => {
  fixtureRepoPath = fs.mkdtempSync(path.join(os.tmpdir(), "harness-test-"));
});

afterEach(() => {
  fs.rmSync(fixtureRepoPath, { recursive: true, force: true });
});

function makeTask(overrides?: Partial<TaskInput>): TaskInput {
  return {
    taskId: "test-task-1",
    description: "do something",
    targetRepoPath: fixtureRepoPath,
    verifyCommands: ["echo ok"],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("runAgentAttempt", () => {
  it("success case: fake queryFn resolves quickly → ok=true, timedOut=false, output contains result", async () => {
    const task = makeTask();
    const result = await runAgentAttempt(task, {
      queryFn: makeSuccessQueryFn("task completed successfully"),
      timeoutMs: 5_000,
    });

    expect(result.ok).toBe(true);
    expect(result.timedOut).toBe(false);
    expect(result.output).toContain("task completed successfully");
    expect(result.error).toBeUndefined();
  });

  it("timeout case: fake queryFn hangs → ok=false, timedOut=true, resolves within ~timeoutMs", async () => {
    const task = makeTask();
    const timeoutMs = 80;

    const start = Date.now();
    const result = await runAgentAttempt(task, {
      queryFn: makeHangingQueryFn(),
      timeoutMs,
    });
    const elapsed = Date.now() - start;

    expect(result.ok).toBe(false);
    expect(result.timedOut).toBe(true);
    expect(result.output).toBe("");
    expect(result.error).toMatch(/timed out/i);
    // Should resolve within roughly 10× the timeout (generous for CI jitter)
    expect(elapsed).toBeLessThan(timeoutMs * 10);
  });

  it("error case: fake queryFn throws → ok=false, timedOut=false, error field is set", async () => {
    const task = makeTask();
    const result = await runAgentAttempt(task, {
      queryFn: makeThrowingQueryFn("boom — sdk exploded"),
      timeoutMs: 5_000,
    });

    expect(result.ok).toBe(false);
    expect(result.timedOut).toBe(false);
    expect(result.error).toMatch(/boom — sdk exploded/);
  });

  it("cwd wiring: queryFn receives options.cwd equal to task.targetRepoPath", async () => {
    const task = makeTask();
    let capturedCwd: string | undefined;

    const capturingQueryFn: QueryFn = function (params) {
      capturedCwd = params.options?.cwd;
      return makeSuccessQueryFn("ok")(params);
    };

    await runAgentAttempt(task, { queryFn: capturingQueryFn, timeoutMs: 5_000 });

    expect(capturedCwd).toBe(task.targetRepoPath);
  });

  it("repairPrompt: when provided, prompt sent to queryFn includes both task description and repairPrompt", async () => {
    const task = makeTask({ description: "primary task" });
    let capturedPrompt: string | undefined;

    const capturingQueryFn: QueryFn = function (params) {
      capturedPrompt =
        typeof params.prompt === "string" ? params.prompt : undefined;
      return makeSuccessQueryFn("ok")(params);
    };

    await runAgentAttempt(task, {
      queryFn: capturingQueryFn,
      timeoutMs: 5_000,
      repairPrompt: "previous attempt failed with: error X",
    });

    expect(capturedPrompt).toContain("primary task");
    expect(capturedPrompt).toContain("previous attempt failed with: error X");
  });

  it("no apiKey: queryFn options must NOT include any apiKey field", async () => {
    const task = makeTask();
    let hasApiKey = false;

    const capturingQueryFn: QueryFn = function (params) {
      // Check at runtime that no apiKey is included in options (Core Rule 8).
      hasApiKey = params.options != null && "apiKey" in params.options;
      return makeSuccessQueryFn("ok")(params);
    };

    await runAgentAttempt(task, { queryFn: capturingQueryFn, timeoutMs: 5_000 });

    expect(hasApiKey).toBe(false);
  });
});
