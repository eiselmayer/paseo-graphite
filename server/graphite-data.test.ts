import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import { readGraphiteRepo, readHead } from "./graphite-data.ts";
import { findBinary } from "./process.ts";
import { stackBranches } from "./stack.ts";

// A repository as gt leaves it: main ← one ← two, with two checked out in a second worktree.
const root = await mkdtemp(join(tmpdir(), "paseo-graphite-repo-"));
after(() => rm(root, { recursive: true, force: true }));
const repo = join(root, "repo");
const worktree = join(root, "worktree");
const run = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" },
  }).trim();
execFileSync("git", ["init", "--quiet", "-b", "main", repo]);
const commit = (message: string) => {
  run(repo, "commit", "--quiet", "--allow-empty", "-m", message);
  return run(repo, "rev-parse", "HEAD");
};
const main = commit("main");
run(repo, "checkout", "--quiet", "-b", "one");
const one = commit("one");
run(repo, "checkout", "--quiet", "-b", "two");
const two = commit("two");
run(repo, "checkout", "--quiet", "main");
// A tag of the same name must not hide the branch.
run(repo, "tag", "two");
run(repo, "remote", "add", "origin", "git@github.com:example/repo.git");
run(repo, "worktree", "add", "--quiet", worktree, "two");

// git answers with real paths, and the temp directory sits behind a symlink on macOS.
const gitDir = join(await realpath(repo), ".git");
await writeFile(join(gitDir, ".graphite_repo_config"), JSON.stringify({ trunks: [{ name: "main" }] }));
await writeFile(
  join(gitDir, ".graphite_pr_info"),
  JSON.stringify({
    prInfos: [{ prNumber: 5, title: "One", headRefName: "one", url: "https://app.graphite.com/github/pr/example/repo/5", versions: [{ headSha: one }] }],
    mergeabilityStatuses: [{ prNumber: 5, mergeabilityStatus: "NEEDS_APPROVALS" }],
  }),
);
const database = new DatabaseSync(join(gitDir, ".graphite_metadata.db"));
database.exec(`create table branch_metadata (branch_name text primary key, parent_branch_name text, parent_branch_revision text,
  last_submitted_version text, state text, children text, branch_revision text, validation_result text, parent_head_revision text)`);
const insert = database.prepare(
  "insert into branch_metadata (branch_name, parent_branch_name, parent_branch_revision, last_submitted_version, validation_result) values (?, ?, ?, ?, ?)",
);
insert.run("main", null, null, null, "TRUNK");
insert.run("one", "main", main, JSON.stringify({ headSha: one, baseSha: main, versionNumber: 1 }), "VALID");
insert.run("two", "one", one, null, "VALID");
insert.run("orphan", "deleted", "abc", null, "BAD_PARENT_NAME");
database.close();
const git = (await findBinary("git"))!;

test("a linked worktree's branch and the git directory its repository shares", async () => {
  const head = await readHead(git, worktree);
  assert.equal(head?.branch, "two");
  assert.equal(head?.commonDir, gitDir);
  assert.equal((await readHead(git, repo))?.branch, "main");
  assert.equal(await readHead(git, root), null);
});

test("Graphite's files read as gt shows them, for every worktree at once", async () => {
  const data = (await readGraphiteRepo(git, gitDir, worktree, true))!;
  assert.equal(data.trunk, "main");
  assert.deepEqual(data.repository, { owner: "example", name: "repo" });
  assert.equal(data.tips.get("two"), two);
  assert.deepEqual([...data.tracked.keys()].sort(), ["one", "two"]);
  assert.deepEqual(
    stackBranches(data, "two")?.map((branch) => [branch.branch, branch.prNumber, branch.graphitePrStatus, branch.submittedVersion, branch.localStatus]),
    [
      ["two", null, null, null, null],
      ["one", 5, "Needs more approvals", "v1", null],
    ],
  );
});

test("a read that fails for a moment is covered by the last good one; a repository never read has none", async () => {
  await readGraphiteRepo(git, gitDir, worktree, true);
  await writeFile(join(gitDir, ".graphite_repo_config"), "{ half written");
  try {
    assert.equal((await readGraphiteRepo(git, gitDir, worktree, true))?.trunk, "main");
  } finally {
    await writeFile(join(gitDir, ".graphite_repo_config"), JSON.stringify({ trunks: [{ name: "main" }] }));
  }
  assert.equal(await readGraphiteRepo(git, join(root, "elsewhere"), worktree, true), null);
});
