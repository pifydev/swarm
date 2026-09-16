import { outcomeLine } from "./outcome.ts";
import type { ItemState, SwarmRun } from "./types.ts";

/** Longest gate output kept per item; a failing suite prints books. */
const GATE_TAIL = 1200;

/**
 * What the gate proved about one item. Shown whenever a gate ran — a pass is as
 * much a fact as a failure, and silence would make "verified" and "never
 * checked" look identical.
 */
function gateLines(item: ItemState): string[] {
  const gate = item.gate;
  if (!gate) return [];
  const lines = [`[gate] ${gate.outcome} — ${gate.reason} (\`${gate.command}\`)`];
  if (gate.repairs) {
    lines.push(`  repaired ${gate.repairs} time${gate.repairs === 1 ? "" : "s"} and re-run.`);
  }
  if (gate.sharedWith?.length) {
    lines.push(
      `  ${gate.sharedWith.join(", ")} ${gate.sharedWith.length === 1 ? "was" : "were"} also changing this directory — the verdict is true of the tree, not of this item's work alone.`,
    );
  }
  if (!gate.ok && gate.output) {
    const tail = gate.output.length > GATE_TAIL ? `…\n${gate.output.slice(-GATE_TAIL)}` : gate.output;
    lines.push(tail.replace(/^/gm, "  "));
  }
  return lines;
}

function verdict(item: ItemState): string {
  const parts = gateLines(item);
  if (item.outcome) parts.push(outcomeLine(item.outcome, item.verification ?? "not-requested"));
  return parts.length > 0 ? `\n\n${parts.join("\n")}` : "";
}

/**
 * Aggregated report returned to the parent model when a run finishes.
 *
 * The header counts *outcomes*, not statuses. An item whose child ran to the
 * end and then failed its gate is not something the caller wants filed under
 * "done" — that is the whole reason the two are recorded separately.
 */
export function buildReport(run: SwarmRun): string {
  const counts = { succeeded: 0, blocked: 0, failed: 0, skipped: 0 };
  for (const item of run.items) {
    if (item.status === "skipped") counts.skipped++;
    else if (item.outcome) counts[item.outcome]++;
    else if (item.status === "done") counts.succeeded++;
    else counts.failed++;
  }
  const tally = [
    `${counts.succeeded} succeeded`,
    ...(counts.blocked ? [`${counts.blocked} blocked`] : []),
    `${counts.failed} failed`,
    ...(counts.skipped ? [`${counts.skipped} skipped`] : []),
  ].join(", ");

  const header = `[swarm ${run.runId}] ${run.items.length} items — ${tally}`;

  const sections = run.items.map((item) => {
    const label = `### ${item.index + 1}. [${item.agent}] ${item.item}`;
    if (item.status === "done") return `${label}\n${item.result ?? "(empty report)"}${verdict(item)}`;
    if (item.status === "error") return `${label}\nError: ${item.error ?? "unknown"}${verdict(item)}`;
    if (item.status === "skipped") {
      return `${label}\nSkipped — ${item.error ?? "something it needed did not succeed"}. Nothing ran, so nothing was spent on it.`;
    }
    if (item.status === "aborted") {
      // cancelRun writes who stopped the run and what that cost into `error`;
      // a turn-cap stop leaves it empty. Either way the reader should not have
      // to guess which one it was.
      // cancelNote ends its sentence itself; do not add a second period.
      const why = (item.error ?? "turn cap or stop").replace(/\.$/, "");
      return `${label}\nAborted — ${why}. Partial:\n${item.result ?? "(none)"}`;
    }
    return `${label}\n(${item.status})`;
  });

  return [header, ...sections].join("\n\n");
}

/** One-line progress for swarm_status while a run is live. */
export function buildStatusLine(run: SwarmRun): string {
  const parts = run.items.map(
    (i) => `${i.index + 1}:${i.agent}=${i.status}${i.turns ? `(${i.turns}t)` : ""}`,
  );
  return `[swarm ${run.runId}] ${run.status} — ${parts.join(" · ")}`;
}

/**
 * The interrupt for an item that failed while the rest of the run is still
 * going. @pify/subagent already treats a failed background child as a steer
 * rather than a polite follow-up — a broken intermediate the caller is likely
 * building on should arrive now, not after the remaining items finish. This is
 * the same rule for a swarm: one wake, for the first hard failure only.
 */
export function earlyFailureNotice(run: SwarmRun, item: ItemState): string {
  const reason = item.gate && !item.gate.ok ? item.gate.reason : (item.error ?? "unknown failure");
  const pending = run.items.filter((i) => i.status === "queued" || i.status === "running").length;
  return [
    `[swarm ${run.runId}] item ${item.index + 1} (${item.id}, ${item.agent}) failed: ${reason}`,
    pending > 0
      ? `${pending} item${pending === 1 ? " is" : "s are"} still running and the full report follows when they settle — this is a warning, not the result. Do not build on this item's output, and do not poll swarm_status.`
      : "The full report follows.",
  ].join("\n");
}
