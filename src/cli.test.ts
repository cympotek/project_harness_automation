/**
 * Tests for CLI module — resolveAllowedRoots (Task 1.7, Fix 4).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveAllowedRoots } from "./cli.js";

describe("resolveAllowedRoots (Fix 4)", () => {
  beforeEach(() => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns parsed roots from envValue when set", () => {
    const roots = resolveAllowedRoots("/repo", "/allowed/a,/allowed/b");
    expect(roots).toEqual(["/allowed/a", "/allowed/b"]);
    expect(console.warn).not.toHaveBeenCalled();
  });

  it("trims whitespace around each root", () => {
    const roots = resolveAllowedRoots("/repo", " /x , /y , /z ");
    expect(roots).toEqual(["/x", "/y", "/z"]);
  });

  it("filters out empty segments (double-comma or trailing comma)", () => {
    const roots = resolveAllowedRoots("/repo", "/a,,/b,");
    expect(roots).toEqual(["/a", "/b"]);
  });

  it("falls back to [repoPath] and calls console.warn when envValue is undefined", () => {
    const roots = resolveAllowedRoots("/repo", undefined);
    expect(roots).toEqual(["/repo"]);
    expect(console.warn).toHaveBeenCalledOnce();
    const warnMsg = (console.warn as ReturnType<typeof vi.fn>).mock.calls[0]![0] as string;
    expect(warnMsg).toContain("ALLOWED_ROOTS");
  });

  it("falls back to [repoPath] and calls console.warn when envValue is empty string", () => {
    const roots = resolveAllowedRoots("/repo", "");
    expect(roots).toEqual(["/repo"]);
    expect(console.warn).toHaveBeenCalledOnce();
  });

  it("falls back to [repoPath] and calls console.warn when envValue is whitespace-only", () => {
    const roots = resolveAllowedRoots("/repo", "   ");
    expect(roots).toEqual(["/repo"]);
    expect(console.warn).toHaveBeenCalledOnce();
  });

  it("does NOT call console.warn when envValue is a valid non-empty string", () => {
    resolveAllowedRoots("/repo", "/single-root");
    expect(console.warn).not.toHaveBeenCalled();
  });
});
