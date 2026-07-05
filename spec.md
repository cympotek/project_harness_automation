# project_harness_automation — Spec (Product Contract)

Created: 2026-07-05
Precedence: this file (spec.md) > sub-specs > Plans.md

## Purpose

Build a self-driving "harness / loop engineering system": a runner that takes one coding
task, executes it against a target repo via the Claude Agent SDK (TypeScript), verifies the
result using deterministic computational sensors (lint / typecheck / test), and — on
failure — feeds the sensor failure output back to the agent as a repair prompt and retries,
up to a capped number of attempts. On success it reports completion; on exceeding the cap it
escalates to a human instead of looping forever.

MVP scope is a single-agent, single-task walking skeleton: run → verify → loop → done or
escalate. Multi-agent orchestration, skill marketplace auto-install, a GUI/dashboard, and
distributed/cloud execution are explicitly deferred (see Non-Goals).

## Users And Workflows

- Primary user: a solo developer (project owner), operating the harness from the CLI on
  their own machine.
- Workflow: user invokes the harness with a task description, a target repo path, and a list
  of verification commands (or lets the harness auto-detect them where possible). The
  harness runs the loop and prints small, declarative status lines (task started →
  attempt N → verifying → passed/failed → done/escalated) rather than a dashboard. The user
  can watch the terminal or check the on-disk state/escalation file later.

## Core Rules

1. **Guides × Sensors loop.** The agent receives "guides" (task description, target repo
   context, project's own CLAUDE.md/AGENTS.md if present) and produces an attempt. Sensors
   (lint/typecheck/test — deterministic pass/fail, never LLM judgment) are the sole authority
   on whether an attempt succeeded. The agent's own claim of "done" is never trusted.
2. **Capped retries, no unbounded loops.** Max attempts is configurable, default 3. On
   sensor failure, the sensor's failure output (not a paraphrase) is fed back to the agent
   verbatim as the repair prompt for the next attempt. Exceeding the cap stops the loop and
   escalates — it never retries indefinitely.
3. **Escalation is explicit and dual-channel.** On cap-exceeded, the harness both (a) prints
   a console escalation message and (b) writes an escalation artifact to
   `.harness/escalations/<task-id>.json` (status, attempt history, last sensor output). A
   console-only signal is not sufficient — the file is the durable record a human (or a
   future watcher process) can pick up later even if the terminal was not being watched live.
4. **Repo state on escalation: leave as-is.** The harness does not auto-rollback the target
   repo on escalation. The last attempt's edits remain in the working tree for human
   inspection. This is a deliberate MVP tradeoff (favors debuggability over cleanliness) and
   must stay documented here, not silently assumed.
5. **Disk-persisted, resumable state.** After every attempt, state (task id, attempt count,
   status, last sensor output, timestamps) is written to
   `.harness/state/<task-id>.json`. If the process crashes or is killed, restarting with the
   same task id resumes from the last persisted attempt count rather than starting over from
   attempt 1.
6. **Path confinement via allowlist.** The target repo path must resolve inside an
   `ALLOWED_ROOTS` allowlist (env-configured, comma-separated absolute paths) before any
   agent or sensor execution is attempted. A path outside the allowlist is a hard rejection,
   not a warning.
7. **Subprocess safety.** Every sensor command and every underlying agent-SDK subprocess call
   runs with an explicit timeout. A timeout counts as a failed attempt (feeds back like any
   other sensor failure) — it must never hang the loop indefinitely.
8. **Authentication follows Claude Agent SDK defaults — no custom key plumbing.** The agent
   runner does not pass an explicit API key into the SDK's `query()` call. The SDK resolves
   credentials itself: `ANTHROPIC_API_KEY` env var first, falling back to subscription auth
   (`claude login` credentials / OS keychain) if unset. The harness only passes
   `cwd` / `model` / `systemPrompt` / `mcpServers`-style options — it does not re-implement or
   intercept auth. (Confirmed from an existing sibling implementation pattern:
   `agent/src/index.ts` + `Session.ts`, which logs
   `ANTHROPIC_API_KEY not set — SDK will fall back to subscription auth` and works fine
   dev-side purely on `claude login` with no key in `.env`.)
9. **Cost/token budget is a distinct concern from attempt-count cap.** The attempt cap
   bounds *iterations*; it does not bound *spend*. This is intentionally left as an Open
   Decision (below), not silently ignored.
10. **Status UX: small declarative units, confirmation only at real decision points.**
    Following OpenAI Apps SDK UX principles (optimize for conversation not navigation; custom
    UI only to clarify/capture/confirm): the CLI never asks for confirmation mid-loop except
    at genuine branch points (e.g., about to escalate). Progress is a linear stream of short
    status lines, not a dashboard requiring navigation.

## Data And Contracts

**Task input** (what the user/CLI provides):
```
{
  taskId: string
  description: string
  targetRepoPath: string        // must resolve inside ALLOWED_ROOTS
  verifyCommands: string[]      // e.g. ["npm run lint", "npm run typecheck", "npm test"]
  maxAttempts?: number          // default 3
}
```

**State file** (`.harness/state/<task-id>.json`):
```
{
  taskId: string
  attemptCount: number
  status: "running" | "passed" | "escalated"
  lastSensorOutput: string      // truncated/redacted, see below
  createdAt: string
  updatedAt: string
}
```

**Escalation artifact** (`.harness/escalations/<task-id>.json`):
```
{
  taskId: string
  attemptHistory: { attempt: number; sensorResult: string; timestamp: string }[]
  finalStatus: "escalated"
  reason: string                // e.g. "max attempts exceeded"
}
```

**Config env vars** (loaded at CLI/config-load time, modeled on the sibling `agent/.env`
pattern): `PORT`, `HOST` (only relevant if/when the harness grows an HTTP surface — not
required for the CLI-only MVP), `AGENT_TOKEN` (reserved for a future HTTP surface's own auth,
unrelated to the Anthropic/Claude auth in Core Rule 8), `ALLOWED_ROOTS` (comma-separated
absolute path allowlist, required), `ANTHROPIC_API_KEY` (optional — omitted entirely when
relying on subscription auth).

**Redaction rule:** sensor stdout/stderr must be truncated and scanned for common secret
patterns (e.g. `sk-`, `ghp_`, AWS key prefixes) before being persisted to any state/escalation
file or fed back into a repair prompt.

## Non-Goals (MVP)

- Multi-agent team orchestration (Planner/Generator/Evaluator role separation) — deferred to
  Phase 2+; MVP satisfies "no self-grading" only via sensor-is-authority (Core Rule 1), not a
  separate evaluator agent.
- Automatic skill discovery/install from skill marketplaces (skills.sh, Hermes, etc.) — noted
  for future SKILL.md-standard compatibility, not built in MVP.
- GUI/dashboard — CLI + JSON artifacts only.
- Distributed/cloud execution or a host-agnostic multi-backend executor — single local
  process only.
- A hard token/cost budget ceiling — see Open Decisions.

## Open Decisions

1. Which verification commands are auto-detected (e.g. from `package.json` scripts) vs
   always user-specified. Default for MVP: user-specified list is authoritative; auto-detect
   is a nice-to-have, not required for the walking skeleton.
2. Whether/how to add a token or dollar-cost budget ceiling alongside the attempt-count cap
   (Core Rule 9). Not resolved yet — flag before this becomes a real spend risk once the
   harness runs unattended for longer sessions.
3. Whether escalation should ever push beyond console+file (e.g. Slack/PushNotification) —
   deferred until there's evidence the console+file combo is insufficient for the solo-dev
   MVP user.
4. Whether `TaskInput.verifyCommands` should be required to be non-empty. Currently
   `validateTaskInput` (Core schema) only checks it is a string array; an empty list makes
   the loop controller's sensor run vacuously "pass" (`Array.prototype.every` on `[]` is
   `true`) after a single agent attempt with zero real verification. Discovered during task
   1.5 review — not fixed yet since it means touching the already-shipped schema validator;
   tracked here rather than silently left as an implicit assumption.

## Links

- https://github.com/memorysaver/agentic-engineering-patterns (Generator/Evaluator
  separation, signal-file protocol, autopilot tick loop)
- https://hackmd.io/@BASHCAT/SkQEW0F2bg (Guides × Sensors harness-engineering model)
- https://github.com/shareAI-lab/learn-claude-code (Claude Code internals reference)
- https://hermes-agent.nousresearch.com/docs/skills/ , https://www.skills.sh/ (SKILL.md
  ecosystem — Non-Goal for MVP, future-compat reference)
- https://developers.openai.com/apps-sdk/concepts/ux-principles ,
  https://developers.openai.com/apps-sdk/concepts/ui-guidelines (status/UX principles)
