/**
 * Agent runner module (Task 1.3).
 *
 * Given a TaskInput, invokes the Claude Agent SDK's `query()` with:
 *   - cwd: task.targetRepoPath
 *   - NO explicit apiKey — SDK resolves credentials itself (Core Rule 8)
 *
 * Enforces a subprocess timeout (Core Rule 7): if the SDK call does not
 * settle within `timeoutMs`, resolves with a timed-out failure result rather
 * than hanging. Uses AbortController to actually cancel the underlying SDK
 * work rather than just abandoning a leaked promise.
 *
 * Returns a structured `AgentAttemptResult` — never throws, never hangs.
 *
 * Core Rule 1 note: this module produces an *attempt result* only. It does
 * NOT decide whether the task is "done" — that is the sensor runner's job
 * (Task 1.4). The `ok` field means "the SDK call completed without
 * error/timeout", not "the task succeeded".
 *
 * ---
 * Real SDK `query()` API (as of @anthropic-ai/claude-agent-sdk v0.3.201):
 *
 *   function query({ prompt, options? }): Query
 *
 *   - `prompt`: string | AsyncIterable<SDKUserMessage>
 *   - `options`: optional Options object (cwd, model, systemPrompt,
 *       abortController, permissionMode, allowedTools, disallowedTools, env,
 *       maxTurns, hooks, and many more). NO apiKey option — auth is resolved
 *       by the SDK from ANTHROPIC_API_KEY env or subscription auth (claude
 *       login / OS keychain).
 *   - Returns `Query` which extends `AsyncGenerator<SDKMessage, void>` and
 *       additionally exposes .interrupt(), .setPermissionMode(), .setModel(),
 *       .setMaxThinkingTokens() and other mid-stream control methods.
 *
 *   The stream yields `SDKMessage` union variants (assistant text, tool
 *   results, status lines, etc.). The final message always has
 *   `type: 'result'` with either:
 *     - `subtype: 'success'` and a `result: string` containing the agent's
 *       output text, or
 *     - an error subtype (e.g. 'error_during_execution', 'error_max_turns')
 *       with an `errors: string[]` array describing the failure.
 *
 *   AbortController integration: passing an `abortController` in Options lets
 *   the SDK properly clean up the underlying subprocess on cancellation rather
 *   than leaving it running detached. This is the recommended cancellation
 *   mechanism (vs. just abandoning the promise).
 */

import { query as sdkQuery } from "@anthropic-ai/claude-agent-sdk";
import type { Options } from "@anthropic-ai/claude-agent-sdk";
import type { TaskInput } from "./schema.js";

// ---------------------------------------------------------------------------
// Local structural type for SDK stream messages
//
// The real SDK exports a large `SDKMessage` union (30+ variants) whose full
// type graph may not resolve deterministically in @typescript-eslint's type-
// checked rules. We use a minimal flat structural type that covers only the
// fields we actually read from the stream. Every real SDKMessage satisfies
// this type (all SDK messages have `type: string`; the optional fields are
// absent on non-result messages which TypeScript treats as compatible with
// optional properties).
// ---------------------------------------------------------------------------

/**
 * Minimal structural type for SDK stream messages.
 *
 * Exported so tests can create fake messages without importing from the SDK.
 * The real SDK's `SDKMessage` union is a structural supertype of this
 * (every SDKMessage is assignable here), so `sdkQuery` is assignable to
 * `QueryFn` through the `as unknown as QueryFn` bridge in the implementation.
 */
export type SdkStreamMessage = {
  type: string;
  subtype?: string;
  result?: string;
  errors?: string[];
};

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * The type of the SDK `query()` function, extracted for dependency injection.
 * Tests pass a fake implementation; production uses the real SDK.
 */
export type QueryFn = (params: {
  prompt: string | AsyncIterable<SdkStreamMessage>;
  options?: Options;
}) => AsyncGenerator<SdkStreamMessage, void>;

/** Result of one agent attempt. */
export interface AgentAttemptResult {
  /**
   * True if the SDK call completed without error or timeout.
   *
   * NOTE: this does NOT mean the task is done — that is the sensor runner's
   * (Task 1.4) determination. A `true` value here only means the SDK round-
   * trip finished cleanly.
   */
  ok: boolean;

  /** True when the attempt was terminated because it exceeded `timeoutMs`. */
  timedOut: boolean;

  /**
   * The result text from the SDK's final `result` message (on success), or
   * an empty string (on timeout/error). Used as context for repair prompts
   * if the loop controller (Task 1.5) needs to feed sensor failure output
   * back to the agent.
   */
  output: string;

  /** Human-readable error description; present only when `ok` is false. */
  error?: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default timeout for a single agent attempt (5 minutes). */
const DEFAULT_TIMEOUT_MS = 300_000;

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

/**
 * Runs one agent attempt for the given task.
 *
 * @param task          Validated TaskInput from schema.ts.
 * @param opts.timeoutMs   Max wall-clock time for the SDK call (ms). Default: 300 000.
 * @param opts.repairPrompt  When provided, appended to `task.description` so the
 *                     agent receives sensor failure output from the previous
 *                     attempt (used by the loop controller in Task 1.5).
 * @param opts.queryFn  Dependency-injection point for the SDK `query()` function.
 *                     Production callers omit this (real SDK is used). Tests
 *                     pass a fake implementation so no live API calls are made.
 */
export async function runAgentAttempt(
  task: TaskInput,
  opts?: {
    timeoutMs?: number;
    repairPrompt?: string;
    queryFn?: QueryFn;
  },
): Promise<AgentAttemptResult> {
  const timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  // Cast through unknown to bridge sdkQuery (returns Query<SDKMessage>) to
  // QueryFn (returns AsyncGenerator<SdkStreamMessage>). Every SDKMessage is
  // structurally compatible with SdkStreamMessage, so this is runtime-correct.
  const queryFn: QueryFn =
    opts?.queryFn ?? (sdkQuery as unknown as QueryFn);

  // Build the prompt — include repair context from the previous attempt when
  // the loop controller (Task 1.5) provides it.
  const prompt =
    opts?.repairPrompt != null && opts.repairPrompt.length > 0
      ? `${task.description}\n\n${opts.repairPrompt}`
      : task.description;

  // AbortController lets us actually stop the SDK subprocess when the timeout
  // fires, rather than just abandoning a leaked promise.
  const abortController = new AbortController();

  // Timeout promise: resolves to a timed-out failure result after `timeoutMs`.
  // Also fires abortController.abort() so the SDK cleans up its subprocess.
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<AgentAttemptResult>((resolve) => {
    timeoutHandle = setTimeout(() => {
      abortController.abort();
      resolve({
        ok: false,
        timedOut: true,
        output: "",
        error: `agent attempt timed out after ${timeoutMs}ms`,
      });
    }, timeoutMs);
  });

  // Main run promise: iterates the SDK async generator, collecting output.
  const runPromise: Promise<AgentAttemptResult> = (async () => {
    try {
      const gen = queryFn({
        prompt,
        options: {
          // Core Rule 8: pass cwd but NOT an explicit apiKey.
          // The SDK resolves ANTHROPIC_API_KEY env var itself, falling back
          // to subscription auth (claude login / OS keychain) if unset.
          // TODO(task 1.5+): thread model/systemPrompt through once TaskInput
          // supports them (currently TaskInput only exposes targetRepoPath/cwd).
          cwd: task.targetRepoPath,
          abortController,
        },
      });

      let output = "";

      for await (const message of gen) {
        // Stop early if we were aborted (timeout already fired).
        if (abortController.signal.aborted) {
          break;
        }

        if (message.type === "result") {
          if (message.subtype === "success") {
            // SDK result message with success subtype: result field holds output.
            output = message.result ?? "";
          } else {
            // SDK result message with error subtype (max turns, budget, etc.)
            const errors = message.errors ?? [];
            return {
              ok: false,
              timedOut: false,
              output: "",
              error:
                errors.length > 0
                  ? errors.join("; ")
                  : String(message.subtype ?? "sdk error"),
            };
          }
        }
        // Other message types (assistant text, tool results, status lines, etc.)
        // are intentionally ignored — the final result message carries output.
      }

      clearTimeout(timeoutHandle);
      return { ok: true, timedOut: false, output };
    } catch (err: unknown) {
      clearTimeout(timeoutHandle);
      // If the abort caused the error, the timeout promise already resolved;
      // this branch handles genuine SDK errors or unexpected throws.
      if (abortController.signal.aborted) {
        // Timeout already resolved via timeoutPromise and won the race.
        // Return a plain result (not a never-settling promise) to avoid
        // retaining a closure over `gen`, `abortController`, and `output`
        // indefinitely — Promise.race's losing side never fires .then()
        // reactions but DOES hold the promise in memory until GC. Since
        // timed-out attempts are the expected path this module exists for,
        // using a never-settling promise here would accumulate leaks across
        // every attempt in a long-running harness session.
        return {
          ok: false,
          timedOut: true,
          output: "",
          error: `agent attempt timed out after ${timeoutMs}ms`,
        };
      }
      return {
        ok: false,
        timedOut: false,
        output: "",
        error: err instanceof Error ? err.message : String(err),
      };
    }
  })();

  // Race: whichever settles first wins.
  const result = await Promise.race([runPromise, timeoutPromise]);

  // Clean up: if runPromise won, cancel the timeout; if timeoutPromise won,
  // the abort is already fired. Either way, clear the handle defensively.
  clearTimeout(timeoutHandle);

  return result;
}
