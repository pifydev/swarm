---
name: swarm
description: Use when work splits into several independent items that can run in parallel - multi-file reviews, sweeps, parallel research - explains swarm_run fan-out, auto-routing, and how to slice items well
---

# Swarm

This project has the `@pify/swarm` extension installed: `swarm_run` fans a
list of independent items out to parallel child agents (concurrency 4) and
returns one aggregated report; `swarm_status` polls background runs.

## When to fan out

- Reviewing or auditing several files/modules independently.
- The same question asked across many places ("check each package for X").
- Parallel research where items do not depend on each other.

Do NOT use a swarm when items depend on each other's results (do them
sequentially yourself) or for a single task (use agent_run from
@pify/subagent instead).

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

## Collecting

Blocking runs return the report directly. For `background: true`, ALWAYS
collect with `swarm_status` before relying on any item's outcome.
