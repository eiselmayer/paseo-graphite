import assert from "node:assert/strict";
import { test } from "node:test";
import type { PaseoApi } from "@getpaseo/client";

import {
  attention,
  inspectWorkspaceStack,
  type GithubPr,
  type LocalBranch,
} from "./inspect.ts";

const localBranch: LocalBranch = {
  branch: "feature",
  current: true,
  localStatus: "needs restack",
  parent: "main",
  submittedVersion: "v3",
  remoteStatus: "remote at v5, need get",
  graphitePrStatus: "Ready to merge",
  graphiteUrl: "https://app.graphite.com/github/pr/example/repo/42",
  prNumber: 42,
  graphiteTitle: "Ready change",
  knownHeads: [],
};

const readyPr: GithubPr = {
  number: 42,
  title: "Ready change",
  url: "https://github.com/example/repo/pull/42",
  state: "OPEN",
  isDraft: false,
  author: "author",
  viewerIsAuthor: true,
  baseBranch: "main",
  headBranch: "feature",
  mergeable: "MERGEABLE",
  mergeStateStatus: "CLEAN",
  reviewDecision: "APPROVED",
  reviewRequests: [],
  totalThreads: 5,
  resolvedThreads: 5,
  unresolvedThreads: 0,
  checks: {
    total: 5,
    passed: 5,
    pending: 0,
    failed: 0,
    requiredTotal: 5,
    requiredPassed: 5,
    requiredPending: 0,
    requiredFailed: 0,
    failingNames: [],
    requiredFailingNames: [],
  },
  updatedAt: "2026-09-23T00:00:00Z",
};

test("remote ready status wins over stale local restack metadata", () => {
  assert.deepEqual(attention(localBranch, readyPr), {
    level: "ready",
    reasons: ["ready-to-merge"],
    label: "Ready to merge",
    command: null,
  });
});

test("merge queue status wins over stale local restack metadata", () => {
  assert.deepEqual(
    attention({ ...localBranch, graphitePrStatus: "Queued to merge..." }, readyPr),
    {
      level: "waiting",
      reasons: ["merge-queued"],
      label: "Queued to merge",
      command: null,
    },
  );
});

test("remote blockers still win over Graphite ready status", () => {
  assert.deepEqual(
    attention(localBranch, { ...readyPr, mergeable: "CONFLICTING" }),
    {
      level: "action",
      reasons: ["merge-conflict"],
      label: "Resolve merge conflict",
      command: null,
    },
  );
});

test("concurrent cache misses share one stack inspection", async () => {
  let refreshes = 0;
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const paseo = {
    workspaces: {
      ref: () => ({
        refresh: async () => {
          refreshes += 1;
          await gate;
          return {
            id: "workspace-concurrent",
            name: "Concurrent",
            title: null,
            workspaceDirectory: null,
          };
        },
      }),
    },
  } as unknown as PaseoApi;

  const requests = Array.from({ length: 20 }, () =>
    inspectWorkspaceStack(paseo, "workspace-concurrent", true),
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(refreshes, 1);
  release();
  const results = await Promise.all(requests);
  assert.equal(results.length, 20);
  assert.ok(results.every((result) => result.workspaceId === "workspace-concurrent"));
});
