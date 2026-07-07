# Harness as a Claude Code (+ Codex, best-effort) Plugin — Design

Created: 2026-07-07
Status: drafted, pending user review
Precedence: subordinate to [`spec.md`](../../../spec.md) (product contract). Where this
doc changes a Core Rule or contract from spec.md, that change must be folded back into
spec.md before/while implementing (tracked in the implementation plan, not here).

## Problem

Phase 1 shipped `harness-loop` as a standalone CLI (`harness run --task ... --repo ...
--verify ...`). Using it from a second project requires: build it locally, `npm link`
(or global install, or a `file:` dependency), set `ALLOWED_ROOTS`, then remember the
full flag syntax. That's real friction for a solo dev who mostly lives inside Claude
Code / Codex sessions already.

Goal: make both **installation** and **invocation** as low-friction as "drop a folder
in, then say what you want in plain language" — by packaging the harness as a plugin
for Claude Code (primary) and Codex (best-effort, since Codex's plugin manifest format
isn't fully documented yet).

## Decisions made (via brainstorming Q&A)

1. Both ease-of-install and ease-of-invocation are in scope (not just one).
2. Build for both Claude Code and Codex now, best-effort — Codex's thinner docs are an
   accepted risk, not a blocker.
3. The standalone CLI (`cli.ts`, the `harness` bin) is **retired**, not kept alongside.
   The plugin/MCP server becomes the only supported entrypoint.
4. Both `repo` and `verify` commands are auto-detected by default (host project dir;
   `package.json` scripts), with explicit override still possible.
5. Progress is **streamed** via MCP progress notifications (attempt-by-attempt), not a
   single blocking call — closer to today's CLI console UX.

## Architecture

Two layers:

1. **Core engine** — `schema.ts`, `agent-runner.ts`, `sensor-runner.ts`,
   `loop-controller.ts`, `state-store.ts`. Unchanged. Every Core Rule in spec.md that
   governs this layer (1–2, 4–9: sensors-as-authority, capped retries, no auto-rollback,
   resumable state, path confinement, subprocess timeouts, no custom auth, redaction)
   still applies exactly as written.
2. **Entrypoint layer** — `cli.ts` is deleted. A new MCP stdio server (`mcp-server.ts`)
   becomes the only entrypoint, exposing one tool, `harness_run`, that both Claude Code
   and Codex can register as a plugin's MCP-server component.

## New components

### `src/mcp-server.ts`

Exposes one MCP tool, `harness_run`:

**Input schema:**
```
{
  description: string              // required — the task, in plain language
  taskId?: string                  // optional — auto-slugged from description if omitted
  repo?: string                    // optional — default: host project dir (see below)
  verify?: string[]                // optional — default: auto-detected (see below)
  maxAttempts?: number             // optional — default: 3
}
```

**Repo auto-detection default:** resolve via the MCP `roots/list` request (falls back
to `CLAUDE_PROJECT_DIR` env var if the host doesn't answer `roots/list`). `ALLOWED_ROOTS`
confinement (Core Rule 6) still applies unchanged — auto-detection picks the default
candidate, it does not bypass the allowlist check.

**Verify auto-detection default:** delegated to `verify-detect.ts` (below). If neither
an explicit `verify` array nor any auto-detected script exists, the tool call fails
validation rather than running with zero checks. This resolves spec.md Open Decision #4
(empty verify list vacuously "passing") as a side effect of this work — spec.md must be
updated to reflect that `verifyCommands` is now enforced non-empty at the schema level.

**Output:** structured result — `status` (`"passed" | "escalated"`), `attempts` (count),
and on escalation, the same summary that's written to the escalation artifact (see
below). No behavior change to what gets persisted on disk.

**Progress streaming:** each loop-controller transition (attempt started → verifying →
attempt result) sends an MCP `notifications/progress` message. A host that renders
progress notifications shows live status; a host that doesn't just sees the final
result when the call resolves — no hard dependency either way.

### `src/verify-detect.ts` (new)

Given a resolved repo path, reads `<repo>/package.json`, checks for `scripts.lint`,
`scripts.typecheck` (or `scripts["type-check"]`), and `scripts.test`. Returns
`npm run <name>` for each script key present, in that order. Pure function, no side
effects — easy to unit test against fixture `package.json` files (present / partial /
absent / no scripts at all).

### Claude Code plugin packaging (repo root becomes the plugin)

```
.claude-plugin/plugin.json     # name: "harness-loop", version, description
.mcp.json                      # { "harness": { command: "node",
                                #     args: ["${CLAUDE_PLUGIN_ROOT}/dist/mcp-server.js"] } }
skills/harness-run/SKILL.md    # documents /harness-run, what's auto-detected vs overridable
hooks/hooks.json               # SessionStart hook: npm ci into ${CLAUDE_PLUGIN_DATA}
                                #   on first load / when package.json changes
```

The `SessionStart` hook means a consumer never runs `npm install` / `npm run build`
themselves — the plugin installs its own runtime dependency into its persistent data
directory the first time it loads (pattern taken directly from Claude Code's own
plugin docs for this exact scenario).

**Distribution:** this repo (or a built release of it) is dropped/symlinked into
`~/.claude/skills/harness-loop/` (available in every project, personal scope) or
`<their-repo>/.claude/skills/harness-loop/` (team-shared via git, project scope).
Because it has `.claude-plugin/plugin.json`, Claude Code auto-loads it as a plugin next
session — no marketplace, no `claude plugin install` step.

### Codex packaging (best-effort, now with a concrete schema to build against)

Per `developers.openai.com/codex/plugins/build`, Codex plugins use their own manifest,
distinct from Claude Code's:

```
.codex-plugin/plugin.json     # required fields: name, version, description
                               # optional: skills, mcpServers, apps, hooks (paths)
.mcp.json                     # same server-map shape as Claude Code's:
                               #   { "harness": { "command": "...", "args": [...] } }
skills/harness-run/SKILL.md   # same SKILL.md shape (frontmatter: name, description)
```

Reuses the exact same `dist/mcp-server.js` built for Claude Code — only the manifest
wrapper differs (`.codex-plugin/plugin.json` instead of `.claude-plugin/plugin.json`).
Local dev/testing needs a marketplace entry at `.agents/plugins/marketplace.json` (repo
root or `~/.agents/plugins/`) with a relative `source.path`, then a Codex restart to
load it — there's no zero-config "skills-dir" equivalent documented for Codex the way
Claude Code has one, so this path is one step heavier to install than the Claude Code
one. Still marked best-effort since it hasn't been validated against a live Codex
install yet, but the manifest shape itself is no longer a guess.

## Data flow

```
Claude Code / Codex session
  → user: "/harness-run fix the null check in src/foo.ts"
     (or Claude auto-invokes harness_run based on conversation context)
  → MCP tool call: harness_run({ description, repo?, verify?, maxAttempts? })
  → mcp-server.ts resolves repo (roots/list or CLAUDE_PROJECT_DIR) and verify
    (verify-detect.ts) if not explicitly given
  → same loop-controller as today: attempt → verify → repair-prompt-on-fail →
    retry/escalate, with progress notifications sent per transition
  → state/escalation JSON still written to <repo>/.harness/... exactly as today
  → tool call resolves with final status; session shows it
```

## What's explicitly unchanged

- `.harness/state/<task-id>.json` / `.harness/escalations/<task-id>.json` — same shape,
  same location (inside the *target* repo), still human/dashboard-inspectable
  independent of which host ran the task.
- No auto-rollback on escalation (Core Rule 4).
- No multi-task queue, dashboard, or multi-agent orchestration (spec.md Non-Goals) —
  untouched by this work.

## What this design changes in spec.md (to fold in during implementation)

- Core Rule 8 references CLI-only invocation implicitly via `query()` cwd/model/etc —
  still accurate, just now called from `mcp-server.ts` instead of `cli.ts`.
- "Task input" contract in Data And Contracts gains optional auto-detection defaults for
  `targetRepoPath` and `verifyCommands`.
- Open Decision #1 (verify auto-detection) — resolved: auto-detected from `package.json`
  scripts, explicit override always wins.
- Open Decision #4 (empty verifyCommands vacuous pass) — resolved: schema now rejects an
  empty, fully-unresolved verify list.
- A new Core Rule should document the MCP entrypoint replacing the CLI entrypoint, and
  that progress is communicated via MCP progress notifications where the host supports
  it.

## Testing

- `verify-detect.ts`: unit tests over fixture `package.json` files (all three scripts
  present; partial; absent; malformed JSON).
- `mcp-server.ts`: integration test using an in-memory/mock MCP client driving a
  `harness_run` call end-to-end against a fixture repo (mirrors the existing
  `e2e.test.ts` pattern from Phase 1, adapted to go through the MCP tool call instead of
  spawning the CLI as a subprocess).
- Progress notifications: test that the expected sequence of `notifications/progress`
  messages is sent for a multi-attempt run (fails twice, passes on the third).
- Regression: every existing Phase 1 unit test for the core engine
  (schema/agent-runner/sensor-runner/loop-controller/state-store) should keep passing
  unmodified, since that layer isn't touched.

## Risks / open items for the implementation plan to track explicitly

- Codex manifest format is a best guess — flag as experimental, budget time to revise
  once tested against a real Codex CLI install.
- MCP progress notification rendering depends on host support — verify empirically in
  Claude Code before assuming the UX win is real; degrade gracefully (final result only)
  if not rendered.
- Retiring the CLI is a breaking change for anyone already using the Phase 1 CLI
  workflow documented in the current README — the implementation plan should include
  updating/removing that CLI-usage documentation in the same pass as the code change,
  not leave it stale.
