import type { SwarmRun } from "./types.ts";

/** Aggregated report returned to the parent model when a run finishes. */
export function buildReport(run: SwarmRun): string {
  const counts = { done: 0, error: 0, aborted: 0 };
  for (const item of run.items) {
    if (item.status === "done") counts.done++;
    else if (item.status === "error") counts.error++;
    else if (item.status === "aborted") counts.aborted++;
  }

  const header = `[swarm ${run.runId}] ${run.items.length} items — ${counts.done} done, ${counts.error} error, ${counts.aborted} aborted`;

  const sections = run.items.map((item) => {
    const label = `### ${item.index + 1}. [${item.agent}] ${item.item}`;
    if (item.status === "done") return `${label}\n${item.result ?? "(empty report)"}`;
    if (item.status === "error") return `${label}\nError: ${item.error ?? "unknown"}`;
    if (item.status === "aborted") {
      return `${label}\nAborted (turn cap or stop). Partial:\n${item.result ?? "(none)"}`;
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
