/**
 * @pify/swarm — coordinate multiple pi agents working in parallel.
 *
 * swarm_run fans a list of task items out to child agents (the same
 * in-process createAgentSession runner proven in @pify/subagent), with a
 * concurrency queue, per-item auto-routing via agent-def match_patterns /
 * match_keywords (gjczone's model), a live widget, and an aggregated
 * report. Blocking by default; background: true returns a runId polled
 * with swarm_status. Items are independent — no shared state, no nesting.
 *
 * Reads the SAME .pi/agents/*.md definitions as @pify/subagent (plus the
 * two routing keys), so one agent catalog serves both packages.
 */
import {
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  SessionManager,
  type AgentSession,
  type ToolDefinition,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";

import { BUILTIN_AGENTS } from "../src/builtin.ts";
import { withUiLock } from "../src/ui-lock.ts";
import {
  consentQuestion,
  decideConsent,
  envConsent,
  parseConsent,
  readConsent,
  writeConsent,
} from "../src/consent.ts";
import { LiveChildren, cancelNote, type CancelReason } from "../src/cancel.ts";
import { DELIVERY_TYPE, deliveryMessage, pendingResult } from "../src/pending.ts";
import { createIsolationWorktree, isolationNote, removeIfUnchanged } from "../src/isolate.ts";
import { formatInbox, mailboxDir, mailboxPrompt, postMessage, readInbox } from "../src/mailbox.ts";
import { parseAgentFile } from "../src/frontmatter.ts";
import { buildReport, buildStatusLine } from "../src/report.ts";
import { routeItem } from "../src/routing.ts";
import { buildWidgetLines } from "../src/widget.ts";
import {
  DEFAULT_CONCURRENCY,
  MAX_ITEMS,
  isRecord,
  type AgentDef,
  type ItemState,
  type SwarmRun,
} from "../src/types.ts";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";

const RUN_ENTRY = "swarm-run";
const CLEAN_WORKTREE_NOTE =
  "Ran isolated in a temporary worktree; it changed nothing, so the worktree was removed.";

type UiContext = ExtensionContext;

function loadDefs(cwd: string, agentDir: string, projectAllowed: boolean): Map<string, AgentDef> {
  const defs = new Map<string, AgentDef>();
  for (const [name, content] of Object.entries(BUILTIN_AGENTS)) {
    const def = parseAgentFile(name, content, "builtin");
    if (def) defs.set(def.name, def);
  }
  // The project directory is consent-gated: `.pi/agents/*.md` is repo-shipped
  // text that becomes a CHILD SYSTEM PROMPT, overriding builtins of the same
  // name, and pi never asks about it — measured, a repo whose only pi file is
  // `.pi/agents/reviewer.md` reports isProjectTrusted=true. One answer,
  // recorded under the same "agents" scope subagent uses, governs the catalog
  // across the whole suite.
  const sources: Array<readonly [string, "global" | "project"]> = [
    [join(agentDir, "agents"), "global"] as const,
    ...(projectAllowed ? [[join(cwd, ".pi", "agents"), "project"] as const] : []),
  ];
  for (const [dir, source] of sources) {
    try {
      for (const file of readdirSync(dir).filter((f) => f.endsWith(".md"))) {
        try {
          const def = parseAgentFile(basename(file, ".md"), readFileSync(join(dir, file), "utf8"), source);
          if (def) defs.set(def.name, def);
        } catch {
          // skip unreadable
        }
      }
    } catch {
      // dir missing
    }
  }
  return defs;
}

export default function swarm(pi: ExtensionAPI) {
  let defs = new Map<string, AgentDef>();
  const runs = new Map<string, SwarmRun>();
  /** Live child sessions per run, so a stop actually reaches the children. */
  const live = new LiveChildren();
  let activeRun: SwarmRun | null = null;
  let runCounter = 0;
  let lastUiCtx: UiContext | null = null;

  function renderWidget(ctx: UiContext | null = lastUiCtx): void {
    if (!ctx || !ctx.hasUI) return;
    lastUiCtx = ctx;
    const run = activeRun;
    const now = Date.now();
    if (!run || (run.status !== "running" && (run.finishedAt ?? 0) < now - 15_000)) {
      ctx.ui.setWidget("swarm", undefined);
      return;
    }
    ctx.ui.setWidget(
      "swarm",
      (_tui: unknown, theme: { fg(c: string, s: string): string; bold(s: string): string }) =>
        new Text(buildWidgetLines(run, theme, Date.now()).join("\n"), 0, 0),
      { placement: "aboveEditor" },
    );
  }

  function notify(ctx: UiContext, message: string, level: "info" | "warning" | "error"): void {
    if (ctx.hasUI) ctx.ui.notify(message, level);
  }

  // ── Child runner (subagent-proven pattern, one per item) ─────────────

  /**
   * Mailbox tools for one child. Each agent posts under its own label and
   * never sees its own posts echoed back; `seen` advances per agent so a
   * second swarm_inbox only reports what arrived since the first.
   */
  function mailboxTools(dir: string, label: string): ToolDefinition[] {
    let seen = 0;
    return [
      {
        name: "swarm_post",
        label: "Post to swarm",
        description:
          "Tell the other agents in this swarm something that changes their work: a shared file you " +
          "modified, a convention you had to choose, a blocker they will hit too. Not for progress " +
          "narration — only facts a sibling needs to avoid redoing or undoing your work.",
        parameters: Type.Object({
          message: Type.String({ description: "One fact the other agents need" }),
        }),
        async execute(_id: string, params: { message: string }) {
          const posted = postMessage(dir, label, params.message, Date.now());
          return {
            content: [{ type: "text", text: `Posted #${posted.seq} to the swarm.` }],
            details: { seq: posted.seq },
          };
        },
      },
      {
        name: "swarm_inbox",
        label: "Read swarm inbox",
        description:
          "Read what the other agents in this swarm have posted since you last checked. Call it " +
          "before you start working and again before you finish.",
        parameters: Type.Object({}),
        async execute() {
          const read = readInbox(dir, label, seen);
          seen = read.nextSeq;
          return {
            content: [{ type: "text", text: formatInbox(read) }],
            details: { count: read.messages.length },
          };
        },
      },
    ] as unknown as ToolDefinition[];
  }

  async function runItem(
    ctx: UiContext,
    runId: string,
    def: AgentDef,
    item: ItemState,
    context: string,
    workDir?: string,
    mailbox?: string,
  ): Promise<void> {
    item.status = "running";
    renderWidget();
    let session: AgentSession | null = null;
    let unsubscribe: (() => void) | null = null;
    let releaseLive: (() => void) | null = null;
    try {
      let model = ctx.model ?? null;
      if (def.model) {
        const [provider, ...rest] = def.model.split("/");
        const found =
          provider && rest.length > 0 ? ctx.modelRegistry.find(provider, rest.join("/")) : undefined;
        if (found) model = found;
      }
      if (!model) throw new Error("No model available");

      const promptHost = ctx as unknown as {
        getSystemPromptOptions?: () => { customPrompt?: string; appendSystemPrompt?: string };
      };
      const promptOptions = promptHost.getSystemPromptOptions?.() ?? {};

      // `reload()` is not optional. `createAgentSession` only loads a resource
      // loader it builds itself; one passed in is used exactly as handed over,
      // and a fresh DefaultResourceLoader resolves neither `systemPrompt` nor
      // `appendSystemPrompt` until it loads. Without it the child ran with no
      // instructions at all — the call succeeds, the model answers, and it
      // answers as a generic assistant with nothing to say it went wrong.
      const loader = new DefaultResourceLoader({
        cwd: workDir ?? ctx.cwd,
        agentDir: getAgentDir(),
        noExtensions: true,
        noPromptTemplates: true,
        noThemes: true,
        systemPrompt: promptOptions.customPrompt,
        appendSystemPrompt: [
          ...(promptOptions.appendSystemPrompt ? [promptOptions.appendSystemPrompt] : []),
          def.systemPrompt,
          "You are one agent in a swarm, handling exactly one item. Your final assistant message is the deliverable — make it complete and self-contained.",
          ...(mailbox ? [mailboxPrompt(item.agent + "-" + item.index)] : []),
        ],
      });
      await loader.reload();
      const created = await createAgentSession({
        sessionManager: SessionManager.inMemory(workDir ?? ctx.cwd),
        model,
        thinkingLevel: (def.thinking ?? pi.getThinkingLevel()) as never,
        tools: def.tools,
        ...(mailbox ? { customTools: mailboxTools(mailbox, item.agent + "-" + item.index) } : {}),
        resourceLoader: loader,
      });
      session = created.session;
      releaseLive = live.register(runId, session);

      unsubscribe = session.subscribe((event) => {
        if (event.type === "message_end" && (event as { message?: { role?: string } }).message?.role === "assistant") {
          item.turns++;
          const usage = (event as { message?: { usage?: { totalTokens?: number } } }).message?.usage;
          if (usage && typeof usage.totalTokens === "number") item.tokens += usage.totalTokens;
          renderWidget();
          if (item.turns >= def.maxTurns) void session?.abort().catch(() => {});
        }
      });

      const prompt = context ? `${context.trim()}\n\nYour item: ${item.item}` : item.item;
      await session.prompt(prompt, { source: "extension" } as never);

      const messages = session.messages as Array<{
        role?: string;
        stopReason?: unknown;
        content?: Array<{ type?: string; text?: string }>;
      }>;
      const last = [...messages].reverse().find((m) => m.role === "assistant");
      const text = (last?.content ?? [])
        .filter((c) => c.type === "text" && typeof c.text === "string")
        .map((c) => c.text)
        .join("\n")
        .trim();

      item.result = text || null;
      item.status =
        last?.stopReason === "aborted" ? "aborted" : last?.stopReason === "error" ? "error" : "done";
      if (item.status === "error") item.error = text || "child session error";
      // A child that stopped cleanly and said nothing has not answered — the
      // fix subagent already carries and this executor never received. Left
      // as "done", a reasoning-only finish (measured on anthropic/claude-opus-5
      // through child sessions) rendered a successful fan-out of "(empty
      // report)" items. An exit status is not an answer.
      if (item.status === "done" && !item.result) {
        item.status = "error";
        item.error = "the child finished without producing an answer";
      }
    } catch (err) {
      item.status = "error";
      item.error = err instanceof Error ? err.message : String(err);
    } finally {
      if (releaseLive) releaseLive();
      if (unsubscribe) {
        try {
          unsubscribe();
        } catch {
          // gone
        }
      }
      if (session) {
        try {
          session.dispose();
        } catch {
          // fine
        }
      }
      renderWidget();
    }
  }

  /** Pool executor: at most DEFAULT_CONCURRENCY items in flight. */
  async function executeRun(
    ctx: UiContext,
    run: SwarmRun,
    context: string,
    fixed?: string,
    isolate?: boolean,
    useMailbox?: boolean,
  ): Promise<void> {
    // One shared log per run; only created when the caller asked for it.
    const mailbox = useMailbox ? mailboxDir(getAgentDir(), run.runId) : undefined;
    const queue = [...run.items];
    const workers = Array.from({ length: Math.min(DEFAULT_CONCURRENCY, queue.length) }, async () => {
      for (;;) {
        // A cancelled run stops taking new items; the ones already in flight
        // were aborted by cancelRun.
        if (run.status === "cancelled") return;
        const item = queue.shift();
        if (!item) return;
        const def = routeItem(item.item, defs, fixed);
        item.agent = def.name;
        if (isolate) {
          try {
            const iso = createIsolationWorktree(ctx.cwd, run.runId + "-i" + (item.index + 1));
            await runItem(ctx, run.runId, def, item, context, iso.path, mailbox);
            if (item.result !== null) item.result = `${item.result}\n\n${isolationNote(iso)}`;
          } catch (err) {
            item.status = "error";
            item.error = err instanceof Error ? err.message : String(err);
          }
        } else {
          await runItem(ctx, run.runId, def, item, context, undefined, mailbox);
        }
      }
    });
    await Promise.all(workers);
    if (run.status !== "cancelled") run.status = "done";
    run.finishedAt = Date.now();
    pi.appendEntry(RUN_ENTRY, run);
    renderWidget();
  }

  /**
   * Stop a run and every child it started. Both meanings of "stop" — the
   * user's abort and session teardown — come through here.
   */
  function cancelRun(run: SwarmRun, reason: CancelReason): void {
    const stopped = live.abortRun(run.runId);
    if (run.status === "running") {
      run.status = "cancelled";
      run.finishedAt = Date.now();
    }
    for (const item of run.items) {
      if (item.status === "running" || item.status === "queued") {
        item.status = "aborted";
        item.error = cancelNote(reason, stopped);
      }
    }
    renderWidget();
  }

  // ── Tools ────────────────────────────────────────────────────────────

  pi.registerTool({
    name: "swarm_run",
    label: "Run swarm",
    promptSnippet: "Run many independent items through child agents at once",
    description:
      `Fan out 1-${MAX_ITEMS} independent task items to parallel child agents (concurrency ${DEFAULT_CONCURRENCY}). ` +
      "Each item auto-routes to an agent type via its match_patterns/match_keywords, falling back to the " +
      "read-only scout; set agent to force one type for all items. context is prepended to every item. " +
      "Blocking by default (returns the aggregated report); background=true returns a runId for swarm_status. " +
      "Write each item as a self-contained brief — children see nothing else. For MUTATING items set " +
      "isolation=worktree: each item gets its own git worktree and branch; reports say how to merge. " +
      "mailbox=true adds swarm_post/swarm_inbox so agents can warn each other about shared files and " +
      "conventions instead of silently conflicting.",
    parameters: Type.Object({
      items: Type.Array(Type.String(), { minItems: 1, maxItems: MAX_ITEMS }),
      context: Type.Optional(Type.String({ description: "Shared preamble for every item" })),
      agent: Type.Optional(Type.String({ description: "Force one agent type for all items" })),
      isolation: Type.Optional(Type.String({ description: "Set to worktree to give each item its own git worktree (for mutating items)" })),
      mailbox: Type.Optional(
        Type.Boolean({ description: "Give the agents swarm_post/swarm_inbox to share facts mid-run" }),
      ),
      background: Type.Optional(Type.Boolean()),
    }),
    async execute(
      _id,
      params: {
        items: string[];
        context?: string;
        agent?: string;
        background?: boolean;
        isolation?: string;
        mailbox?: boolean;
      },
      signal,
      _onUpdate,
      ctx,
    ) {
      const uiCtx = ctx as UiContext;
      const items = params.items.map((s) => s.trim()).filter(Boolean);
      if (items.length === 0) throw new Error("swarm_run requires at least one non-empty item.");
      if (params.agent && !defs.has(params.agent.toLowerCase())) {
        throw new Error(`Unknown agent type "${params.agent}". Available: ${[...defs.keys()].sort().join(", ")}`);
      }
      if (activeRun?.status === "running") {
        throw new Error(`Swarm ${activeRun.runId} is still running — wait or check swarm_status.`);
      }

      runCounter++;
      const run: SwarmRun = {
        runId: `s${runCounter}`,
        background: params.background === true,
        status: "running",
        startedAt: Date.now(),
        finishedAt: null,
        items: items.map((item, index) => ({
          index,
          item,
          agent: params.agent?.toLowerCase() ?? "?",
          status: "queued",
          turns: 0,
          tokens: 0,
          result: null,
          error: null,
        })),
      };
      runs.set(run.runId, run);
      activeRun = run;
      renderWidget(uiCtx);

      // Esc must reach the children. A background run outlives this tool call
      // by design, so its signal is not its cancel button.
      let stopListening: (() => void) | null = null;
      if (signal && !run.background) {
        const onAbort = () => cancelRun(run, "user-abort");
        if (signal.aborted) onAbort();
        else {
          signal.addEventListener("abort", onAbort, { once: true });
          stopListening = () => signal.removeEventListener("abort", onAbort);
        }
      }

      if (run.background) {
        void executeRun(uiCtx, run, params.context ?? "", params.agent, params.isolation === "worktree", params.mailbox === true)
          .then(() => {
            notify(uiCtx, `swarm ${run.runId} finished`, "info");
            // The report goes to the agent, not only to the screen — otherwise
            // asking again was its only way to find out.
            pi.sendMessage(
              {
                customType: DELIVERY_TYPE,
                content: deliveryMessage(run.runId, "swarm", buildReport(run)),
                display: true,
                details: { runId: run.runId, status: run.status, items: run.items.length },
              },
              { deliverAs: "followUp", triggerTurn: true },
            );
          })
          .catch(() => {
            // The whole chain, not just sendMessage: a /reload or session
            // switch while the run is in flight makes every captured pi/ctx
            // handle throw "ctx is stale" on next use, and an uncaught
            // rejection here takes the entire process down with it — the run's
            // work lost to a notification. Delivery is a convenience;
            // swarm_status still works.
          });
        return {
          content: [
            { type: "text", text: `Swarm ${run.runId} started (${items.length} items). Poll swarm_status runId="${run.runId}".` },
          ],
          details: { runId: run.runId },
        };
      }

      try {
        await executeRun(uiCtx, run, params.context ?? "", params.agent, params.isolation === "worktree", params.mailbox === true);
      } finally {
        if (stopListening) stopListening();
      }
      return {
        content: [{ type: "text", text: buildReport(run) }],
        details: { runId: run.runId },
      };
    },
  });

  pi.registerTool({
    name: "swarm_status",
    label: "Swarm status",
    promptSnippet: "Progress of a running swarm",
    description: "Progress of a swarm run (default: the latest). Returns the full report when finished.",
    parameters: Type.Object({
      runId: Type.Optional(Type.String()),
    }),
    async execute(_id, params: { runId?: string }) {
      const run = params.runId ? runs.get(params.runId.trim()) : activeRun ?? [...runs.values()].pop();
      if (!run) throw new Error("No swarm runs this session.");
      if (run.status === "running") {
        const pending = pendingResult({
          id: run.runId,
          kind: "running",
          startedAt: run.startedAt,
          now: Date.now(),
          collectWith: "swarm_status",
        });
        return { content: [{ type: "text", text: pending.text }], details: pending.details as never };
      }
      const text =
        run.status === "cancelled"
          ? "This run was cancelled before it finished. Below is what the items that did complete produced.\n" +
            buildReport(run)
          : run.status === "done"
            ? buildReport(run)
            : buildStatusLine(run);
      return { content: [{ type: "text", text }], details: { runId: run.runId, status: run.status } };
    },
  });

  // ── Lifecycle & command ──────────────────────────────────────────────

  /** Where the suite records which projects you approved, and for what. */
  function consentFile(): string {
    return join(getAgentDir(), "pify-project-consent.json");
  }

  /**
   * May this repository's own agent definitions load? Same question, same
   * store, and the same "agents" scope subagent records — one answer governs
   * the catalog across subagent, swarm and workflow, so approving or refusing
   * once means the same thing everywhere.
   */
  async function projectAgentsAllowed(ctx: ExtensionContext): Promise<boolean> {
    const dir = join(ctx.cwd, ".pi", "agents");
    if (!existsSync(dir)) return false;
    const file = consentFile();
    let raw: string | null = null;
    try {
      raw = readFileSync(file, "utf8");
    } catch {
      raw = null;
    }
    const store = parseConsent(raw);
    const verdict = decideConsent({
      projectTrusted: (ctx as unknown as { isProjectTrusted?: () => boolean }).isProjectTrusted?.() ?? false,
      remembered: readConsent(store, ctx.cwd, "agents"),
      hasUI: ctx.hasUI,
      envOverride: envConsent(process.env),
    });
    if (verdict !== "ask") return verdict === "allow";

    const approved = await withUiLock(() =>
      ctx.ui.confirm(
        "Load this project's agent definitions?",
        consentQuestion("its own agent definitions, which override the builtins of the same name", dir),
      ),
    );
    try {
      writeFileSync(file, `${JSON.stringify(writeConsent(store, ctx.cwd, "agents", approved), null, 2)}
`);
    } catch {
      // An unwritable consent file costs us the memory of the answer, not the answer.
    }
    return approved;
  }

  pi.on("session_start", async (_event, ctx) => {
    defs = loadDefs(ctx.cwd, getAgentDir(), await projectAgentsAllowed(ctx));
    runs.clear();
    activeRun = null;
    for (const entry of ctx.sessionManager.getBranch()) {
      const e = entry as { type?: string; customType?: string; data?: unknown };
      if (e.type !== "custom" || e.customType !== RUN_ENTRY || !isRecord(e.data)) continue;
      const run = e.data as unknown as SwarmRun;
      if (typeof run.runId === "string" && run.status !== "running") {
        runs.set(run.runId, run);
        const n = Number.parseInt(run.runId.slice(1), 10);
        if (Number.isFinite(n) && n > runCounter) runCounter = n;
      }
    }
    renderWidget(ctx);
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    // A run cannot outlive the session that owns it.
    for (const run of runs.values()) {
      if (run.status === "running") cancelRun(run, "session-switch");
    }
    if (ctx.hasUI) ctx.ui.setWidget("swarm", undefined);
  });

  pi.registerCommand("swarm", {
    description: "Show swarm runs and routing-capable agent types",
    handler: async (_args, ctx) => {
      if (!ctx.hasUI) return;
      const routed = [...defs.values()]
        .map((d) => {
          const rules = [
            ...d.matchPatterns.map((p) => `glob:${p}`),
            ...d.matchKeywords.map((k) => `kw:${k}`),
          ].join(", ");
          return `${d.name} (${d.source})${rules ? ` [${rules}]` : ""}`;
        })
        .join("\n");
      const runLines =
        [...runs.values()].map((r) => buildStatusLine(r)).join("\n") || "(no runs yet)";
      ctx.ui.notify(`Agent types\n${routed}\n\nRuns\n${runLines}`, "info");
    },
  });
}
