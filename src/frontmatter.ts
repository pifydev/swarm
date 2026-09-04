import {
  DEFAULT_MAX_TURNS,
  THINKING_LEVELS,
  VALID_TOOLS,
  type AgentDef,
  type ThinkingLevelName,
  type ValidTool,
} from "./types.ts";

/**
 * Parse an agent definition file: same schema as @pify/subagent plus the
 * routing keys `match_patterns` / `match_keywords` (comma-separated, also
 * accepts the camelCase spellings gjczone used). One definition file serves
 * both packages.
 */
export function parseAgentFile(
  name: string,
  content: string,
  source: AgentDef["source"],
): AgentDef | null {
  const normalized = content.replace(/\r\n/g, "\n");
  const match = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(normalized);
  if (!match) return null;

  const fields = new Map<string, string>();
  for (const line of match[1]!.split("\n")) {
    const kv = /^([A-Za-z_][A-Za-z0-9_-]*)\s*:\s*(.*)$/.exec(line.trim());
    if (kv) fields.set(kv[1]!.toLowerCase(), kv[2]!.trim());
  }

  const description = fields.get("description") ?? "";
  if (!description) return null;

  const thinkingRaw = fields.get("thinking")?.toLowerCase();
  const maxTurnsRaw = Number.parseInt(fields.get("max_turns") ?? "", 10);

  return {
    name: name.toLowerCase(),
    description,
    tools: parseTools(fields.get("tools")),
    model: fields.get("model") || null,
    thinking: (THINKING_LEVELS as readonly string[]).includes(thinkingRaw ?? "")
      ? (thinkingRaw as ThinkingLevelName)
      : null,
    maxTurns:
      Number.isFinite(maxTurnsRaw) && maxTurnsRaw > 0 && maxTurnsRaw <= 200
        ? maxTurnsRaw
        : DEFAULT_MAX_TURNS,
    systemPrompt: match[2]!.trim(),
    source,
    matchPatterns: parseList(fields.get("match_patterns") ?? fields.get("matchpatterns")),
    matchKeywords: parseList(fields.get("match_keywords") ?? fields.get("matchkeywords")).map((k) =>
      k.toLowerCase(),
    ),
  };
}

function parseList(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .replace(/^\[|\]$/g, "")
    .split(",")
    .map((t) => t.trim().replace(/^["']|["']$/g, ""))
    .filter(Boolean);
}

function parseTools(raw: string | undefined): ValidTool[] {
  if (!raw) return ["read", "grep", "find", "ls"];
  const valid = raw
    .split(",")
    .map((t) => t.trim().toLowerCase())
    .filter((t): t is ValidTool => (VALID_TOOLS as readonly string[]).includes(t));
  return valid.length > 0 ? valid : ["read", "grep", "find", "ls"];
}
