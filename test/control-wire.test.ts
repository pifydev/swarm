/**
 * Wire tests for the parts of a run that only exist in the extension: the
 * gate-repair pass, `/swarm stop`, and `swarm_status wait`. Same harness idea
 * as mailbox-wire: createAgentSession is stubbed at the boundary and each
 * child is scripted, so the real runItem/gateItem/cancelRun code runs with a
 * fake model behind it. The gate is a real shell command.
 *
 * Pinned here:
 *
 *  1. A repair child receives the repair brief and nothing else. It used to
 *     get the brief as `context` and the whole original task as `Your item:`,
 *     which read as "do the task again" rather than "fix this one thing".
 *  2. A repair child joins the run's mailbox, the way the original did.
 *  3. While a repair runs the item shows as running, not finished.
 *  4. A child that declared OUTCOME: blocked is not sent on a repair pass;
 *     the gate still runs once so the report says what it proved.
 *  5. `/swarm stop` reaches a background run — the one Esc cannot reach.
 *  6. `swarm_status wait` returns the report when the run finishes inside the
 *     wait instead of a not-ready answer.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mock } from "bun:test";

const GATE_FAILS = 'node -e "process.exit(1)"';

interface ChildSpec {
  /** The child's final assistant text; a promise holds the child open. */
  reply: (prompt: string, child: { aborted: Promise<void> }) => string | Promise<string>;
  stopReason?: string;
}

interface Spawned {
  prompt: string;
  tools: string[];
  customTools: string[];
  aborts: number;
}

type ToolLike = { execute: (...a: unknown[]) => Promise<{ content: Array<{ text?: string }>; details?: unknown }> };
type Command = { handler: (args: string, ctx: unknown) => Promise<void> };

async function harness(opts: { agentDir: string; repoDir: string; children: ChildSpec[]; hasUI?: boolean }) {
  const spawned: Spawned[] = [];
  await mock.module("@earendil-works/pi-coding-agent", () => ({
    getAgentDir: () => opts.agentDir,
    SessionManager: { inMemory: () => ({}) },
    DefaultResourceLoader: class {
      constructor(_o: unknown) {}
      async reload() {}
    },
    async createAgentSession(arg: { tools: string[]; customTools?: Array<{ name: string }> }) {
      const spec = opts.children[spawned.length] ?? opts.children[opts.children.length - 1]!;
      const entry: Spawned = {
        prompt: "",
        tools: arg.tools,
        customTools: (arg.customTools ?? []).map((t) => t.name),
        aborts: 0,
      };
      spawned.push(entry);
      let release = (): void => {};
      const aborted = new Promise<void>((r) => (release = r));
      const messages: Array<{ role: string; stopReason: string; content: Array<{ type: string; text: string }> }> = [];
      return {
        session: {
          subscribe: () => () => {},
          async prompt(text: string) {
            entry.prompt = text;
            const reply = await spec.reply(text, { aborted });
            messages.push({
              role: "assistant",
              stopReason: entry.aborts > 0 ? "aborted" : (spec.stopReason ?? "stop"),
              content: [{ type: "text", text: reply }],
            });
          },
          messages,
          dispose() {},
          async abort() {
            entry.aborts++;
            release();
          },
        },
      };
    },
  }));
  // The widget is the only place an item's live status is visible from the
  // outside; a Text that just keeps its string lets the test read it.
  await mock.module("@earendil-works/pi-tui", () => ({
    Text: class {
      text: string;
      constructor(text: string) {
        this.text = text;
      }
    },
  }));

  const mod = await import("../extensions/swarm.ts");
  const handlers: Record<string, (e: unknown, c: unknown) => unknown> = {};
  const tools: Record<string, ToolLike> = {};
  const commands: Record<string, Command> = {};
  const pi = {
    registerTool: (t: { name: string } & ToolLike) => {
      tools[t.name] = t;
    },
    registerCommand: (name: string, c: Command) => {
      commands[name] = c;
    },
    on: (event: string, cb: (e: unknown, c: unknown) => unknown) => {
      handlers[event] = cb;
    },
    getThinkingLevel: () => "off",
    appendEntry: () => {},
    sendMessage: () => {},
  };
  (mod.default as unknown as (p: typeof pi) => void)(pi);

  const notices: string[] = [];
  let widget: ((tui: unknown, theme: unknown) => { text: string }) | undefined;
  const theme = { fg: (_c: string, s: string) => s, bold: (s: string) => s };
  const ctx = {
    cwd: opts.repoDir,
    hasUI: opts.hasUI ?? false,
    model: { id: "fake" },
    modelRegistry: { find: () => undefined },
    sessionManager: { getBranch: () => [] },
    ui: {
      notify: (m: string) => void notices.push(m),
      setWidget: (_id: string, factory?: (tui: unknown, theme: unknown) => { text: string }) => {
        widget = factory;
      },
    },
  };
  await handlers.session_start!({}, ctx);
  const widgetText = () => (widget ? widget(null, theme).text : "");
  const text = (r: { content: Array<{ text?: string }> }) => String(r.content[0]?.text ?? "");
  return { spawned, tools, commands, ctx, notices, widgetText, text };
}

function dirs(tag: string) {
  const agentDir = mkdtempSync(join(tmpdir(), `pify-swarm-${tag}-agent-`));
  const repoDir = mkdtempSync(join(tmpdir(), `pify-swarm-${tag}-repo-`));
  return {
    agentDir,
    repoDir,
    clean() {
      rmSync(agentDir, { recursive: true, force: true });
      rmSync(repoDir, { recursive: true, force: true });
    },
  };
}

test("wire: a repair child gets the brief alone, the run's mailbox, and shows as running", async () => {
  const d = dirs("repair");
  try {
    let duringRepair = "";
    const h = await harness({
      ...d,
      hasUI: true,
      children: [
        { reply: () => "changed the thing" },
        {
          reply: () => {
            duringRepair = h.widgetText();
            return "fixed the check";
          },
        },
      ],
    });
    const report = h.text(
      await h.tools.swarm_run!.execute(
        "c1",
        { items: ["add a helper to util.ts"], agent: "worker", gate: GATE_FAILS, mailbox: true },
        undefined,
        undefined,
        h.ctx,
      ),
    );

    assert.equal(h.spawned.length, 2, "one child, one repair pass");
    const repair = h.spawned[1]!;
    // 1. The brief is the prompt. Not "fix this" followed by the whole task.
    assert.match(repair.prompt, /^Your work did not pass its verification check/);
    assert.ok(!repair.prompt.includes("Your item:"), `the original task was re-issued:\n${repair.prompt}`);
    assert.match(repair.prompt, /== Original task ==\nadd a helper to util\.ts/);
    // 2. Same mailbox as the original item.
    assert.ok(repair.tools.includes("swarm_post"), "repair child lost the mailbox");
    assert.deepEqual([...repair.customTools].sort(), ["swarm_inbox", "swarm_post"]);
    // 3. Shown as running while the repair is in flight, not as finished.
    assert.match(duringRepair, /⟳ worker/, `widget during repair:\n${duringRepair}`);
    assert.doesNotMatch(duringRepair, /✓ worker/);
    // The repair's report replaces the stale one; the gate still stands as failed.
    assert.match(report, /fixed the check/);
    assert.match(report, /repaired 1 time and re-run/);
    assert.match(report, /\[outcome\] failed/);
  } finally {
    d.clean();
  }
});

test("wire: a child that declared itself blocked is gated once and never repaired", async () => {
  const d = dirs("blocked");
  try {
    const h = await harness({
      ...d,
      children: [{ reply: () => "need the schema first\nOUTCOME: blocked" }],
    });
    const report = h.text(
      await h.tools.swarm_run!.execute(
        "c2",
        { items: ["add a helper to util.ts"], agent: "worker", gate: GATE_FAILS },
        undefined,
        undefined,
        h.ctx,
      ),
    );
    assert.equal(h.spawned.length, 1, "no repair pass for a blocked child");
    assert.match(report, /\[gate\] failure/, "the gate still ran once");
    assert.doesNotMatch(report, /repaired/);
    assert.match(report, /1 items — 0 succeeded, 1 failed/);
  } finally {
    d.clean();
  }
});

test("wire: /swarm stop cancels a background run and aborts its child", async () => {
  const d = dirs("stop");
  try {
    const h = await harness({
      ...d,
      hasUI: true,
      children: [{ reply: async (_p, child) => (await child.aborted, "partial") }],
    });
    const started = h.text(
      await h.tools.swarm_run!.execute("c3", { items: ["long task"], background: true }, undefined, undefined, h.ctx),
    );
    assert.match(started, /\/swarm stop/, "the start text says how to stop it");

    // The child exists and is mid-prompt — the state Esc cannot reach.
    while (!h.spawned[0]?.prompt) await new Promise((r) => setTimeout(r, 5));
    await h.commands.swarm!.handler("stop", h.ctx);
    assert.equal(h.spawned[0]!.aborts, 1, "the live child was aborted");
    assert.ok(h.notices.some((n) => /s1/.test(n) && /stopp|cancel/i.test(n)), `notices: ${h.notices.join(" | ")}`);

    // Let the aborted child settle so the run's record is complete.
    await new Promise((r) => setTimeout(r, 20));
    const status = h.text(await h.tools.swarm_status!.execute("c4", {}, undefined, undefined, h.ctx));
    assert.match(status, /cancelled before it finished/);
    assert.match(status, /Cancelled by the user/);

    // A second stop has nothing to stop and says so instead of throwing.
    await h.commands.swarm!.handler("stop s1", h.ctx);
    assert.ok(h.notices.some((n) => /not running/.test(n)), `notices: ${h.notices.join(" | ")}`);
    await h.commands.swarm!.handler("stop s9", h.ctx);
    assert.ok(h.notices.some((n) => /No swarm run s9/.test(n)));
  } finally {
    d.clean();
  }
});

test("wire: a stop that lands before the child exists still ends the run", async () => {
  const d = dirs("early-stop");
  try {
    const h = await harness({
      ...d,
      hasUI: true,
      children: [{ reply: () => "should never be asked" }],
    });
    await h.tools.swarm_run!.execute("c10", { items: ["task"], background: true }, undefined, undefined, h.ctx);
    // No ticks: the scheduler has launched the item but no session exists yet,
    // so there is nothing to abort — and nothing may start afterwards either.
    await h.commands.swarm!.handler("stop", h.ctx);
    await new Promise((r) => setTimeout(r, 20));
    assert.ok(
      h.spawned.every((s) => s.prompt === ""),
      "a child of a cancelled run was prompted after the stop",
    );
    const status = h.text(await h.tools.swarm_status!.execute("c11", {}, undefined, undefined, h.ctx));
    assert.match(status, /cancelled before it finished/);
    assert.match(status, /Aborted/, "the record cancelRun wrote was not overwritten by a late start");
    assert.doesNotMatch(status, /should never be asked/);
  } finally {
    d.clean();
  }
});

test("wire: swarm_status wait returns the report once the run finishes inside the wait", async () => {
  const d = dirs("wait");
  try {
    const h = await harness({
      ...d,
      children: [{ reply: () => new Promise((r) => setTimeout(() => r("all done"), 60)) }],
    });
    await h.tools.swarm_run!.execute("c5", { items: ["quick task"], background: true }, undefined, undefined, h.ctx);

    // No wait: not ready, and headless, so it tells the model about wait.
    const early = await h.tools.swarm_status!.execute("c6", {}, undefined, undefined, h.ctx);
    assert.match(h.text(early), /still running/);
    assert.match(h.text(early), /wait/);
    assert.equal((early.details as { pollRequired: boolean }).pollRequired, true);

    const waited = h.text(await h.tools.swarm_status!.execute("c7", { wait: 5 }, undefined, undefined, h.ctx));
    assert.match(waited, /1 items — 1 succeeded/, `expected the report, got:\n${waited}`);
    assert.match(waited, /all done/);

    // An aborted signal ends the wait at once rather than sitting out the budget.
    const controller = new AbortController();
    controller.abort();
    const h2 = await harness({
      ...d,
      children: [{ reply: () => new Promise((r) => setTimeout(() => r("later"), 300)) }],
    });
    await h2.tools.swarm_run!.execute("c8", { items: ["slow task"], background: true }, undefined, undefined, h2.ctx);
    const t0 = Date.now();
    const cut = h2.text(await h2.tools.swarm_status!.execute("c9", { wait: 10 }, controller.signal, undefined, h2.ctx));
    assert.ok(Date.now() - t0 < 250, "the abort signal cut the wait short");
    assert.match(cut, /still running/);
    await new Promise((r) => setTimeout(r, 350));
  } finally {
    d.clean();
  }
});
