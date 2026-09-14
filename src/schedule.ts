/**
 * The readiness scheduler, pure and testable.
 *
 * Given nodes that may depend on one another, run each one as soon as its
 * `needs` have finished, never more than `concurrency` at a time. The caller's
 * `run(node, upstream)` does the actual work and is handed the finished
 * upstream nodes (in `needs` order) so it can thread their output into the
 * dependent. A node whose run rejects still counts as done, so a failure
 * unblocks its dependents rather than wedging the whole graph. `cancelled()` is
 * polled between launches to stop taking on new work.
 *
 * A flat set (no `needs`) makes every node ready at once, so this collapses to
 * a plain concurrency-capped fan-out. Zero dependencies; the graph itself must
 * already be validated (see graph.ts) — this assumes no cycle.
 */

export interface Schedulable {
  id: string;
  needs: string[];
}

export async function runGraph<T extends Schedulable>(
  nodes: readonly T[],
  concurrency: number,
  run: (node: T, upstream: T[]) => void | Promise<void>,
  cancelled: () => boolean = () => false,
): Promise<void> {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const done = new Set<string>();
  const started = new Set<string>();
  const inFlight = new Map<string, Promise<void>>();
  const cap = Math.max(1, concurrency);

  const isReady = (n: T) => !started.has(n.id) && n.needs.every((d) => done.has(d));

  while (!cancelled()) {
    for (const n of nodes) {
      if (inFlight.size >= cap) break;
      if (!isReady(n)) continue;
      started.add(n.id);
      const upstream = n.needs.map((id) => byId.get(id)).filter((x): x is T => x !== undefined);
      const p = Promise.resolve()
        .then(() => run(n, upstream))
        .catch(() => {
          // The caller records its own failure; here a rejected node must still
          // settle so dependents unblock instead of the graph hanging.
        })
        .then(() => {
          done.add(n.id);
          inFlight.delete(n.id);
        });
      inFlight.set(n.id, p);
    }
    if (inFlight.size === 0) break; // nothing running and nothing newly ready
    await Promise.race(inFlight.values());
  }
  // A cancel can leave work in flight; let it settle so the caller's record is
  // complete rather than half-written.
  await Promise.all(inFlight.values());
}
