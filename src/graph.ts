/**
 * Turning a list of items — some depending on others — into a runnable graph.
 *
 * swarm's flat mode fans N independent items out in parallel. But real work is
 * rarely that flat: "write the migration, THEN update the callers, THEN run the
 * tests" is a chain, and "gather these three, then summarize" is a join. Left
 * to the coordinator to sequence by hand, the dependency is a thing it can
 * forget — and the classic failure is forgetting to pass the upstream's output
 * to the downstream item at all.
 *
 * So an item may declare `needs: [id, …]`. This module is the pure half: it
 * normalizes items (string or object) into nodes with stable ids, and rejects a
 * bad graph — a self-edge, a reference to an unknown id, a duplicate id, or a
 * cycle — BEFORE anything is spawned, because a bad graph should cost nothing.
 * The scheduler (in the extension) then runs each item as soon as its needs are
 * done and prepends every upstream's output to it.
 *
 * A flat list (no `needs` anywhere) validates trivially and every node is ready
 * at once — identical to the old parallel fan-out. Zero dependencies.
 */

export interface RawItem {
  task: string;
  id?: string;
  needs?: string[];
}

export interface GraphNode {
  id: string;
  task: string;
  needs: string[];
}

export interface NormalizeResult {
  nodes: GraphNode[];
  error: string | null;
}

/** Accept a plain string or an object; give every item a stable id and clean needs. */
export function normalizeItems(items: Array<string | RawItem>): NormalizeResult {
  const nodes: GraphNode[] = [];
  for (let i = 0; i < items.length; i++) {
    const raw = items[i]!;
    const isString = typeof raw === "string";
    const task = (isString ? raw : raw.task ?? "").trim();
    if (!task) return { nodes: [], error: `item ${i + 1} has no task text` };
    const id = !isString && typeof raw.id === "string" && raw.id.trim() ? raw.id.trim() : `t${i + 1}`;
    const needs =
      !isString && Array.isArray(raw.needs)
        ? raw.needs.filter((n): n is string => typeof n === "string" && n.trim() !== "").map((n) => n.trim())
        : [];
    nodes.push({ id, task, needs });
  }
  const error = validateGraph(nodes);
  return { nodes, error };
}

/** Reject a self-edge, an unknown reference, a duplicate id, or a cycle. */
export function validateGraph(nodes: GraphNode[]): string | null {
  const ids = new Set<string>();
  for (const n of nodes) {
    if (ids.has(n.id)) return `duplicate item id "${n.id}"`;
    ids.add(n.id);
  }
  for (const n of nodes) {
    for (const dep of n.needs) {
      if (dep === n.id) return `item "${n.id}" cannot depend on itself`;
      if (!ids.has(dep)) return `item "${n.id}" needs unknown item "${dep}"`;
    }
  }
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const state = new Map<string, 0 | 1 | 2>(); // 0 unseen, 1 on stack, 2 done
  const hasCycle = (id: string): boolean => {
    const s = state.get(id) ?? 0;
    if (s === 1) return true;
    if (s === 2) return false;
    state.set(id, 1);
    for (const dep of byId.get(id)!.needs) if (hasCycle(dep)) return true;
    state.set(id, 2);
    return false;
  };
  for (const n of nodes) if (hasCycle(n.id)) return `dependency cycle involving "${n.id}"`;
  return null;
}

/** Does any node declare a dependency? If not, the run is a plain flat fan-out. */
export function hasEdges(nodes: GraphNode[]): boolean {
  return nodes.some((n) => n.needs.length > 0);
}
