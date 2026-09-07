# @pify/swarm

Run many [pi](https://github.com/earendil-works/pi) agents in parallel. One tool call fans a list of independent items out to child agents — with per-item routing, a concurrency queue, a live widget, and one aggregated report.

Part of the [Pify suite](https://github.com/pifydev). Install with [`pify install swarm`](https://github.com/pifydev/cli) or `pi install npm:@pify/swarm`.

## Why

Some work is a list of things that do not depend on each other: audit twelve modules, summarise nine files, check every package for the same problem. Doing that in one conversation is slow and fills the context with material the main thread does not need. Doing it with twelve separate delegation calls is the same work typed twelve times.

The catch is that "independent" is usually a small lie — the items do not depend on each other's *results*, but they may touch the same files. That is what the mailbox and worktree isolation below are for.

## Tools

### `swarm_run`

| Parameter | Type | Notes |
|---|---|---|
| `items` | string[], 1–12 | One task per item; four run at a time, the rest queue |
| `context` | string, optional | Prepended to every item, so shared constraints are written once |
| `agent` | string, optional | Force one agent type for all items instead of routing |
| `isolation` | `"worktree"`, optional | Give each item its own git worktree — use it when items write |
| `mailbox` | boolean, optional | Give the children `swarm_post` / `swarm_inbox` |
| `background` | boolean, optional | Return a `runId` immediately instead of blocking |

Blocking by default: returns `N done, M error` plus a per-item report.

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

The catalog is the same `.pi/agents/*.md` one [`@pify/subagent`](https://github.com/pifydev/subagent) reads — `description`, `tools`, `model`, `thinking`, `max_turns` — plus the two routing keys. Project-local definitions load only once pi's project trust has been granted.

## Behaviour

- **Independence by design.** Items share nothing, children cannot spawn children, and each child is capped at its agent's `max_turns`.
- **Stopping stops the children.** Pressing Esc, or switching away from the session, aborts every live child rather than leaving them talking to the provider on your money. A cancelled run keeps that verdict — it is never reported as done — and `swarm_status` shows what the items that did finish produced.
- **Isolated runs clean up after themselves.** With `isolation: "worktree"`, a worktree whose child changed nothing is removed along with its branch; otherwise a read-only step left one of each behind on every run. Anything uncommitted, and any commit the child made, is kept and reported.

## Command

`/swarm` — runs in this session, and the agent types available for routing.

## Where this sits in the suite

[`@pify/subagent`](https://github.com/pifydev/subagent) is one child and one task. `@pify/swarm` is many independent items at once. [`@pify/workflow`](https://github.com/pifydev/workflow) is deterministic scripted orchestration for when the steps genuinely depend on each other. Pick the smallest one that fits.

## License

MIT © [Pify maintainers](https://github.com/pifydev)
