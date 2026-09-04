# @pify/swarm

Coordinate multiple [pi](https://github.com/earendil-works/pi) agents working in parallel. One tool call fans a list of task items out to child agents — with auto-routing, a concurrency queue, a live widget, and one aggregated report.

Part of the [Pify suite](https://github.com/pifydev). Install with [`pify install swarm`](https://github.com/pifydev/cli) or `pi install npm:@pify/swarm`.

## What it does

- **`swarm_run`** — fan out 1–12 independent items to parallel children (4 at a time, rest queued). Blocking by default: returns `N done, M error` plus a per-item report. `background: true` returns a `runId` immediately.
- **`swarm_status`** — live per-item progress (`1:scout=running(3t) · 2:reviewer=queued`), full report once finished; completed runs survive `/reload`.
- **Per-item auto-routing**: agent definitions can declare `match_patterns` (globs matched against path-like tokens in the item — longest wins) and `match_keywords`. `review src/auth.rs` routes to your Rust auditor; `test the login flow` to your tester; everything else falls back to the read-only `scout` — the fallback never mutates. Force one type for all items with `agent`.
- **Shared context**: the `context` param is prepended to every item, so common constraints are written once.
- **One agent catalog**: reads the same `.pi/agents/*.md` definitions as [`@pify/subagent`](https://github.com/pifydev/subagent) (description/tools/model/thinking/max_turns), plus the two routing keys:

```markdown
---
description: Rust audit specialist
tools: read, grep, find, ls
match_patterns: *.rs, src/**
match_keywords: rust, memory safety
---
```

- **Independence by design**: items share nothing, children cannot spawn children, and each child is capped at its agent's `max_turns`.

## Where this sits in the suite

`@pify/subagent` = one child, one task. `@pify/swarm` = many independent items at once. `@pify/workflow` = deterministic scripted orchestration. Pick the smallest one that fits.

## License

MIT © [Pify maintainers](https://github.com/pifydev)
