import type { PluginClientContext } from "@getpaseo/plugin/client";
import { useSyncExternalStore } from "react";
import { z } from "zod";
import { commentsMessage, type WaitingComment, waitingCommentSchema } from "../shared/line-comment";
import { deliverComment } from "./comment-queue";
import { readAppStorage, writeAppStorage } from "./web";

type PaseoApi = PluginClientContext["paseo"];

// Comments wait here, per agent, until the user sends them. There is one list for the whole app:
// it lives on globalThis, so every plugin that shows the diff panel (this one, workbench) adds to
// the same list, and in localStorage on web and desktop, so it survives a reload.
const STORAGE_KEY = "paseo-graphite:waiting-comments";

interface Store {
  comments: readonly WaitingComment[];
  listeners: Set<() => void>;
}

declare const globalThis: { __paseoGraphiteWaitingComments?: Store };

function load(): readonly WaitingComment[] {
  try {
    const parsed = z.array(waitingCommentSchema).safeParse(JSON.parse(readAppStorage(STORAGE_KEY) ?? "[]"));
    return parsed.success ? parsed.data : [];
  } catch {
    return [];
  }
}

const store = (globalThis.__paseoGraphiteWaitingComments ??= { comments: load(), listeners: new Set() });

function save(comments: readonly WaitingComment[]): void {
  store.comments = comments;
  writeAppStorage(STORAGE_KEY, JSON.stringify(comments));
  for (const listener of store.listeners) listener();
}

export function addWaitingComment(comment: Omit<WaitingComment, "id">): void {
  const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  save([...store.comments, { ...comment, id }]);
}

export function removeWaitingComments(ids: readonly string[]): void {
  const removed = new Set(ids);
  save(store.comments.filter((comment) => !removed.has(comment.id)));
}

export function waitingComments(): readonly WaitingComment[] {
  return store.comments;
}

export function subscribeWaitingComments(listener: () => void): () => void {
  store.listeners.add(listener);
  return () => store.listeners.delete(listener);
}

export function useWaitingComments(): readonly WaitingComment[] {
  return useSyncExternalStore(subscribeWaitingComments, () => store.comments);
}

/** Sends every comment waiting for the agent as one message, or queues it while the agent works. */
export async function sendWaitingComments(
  paseo: PaseoApi,
  agentId: string,
): Promise<{ outcome: "sent" | "queued"; count: number; agentTitle: string }> {
  const comments = store.comments.filter((comment) => comment.agentId === agentId);
  if (comments.length === 0) throw new Error("No comments are waiting for this agent.");
  const snapshot = await paseo.agents.ref(agentId).refresh();
  if (!snapshot) throw new Error("This agent is gone.");
  const agentTitle = snapshot.agent.title?.trim() || "the agent";
  const outcome = await deliverComment(
    paseo,
    {
      workspaceId: comments[0].workspaceId,
      agentId,
      agentTitle,
      what: "Comments",
      text: commentsMessage(comments),
      attachments: comments.map((comment) => ({
        type: "text",
        mimeType: "text/plain",
        title: comment.title,
        text: comment.context,
      })),
    },
    snapshot.agent.status,
  );
  removeWaitingComments(comments.map((comment) => comment.id));
  return { outcome, count: comments.length, agentTitle };
}
