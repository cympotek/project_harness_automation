# project_harness_automation Plans.md

Created: 2026-07-05

Spec: see `spec.md` (product contract, precedence over this file)

---

## Phase 1: Walking Skeleton (single-agent run → verify → loop)

Purpose: prove the core Guides×Sensors loop end-to-end on one task before any multi-agent or skill-marketplace work.

formatter_baseline: missing
formatter_baseline_evidence: no package.json / tsconfig / lint config present in repo root
formatter_baseline_action: add_setup_task (see 1.1)

| Task | Description | DoD | Depends | Status |
|------|------|-----|---------|--------|
| 1.1 | [setup] [tdd:skip:config-only-scaffold] Scaffold TS project: `package.json`, `tsconfig.json`, ESLint+Prettier config (lint/format baseline), and a CLI entrypoint (`harness run --task <id> --repo <path> --verify "<cmd1>" --verify "<cmd2>"`) that just parses args and exits 0. | `npm run lint` and `npm run build` both exit 0; `harness run --help` prints usage. | - | cc:完了 [b13e4b1] |
| 1.2 | [tdd:required] Define task input contract + state file schema (`TaskInput`, `StateFile`, `EscalationArtifact` types from spec.md Data And Contracts) plus a schema-validation function, including `ALLOWED_ROOTS` path-confinement check. | Unit tests pass validating: a well-formed input, a malformed input (rejected), and a `targetRepoPath` outside `ALLOWED_ROOTS` (rejected). | 1.1 | cc:完了 [b1848bc] |
| 1.3 | [tdd:required] [feature:security] Agent runner module: given a task + target repo path, invoke Claude Agent SDK's `query()` with `cwd`/`model`/`systemPrompt` (no explicit `apiKey` — rely on SDK default auth resolution per spec.md Core Rule 8), enforcing a subprocess timeout. | Integration test against a fixture repo shows the SDK call executes, returns a result object, and a forced-timeout case returns a timed-out failure result rather than hanging. | 1.2 | cc:完了 [1ee2705] |
| 1.4 | [tdd:required] [feature:security] Sensor runner module: given a list of verification commands, execute each against the target repo with an explicit timeout, capture stdout/stderr, apply the redaction rule (truncate + secret-pattern scrub) from spec.md, and return a structured pass/fail result per command. | Unit test with a fixture repo containing one passing command, one intentionally failing command, and one intentionally slow command confirms correct structured output and timeout-as-failure behavior. | 1.2 | cc:完了 [3639bae] |
| 1.5 | [tdd:required] Loop controller: orchestrate agent runner → sensor runner; on failure, feed the sensor's verbatim (redacted) failure output back into the agent as the next repair prompt; retry up to `maxAttempts` (default 3, configurable via `TaskInput`). | Test with a fixture task that fails twice then succeeds on the 3rd attempt confirms the loop retries and terminates on success within the cap; a fixture task that never passes confirms the loop stops exactly at `maxAttempts` and does not retry further. | 1.3, 1.4 | cc:完了 [e459ffc] |
| 1.6 | [tdd:required] Escalation & completion reporting: on success, write state file with `status: "passed"` and print a declarative "done" status line; on cap exceeded, write `.harness/escalations/<task-id>.json` (per spec.md schema) with full attempt history, print a console escalation message, and stop. | Test confirms: (a) a passing run writes `status: "passed"` to the state file and prints exactly one "done" line; (b) a cap-exceeded run writes a well-formed escalation JSON matching the `EscalationArtifact` schema and the process exits without further retries. | 1.5 | cc:完了 [6a64cf9] |
| 1.7 | [tdd:required] Progress persistence: write `.harness/state/<task-id>.json` after every attempt (task id, attempt count, status, last redacted sensor output, timestamps); on restart with the same task id, resume from the last persisted attempt count instead of starting at attempt 1. | Test that terminates the process via `process.exit()` immediately after attempt 1's state write, then re-invokes the CLI with the same task id, confirms attempt count resumes at 2 (not 1) and the loop completes correctly from there. | 1.5 | cc:完了 [7241089] |
| 1.8 | [tdd:required] [e2e] End-to-end smoke test: run the full CLI loop against a fixture repo with one intentionally failing test, confirm the agent fixes it within the retry cap (using real or mocked Agent SDK calls — mocked by default in CI to avoid cost/auth flakiness, with an opt-in flag for a real-SDK run locally) and the loop reports success. | `npm test` includes this e2e case; it passes in CI using the mocked-SDK path by default. | 1.3, 1.4, 1.5, 1.6, 1.7 | cc:完了 [5aaf2e3] |

### Task context / review notes carried into DoDs

- Security review flagged: sensor/agent subprocess timeouts, secret redaction, and
  `ALLOWED_ROOTS` path confinement — all folded into 1.2/1.3/1.4 DoDs above (not a separate
  task; too foundational to defer).
- QA review flagged 1.6/1.7 DoDs as under-specified until escalation-artifact format and
  crash-simulation mechanism were fixed — both are now pinned: escalation artifact schema
  lives in spec.md; crash simulation is `process.exit()` immediately post-write, not a real
  `SIGKILL`, to keep the test deterministic and fast.
- Skeptic review flagged real-SDK calls in CI as a cost/flakiness risk — 1.8's DoD defaults
  to a mocked-SDK path in CI, with real-SDK run as a local opt-in, deferring the "does this
  work against the real Anthropic API in CI" question rather than blocking the walking
  skeleton on it.

## Phase 2: Claude Code (+ Codex, best-effort) Plugin Packaging

Purpose: replace the standalone CLI entrypoint with an MCP-server-backed plugin so
another project can install this harness by dropping a folder into
`~/.claude/skills/` (Claude Code) or a Codex plugins marketplace entry, and invoke it
in plain language instead of remembering CLI flags. Design doc:
[`docs/superpowers/specs/2026-07-07-harness-claude-code-plugin-design.md`](docs/superpowers/specs/2026-07-07-harness-claude-code-plugin-design.md).

Decisions locked in during brainstorming (see design doc for full rationale):
- CLI (`cli.ts`, the `harness` bin) is retired, not kept alongside the plugin.
- Both `repo` and `verify` commands are auto-detected by default (host project dir;
  `package.json` scripts), with explicit override still possible — this resolves
  spec.md Open Decisions #1 and #4.
- Progress is streamed via MCP `notifications/progress`, not a single blocking call.
- Codex support ships best-effort, using the real manifest schema from
  `developers.openai.com/codex/plugins/build` (`.codex-plugin/plugin.json`), reusing
  the same `.mcp.json` and `skills/harness-run/SKILL.md` built for Claude Code.

| Task | Description | DoD | Depends | Status |
|------|------|-----|---------|--------|
| 2.1 | [setup] Add `@modelcontextprotocol/sdk` dependency; scaffold `src/mcp-server.ts` as a stdio MCP server entrypoint with zero tools registered yet. Update `package.json` (drop `harness` bin / commander dependency in prep for 2.7). | `npm run build` succeeds; `node dist/mcp-server.js` starts and exits cleanly on stdin close. | Phase 1 | cc:TODO |
| 2.2 | [tdd:required] `src/verify-detect.ts`: given a repo path, read `package.json`, detect `scripts.lint` / `scripts.typecheck` (or `type-check`) / `scripts.test`, return the present ones as `["npm run <name>", ...]` in that order. | Unit tests over fixture `package.json` variants: all three scripts present, partial, none present, malformed JSON. | 2.1 | cc:TODO |
| 2.3 | [tdd:required] `src/repo-detect.ts`: resolve the target repo path — explicit input wins; else MCP `roots/list`; else `CLAUDE_PROJECT_DIR` env; else a clear validation error (never silently defaults to cwd). | Unit test each fallback branch independently with mocked inputs, plus the no-resolution error case. | 2.1 | cc:TODO |
| 2.4 | [tdd:required] [feature:security] Wire the `harness_run` MCP tool in `mcp-server.ts`: input schema `{ description (required), taskId?, repo?, verify?, maxAttempts? }`; merges auto-detected repo/verify (2.2, 2.3) with explicit overrides; extends `schema.ts` validation to reject an empty, fully-unresolved verify list (closes spec.md Open Decision #4); calls the existing `runTaskToCompletion()`. | Integration test with a mock MCP client calling the tool against a fixture repo; a repo path outside `ALLOWED_ROOTS` is still rejected before any agent/sensor runs (Core Rule 6 unchanged). | 2.2, 2.3 | cc:TODO |
| 2.5 | [tdd:required] Wire loop-controller's per-attempt transitions (attempt started → verifying → result) to MCP `notifications/progress` messages. | Test driving a fixture task that fails twice then passes captures the expected ordered sequence of progress notifications via a mock transport. | 2.4 | cc:TODO |
| 2.6 | [tdd:required] [e2e] End-to-end smoke test through the MCP entrypoint (mirrors `e2e.test.ts` from Phase 1, but drives it via an in-process MCP tool call instead of spawning the CLI): fixture repo with one intentionally failing test, no explicit `repo`/`verify` given, confirms auto-detection + retry-to-success within cap. | `npm test` includes this case and it passes. | 2.4, 2.5 | cc:TODO |
| 2.7 | [cleanup] Retire the CLI: delete `src/cli.ts` and `src/cli.test.ts`; remove `commander` from `package.json` dependencies; update spec.md (Core Rule 8's entrypoint reference, Data And Contracts auto-detect defaults, resolve Open Decisions #1 and #4 explicitly, add a Core Rule documenting the MCP entrypoint + progress-notification behavior). | `npm run build` / `npm run lint` / `npm test` all pass with zero references to the deleted CLI; spec.md reflects the new contract. | 2.6 | cc:TODO |
| 2.8 | [setup] Claude Code plugin packaging: `.claude-plugin/plugin.json`, `.mcp.json` (`command: node`, `args: ["${CLAUDE_PLUGIN_ROOT}/dist/mcp-server.js"]`), `skills/harness-run/SKILL.md` (documents `/harness-run`, auto-detected defaults, override syntax), `hooks/hooks.json` (`SessionStart` hook installing deps into `${CLAUDE_PLUGIN_DATA}` on first load / on `package.json` change). | Structural check against the Claude Code plugin docs (`.claude-plugin/` contains only `plugin.json`; all other dirs at plugin root); `claude plugin validate .` passes if available in this environment. | 2.7 | cc:TODO |
| 2.9 | [setup] [experimental] Codex plugin packaging (best-effort): `.codex-plugin/plugin.json` (required: `name`, `version`, `description`; optional: `skills`, `mcpServers` paths pointing at the same `.mcp.json` / `skills/harness-run/SKILL.md` from 2.8). Flag explicitly as unverified against a live Codex install. | Manifest fields match the documented schema exactly; spec.md notes Codex support as experimental pending live validation. | 2.8 | cc:TODO |
| 2.10 | [docs] Split README into `README.md` (English) and `README.zh-Hant.md` (繁體中文), replacing the retired-CLI install/usage instructions with the real plugin flow: skills-dir drop-in steps for Claude Code, best-effort steps for Codex, `/harness-run` usage, auto-detect behavior + override syntax, unchanged state/escalation-file behavior. | Both files reviewed against the actually-implemented plugin — zero remaining references to `npm link` / `harness run --task ...` CLI syntax. | 2.9 | cc:TODO |

## Phase 3 (Recommended, not started): beyond the walking skeleton

Purpose: extend the walking skeleton toward the fuller harness vision (multi-agent separation, skill ecosystem compatibility) once Phase 1 is proven.

| Task | Description | DoD | Depends | Status |
|------|------|-----|---------|--------|
| 3.1 | Separate Evaluator agent (Generator/Evaluator split) so a distinct agent — not just computational sensors — judges "is this actually done" for cases sensors can't fully capture. | Design spike report: feasible / not feasible / needs-redesign, with a concrete evaluator-agent contract proposal. | Phase 1 | cc:TODO |
| 3.2 | SKILL.md-compatible skill loading: harness can load local skills following the Anthropic SKILL.md convention (frontmatter + progressive disclosure) as additional "guides" for the agent. | A sample local skill folder is loaded and its instructions are demonstrably injected into an agent run's guides. | Phase 1 | cc:TODO |
| 3.3 | Token/cost budget ceiling (Open Decision from spec.md) alongside the existing attempt-count cap. | A run configured with a cost ceiling stops and escalates when the ceiling is hit, even if `maxAttempts` has not been reached. | Phase 1 | cc:TODO |

---

## Team validation record (create — 2026-07-05)

- team_validation_mode: subagent
- Perspectives run: Product, Architecture, Security, QA, Skeptic (single consolidated subagent pass against the full draft)
- Verdict: APPROVE_WITH_CHANGES — all requested changes incorporated above (timeouts, path confinement, CLI entrypoint folded into 1.1, cost-budget Open Decision, tightened 1.6/1.7 DoDs, explicit repo-state-on-escalation rule in spec.md).
- formatter_baseline: missing → setup task 1.1 added ahead of all implementation tasks.
- Memory check: no `.claude/agent-memory/` project-scoped entries found for this repo (fresh project) — memory unconfirmed beyond that, no prior harness-specific decisions to reconcile against.
