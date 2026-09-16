import { test } from "node:test";
import assert from "node:assert/strict";
import { canWrite, repairAllowed } from "../src/repair-policy.ts";
import { sharedWith } from "../src/gate.ts";
import type { AgentDef } from "../src/types.ts";

function def(overrides: Partial<AgentDef> = {}): AgentDef {
  return {
    name: "worker",
    description: "w",
    tools: ["read", "edit"],
    model: null,
    thinking: null,
    maxTurns: 30,
    systemPrompt: "x",
    source: "builtin",
    matchPatterns: [],
    matchKeywords: [],
    ...overrides,
  };
}

test("a read-only agent is never asked to repair", () => {
  assert.equal(canWrite(def({ tools: ["read", "grep"] })), false);
  assert.equal(canWrite(def({ tools: ["read", "bash"] })), true);
  assert.equal(repairAllowed(def({ tools: ["read", "grep"] }), "done it"), false);
});

test("a child that declared itself blocked is not sent back to fix the gate", () => {
  // The declaration is a claim about the item's own wall — a decision or
  // access it does not have — and a failing gate does not remove that wall.
  assert.equal(repairAllowed(def(), "cannot proceed without the schema\nOUTCOME: blocked"), false);
  assert.equal(repairAllowed(def(), "did it\nOUTCOME: failed"), true, "failed is exactly what a repair is for");
  assert.equal(repairAllowed(def(), "did it"), true);
  assert.equal(repairAllowed(def(), null), true);
});

test("sharedWith: a non-isolated sibling does not share an isolated item's worktree", () => {
  const worktree = "/repo/.pi/worktrees/s1-i1";
  const self = { id: 0, label: "t1", status: "done", workDir: worktree };
  // An undefined workDir means "the subject's directory" to sharedWith(), so
  // the extension names every item's directory explicitly — the repo root for
  // items that ran in place. Before that mapping the first case listed t2.
  const inPlace = { id: 1, label: "t2", status: "running", workDir: "/repo" };
  const sameTree = { id: 2, label: "t3", status: "running", workDir: worktree };
  const finished = { id: 3, label: "t4", status: "done", workDir: worktree };
  assert.deepEqual(sharedWith(self, worktree, [inPlace, sameTree, finished]), ["t3"]);
  // The trap the mapping exists to avoid, pinned so it is not reintroduced.
  assert.deepEqual(sharedWith(self, worktree, [{ ...inPlace, workDir: undefined }]), ["t2"]);
});
