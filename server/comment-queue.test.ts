import assert from "node:assert/strict";
import { test } from "node:test";

import { deliverComment, stopCommentQueue } from "../client/comment-queue.ts";

const comment = (agentId: string, text: string) => ({
  workspaceId: "workspace",
  agentId,
  agentTitle: "Agent",
  what: "Comments",
  text,
  attachments: [{ type: "text" as const, mimeType: "text/plain" as const, text: "context" }],
});

function fakePaseo(agent: { send(text: string): Promise<void>; refresh(): Promise<unknown> }) {
  return { agents: { ref: () => agent } } as unknown as Parameters<typeof deliverComment>[0];
}

test("a second comment for an agent waits while the first is on its way", { timeout: 5_000 }, async () => {
  const sent: string[] = [];
  const arrivals: (() => void)[] = [];
  const paseo = fakePaseo({
    send(text) {
      sent.push(text);
      return new Promise<void>((resolve) => arrivals.push(resolve));
    },
    async refresh() {
      return { agent: { status: "running", archivedAt: null } };
    },
  });
  const first = deliverComment(paseo, comment("agent-1", "one"), "idle");
  const second = deliverComment(paseo, comment("agent-1", "two"), "idle");
  for (const arrive of arrivals) arrive();
  assert.equal(await first, "sent");
  assert.equal(await second, "queued");
  assert.deepEqual(sent, ["one"]);
  stopCommentQueue();
});

test("a comment dropped while its agent's status is on its way is not sent", { timeout: 5_000 }, async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const sent: string[] = [];
  let answer: (value: unknown) => void = () => {};
  const paseo = fakePaseo({
    async send(text) {
      sent.push(text);
    },
    refresh: () => new Promise((resolve) => (answer = resolve)),
  });
  assert.equal(await deliverComment(paseo, comment("agent-2", "later"), "running"), "queued");
  t.mock.timers.tick(2_000);
  stopCommentQueue();
  answer({ agent: { status: "idle", archivedAt: null } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(sent, []);
});
