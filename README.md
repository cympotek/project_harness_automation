# harness-loop

**Languages:** English (default) | [繁體中文](./README.zh-Hant.md) | [日本語](./README.ja.md)

Self-driving coding-agent harness: **run → verify → loop → done or escalate.**

Give it a task description, a target repo, and one or more verification commands
(lint / typecheck / test). It drives the Claude Agent SDK against that repo, re-runs
your verification commands after each attempt, and feeds the raw failure output back
to the agent as the next repair prompt — up to a capped number of attempts. On success
it reports done; on exceeding the cap it stops and escalates to a human instead of
looping forever.

Full product contract: see [`spec.md`](./spec.md). Task history: see [`Plans.md`](./Plans.md).

> **MVP status:** single-agent, single-task walking skeleton (Phase 1, complete).
> No task queue, no dashboard, no multi-agent orchestration yet — see spec.md Non-Goals.

## Requirements

- Node >= 20
- Claude Code credentials available to the Agent SDK: either `ANTHROPIC_API_KEY` set,
  or already logged in via `claude login` (subscription auth). The harness does not
  do its own key plumbing — it relies entirely on SDK default auth resolution.

## Installation — using this from another project

This package is not published to any registry. To use it against a different repo on
the same machine, build it here first, then link/install it into the other project.

**1. Build**

```bash
cd /path/to/project_harness_automation
npm install
npm run build   # emits dist/cli.js — the "harness" bin entry
```

**2. Make the `harness` command available elsewhere — pick one**

```bash
# Option A: npm link (best while co-developing both repos)
npm link                       # inside project_harness_automation
cd /path/to/other-project
npm link harness-loop

# Option B: global install
cd /path/to/project_harness_automation
npm install -g .

# Option C: file dependency in the other project's package.json
"harness-loop": "file:../project_harness_automation"
```

**3. Configure the other project**

```bash
export ALLOWED_ROOTS=/absolute/path/to/other-project
# ANTHROPIC_API_KEY optional — omit to rely on `claude login` subscription auth
```

`ALLOWED_ROOTS` is a hard allowlist (comma-separated absolute paths). A `--repo` path
that doesn't resolve inside it is rejected before any agent or sensor runs. If unset,
the CLI falls back to allowing only the exact `--repo` path given and prints a warning
— fine for quick local use, but set it explicitly for anything beyond that.

## How to use — run a task

```bash
harness run \
  --task fix-null-check-42 \
  --repo /absolute/path/to/other-project \
  --verify "npm run typecheck" \
  --verify "npm test" \
  --max-attempts 3
```

Exit code `0` = passed, `1` = escalated or a validation error.

## What happens during a run

1. **Attempt.** The agent (Claude Agent SDK, `cwd` = your target repo) makes an edit
   directly in that repo's working tree.
2. **Verify.** Each `--verify` command runs against that same working tree with a
   timeout; a timeout counts as a failure like any other sensor result.
3. **Pass →** loop stops, state file gets `status: "passed"`, one "done" line prints,
   exit code `0`.
   **Fail →** the sensor's raw (redacted) output — not a paraphrase — becomes the next
   attempt's repair prompt. Attempt count increments.
4. **State persists after every attempt** to
   `<target-repo>/.harness/state/<task-id>.json`. If the process is killed and you
   rerun with the same `--task` id, it resumes from the last persisted attempt count
   instead of starting over at 1.
5. **Cap exceeded →** stops (never retries indefinitely), writes
   `<target-repo>/.harness/escalations/<task-id>.json` (full attempt history + last
   sensor output), and prints a console escalation message.

The harness **never** touches git — it doesn't commit, and on escalation it does not
roll back the target repo. Whatever the last attempt left in the working tree stays
there for you to inspect (`git diff` in the target repo) and finish by hand, or commit
yourself once it's green.

## Notes for the target project

- Add `.harness/` to that project's `.gitignore` (state/escalation artifacts land there).
- `--verify` commands are user-specified only for now — there's no auto-detection from
  `package.json` scripts yet (tracked as an Open Decision in spec.md).
- This is a local dev-loop tool in its current form, not a CI step — nothing about it
  assumes it's running unattended in a pipeline.
