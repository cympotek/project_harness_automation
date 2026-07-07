/**
 * Tests for verify-detect.ts (Task 2.2).
 *
 * TDD approach: these tests are written BEFORE the implementation exists.
 * Running them now should produce RED (module not found).
 *
 * Test strategy: write fixture package.json files into temp directories.
 * No mocks — the function reads a real file from disk.
 *
 * Fixture variants:
 *   1. All three scripts present: lint, typecheck, test
 *   2. typecheck absent but type-check present
 *   3. Partial: only lint and test
 *   4. Partial: only test (plus unrelated scripts)
 *   5. No relevant scripts present
 *   6. scripts key absent entirely
 *   7. package.json does not exist
 *   8. Malformed JSON
 *   9. Both typecheck and type-check present (typecheck wins)
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { detectVerifyCommands } from "./verify-detect.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "verify-detect-test-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function writePackageJson(dir: string, content: object): void {
  fs.writeFileSync(
    path.join(dir, "package.json"),
    JSON.stringify(content),
    "utf8",
  );
}

function writeRaw(dir: string, content: string): void {
  fs.writeFileSync(path.join(dir, "package.json"), content, "utf8");
}

// ---------------------------------------------------------------------------
// detectVerifyCommands
// ---------------------------------------------------------------------------

describe("detectVerifyCommands", () => {
  it("returns all three commands when lint, typecheck, and test are present", () => {
    writePackageJson(tmpDir, {
      scripts: {
        lint: "eslint src",
        typecheck: "tsc --noEmit",
        test: "vitest run",
      },
    });
    expect(detectVerifyCommands(tmpDir)).toEqual([
      "npm run lint",
      "npm run typecheck",
      "npm run test",
    ]);
  });

  it("uses type-check key when typecheck is absent but type-check is present", () => {
    writePackageJson(tmpDir, {
      scripts: {
        lint: "eslint src",
        "type-check": "tsc --noEmit",
        test: "vitest run",
      },
    });
    expect(detectVerifyCommands(tmpDir)).toEqual([
      "npm run lint",
      "npm run type-check",
      "npm run test",
    ]);
  });

  it("returns only present scripts when partial (lint + test only)", () => {
    writePackageJson(tmpDir, {
      scripts: {
        lint: "eslint src",
        test: "vitest run",
      },
    });
    expect(detectVerifyCommands(tmpDir)).toEqual([
      "npm run lint",
      "npm run test",
    ]);
  });

  it("returns only present scripts when partial (test only)", () => {
    writePackageJson(tmpDir, {
      scripts: {
        build: "tsc",
        test: "vitest run",
      },
    });
    expect(detectVerifyCommands(tmpDir)).toEqual(["npm run test"]);
  });

  it("returns [] when none of the relevant scripts are present", () => {
    writePackageJson(tmpDir, {
      scripts: {
        build: "tsc",
        start: "node dist/index.js",
      },
    });
    expect(detectVerifyCommands(tmpDir)).toEqual([]);
  });

  it("returns [] when scripts key is absent entirely", () => {
    writePackageJson(tmpDir, { name: "foo", version: "1.0.0" });
    expect(detectVerifyCommands(tmpDir)).toEqual([]);
  });

  it("returns [] when package.json does not exist", () => {
    // tmpDir exists but has no package.json
    expect(detectVerifyCommands(tmpDir)).toEqual([]);
  });

  it("returns [] when package.json contains malformed JSON", () => {
    writeRaw(tmpDir, "{ not valid json }");
    expect(detectVerifyCommands(tmpDir)).toEqual([]);
  });

  it("prefers typecheck over type-check when both are present", () => {
    writePackageJson(tmpDir, {
      scripts: {
        typecheck: "tsc --noEmit",
        "type-check": "tsc --noEmit --strict",
        test: "vitest run",
      },
    });
    expect(detectVerifyCommands(tmpDir)).toEqual([
      "npm run typecheck",
      "npm run test",
    ]);
  });

  it("preserves declaration order: lint first, then typecheck variant, then test", () => {
    // Regardless of key insertion order in JSON, output order must be fixed:
    // lint → typecheck/type-check → test
    writePackageJson(tmpDir, {
      scripts: {
        test: "vitest run",
        lint: "eslint src",
        typecheck: "tsc --noEmit",
      },
    });
    expect(detectVerifyCommands(tmpDir)).toEqual([
      "npm run lint",
      "npm run typecheck",
      "npm run test",
    ]);
  });
});
