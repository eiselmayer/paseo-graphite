import type { PluginClientContext } from "@getpaseo/plugin/client";
import { useSyncExternalStore } from "react";

type PaseoApi = PluginClientContext["paseo"];
type SendOptions = NonNullable<Parameters<ReturnType<PaseoApi["agents"]["ref"]>["send"]>[1]>;
export type CommentAttachment = NonNullable<SendOptions["attachments"]>[number];

export interface Comment {
  workspaceId: string;
  agentId: string;
  agentTitle: string;
  text: string;
  attachments: CommentAttachment[];
}

export interface QueuedComment extends Comment {
  id: number;
  paseo: PaseoApi;
}

// A message to a working agent replaces its turn, so comments for it wait until it is idle,
// as messages typed into Paseo's composer do. Waiting comments poll their agent: the queue
// then needs nothing from the plugin entry, so the diff panel works inside other plugins too.
const BUSY_STATUSES: ReadonlySet<string> = new Set(["initializing", "running"]);
const POLL_MS = 2_000;
// Right after a send the agent can still read idle; give its turn time to show up.
const SETTLE_MS = 3_000;

let queue: readonly QueuedComment[] = [];
let nextId = 1;
// Agents with a comment on its way; claimed before the round trip, so a second one waits.
const inFlight = new Set<string>();
const settlingUntil = new Map<string, number>();
const listeners = new Set<() => void>();
let poll: ReturnType<typeof setInterval> | null = null;
let polling = false;

export function isBusy(status: string | null | undefined): boolean {
  return status != null && BUSY_STATUSES.has(status);
}

function setQueue(next: readonly QueuedComment[]): void {
  queue = next;
  if (queue.length > 0 && !poll) poll = setInterval(() => void pollQueued(), POLL_MS);
  if (queue.length === 0 && poll) {
    clearInterval(poll);
    poll = null;
  }
  for (const listener of listeners) listener();
}

async function send(paseo: PaseoApi, comment: Comment): Promise<void> {
  inFlight.add(comment.agentId);
  try {
    await paseo.agents.ref(comment.agentId).send(comment.text, { attachments: comment.attachments });
    settlingUntil.set(comment.agentId, Date.now() + SETTLE_MS);
  } finally {
    inFlight.delete(comment.agentId);
  }
}

// The status shown can lag a send by a moment, so a fresh send or an earlier queued comment also waits.
function mustWait(agentId: string, status: string | null): boolean {
  return (
    isBusy(status) ||
    inFlight.has(agentId) ||
    (settlingUntil.get(agentId) ?? 0) > Date.now() ||
    queue.some((item) => item.agentId === agentId)
  );
}

export async function deliverComment(
  paseo: PaseoApi,
  comment: Comment,
  status: string | null,
): Promise<"sent" | "queued"> {
  if (mustWait(comment.agentId, status)) {
    setQueue([...queue, { ...comment, id: nextId++, paseo }]);
    return "queued";
  }
  await send(paseo, comment);
  return "sent";
}

// Sends at most one waiting comment per agent per round, oldest first.
async function pollQueued(): Promise<void> {
  if (polling) return;
  polling = true;
  try {
    const firstPerAgent = queue.filter((item, index) => queue.findIndex((other) => other.agentId === item.agentId) === index);
    for (const item of firstPerAgent) {
      try {
        const result = await item.paseo.agents.ref(item.agentId).refresh();
        // Canceled, or the queue stopped, while the status was on its way.
        if (!queue.some((other) => other.id === item.id)) continue;
        if (!result || result.agent.archivedAt) {
          setQueue(queue.filter((other) => other.agentId !== item.agentId));
          continue;
        }
        if (isBusy(result.agent.status)) {
          settlingUntil.delete(item.agentId);
          continue;
        }
        if (inFlight.has(item.agentId) || (settlingUntil.get(item.agentId) ?? 0) > Date.now()) continue;
        await send(item.paseo, item);
        setQueue(queue.filter((other) => other.id !== item.id));
      } catch (error) {
        // Stays queued for the next round.
        console.error("[paseo-graphite] could not deliver a queued comment", error);
      }
    }
  } finally {
    polling = false;
  }
}

export function cancelQueued(id: number): void {
  setQueue(queue.filter((item) => item.id !== id));
}

export function stopCommentQueue(): void {
  setQueue([]);
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useCommentQueue(): readonly QueuedComment[] {
  return useSyncExternalStore(subscribe, () => queue);
}
