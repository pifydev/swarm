/**
 * Who gets sent back to fix a failed gate.
 *
 * repair.ts bounds *how many* repair passes a failing gate may spend; this
 * decides whether one is worth spending at all. Two facts rule it out. An
 * agent with no writing tool can only re-read the failure and re-report it,
 * so the pass buys nothing. And a child that ended its report with
 * `OUTCOME: blocked` has said the wall is outside its reach — a decision,
 * access or information it does not have — and a failing gate does not move
 * that wall; a repair pass would just re-discover it at the cost of a full
 * child run.
 *
 * The declaration has to be read *before* the item settles: settleItem
 * strips it from the result so the report does not repeat it.
 */

import { parseDeclaredOutcome } from "./outcome.ts";
import type { AgentDef } from "./types.ts";

/** An agent that can write is one that can fix what a gate complained about. */
export function canWrite(def: AgentDef): boolean {
  return def.tools.some((t) => t === "edit" || t === "write" || t === "bash" || t === "powershell");
}

/** May this item be sent on a repair pass, given the agent and what it said? */
export function repairAllowed(def: AgentDef, result: string | null | undefined): boolean {
  return canWrite(def) && parseDeclaredOutcome(result) !== "blocked";
}
