import { clampRows, clampWidth, MAX_WIDGET_ROWS } from "./widget-clamp.ts";
import type { ItemState, SwarmRun, ThemeLike } from "./types.ts";

const WIDTH = 54;

/**
 * The row reports the *task*, not the child session. An item whose agent ran to
 * the end and then failed its gate used to sit here as a green ✓, which is
 * precisely the confusion the outcome field exists to remove.
 */
function icon(item: ItemState): string {
  switch (item.status) {
    case "queued":
      return "·";
    case "running":
      return "⟳";
    case "skipped":
      return "⊘";
    case "done":
      return item.outcome === "failed" ? "✗" : item.outcome === "blocked" ? "⚠" : "✓";
    case "error":
      return "✗";
    default:
      return "◼";
  }
}

type Tone = "dim" | "warning" | "success" | "error";

function tone(item: ItemState): Tone {
  if (item.status === "queued" || item.status === "skipped") return "dim";
  if (item.status === "running") return "warning";
  if (item.status !== "done") return "error";
  if (item.outcome === "failed") return "error";
  if (item.outcome === "blocked") return "warning";
  return "success";
}

/** Widget above the editor for the active (or just-finished) run. */
export function buildWidgetLines(run: SwarmRun | null, theme: ThemeLike, now: number): string[] {
  if (!run) return [];
  if (run.status === "done" && (run.finishedAt ?? 0) < now - 15_000) return [];

  const dim = (s: string) => theme.fg("dim", s);
  const lines: string[] = [];
  const title = ` 🐝 swarm ${run.runId} `;
  const hint = " /swarm ";
  const pad = Math.max(1, WIDTH - title.length - hint.length);
  lines.push(dim(`╭${title}${"─".repeat(pad)}${hint}╮`));

  // Cap the rows: a large swarm would otherwise push the editor off screen,
  // since a Text-factory widget bypasses pi's ten-line guard.
  const rows = run.items.map((item) => {
    const color = tone(item);
    const paint = (s: string) => theme.fg(color, s);
    return `${dim("│ ")}${paint(`${icon(item)} ${clampWidth(item.agent, 24)}`)}${dim(` ${clampWidth(item.item, 32)}`)}`;
  });
  for (const row of clampRows(rows, MAX_WIDGET_ROWS, (hidden) => dim(`│ … +${hidden} more`))) {
    lines.push(row);
  }

  lines.push(dim(`╰${"─".repeat(WIDTH)}╯`));
  return lines;
}
