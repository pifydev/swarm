/**
 * Local structural types for @pify/swarm.
 * No imports from pi packages: src/ typechecks and runs standalone.
 */

import type { GateOutcome } from "./gate.ts";
import type { TaskOutcome, Verification } from "./outcome.ts";

export const VALID_TOOLS = [
  "read",
  "bash",
  "powershell",
  "edit",
  "write",
  "grep",
  "find",
  "ls",
] as const;
export type ValidTool = (typeof VALID_TOOLS)[number];

export type ThinkingLevelName = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
export const THINKING_LEVELS: readonly ThinkingLevelName[] = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];

/** Agent definition; superset of @pify/subagent's with routing keys. */
export interface AgentDef {
  name: string;
  description: string;
  tools: ValidTool[];
  model: string | null;
  thinking: ThinkingLevelName | null;
  maxTurns: number;
  systemPrompt: string;
  source: "builtin" | "global" | "project";
  /** Glob patterns matched against path-like tokens in an item (routing). */
  matchPatterns: string[];
  /** Case-insensitive keywords matched against the item text (routing). */
  matchKeywords: string[];
}

export const DEFAULT_MAX_TURNS = 30;
export const MAX_ITEMS = 12;
export const DEFAULT_CONCURRENCY = 4;
/** Safe default when no routing rule matches: read-only exploration. */
export const FALLBACK_AGENT = "scout";

/**
 * "skipped" is a settled state, not a failure: the item never ran because
 * something it needed did not produce usable input, and the caller asked for
 * that to stop the branch rather than feed it a failure notice.
 */
export type ItemStatus = "queued" | "running" | "done" | "error" | "aborted" | "skipped";

/** What a gate proved about one item, kept alongside the item it judged. */
export interface GateRecord {
  command: string;
  outcome: GateOutcome;
  ok: boolean;
  /** One line in this package's words. */
  reason: string;
  /** Trimmed output, kept only when the gate did not pass. */
  output?: string;
  /** Other items that were live in the same directory while it ran. */
  sharedWith?: string[];
  /** Repair passes spent trying to make it pass. */
  repairs?: number;
}

export interface ItemState {
  index: number;
  /** Stable id used for dependency references, e.g. "t1" or a caller-given id. */
  id: string;
  item: string;
  /** Ids of items that must finish before this one starts (empty = flat). */
  needs: string[];
  agent: string;
  status: ItemStatus;
  turns: number;
  tokens: number;
  result: string | null;
  error: string | null;
  /** The directory the child worked in — its worktree when isolated. */
  workDir?: string;
  /** Set once the item settles: what the task came to, apart from whether the child finished. */
  outcome?: TaskOutcome;
  /** How well that outcome is known. "not-requested" when no gate ran. */
  verification?: Verification;
  gate?: GateRecord;
}

/** How a dependent behaves when something it needs did not succeed. */
export type UpstreamFailurePolicy = "continue" | "skip";

/**
 * "cancelled" is its own outcome, not a completion: someone stopped the run,
 * and calling it done would report results nobody produced.
 */
export type RunStatus = "running" | "done" | "cancelled";

export interface SwarmRun {
  runId: string;
  background: boolean;
  status: RunStatus;
  startedAt: number;
  finishedAt: number | null;
  items: ItemState[];
}

export interface ThemeLike {
  fg(color: string, text: string): string;
  bold(text: string): string;
}

export interface BranchEntryLike {
  type?: string;
  customType?: string;
  data?: unknown;
  [key: string]: unknown;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
