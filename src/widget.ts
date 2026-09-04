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

  for (const item of run.items) {
    const paint =
      item.status === "running"
        ? (s: string) => theme.fg("warning", s)
        : item.status === "done"
          ? (s: string) => theme.fg("success", s)
          : item.status === "queued"
            ? dim
            : (s: string) => theme.fg("error", s);
    const text = item.item.length > 32 ? `${item.item.slice(0, 32)}…` : item.item;
    lines.push(`${dim("│ ")}${paint(`${icon(item.status)} ${item.agent}`)}${dim(` ${text}`)}`);
  }

  lines.push(dim(`╰${"─".repeat(WIDTH)}╯`));
  return lines;
}
