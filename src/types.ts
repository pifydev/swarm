/**
 * Local structural types for @pify/swarm.
 * No imports from pi packages: src/ typechecks and runs standalone.
 */

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

export type ItemStatus = "queued" | "running" | "done" | "error" | "aborted";

export interface ItemState {
  index: number;
  item: string;
  agent: string;
  status: ItemStatus;
  turns: number;
  tokens: number;
  result: string | null;
  error: string | null;
}

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
