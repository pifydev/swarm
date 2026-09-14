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
| `background` | boolean, optional | Return a `runId` immediately instead of blocking |

Blocking by default: returns `N done, M error` plus a per-item report.

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

Live per-item progress (`1:scout=running(3t) · 2:reviewer=queued`), and the full report once the run finishes. Completed runs survive `/reload`.

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
- **Stopping stops the children.** Pressing Esc, or switching away from the session, aborts every live child rather than leaving them talking to the provider on your money. A cancelled run keeps that verdict — it is never reported as done — and `swarm_status` shows what the items that did finish produced.
- **Isolated runs clean up after themselves.** With `isolation: "worktree"`, a worktree whose child changed nothing is removed along with its branch; otherwise a read-only step left one of each behind on every run. Anything uncommitted, and any commit the child made, is kept and reported.

## A background run comes back to you

`swarm_status` on a run still in flight used to say "still running", which left the model one option: ask again. The aggregated report is **delivered** into the conversation when the run finishes — measured, not assumed: `test/live/delivery-wire.mjs` drives a real background swarm through pi, holds the session open the way an interactive one naturally stays open, and reads the report out of pi's own provider payload (3/3; the run finished and the report arrived unasked). One caveat the measurement taught: delivery is a property of sessions that outlive their runs — interactive sessions do, `pi -p` does not. Asking early returns a structured result carrying `retryable`, the elapsed time and `pollRequired: false` — a normal answer rather than an error, because a tool error over a condition only time resolves invites the model's retry machinery into a loop.

## Command

`/swarm` — runs in this session, and the agent types available for routing.

## Where this sits in the suite

[`@pify/subagent`](https://github.com/pifydev/subagent) is one child and one task. `@pify/swarm` is many items at once — independent, or wired together with a declarative `needs` graph (fan-out, chains, joins). [`@pify/workflow`](https://github.com/pifydev/workflow) is for when orchestration needs real control flow — loops, conditionals, retries, fan-out computed at run time — that a static graph can't express. Pick the smallest one that fits.

## License

MIT © [Pify maintainers](https://github.com/pifydev)
