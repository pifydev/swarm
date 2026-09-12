import { clampRows, clampWidth, MAX_WIDGET_ROWS } from "./widget-clamp.ts";
import type { SwarmRun, ThemeLike } from "./types.ts";

const WIDTH = 54;

function icon(status: string): string {
  switch (status) {
    case "queued":
      return "·";
    case "running":
      return "⟳";
    case "done":
      return "✓";
    case "error":
      return "✗";
    default:
      return "◼";
  }
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
    const paint =
      item.status === "running"
        ? (s: string) => theme.fg("warning", s)
        : item.status === "done"
          ? (s: string) => theme.fg("success", s)
          : item.status === "queued"
            ? dim
            : (s: string) => theme.fg("error", s);
    return `${dim("│ ")}${paint(`${icon(item.status)} ${clampWidth(item.agent, 24)}`)}${dim(` ${clampWidth(item.item, 32)}`)}`;
  });
  for (const row of clampRows(rows, MAX_WIDGET_ROWS, (hidden) => dim(`│ … +${hidden} more`))) {
    lines.push(row);
  }

  lines.push(dim(`╰${"─".repeat(WIDTH)}╯`));
  return lines;
}
