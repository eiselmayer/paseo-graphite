import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { runCommand } from "./process";

/** A branch Graphite tracks, from its metadata database. */
export interface TrackedBranch {
  parent: string;
  // The parent commit this branch was last stacked on. When the parent moves on, it needs a restack.
  parentRevision: string | null;
  submitted: { headSha: string; versionNumber: number | null } | null;
}

/** Graphite's record of an open PR: what `gt info` prints on its PR line. */
export interface GraphitePr {
  number: number;
  title: string;
  url: string;
  // Head commit of each submitted version, oldest first.
  versions: string[];
  // Graphite's merge status, like QUEUED_TO_MERGE.
  status: string | null;
}

export interface GraphiteRepo {
  trunk: string;
  // Commit of every local branch.
  tips: ReadonlyMap<string, string>;
  tracked: ReadonlyMap<string, TrackedBranch>;
  // By head branch.
  prs: ReadonlyMap<string, GraphitePr>;
  repository: { owner: string; name: string } | null;
}

type JsonObject = Record<string, unknown>;

const REPO_TTL_MS = 3_000;
// A read can fail for a moment, as while gt writes its database. The last good read stands in
// that long, rather than every worktree falling back to gt at once.
const LAST_GOOD_MS = 60_000;
const ORIGIN_TTL_MS = 5 * 60_000;
const repos = new Map<string, { readAt: number; value: Promise<GraphiteRepo | null> }>();
const lastGood = new Map<string, { readAt: number; repo: GraphiteRepo }>();
const origins = new Map<string, { readAt: number; value: Promise<GraphiteRepo["repository"]> }>();
// Per workspace directory: the worktree's own git directory, holding its HEAD, and the one all
// of the repository's worktrees share. Neither changes, so git is asked once.
const gitDirs = new Map<string, { gitDir: string; commonDir: string }>();

/** The checked-out branch, null when HEAD is detached, and the shared git directory. Null outside a repository. */
export async function readHead(
  git: string,
  directory: string,
): Promise<{ branch: string | null; commonDir: string } | null> {
  let dirs = gitDirs.get(directory);
  if (!dirs) {
    const result = await runCommand(git, ["rev-parse", "--path-format=absolute", "--git-dir", "--git-common-dir"], {
      cwd: directory,
      timeoutMs: 8_000,
    });
    const [gitDir, commonDir] = result.stdout.trim().split("\n");
    if (!result.ok || !gitDir || !commonDir) return null;
    dirs = { gitDir, commonDir };
    gitDirs.set(directory, dirs);
  }
  let head: string;
  try {
    head = (await readFile(join(dirs.gitDir, "HEAD"), "utf8")).trim();
  } catch {
    gitDirs.delete(directory);
    return null;
  }
  const branch = /^ref: refs\/heads\/(.+)$/.exec(head)?.[1] ?? null;
  // Repositories on the reftable backend keep a placeholder there; ask git instead.
  if (branch !== ".invalid") return { branch, commonDir: dirs.commonDir };
  const ref = await runCommand(git, ["symbolic-ref", "--quiet", "HEAD"], { cwd: directory, timeoutMs: 8_000 });
  const name = ref.stdout.trim();
  return { branch: ref.ok && name.startsWith("refs/heads/") ? name.slice("refs/heads/".length) : null, commonDir: dirs.commonDir };
}

/**
 * Everything `gt log` and `gt info` show, read straight from the files Graphite keeps in the
 * repository's shared git directory: one read serves every worktree, where each gt command
 * takes half a second. Null when the files are missing or not in the expected format, as with
 * older gt versions; read through gt then.
 */
export function readGraphiteRepo(
  git: string,
  commonDir: string,
  directory: string,
  fresh = false,
): Promise<GraphiteRepo | null> {
  const cached = repos.get(commonDir);
  if (!fresh && cached && Date.now() - cached.readAt < REPO_TTL_MS) return cached.value;
  const value = readRepo(git, commonDir, directory).catch(() => null);
  repos.set(commonDir, { readAt: Date.now(), value });
  return value;
}

export function forgetGraphiteRepo(commonDir: string): void {
  repos.delete(commonDir);
}

async function readRepo(git: string, commonDir: string, directory: string): Promise<GraphiteRepo | null> {
  const [config, tracked, prs, refs, repository] = await Promise.all([
    readJson(join(commonDir, ".graphite_repo_config")),
    readTracked(join(commonDir, ".graphite_metadata.db")),
    readJson(join(commonDir, ".graphite_pr_info")),
    // lstrip, not short: short turns a branch named like a tag into "heads/name".
    runCommand(git, ["for-each-ref", "--format=%(refname:lstrip=2)%00%(objectname)", "refs/heads"], {
      cwd: directory,
      timeoutMs: 8_000,
    }),
    readOrigin(git, commonDir, directory),
  ]);
  const previous = lastGood.get(commonDir);
  const recent = previous && Date.now() - previous.readAt < LAST_GOOD_MS ? previous.repo : null;
  const trunk = trunkName(config);
  if (!trunk || !tracked || !refs.ok) return recent;
  const tips = new Map<string, string>();
  for (const line of refs.stdout.split("\n")) {
    const [branch, commit] = line.split("\0");
    if (branch && commit) tips.set(branch, commit);
  }
  // gt rewrites its PR info now and then; a read in between finds no PRs.
  const repo = { trunk, tips, tracked, prs: prs === null && recent ? recent.prs : parsePrInfo(prs), repository };
  lastGood.set(commonDir, { readAt: Date.now(), repo });
  return repo;
}

function readOrigin(git: string, commonDir: string, directory: string): Promise<GraphiteRepo["repository"]> {
  const cached = origins.get(commonDir);
  if (cached && Date.now() - cached.readAt < ORIGIN_TTL_MS) return cached.value;
  const value = runCommand(git, ["remote", "get-url", "origin"], { cwd: directory, timeoutMs: 8_000 }).then((origin) =>
    origin.ok ? parseOrigin(origin.stdout) : null,
  );
  origins.set(commonDir, { readAt: Date.now(), value });
  return value;
}

async function readJson(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return null;
  }
}

function object(value: unknown): JsonObject | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as JsonObject) : null;
}

function trunkName(config: unknown): string | null {
  const value = object(config);
  const trunks = Array.isArray(value?.trunks) ? value.trunks : [];
  const name = object(trunks[0])?.name ?? value?.trunk;
  return typeof name === "string" && name ? name : null;
}

async function readTracked(path: string): Promise<Map<string, TrackedBranch> | null> {
  const { DatabaseSync } = await import("node:sqlite");
  let database: InstanceType<typeof DatabaseSync>;
  try {
    database = new DatabaseSync(path, { readOnly: true });
  } catch {
    return null;
  }
  try {
    // gt may be writing. The wait blocks this process, so it is short; a failed read is retried.
    database.exec("pragma busy_timeout = 200");
    const rows = database
      .prepare(
        "select branch_name, parent_branch_name, parent_branch_revision, last_submitted_version, validation_result from branch_metadata",
      )
      .all();
    const tracked = new Map<string, TrackedBranch>();
    for (const row of rows) {
      const { branch_name: branch, parent_branch_name: parent, parent_branch_revision: revision } = row;
      if (typeof branch !== "string" || typeof parent !== "string" || !parent) continue;
      // gt no longer counts these as tracked, as when the parent branch was deleted.
      if (typeof row.validation_result === "string" && row.validation_result.startsWith("BAD_")) continue;
      tracked.set(branch, {
        parent,
        parentRevision: typeof revision === "string" ? revision : null,
        submitted: parseSubmitted(row.last_submitted_version),
      });
    }
    return tracked;
  } catch {
    return null;
  } finally {
    database.close();
  }
}

function parseSubmitted(value: unknown): TrackedBranch["submitted"] {
  if (typeof value !== "string") return null;
  try {
    const submitted = object(JSON.parse(value));
    if (typeof submitted?.headSha !== "string") return null;
    const versionNumber = submitted.versionNumber;
    return {
      headSha: submitted.headSha,
      versionNumber: typeof versionNumber === "number" && Number.isInteger(versionNumber) ? versionNumber : null,
    };
  } catch {
    return null;
  }
}

function parsePrInfo(value: unknown): Map<string, GraphitePr> {
  const info = object(value);
  const statuses = new Map<number, string>();
  for (const entry of Array.isArray(info?.mergeabilityStatuses) ? info.mergeabilityStatuses : []) {
    const status = object(entry);
    if (typeof status?.prNumber === "number" && typeof status.mergeabilityStatus === "string") {
      statuses.set(status.prNumber, status.mergeabilityStatus);
    }
  }
  const prs = new Map<string, GraphitePr>();
  for (const entry of Array.isArray(info?.prInfos) ? info.prInfos : []) {
    const pr = object(entry);
    const number = pr?.prNumber;
    if (typeof number !== "number" || typeof pr?.headRefName !== "string") continue;
    const versions = (Array.isArray(pr.versions) ? pr.versions : [])
      .map((version) => object(version)?.headSha)
      .filter((sha): sha is string => typeof sha === "string");
    prs.set(pr.headRefName, {
      number,
      title: typeof pr.title === "string" ? pr.title : "",
      url: typeof pr.url === "string" ? pr.url : "",
      versions,
      status: statuses.get(number) ?? null,
    });
  }
  return prs;
}

export function parseOrigin(remote: string): { owner: string; name: string } | null {
  const value = remote.trim().replace(/\.git$/, "");
  const ssh = value.match(/^(?:ssh:\/\/)?git@github\.com[:/]([^/]+)\/([^/]+)$/i);
  const https = value.match(/^https?:\/\/github\.com\/([^/]+)\/([^/]+)$/i);
  const match = ssh ?? https;
  return match ? { owner: match[1], name: match[2] } : null;
}
