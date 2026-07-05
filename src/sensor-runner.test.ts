/**
 * Tests for sensor-runner.ts (Task 1.4).
 *
 * TDD approach: these tests are written BEFORE the implementation exists.
 * Running them now should produce RED (import resolution failure or type errors).
 *
 * Test strategy: real subprocess execution — no mocks.
 *
 * Why real subprocesses instead of mocks:
 *   The whole job of the sensor runner IS running real subprocesses. Real trivial
 *   commands (`node -e "process.exit(0)"`) are fast (~50 ms), cross-platform-safe
 *   (Node is guaranteed present), and exercise the actual kill-on-timeout logic that
 *   mocks would only simulate. Mocking subprocess execution here would be testing
 *   the wrong abstraction.
 *
 * All "slow" test cases use a short timeoutMs (200–2 000 ms) against a `node -e
 * "setTimeout(function(){}, 60000)"` command that would otherwise run for 60 s, so
 * the test suite stays fast even on CI.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { redactOutput, runSensors } from "./sensor-runner.js";

// ---------------------------------------------------------------------------
// Fixture directory
// ---------------------------------------------------------------------------

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sensor-test-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// runSensors — core execution tests
// ---------------------------------------------------------------------------

describe("runSensors", () => {
  it("passing command: exits 0 → passed=true, exitCode=0, timedOut=false, allPassed=true", async () => {
    const result = await runSensors(
      ['node -e "process.exit(0)"'],
      tmpDir,
      { timeoutMs: 5_000 },
    );

    expect(result.results).toHaveLength(1);
    const r = result.results[0]!;
    expect(r.passed).toBe(true);
    expect(r.exitCode).toBe(0);
    expect(r.timedOut).toBe(false);
    expect(r.command).toBe('node -e "process.exit(0)"');
    expect(result.allPassed).toBe(true);
  });

  it("failing command: exits non-zero → passed=false, timedOut=false, allPassed=false", async () => {
    const result = await runSensors(
      ['node -e "process.exit(2)"'],
      tmpDir,
      { timeoutMs: 5_000 },
    );

    expect(result.results).toHaveLength(1);
    const r = result.results[0]!;
    expect(r.passed).toBe(false);
    expect(r.exitCode).toBe(2);
    expect(r.timedOut).toBe(false);
    expect(result.allPassed).toBe(false);
  });

  it("slow command: exceeds short timeout → timedOut=true, exitCode=null, passed=false, test completes quickly", async () => {
    const start = Date.now();

    const result = await runSensors(
      // Would run for 60 s if not killed; timeout is 200 ms.
      ['node -e "setTimeout(function(){}, 60000)"'],
      tmpDir,
      { timeoutMs: 200 },
    );

    const elapsed = Date.now() - start;

    expect(result.results).toHaveLength(1);
    const r = result.results[0]!;
    expect(r.timedOut).toBe(true);
    expect(r.exitCode).toBeNull();
    expect(r.passed).toBe(false);
    expect(result.allPassed).toBe(false);

    // Generous ceiling for CI jitter — the key guarantee is that we didn't
    // wait anywhere near the 60 s the command would have taken.
    expect(elapsed).toBeLessThan(10_000);
  });

  it("mix of passing, failing, and slow commands → allPassed=false, each result shape correct", async () => {
    // Timeout of 2 000 ms: fast commands finish in < 500 ms, slow command
    // (60 s) is killed after 2 s. Total wall-clock: ~2.1 s.
    const result = await runSensors(
      [
        'node -e "process.exit(0)"',
        'node -e "process.exit(1)"',
        'node -e "setTimeout(function(){}, 60000)"',
      ],
      tmpDir,
      { timeoutMs: 2_000 },
    );

    expect(result.results).toHaveLength(3);
    expect(result.allPassed).toBe(false);

    const [passing, failing, slow] = result.results;

    // Passing command
    expect(passing!.passed).toBe(true);
    expect(passing!.timedOut).toBe(false);
    expect(passing!.exitCode).toBe(0);

    // Failing command
    expect(failing!.passed).toBe(false);
    expect(failing!.timedOut).toBe(false);
    expect(failing!.exitCode).toBe(1);

    // Slow command (timed out)
    expect(slow!.timedOut).toBe(true);
    expect(slow!.passed).toBe(false);
    expect(slow!.exitCode).toBeNull();
  });

  it("output captures both stdout and stderr", async () => {
    const result = await runSensors(
      [
        // Write to both streams then exit cleanly
        "node -e \"process.stdout.write('hello-stdout'); process.stderr.write('hello-stderr'); process.exit(0)\"",
      ],
      tmpDir,
      { timeoutMs: 5_000 },
    );

    const r = result.results[0]!;
    expect(r.output).toContain("hello-stdout");
    expect(r.output).toContain("hello-stderr");
  });

  it("allPassed=true only when every command exits 0", async () => {
    const result = await runSensors(
      ['node -e "process.exit(0)"', 'node -e "process.exit(0)"'],
      tmpDir,
      { timeoutMs: 5_000 },
    );
    expect(result.allPassed).toBe(true);
    expect(result.results.every((r) => r.passed)).toBe(true);
  });

  it("empty command list → allPassed=true, results=[]", async () => {
    const result = await runSensors([], tmpDir, { timeoutMs: 5_000 });
    expect(result.allPassed).toBe(true);
    expect(result.results).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// redactOutput — standalone helper tests
//
// NOTE: test "secrets" below are synthetic strings built via concatenation so
// they do not appear as literal secrets in source and do not trip security
// scanners. The redactOutput function detects them by regex at runtime.
// ---------------------------------------------------------------------------

/** Builds a fake OpenAI-style token (sk- + N alphanumeric chars) at runtime. */
function fakeOpenAiToken(len: number): string {
  // Build dynamically so no static-analysis scanner sees a literal "sk-..." key.
  return ["sk", "a".repeat(len)].join("-");
}

/** Builds a fake GitHub token (ghp_ + N alphanumeric chars) at runtime. */
function fakeGitHubToken(len: number): string {
  return ["ghp_", "A".repeat(len)].join("");
}

/** Builds a fake AWS access key ID (AKIA + 16 uppercase alphanumeric chars) at runtime. */
function fakeAwsKeyId(): string {
  // "AKIA" + 16 uppercase chars = the pattern AKIA[0-9A-Z]{16}
  return ["AKIA", "IOSFODNN7EXAMPLE"].join("");
}

describe("redactOutput", () => {
  it("passes through short normal output unchanged", () => {
    const normal = "Tests passed: 42/42\nAll green.";
    expect(redactOutput(normal)).toBe(normal);
  });

  it("redacts OpenAI-style sk- tokens (20+ alphanumeric chars after sk-)", () => {
    const token = fakeOpenAiToken(20); // exactly 20 chars — at the threshold
    const input = `Error: API key ${token} is invalid`;
    const result = redactOutput(input);
    expect(result).not.toContain(token);
    expect(result).toContain("[REDACTED]");
    // Surrounding text should be preserved
    expect(result).toContain("Error: API key");
    expect(result).toContain("is invalid");
  });

  it("does NOT redact short sk- strings (fewer than 20 alphanumeric chars after sk-)", () => {
    // 5 chars after "sk-" — below the 20-char threshold, should not be redacted
    const token = fakeOpenAiToken(5);
    const input = `Error: ${token} is not a real key`;
    const result = redactOutput(input);
    expect(result).toContain(token);
    expect(result).not.toContain("[REDACTED]");
  });

  it("redacts GitHub personal access tokens (ghp_ + 36+ alphanumeric chars)", () => {
    const token = fakeGitHubToken(36); // exactly 36 chars — at the threshold
    const input = `Using token ${token} for push`;
    const result = redactOutput(input);
    expect(result).not.toContain(token);
    expect(result).toContain("[REDACTED]");
    expect(result).toContain("Using token");
    expect(result).toContain("for push");
  });

  it("redacts AWS access key IDs (AKIA + exactly 16 uppercase alphanumeric chars)", () => {
    const keyId = fakeAwsKeyId();
    const input = `AWS key: ${keyId} is exposed in logs`;
    const result = redactOutput(input);
    expect(result).not.toContain(keyId);
    expect(result).toContain("[REDACTED]");
  });

  it("truncates output beyond 10 000 chars and appends a truncation marker", () => {
    const longString = "x".repeat(20_000);
    const result = redactOutput(longString);
    // Must be shorter than the original
    expect(result.length).toBeLessThan(20_000);
    // Truncation marker should be present
    expect(result).toContain("[truncated");
    // Should start with the first 10 000 chars
    expect(result.startsWith("x".repeat(10_000))).toBe(true);
  });

  it("redacts secrets that appear in the middle of output", () => {
    const prefix = "ok\n".repeat(100); // short, not truncated
    const secret = fakeOpenAiToken(26); // 26 chars after sk-
    const suffix = "\nmore output";
    const input = prefix + secret + suffix;
    const result = redactOutput(input);
    expect(result).not.toContain(secret);
    expect(result).toContain("[REDACTED]");
  });

  it("secret before truncation boundary is fully redacted (redact-first ordering)", () => {
    // With redact-first ordering, a complete secret is always matched and replaced
    // before any truncation, regardless of its position relative to the boundary.
    const fullSecret = fakeOpenAiToken(25); // 28-char token placed at pos 100
    const input = "a".repeat(100) + fullSecret + "c".repeat(20_000);
    const result = redactOutput(input);
    expect(result).not.toContain(fullSecret);
    expect(result).toContain("[REDACTED]");
  });

  it("AKIA key straddling the raw truncation boundary is fully redacted (regression for fixed-length pattern boundary-split leak)", () => {
    // Critical regression test for the redact-first ordering fix.
    //
    // AKIA keys require EXACTLY 16 chars after "AKIA" to match the regex
    // AKIA[0-9A-Z]{16} (20 chars total). Unlike the unbounded sk-/ghp_ patterns,
    // there is no partial match for fewer chars.
    //
    // OLD ordering (truncate-then-redact): if the key straddles the 10 000-char
    // boundary, truncation cuts the key in two. The remaining prefix (fewer than
    // 16 chars after "AKIA") no longer satisfies the {16} quantifier — the
    // regex fails to match — and the key prefix leaks in cleartext.
    //
    // NEW ordering (redact-then-truncate): the full 20-char key is matched and
    // replaced with "[REDACTED]" (10 chars) on the full raw string BEFORE any
    // truncation. Because "[REDACTED]" is 10 chars shorter than the original
    // 20-char key, the placeholder fits within the truncation window even when
    // the original key straddled the boundary.
    //
    // Placement constraint:
    //   - Key starts at position K in the raw string.
    //   - Key straddles the 10 000-char boundary: K < 10 000 < K + 20,
    //     which means K ≥ 9 981.
    //   - After redaction, the 10-char "[REDACTED]" placeholder ends at K + 10.
    //     For it to remain fully within the 10 000-char truncation window:
    //     K + 10 ≤ 10 000, so K ≤ 9 990.
    //   - Valid placement: 9 981 ≤ K ≤ 9 990. We use K = 9 985.
    //
    // With K = 9 985:
    //   - Raw: key spans positions 9 985–10 004 (straddles boundary at 10 000)
    //   - Redacted: "[REDACTED]" spans positions 9 985–9 994 (fits within 10 000)
    //   - After truncation: "[REDACTED]" is preserved intact in the output.
    const awsKey = fakeAwsKeyId(); // "AKIA" + 16 uppercase alphanumeric = 20 chars
    const K = 9_985; // key start position — straddles raw boundary, placeholder fits
    const input = "a".repeat(K) + awsKey + "b".repeat(5_000);
    const result = redactOutput(input);
    // The full key must not appear in any form in the output
    expect(result).not.toContain(awsKey);
    // [REDACTED] must be present and intact — the key was detected and replaced
    // before truncation, so the placeholder was not split by the truncation boundary
    expect(result).toContain("[REDACTED]");
  });
});
