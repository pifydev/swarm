/**
 * Waiting on a run without teaching the model to poll.
 *
 * pending.ts says "do not poll" and means it — in an interactive session the
 * report arrives on its own. A headless `pi -p` run has no such delivery, so
 * there the model's only move was to call swarm_status again, and again, each
 * call a full turn. `wait` lets one call sit on the run for a bounded time
 * instead: the answer is the same either way, it just arrives in one turn.
 *
 * Pure: the condition, the budget and the tool's own AbortSignal. The
 * extension owns what is being waited for.
 */

/**
 * Resolve true as soon as `check()` holds, false when `ms` runs out or the
 * signal fires first. Polls rather than subscribes: the run has no event to
 * listen to, and a check every `intervalMs` costs nothing measurable.
 */
export function waitUntil(
  check: () => boolean,
  ms: number,
  intervalMs = 250,
  signal?: AbortSignal,
): Promise<boolean> {
  if (check()) return Promise.resolve(true);
  if (!(ms > 0) || signal?.aborted) return Promise.resolve(false);
  const interval = Math.max(1, intervalMs);
  return new Promise((resolve) => {
    const deadline = Date.now() + ms;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (value: boolean): void => {
      if (timer !== undefined) clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      resolve(value);
    };
    // An abort is the caller leaving, not a verdict; if the condition happens
    // to hold by then, say so rather than reporting a wait that never happened.
    const onAbort = (): void => finish(check());
    const tick = (): void => {
      if (check()) return finish(true);
      const left = deadline - Date.now();
      if (left <= 0) return finish(false);
      timer = setTimeout(tick, Math.min(interval, left));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    timer = setTimeout(tick, Math.min(interval, ms));
  });
}
