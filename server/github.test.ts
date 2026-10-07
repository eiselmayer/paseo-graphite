import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import type { PrLookup } from "./github.ts";

const directory = await mkdtemp(join(tmpdir(), "paseo-graphite-test-"));
process.env.PASEO_GRAPHITE_CACHE_DIR = join(directory, "cache");
after(() => rm(directory, { recursive: true, force: true }));
const github: typeof import("./github.ts") = await import("./github.ts");
const { batchQuery, loadPrs, parseBatch } = github;

// A stand-in for gh that answers each lookup with a PR at commit "head-<branch>", as set in
// FAKE_GH, and counts its calls.
const calls = join(directory, "calls");
const gh = join(directory, "gh");
await writeFile(
  gh,
  `#!/usr/bin/env node
const { appendFileSync } = require("node:fs");
const config = JSON.parse(process.env.FAKE_GH || "{}");
appendFileSync(${JSON.stringify(calls)}, "call\\n");
setTimeout(() => {
  if (config.fail) process.exit(1);
  const repository = {};
  const errors = [];
  for (const arg of process.argv) {
    const lookup = /^([nh])(\\d+)=(.*)$/s.exec(arg);
    if (!lookup) continue;
    const [, kind, index, value] = lookup;
    const alias = "b" + index;
    if ((config.failAliases || []).includes(alias)) {
      repository[alias] = null;
      errors.push({ type: "SERVICE_UNAVAILABLE", path: ["repository", alias, "commits"] });
      continue;
    }
    const pr = {
      number: kind === "n" ? Number(value) : 100 + Number(index),
      state: config.state || "OPEN",
      headRefName: value,
      headRefOid: config.headOid || "head-" + value,
      isCrossRepository: false,
    };
    repository[alias] = kind === "n" ? pr : { nodes: [pr] };
  }
  process.stdout.write(JSON.stringify({ data: { viewer: { login: "me" }, repository }, errors }));
  process.exit(errors.length ? 1 : 0);
}, config.delayMs || 0);
`,
);
await chmod(gh, 0o755);

function fakeGh(config: object = {}) {
  process.env.FAKE_GH = JSON.stringify(config);
}

async function callCount(): Promise<number> {
  return (await readFile(calls, "utf8").catch(() => "")).split("\n").filter(Boolean).length;
}

let repositories = 0;
function freshRepository() {
  repositories += 1;
  return { owner: "example", name: `repo-${repositories}` };
}

const lookups: PrLookup[] = [
  { branch: "one", number: 11 },
  { branch: "two", number: null, heads: ["head-two"] },
];

test("one query loads many PRs, with branch names passed as variables", () => {
  const { query, variables } = batchQuery([...lookups, { branch: 'quote"d', number: null, heads: [] }]);
  assert.match(query, /b0: pullRequest\(number:\$n0\)/);
  assert.match(query, /b1: pullRequests\(headRefName:\$h1,first:3/);
  assert.ok(!query.includes("quote"));
  assert.deepEqual(variables, [
    ["n0", 11],
    ["h1", "two"],
    ["h2", 'quote"d'],
  ]);
});

test("a PR found by branch name counts only at one of the branch's commits, and not from a fork", () => {
  const node = (number: number, extra: object = {}) => ({ number, state: "OPEN", author: { login: "me" }, ...extra });
  const answer = (nodes: object[]) =>
    parseBatch({ data: { viewer: { login: "me" }, repository: { b0: node(11), b1: { nodes } } } }, lookups);
  const parsed = answer([node(12, { headRefOid: "someone-elses" }), node(13, { headRefOid: "head-two" })]);
  assert.equal(parsed?.viewer, "me");
  assert.equal(parsed?.prs.get("one")?.number, 11);
  assert.equal(parsed?.prs.get("one")?.viewerIsAuthor, true);
  assert.equal(parsed?.prs.get("two")?.number, 13);
  assert.equal(answer([node(12, { headRefOid: "someone-elses" })])?.prs.get("two"), null);
  assert.equal(answer([node(13, { headRefOid: "head-two", isCrossRepository: true })])?.prs.get("two"), null);
});

test("merge when ready is on with Graphite's merge label or GitHub's auto-merge", () => {
  const mergeWhenReady = (extra: object) =>
    github.parsePullRequest({ number: 1, state: "OPEN", ...extra }, "me").mergeWhenReady;
  assert.equal(mergeWhenReady({ labels: { nodes: [{ name: "merge-queue" }] } }), true);
  assert.equal(mergeWhenReady({ autoMergeRequest: { enabledAt: "2026-10-07T22:10:29Z" } }), true);
  assert.equal(mergeWhenReady({ labels: { nodes: [{ name: "bug" }] }, autoMergeRequest: null }), false);
  assert.equal(mergeWhenReady({}), false);
});

test("a failed part of an answer is left out, an unknown PR number is not, and a failed answer is null", () => {
  const parsed = parseBatch(
    {
      data: { viewer: null, repository: { b0: null, b1: null } },
      errors: [
        { type: "NOT_FOUND", path: ["repository", "b0"] },
        { type: "SERVICE_UNAVAILABLE", path: ["repository", "b1", "commits"] },
      ],
    },
    lookups,
  );
  assert.deepEqual([...(parsed?.prs ?? [])], [["one", null]]);
  assert.equal(parseBatch({ errors: [{ message: "Bad credentials" }] }, lookups), null);
});

test("worktrees asking for the same branches at once share one load", async () => {
  fakeGh();
  const repository = freshRepository();
  const before = await callCount();
  const [first, second] = await Promise.all([
    loadPrs(gh, directory, repository, lookups),
    loadPrs(gh, directory, repository, [lookups[0]]),
  ]);
  assert.equal((await callCount()) - before, 1);
  assert.equal(first.prs.get("one")?.number, 11);
  assert.equal(first.prs.get("two")?.number, 101);
  assert.equal(second.prs.get("one")?.number, 11);
  assert.equal(first.failed, 0);
});

test("status is reused for a minute, then shown while a new copy loads, and a manual refresh waits for one", async (t) => {
  fakeGh();
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  const repository = freshRepository();
  await loadPrs(gh, directory, repository, lookups);
  const before = await callCount();
  await loadPrs(gh, directory, repository, lookups);
  assert.equal(await callCount(), before);

  t.mock.timers.tick(61_000);
  const stale = await loadPrs(gh, directory, repository, lookups);
  assert.equal(stale.prs.get("one")?.number, 11);
  for (let wait = 0; (await callCount()) === before && wait < 50; wait++) await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal((await callCount()) - before, 1);

  t.mock.timers.tick(6_000);
  await new Promise((resolve) => setTimeout(resolve, 300));
  await loadPrs(gh, directory, repository, lookups, true);
  assert.equal((await callCount()) - before, 2);
});

test("a failing GitHub is asked once, then left alone until a manual refresh", async () => {
  fakeGh({ fail: true, delayMs: 200 });
  const repository = freshRepository();
  const before = await callCount();
  const results = await Promise.all(Array.from({ length: 5 }, () => loadPrs(gh, directory, repository, lookups)));
  assert.equal((await callCount()) - before, 1);
  assert.ok(results.every((result) => result.failed === 1 && result.prs.size === 0));

  await loadPrs(gh, directory, repository, lookups);
  assert.equal((await callCount()) - before, 1);
  fakeGh();
  const forced = await loadPrs(gh, directory, repository, lookups, true);
  assert.equal((await callCount()) - before, 2);
  assert.equal(forced.failed, 0);
});

test("a branch whose part of the answer failed keeps its earlier status and is reported", async (t) => {
  fakeGh();
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  const repository = freshRepository();
  await loadPrs(gh, directory, repository, lookups);
  fakeGh({ failAliases: ["b0"] });
  t.mock.timers.tick(11 * 60_000);
  const result = await loadPrs(gh, directory, repository, lookups);
  assert.equal(result.prs.get("two")?.number, 101);
  assert.equal(result.prs.has("one"), false);
  assert.equal(result.failed, 1);
});

test("a merged PR is not loaded again for half an hour", async (t) => {
  fakeGh({ state: "MERGED" });
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  const repository = freshRepository();
  await loadPrs(gh, directory, repository, [lookups[0]]);
  const before = await callCount();
  t.mock.timers.tick(20 * 60_000);
  const result = await loadPrs(gh, directory, repository, [lookups[0]]);
  assert.equal(result.prs.get("one")?.state, "MERGED");
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(await callCount(), before);
});

// A second copy of the module has its own memory, like the workbench's process.
async function otherProcess(): Promise<typeof import("./github.ts")> {
  return import(new URL(`./github.ts?process=${Math.random()}`, import.meta.url).href);
}

test("the other plugin process reads the status this one loaded", async () => {
  fakeGh();
  const repository = freshRepository();
  await loadPrs(gh, directory, repository, lookups);
  const before = await callCount();
  const result = await (await otherProcess()).loadPrs(gh, directory, repository, lookups);
  assert.equal(await callCount(), before);
  assert.equal(result.prs.get("one")?.number, 11);
  assert.equal(result.viewer, "me");
});

test("two processes loading at once make one query: the second waits for the first one's file", async () => {
  fakeGh({ delayMs: 500 });
  const repository = freshRepository();
  const other = await otherProcess();
  const before = await callCount();
  const [mine, theirs] = await Promise.all([
    loadPrs(gh, directory, repository, lookups),
    other.loadPrs(gh, directory, repository, lookups),
  ]);
  assert.equal((await callCount()) - before, 1);
  assert.equal(mine.prs.get("one")?.number, 11);
  assert.equal(theirs.prs.get("one")?.number, 11);
});
