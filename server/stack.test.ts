import assert from "node:assert/strict";
import { test } from "node:test";

import type { GraphiteRepo, GraphitePr, TrackedBranch } from "./graphite-data.ts";
import { stackBranches } from "./stack.ts";

// main ← one ← two ← three, and side stacked on one.
function repo(overrides: { tips?: Record<string, string>; prs?: Record<string, GraphitePr> } = {}): GraphiteRepo {
  const tracked = (parent: string, parentRevision: string, submitted: TrackedBranch["submitted"] = null): TrackedBranch => ({
    parent,
    parentRevision,
    submitted,
  });
  return {
    trunk: "main",
    tips: new Map(Object.entries({ main: "m1", one: "o1", two: "t1", three: "h1", side: "s1", ...overrides.tips })),
    tracked: new Map([
      ["one", tracked("main", "m1", { headSha: "o1", versionNumber: 2 })],
      ["two", tracked("one", "o1", { headSha: "t0", versionNumber: null })],
      ["three", tracked("two", "t1")],
      ["side", tracked("one", "o1")],
      ["gone", tracked("one", "o1")],
    ]),
    prs: new Map(Object.entries(overrides.prs ?? {})),
    repository: { owner: "example", name: "repo" },
  };
}

const pr = (number: number, versions: string[], status: string | null = null): GraphitePr => ({
  number,
  title: `PR ${number}`,
  url: `https://app.graphite.com/github/pr/example/repo/${number}`,
  versions,
  status,
});

test("a stack lists the branches above the current one first, then its ancestors, without trunk", () => {
  const branches = stackBranches(repo(), "two");
  assert.deepEqual(
    branches?.map((branch) => [branch.branch, branch.parent, branch.current]),
    [
      ["three", "two", false],
      ["two", "one", true],
      ["one", "main", false],
    ],
  );
});

test("a stack holds every branch built on the current one, and no branch that is gone", () => {
  assert.deepEqual(stackBranches(repo(), "one")?.map((branch) => branch.branch), ["side", "three", "two", "one"]);
});

test("an untracked branch and trunk have no stack", () => {
  assert.equal(stackBranches(repo({ tips: { loose: "l1" } }), "loose"), null);
  assert.equal(stackBranches(repo(), "main"), null);
});

test("a branch needs a restack when its parent moved on from the commit it was stacked on", () => {
  const branches = stackBranches(repo({ tips: { main: "m2" } }), "two")!;
  assert.deepEqual(
    branches.map((branch) => [branch.branch, branch.localStatus]),
    [
      ["three", null],
      ["two", null],
      ["one", "needs restack"],
    ],
  );
});

test("submitted versions and remote state read as gt prints them", () => {
  const branches = stackBranches(
    repo({ prs: { one: pr(1, ["o0", "o1", "o2"], "QUEUED_TO_MERGE"), two: pr(2, ["t9", "t0"], "NEEDS_APPROVALS") } }),
    "two",
  )!;
  const one = branches.find((branch) => branch.branch === "one")!;
  const two = branches.find((branch) => branch.branch === "two")!;
  assert.deepEqual(
    [one.submittedVersion, one.remoteStatus, one.graphitePrStatus, one.prNumber],
    ["v2", "remote at v3, need get", "Queued to merge", 1],
  );
  // No stored version number: the submitted commit is the PR's second version.
  assert.deepEqual(
    [two.submittedVersion, two.remoteStatus, two.graphitePrStatus, two.graphiteUrl],
    ["v2", "local changes, need submit", "Needs more approvals", "https://app.graphite.com/github/pr/example/repo/2"],
  );
});

test("a parent cycle in damaged metadata ends the stack instead of looping", () => {
  const damaged = repo();
  (damaged.tracked as Map<string, TrackedBranch>).set("one", { parent: "three", parentRevision: "h1", submitted: null });
  assert.deepEqual(stackBranches(damaged, "two")?.map((branch) => branch.branch), ["side", "one", "three", "two"]);
});
