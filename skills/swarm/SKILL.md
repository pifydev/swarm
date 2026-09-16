---
name: swarm
description: Use when work splits into several independent items that can run in parallel - multi-file reviews, sweeps, parallel research
---

# Swarm

This project has the `@pify/swarm` extension installed: `swarm_run` fans a
list of items out to parallel child agents (concurrency 4) and returns one
aggregated report. A background run's report is delivered to you when it
finishes, and the first hard failure interrupts you early — do not poll;
`swarm_status` shows progress if you need it before then.

## When to fan out

- Reviewing or auditing several files/modules independently.
- The same question asked across many places ("check each package for X").
- Parallel research where items do not depend on each other.

Items that depend on each other's results are fine: write them as
`{task, id, needs: [ids]}` and each dependent receives its needs' output
automatically, starting only once they finish. Set
`on_upstream_failure: "skip"` when a dependent is pointless without its
input. For a single task use agent_run from @pify/subagent instead.

## Slicing items

- Each item must be a self-contained brief: the child sees only its item
  plus the shared `context` preamble — never this conversation.
- Prefer one file/module per item; 3-8 items is the sweet spot (max 12).
- Put everything common (goal, output format, constraints) in `context`
  once instead of repeating it per item.

## Routing

Items auto-route by agent-def `match_patterns` (globs against paths in the
item) then `match_keywords`, falling back to the read-only scout. Force one
type with `agent` when the routing does not fit. Mutating items must
explicitly target `worker` — the fallback never mutates.

## Verifying

Give `gate` a command every item must pass (`bun test`, `tsc --noEmit`); it
runs in each item's own working directory after the child finishes, a
failure sends the child back once to fix it, and the report says what the
check proved. Each item reports an outcome (succeeded / blocked / failed)
separately from whether its child finished; the header counts outcomes.

## Collecting

Blocking runs return the report directly. A `background: true` run delivers
its report when it finishes — carry on with other work or end your turn; do
not call `swarm_status` in a loop. In a headless run (no UI) nothing can be
delivered after your turn ends, so collect with `swarm_status` within it.
