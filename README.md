# @pify/swarm

[![CI](https://github.com/pifydev/swarm/actions/workflows/ci.yml/badge.svg)](https://github.com/pifydev/swarm/actions/workflows/ci.yml) [![npm version](https://img.shields.io/npm/v/@pify/swarm)](https://www.npmjs.com/package/@pify/swarm) [![npm downloads](https://img.shields.io/npm/dm/@pify/swarm)](https://www.npmjs.com/package/@pify/swarm)

Run many [pi](https://github.com/earendil-works/pi) agents in parallel. One tool call fans a list of independent items out to child agents — with per-item routing, a concurrency queue, a live widget, and one aggregated report.

Part of the [Pify suite](https://github.com/pifydev). Install with [`pify install swarm`](https://github.com/pifydev/cli) or `pi install npm:@pify/swarm`.

## Why

Some work is a list of things that do not depend on each other: audit twelve modules, summarise nine files, check every package for the same problem. Doing that in one conversation is slow and fills the context with material the main thread does not need. Doing it with twelve separate delegation calls is the same work typed twelve times.

The catch is that "independent" is usually a small lie — the items do not depend on each other's *results*, but they may touch the same files. That is what the mailbox and worktree isolation below are for.

## Tools

### `swarm_run`

| Parameter | Type | Notes |
|---|---|---|
| `items` | array, 1–12 | A plain string per task, or `{task, id, needs}` to declare a dependency |
| `context` | string, optional | Prepended to every item, so shared constraints are written once |
| `agent` | string, optional | Force one agent type for all items instead of routing |
| `isolation` | `"worktree"`, optional | Give each item its own git worktree — use it when items write |
| `mailbox` | boolean, optional | Give the children `swarm_post` / `swarm_inbox` |
| `gate` | string, optional | A command every item must pass — `bun test`, `tsc --noEmit` — run in that item's own working directory |
| `gateExpect` | string, optional | Regex the gate output must match, for checks that exit 0 without proving anything |
| `gateRepairs` | number, optional | Repair passes per item after a failed gate, 0–5 (default 1) |
| `on_upstream_failure` | `"continue"` / `"skip"`, optional | What a dependent does when something it needs did not succeed (default `continue`) |
| `background` | boolean, optional | Return a `runId` immediately instead of blocking |

Blocking by default: returns `N succeeded, M failed` plus a per-item report.

### Gates and outcomes

A gate asks the shell, not a model. Each item's gate runs in the tree that item worked in — its own worktree under `isolation: "worktree"` — after the child finishes, so it judges what you would merge. It runs asynchronously: pi keeps rendering, Esc still lands, and the other children's streams are still read while a two-minute suite runs; at the deadline the whole process tree is killed, not just the shell that started it, so a timed-out suite does not run on holding the pipes open. A failing gate sends the child back once with the command, the verdict and the output, then re-runs; `gateRepairs: 0` turns that off. That repair brief is the whole prompt the child gets — it quotes the original task under `== Original task ==` and says to fix the cause and stop, not to do the task again — and the child rejoins the run's mailbox. A read-only agent is never asked to repair, and neither is a child that ended its report with `OUTCOME: blocked`: the wall it named is outside its reach, and a failing gate does not move it. The gate still runs once so the report says what it proved. While a repair is in flight the item shows as running, not finished.

The verdict can say more than pass/fail: `success`, `failure`, `result_missing` (exited 0 but never showed the evidence `gateExpect` asked for — a runner that matched no tests), `timeout`, or `no_attestation` (never ran at all — a typo, a missing runner; not a verdict on the work, and never repaired). If other items were changing the same directory while a gate ran, the report says the verdict is true of the tree, not of that item alone — which is what `isolation` is for.

Every item then reports two facts. Its **status** says whether the child finished; its **outcome** says whether the task did. A failed gate outranks a child that claims success; without a gate the outcome is the child's own account, and a child that could not finish can end its report with `OUTCOME: blocked` or `OUTCOME: failed` to say so in one parseable place. The header counts outcomes, so an item that ran to the end and failed its check is filed under `failed`, not `done` — and the widget shows it as ✗, not ✓.

**Failures interrupt.** A background run wakes you once, as soon as the first item fails hard, while the rest are still running — the same rule `@pify/subagent` uses for a failed background child. The message says it is a warning and that the full report still follows; it does not ask you to poll. Subsequent failures wait for the aggregate report, since N interrupts for N failures would be worse than none.

**`on_upstream_failure`.** By default a dependent still runs when something it needed failed, with a `(failed: …)` notice in place of that item's output — visible, but it spends a child on a step that is usually doomed. `skip` settles the dependent instead, marks it `skipped` (its own state, not a second failure), and the skip cascades down the branch. Independent items are unaffected either way.

### Dependencies: `needs`

An item can be a plain string (independent, as before) or an object that declares what it depends on:

```json
{
  "items": [
    { "id": "mig",     "task": "write the DB migration for the users table" },
    { "id": "callers", "task": "update every caller of the old schema", "needs": ["mig"] },
    { "id": "tests",   "task": "run the suite and fix what broke",       "needs": ["callers"] }
  ]
}
```

An item starts only once its `needs` have finished, and each upstream item's output is prepended to it as a `## Output of <id>` block — so the thing the coordinator used to forget, passing X to the step that needs it, happens by construction. Independent items still run in parallel up to the concurrency cap; a chain runs in order; a diamond joins after both branches. Ids default to `t1`, `t2`, … when you omit them.

The whole graph is checked **before anything spawns**: a cycle, a self-edge, a duplicate id, or a reference to an unknown id is rejected outright, so a bad graph costs nothing. A flat list of strings has no edges and behaves exactly as it always did.

### `swarm_status`

| Parameter | Type | Notes |
|---|---|---|
| `runId` | string, optional | Defaults to the most recent run |
| `wait` | number, optional | Seconds to hold the call for the run to finish, 0–120 (default 0) |

A "not ready" answer while the run is in flight (per-item progress is on the widget and in `/swarm`), and the full report once the run finishes. Completed runs survive `/reload`. `wait` is for the headless case (`pi -p`), where nothing is delivered after the turn ends: one call that waits returns the report in one turn instead of several; the wait ends early on Esc.

### `swarm_post` / `swarm_inbox`

Registered for the children only, and only when `mailbox: true`.

- `swarm_post(message)` — tell the siblings something that changes their work: a shared file you modified, a convention you had to pick, a blocker they will hit too.
- `swarm_inbox()` — read what the others have posted since your last check.

Without it, parallel agents cannot see each other, so two of them cheerfully fix the same shared helper in two different ways. It is deliberately not a chat: no addressing, no waiting, no replies. An append-only log per run, and an agent never sees its own posts echoed back. A torn line from two simultaneous appends is skipped rather than failing the read.

## Per-item routing

Agent definitions declare what they are for, and each item picks its own:

```markdown
---
description: Rust audit specialist
tools: read, grep, find, ls
match_patterns: *.rs, src/**
match_keywords: rust, memory safety
---
```

`match_patterns` are globs matched against path-like tokens in the item — the longest match wins, so a specific rule beats a general one. `match_keywords` match the item's words. `review src/auth.rs` routes to the Rust auditor; `test the login flow` to a tester; anything matching nothing falls back to the read-only `scout`, so **the fallback can never mutate**.

The catalog is the same `.pi/agents/*.md` one [`@pify/subagent`](https://github.com/pifydev/subagent) reads — `description`, `tools`, `model`, `thinking`, `max_turns` — plus the two routing keys. Project-local definitions load only after you approve them — once per project, remembered in `pify-project-consent.json`, the same "agents" answer [`@pify/subagent`](https://github.com/pifydev/subagent) records, so approving or refusing once means the same thing across the suite. pi's own project trust is necessary but not sufficient here: pi only asks about trust when a repo ships something pi itself loads, and `.pi/agents/` is not on that list — measured, a repo whose only pi file is `.pi/agents/reviewer.md` reports `isProjectTrusted=true`. For CI, `PIFY_TRUST_PROJECT=1`. (Earlier versions of this paragraph claimed the gate existed before it did; as of v0.7.0 it does.)

## Behaviour

- **Independence by design.** Items share nothing, children cannot spawn children, and each child is capped at its agent's `max_turns`.
- **Stopping stops the children.** Pressing Esc stops a foreground run, `/swarm stop [runId]` stops a background one (its tool call returned long ago, so Esc has nothing to reach), and switching away from the session stops both — in every case every live child is aborted rather than left talking to the provider on your money. A cancelled run keeps that verdict — it is never reported as done — and `swarm_status` shows what the items that did finish produced, with each stopped item saying who stopped it.
- **Isolated runs clean up after themselves.** With `isolation: "worktree"`, a worktree whose child changed nothing is removed along with its branch; otherwise a read-only step left one of each behind on every run. Anything uncommitted, and any commit the child made, is kept and reported.

## A background run comes back to you

`swarm_status` on a run still in flight used to say "still running", which left the model one option: ask again. The aggregated report is **delivered** into the conversation when the run finishes — measured, not assumed: `test/live/delivery-wire.mjs` drives a real background swarm through pi, holds the session open the way an interactive one naturally stays open, and reads the report out of pi's own provider payload (3/3; the run finished and the report arrived unasked). One caveat the measurement taught: delivery is a property of sessions that outlive their runs — interactive sessions do, `pi -p` does not. Asking early returns a structured result carrying `retryable`, the elapsed time and `pollRequired` (`false` interactively; `true` under `pi -p`, where the text tells the model to collect within the turn or use `wait`) — a normal answer rather than an error, because a tool error over a condition only time resolves invites the model's retry machinery into a loop.

## Command

`/swarm` — runs in this session, and the agent types available for routing.

`/swarm stop [runId]` — cancel a live run (default: the active one) and abort its children. The way to stop a background run; a foreground run stops on Esc.

## Where this sits in the suite

[`@pify/subagent`](https://github.com/pifydev/subagent) is one child and one task. `@pify/swarm` is many items at once — independent, or wired together with a declarative `needs` graph (fan-out, chains, joins). [`@pify/workflow`](https://github.com/pifydev/workflow) is for when orchestration needs real control flow — loops, conditionals, retries, fan-out computed at run time — that a static graph can't express. Pick the smallest one that fits.

## License

MIT © [Pify maintainers](https://github.com/pifydev)
