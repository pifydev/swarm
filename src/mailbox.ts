/**
 * Run mailbox (v0.3, gjczone's shared inbox/outbox). Swarm agents work the
 * same repository at the same time and cannot see each other, so two of them
 * happily fix the same shared helper in two different ways. A mailbox is the
 * cheapest fix: one append-only log per run, readable by every sibling.
 *
 * Deliberately not a chat. Agents post facts they discovered that change
 * someone else's work, and read what others posted; there is no addressing,
 * no waiting, and no reply. Anything richer needs steering, which is a
 * different feature.
 */

import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface MailMessage {
  seq: number;
  from: string;
  text: string;
  timestamp: number;
}

export const MAX_MESSAGE_CHARS = 1200;
export const MAX_INBOX_MESSAGES = 30;

/**
 * One directory per run under the agent dir. Run ids are generated locally,
 * but this builds a filesystem path, so it stays a single flat segment: no
 * separators and no `..` can survive the sanitizer.
 */
export function mailboxDir(agentDir: string, runId: string): string {
  const safe =
    runId
      .replace(/[^A-Za-z0-9._-]/g, "-")
      .replace(/\.{2,}/g, "-")
      .replace(/^[.-]+/, "")
      .slice(0, 80) || "run";
  return join(agentDir, "swarm-mailbox", safe);
}

function logPath(dir: string): string {
  return join(dir, "messages.jsonl");
}

export function readMailbox(dir: string): MailMessage[] {
  let raw: string;
  try {
    raw = readFileSync(logPath(dir), "utf8");
  } catch {
    return [];
  }
  const messages: MailMessage[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line) as MailMessage;
      if (typeof parsed.seq === "number" && typeof parsed.from === "string" && typeof parsed.text === "string") {
        messages.push(parsed);
      }
    } catch {
      // a torn line from a concurrent append — skip it, never fail the read
    }
  }
  return messages;
}

/**
 * Append one message. Concurrency is handled by the filesystem: a single
 * append of one line is atomic enough for this, and a torn read is skipped
 * rather than treated as an error.
 */
export function postMessage(dir: string, from: string, text: string, now: number): MailMessage {
  const trimmed = text.trim().slice(0, MAX_MESSAGE_CHARS);
  if (!trimmed) throw new Error("A mailbox message cannot be empty.");
  mkdirSync(dir, { recursive: true });
  const seq = readMailbox(dir).length + 1;
  const message: MailMessage = { seq, from, text: trimmed, timestamp: now };
  appendFileSync(logPath(dir), `${JSON.stringify(message)}\n`);
  return message;
}

export interface InboxRead {
  messages: MailMessage[];
  /** Pass back as `sinceSeq` to read only what arrives after this. */
  nextSeq: number;
}

/** Messages from OTHER agents after `sinceSeq`. Own posts are never echoed. */
export function readInbox(dir: string, reader: string, sinceSeq = 0): InboxRead {
  const all = readMailbox(dir);
  const highest = all.reduce((max, m) => Math.max(max, m.seq), 0);
  const messages = all
    .filter((m) => m.seq > sinceSeq && m.from !== reader)
    .slice(-MAX_INBOX_MESSAGES);
  return { messages, nextSeq: highest };
}

export function formatInbox(read: InboxRead): string {
  if (read.messages.length === 0) return "No new messages from the other agents.";
  return read.messages.map((m) => `[#${m.seq} from ${m.from}] ${m.text}`).join("\n");
}

/** The instruction children get, naming their own label so posts are attributable. */
export function mailboxPrompt(label: string): string {
  return [
    `You are agent "${label}" in a parallel swarm working the same repository.`,
    "Use swarm_post to tell the other agents something that changes their work:",
    "a shared file you modified, a convention you had to pick, a blocker they will hit too.",
    "Use swarm_inbox before you start and again before you finish, so you do not redo",
    "or undo someone else's work. Do not post progress narration — only facts others need.",
  ].join(" ");
}
