import { mkdir, open, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCommand } from "./process";

export interface GithubPr {
  number: number;
  title: string;
  url: string;
  state: string;
  isDraft: boolean;
  author: string | null;
  viewerIsAuthor: boolean;
  baseBranch: string;
  headBranch: string;
  mergeable: string;
  mergeStateStatus: string;
  reviewDecision: string;
  // Graphite's "Merge when ready", or GitHub's auto-merge, is on.
  mergeWhenReady: boolean;
  reviewRequests: string[];
  totalThreads: number;
  resolvedThreads: number;
  unresolvedThreads: number;
  checks: {
    total: number;
    passed: number;
    pending: number;
    failed: number;
    requiredTotal: number;
    requiredPassed: number;
    requiredPending: number;
    requiredFailed: number;
    failingNames: string[];
    requiredFailingNames: string[];
  };
  updatedAt: string;
}

/**
 * A branch whose PR to load: by number when Graphite knows it. Else by branch name, which other
 * people's PRs can share, so only a PR whose head is one of `heads` counts.
 */
export interface PrLookup {
  branch: string;
  number: number | null;
  heads?: readonly string[];
}

export interface Repository {
  owner: string;
  name: string;
}

type JsonObject = Record<string, unknown>;

function object(value: unknown): JsonObject | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as JsonObject)
    : null;
}

function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function bool(value: unknown): boolean {
  return value === true;
}

// The label Graphite's merge queue enqueues with. Graphite adds it when "Merge when ready" is
// turned on and removes it when that is turned off or the PR leaves the queue.
const MERGE_LABEL = "merge-queue";

const PR_FRAGMENT = `
fragment pr on PullRequest {
  number title url state isDraft updatedAt headRefName headRefOid baseRefName mergeable mergeStateStatus reviewDecision isCrossRepository
  author{login}
  autoMergeRequest{enabledAt}
  labels(first:20){nodes{name}}
  baseRef{branchProtectionRule{requiresStatusChecks requiredStatusCheckContexts}}
  reviewRequests(first:20){nodes{requestedReviewer{... on User{login} ... on Team{slug}}}}
  reviewThreads(first:100){totalCount nodes{isResolved}}
  commits(last:1){nodes{commit{statusCheckRollup{contexts(first:100){nodes{
    ... on CheckRun{name status conclusion detailsUrl}
    ... on StatusContext{context state targetUrl}
  }}}}}}
}`;

/** One GraphQL query for many PRs. Branch names and numbers go in as variables, never into the query text. */
export function batchQuery(lookups: readonly PrLookup[]): { query: string; variables: Array<[string, string | number]> } {
  const declarations = ["$owner:String!", "$name:String!"];
  const fields: string[] = [];
  const variables: Array<[string, string | number]> = [];
  lookups.forEach((lookup, index) => {
    if (lookup.number !== null) {
      declarations.push(`$n${index}:Int!`);
      variables.push([`n${index}`, lookup.number]);
      fields.push(`b${index}: pullRequest(number:$n${index}){...pr}`);
    } else {
      declarations.push(`$h${index}:String!`);
      variables.push([`h${index}`, lookup.branch]);
      fields.push(
        `b${index}: pullRequests(headRefName:$h${index},first:3,orderBy:{field:CREATED_AT,direction:DESC}){nodes{...pr}}`,
      );
    }
  });
  return {
    query: `query(${declarations.join(",")}){viewer{login} repository(owner:$owner,name:$name){${fields.join(" ")}}}${PR_FRAGMENT}`,
    variables,
  };
}

/**
 * The PR of each looked-up branch, null where it has none. Branches whose part of the answer
 * failed are left out. Null when the whole query failed.
 */
export function parseBatch(
  payload: unknown,
  lookups: readonly PrLookup[],
): { viewer: string | null; prs: Map<string, GithubPr | null> } | null {
  const root = object(payload);
  const data = object(root?.data);
  const repository = object(data?.repository);
  if (!repository) return null;
  // gh exits 1 when part of the answer failed; that part names its alias in the error path.
  // A PR number GitHub does not know is an answer, not a failure.
  const failed = new Set<string>();
  for (const value of array(root?.errors)) {
    const error = object(value);
    const path = array(error?.path);
    if (path[0] !== "repository" || typeof path[1] !== "string") return null;
    if (path.length > 2 || error?.type !== "NOT_FOUND") failed.add(path[1]);
  }
  const viewer = text(object(data?.viewer)?.login) || null;
  const prs = new Map<string, GithubPr | null>();
  lookups.forEach((lookup, index) => {
    if (failed.has(`b${index}`)) return;
    const result = object(repository[`b${index}`]);
    // A fork's PR can share the branch name, and so can an old PR of someone else's.
    const node = lookup.number !== null
      ? result
      : array(result?.nodes)
          .map(object)
          .find((pr) => pr && !bool(pr.isCrossRepository) && lookup.heads?.includes(text(pr.headRefOid)));
    prs.set(lookup.branch, node ? parsePullRequest(node, viewer) : null);
  });
  return { viewer, prs };
}

function checkSummary(nodes: unknown[], requiredContexts: Set<string>): GithubPr["checks"] {
  let passed = 0;
  let pending = 0;
  let failed = 0;
  let requiredPassed = 0;
  let requiredPending = 0;
  let requiredFailed = 0;
  const requiredSeen = new Set<string>();
  const failingNames: string[] = [];
  const requiredFailingNames: string[] = [];
  const failureValues = new Set([
    "FAILURE",
    "ERROR",
    "TIMED_OUT",
    "ACTION_REQUIRED",
    "CANCELLED",
    "STARTUP_FAILURE",
  ]);
  for (const value of nodes) {
    const node = object(value);
    if (!node) continue;
    const name = text(node.name) || text(node.context) || "Unnamed check";
    const status = text(node.status).toUpperCase();
    const conclusion = (text(node.conclusion) || text(node.state)).toUpperCase();
    const required = requiredContexts.has(name);
    if (required) requiredSeen.add(name);
    if ((status && status !== "COMPLETED") || conclusion === "PENDING" || conclusion === "EXPECTED") {
      pending += 1;
      if (required) requiredPending += 1;
    } else if (failureValues.has(conclusion)) {
      failed += 1;
      if (required) {
        requiredFailed += 1;
        if (requiredFailingNames.length < 5) requiredFailingNames.push(name);
      }
      if (failingNames.length < 5) failingNames.push(name);
    } else {
      passed += 1;
      if (required) requiredPassed += 1;
    }
  }
  requiredPending += Math.max(0, requiredContexts.size - requiredSeen.size);
  return {
    total: nodes.length,
    passed,
    pending,
    failed,
    requiredTotal: requiredContexts.size,
    requiredPassed,
    requiredPending,
    requiredFailed,
    failingNames,
    requiredFailingNames,
  };
}

export function parsePullRequest(pr: JsonObject, viewer: string | null): GithubPr {
  const reviewThreads = object(pr.reviewThreads);
  const threadNodes = array(reviewThreads?.nodes).map(object).filter((thread) => thread !== null);
  const reportedTotal = Number(reviewThreads?.totalCount);
  const totalThreads = Number.isInteger(reportedTotal) && reportedTotal >= 0
    ? reportedTotal
    : threadNodes.length;
  const resolvedThreads = threadNodes.filter((thread) => bool(thread.isResolved)).length;
  const unresolvedThreads = Math.max(0, totalThreads - resolvedThreads);

  const commit = object(array(object(pr.commits)?.nodes).at(-1));
  const commitData = object(commit?.commit);
  const rollup = object(commitData?.statusCheckRollup);
  const contexts = array(object(rollup?.contexts)?.nodes);
  const baseRef = object(pr.baseRef);
  const protection = object(baseRef?.branchProtectionRule);
  const requiredContexts = new Set(array(protection?.requiredStatusCheckContexts).map(text).filter(Boolean));
  const reviewRequests = array(object(pr.reviewRequests)?.nodes)
    .map((entry) => {
      const value = object(object(entry)?.requestedReviewer);
      return text(value?.login) || text(value?.slug);
    })
    .filter(Boolean);
  const author = text(object(pr.author)?.login) || null;
  const labels = array(object(pr.labels)?.nodes).map((label) => text(object(label)?.name));

  return {
    number: Number(pr.number),
    title: text(pr.title),
    url: text(pr.url),
    state: text(pr.state),
    isDraft: bool(pr.isDraft),
    author,
    viewerIsAuthor: author !== null && viewer === author,
    baseBranch: text(pr.baseRefName),
    headBranch: text(pr.headRefName),
    mergeable: text(pr.mergeable),
    mergeStateStatus: text(pr.mergeStateStatus),
    reviewDecision: text(pr.reviewDecision),
    mergeWhenReady: object(pr.autoMergeRequest) !== null || labels.includes(MERGE_LABEL),
    reviewRequests,
    totalThreads,
    resolvedThreads,
    unresolvedThreads,
    checks: checkSummary(contexts, requiredContexts),
    updatedAt: text(pr.updatedAt),
  };
}

// GitHub status is loaded per repository, not per worktree: every worktree of a repository
// shows branches of the same PRs. Loaded status is reused for a minute, then shown while a
// newer copy loads in the background. paseo-graphite and the workbench run this same code in
// two processes, so the status also goes to a file both read, and one loads at a time.
const FRESH_MS = 60_000;
// Older status is not shown: the request waits for a new copy.
const STALE_LIMIT_MS = 10 * 60_000;
// A manual refresh takes status this recent.
const FORCED_MS = 5_000;
// Merged and closed PRs no longer change; their status is reused this much longer.
const SETTLED_MS = 30 * 60_000;
// After a failed load, polls leave GitHub alone this long. A manual refresh tries at once.
const RETRY_MS = 30_000;
// Branches looked at this recently load together, so the repository needs one query a minute.
const WANTED_MS = 5 * 60_000;
const BATCH_SIZE = 25;
const BATCH_CONCURRENCY = 3;
// A lock whose process is gone is stale at once. This bounds one whose process id was reused.
const LOCK_STALE_MS = 5 * 60_000;
const LOCK_WAIT_MS = 30_000;
const CACHE_VERSION = 3;
const CACHE_DIR =
  process.env.PASEO_GRAPHITE_CACHE_DIR || join(tmpdir(), `paseo-graphite-${process.getuid?.() ?? "user"}`);

interface Entry {
  pr: GithubPr | null;
  // The number it was looked up by, null when looked up by branch.
  number: number | null;
  fetchedAt: number;
}

interface RepoState {
  file: string;
  viewer: string | null;
  entries: Map<string, Entry>;
  wanted: Map<string, { lookup: PrLookup; at: number }>;
  fileMtime: number;
  // Last load with a failure, and last load without one, by either process.
  failedAt: number;
  loadedAt: number;
  loading: Promise<void> | null;
}

const states = new Map<string, RepoState>();

function stateFor(repository: Repository): RepoState {
  const key = `${repository.owner}/${repository.name}`.toLowerCase();
  let state = states.get(key);
  if (!state) {
    state = {
      file: join(CACHE_DIR, `github-${key.replace(/[^a-z0-9._-]+/g, "_")}.json`),
      viewer: null,
      entries: new Map(),
      wanted: new Map(),
      fileMtime: 0,
      failedAt: 0,
      loadedAt: 0,
      loading: null,
    };
    states.set(key, state);
  }
  return state;
}

function failing(state: RepoState): boolean {
  return state.failedAt > state.loadedAt;
}

function age(state: RepoState, lookup: PrLookup, now: number): number {
  const entry = state.entries.get(lookup.branch);
  // Graphite learned of the branch's PR, as after `gt submit`, or forgot it after a merge.
  if (!entry || entry.number !== lookup.number) return Infinity;
  const elapsed = now - entry.fetchedAt;
  const settled = entry.pr?.state === "MERGED" || entry.pr?.state === "CLOSED";
  return settled ? Math.max(0, elapsed - SETTLED_MS) : elapsed;
}

export interface PrStatuses {
  // By branch; null where the branch has no PR, missing where its status could not be loaded.
  prs: ReadonlyMap<string, GithubPr | null>;
  viewer: string | null;
  // Branches with a known PR whose status could not be loaded.
  failed: number;
}

export async function loadPrs(
  gh: string,
  directory: string,
  repository: Repository,
  lookups: readonly PrLookup[],
  force = false,
): Promise<PrStatuses> {
  const state = stateFor(repository);
  const source = { gh, directory, repository };
  const requestedAt = Date.now();
  for (const lookup of lookups) state.wanted.set(lookup.branch, { lookup, at: requestedAt });
  await mergeFile(state);
  const maxAge = force ? FORCED_MS : STALE_LIMIT_MS;
  if (lookups.some((lookup) => age(state, lookup, requestedAt) > maxAge)) {
    await refresh(state, source, lookups, maxAge, { wait: true, force });
  } else if (lookups.some((lookup) => age(state, lookup, requestedAt) > FRESH_MS)) {
    void refresh(state, source, lookups, FRESH_MS, { wait: false, force: false }).catch(() => undefined);
  }

  const now = Date.now();
  const prs = new Map<string, GithubPr | null>();
  let failed = 0;
  for (const lookup of lookups) {
    const entryAge = age(state, lookup, now);
    if (entryAge <= STALE_LIMIT_MS) prs.set(lookup.branch, state.entries.get(lookup.branch)!.pr);
    // While GitHub fails, status older than a minute counts as not loaded.
    const loaded = entryAge <= (failing(state) ? FRESH_MS : STALE_LIMIT_MS) && prs.get(lookup.branch);
    if (lookup.number !== null && !loaded) failed += 1;
  }
  return { prs, viewer: state.viewer, failed };
}

interface Source {
  gh: string;
  directory: string;
  repository: Repository;
}

async function refresh(
  state: RepoState,
  source: Source,
  lookups: readonly PrLookup[],
  maxAge: number,
  options: { wait: boolean; force: boolean },
): Promise<void> {
  // One load per repository at a time in this process. Callers behind it then check again,
  // which after a failure means waiting out RETRY_MS rather than loading once each.
  while (state.loading) {
    if (!options.wait) return;
    await state.loading;
  }
  const run = loadShared(state, source, lookups, maxAge, options);
  state.loading = run.then(
    () => undefined,
    () => undefined,
  );
  try {
    await run;
  } finally {
    state.loading = null;
  }
}

async function loadShared(
  state: RepoState,
  source: Source,
  lookups: readonly PrLookup[],
  maxAge: number,
  { wait, force }: { wait: boolean; force: boolean },
): Promise<void> {
  const deadline = performance.now() + LOCK_WAIT_MS;
  const needsLoad = () => {
    const now = Date.now();
    if (!force && failing(state) && now - state.failedAt < RETRY_MS) return false;
    return lookups.some((lookup) => age(state, lookup, now) > maxAge);
  };
  for (;;) {
    await mergeFile(state);
    if (!needsLoad()) return;
    const release = await lock(state.file);
    if (release) {
      try {
        // The other process may have loaded it just before letting go.
        await mergeFile(state);
        if (!needsLoad()) return;
        await fetchInto(state, source, withWanted(state, lookups, maxAge));
        await saveFile(state);
      } finally {
        await release();
      }
      return;
    }
    // The other process is loading; its file may soon hold what this request needs.
    if (!wait || performance.now() > deadline) return;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

/** The lookups still too old, plus every branch looked at lately whose status is getting old. */
function withWanted(state: RepoState, lookups: readonly PrLookup[], maxAge: number): PrLookup[] {
  const now = Date.now();
  const batch = new Map<string, PrLookup>();
  for (const lookup of lookups) {
    if (age(state, lookup, now) > maxAge) batch.set(lookup.branch, lookup);
  }
  for (const [branch, { lookup, at }] of state.wanted) {
    if (now - at > WANTED_MS) state.wanted.delete(branch);
    else if (!batch.has(branch) && age(state, lookup, now) > FRESH_MS / 2) batch.set(branch, lookup);
  }
  return [...batch.values()];
}

async function fetchInto(state: RepoState, source: Source, lookups: readonly PrLookup[]): Promise<void> {
  const batches: PrLookup[][] = [];
  for (let index = 0; index < lookups.length; index += BATCH_SIZE) batches.push(lookups.slice(index, index + BATCH_SIZE));
  let failed = false;
  await mapLimit(batches, BATCH_CONCURRENCY, async (batch) => {
    const { query, variables } = batchQuery(batch);
    const args = ["api", "graphql", "-f", `query=${query}`, "-f", `owner=${source.repository.owner}`, "-f", `name=${source.repository.name}`];
    // -F reads numbers as numbers; -f keeps branch names as plain strings (-F would read "@name" as a file).
    for (const [key, value] of variables) args.push(typeof value === "number" ? "-F" : "-f", `${key}=${value}`);
    const askedAt = Date.now();
    const result = await runCommand(source.gh, args, { cwd: source.directory, timeoutMs: 30_000 });
    let parsed: ReturnType<typeof parseBatch> = null;
    try {
      parsed = parseBatch(JSON.parse(result.stdout), batch);
    } catch {
      parsed = null;
    }
    if (!parsed || parsed.prs.size < batch.length) failed = true;
    if (!parsed) return;
    if (parsed.viewer) state.viewer = parsed.viewer;
    // A branch whose part failed keeps its earlier status.
    for (const lookup of batch) {
      if (!parsed.prs.has(lookup.branch)) continue;
      state.entries.set(lookup.branch, { pr: parsed.prs.get(lookup.branch)!, number: lookup.number, fetchedAt: askedAt });
    }
  });
  if (failed) state.failedAt = Date.now();
  else state.loadedAt = Date.now();
}

async function mapLimit<T>(values: readonly T[], limit: number, work: (value: T) => Promise<void>): Promise<void> {
  let cursor = 0;
  async function worker() {
    while (cursor < values.length) await work(values[cursor++]);
  }
  await Promise.all(Array.from({ length: Math.min(limit, values.length) }, () => worker()));
}

async function mergeFile(state: RepoState): Promise<void> {
  let mtime: number;
  try {
    mtime = (await stat(state.file)).mtimeMs;
  } catch {
    return;
  }
  if (mtime === state.fileMtime) return;
  state.fileMtime = mtime;
  let saved: JsonObject | null;
  try {
    saved = object(JSON.parse(await readFile(state.file, "utf8")));
  } catch {
    return;
  }
  if (saved?.version !== CACHE_VERSION) return;
  if (typeof saved.viewer === "string") state.viewer ??= saved.viewer;
  if (typeof saved.failedAt === "number") state.failedAt = Math.max(state.failedAt, saved.failedAt);
  if (typeof saved.loadedAt === "number") state.loadedAt = Math.max(state.loadedAt, saved.loadedAt);
  for (const [branch, value] of Object.entries(object(saved.entries) ?? {})) {
    const entry = object(value);
    const pr = entry?.pr === null ? null : object(entry?.pr);
    const number = typeof entry?.number === "number" ? entry.number : null;
    if (typeof entry?.fetchedAt !== "number" || (pr !== null && typeof pr.number !== "number")) continue;
    const current = state.entries.get(branch);
    if (!current || current.fetchedAt < entry.fetchedAt) {
      state.entries.set(branch, { pr: pr as GithubPr | null, number, fetchedAt: entry.fetchedAt });
    }
  }
}

async function saveFile(state: RepoState): Promise<void> {
  const cutoff = Date.now() - 24 * 60 * 60_000;
  const entries = Object.fromEntries([...state.entries].filter(([, entry]) => entry.fetchedAt > cutoff));
  const { viewer, failedAt, loadedAt } = state;
  try {
    await mkdir(CACHE_DIR, { recursive: true, mode: 0o700 });
    const temporary = `${state.file}.${process.pid}.tmp`;
    await writeFile(temporary, JSON.stringify({ version: CACHE_VERSION, viewer, failedAt, loadedAt, entries }));
    await rename(temporary, state.file);
    state.fileMtime = (await stat(state.file)).mtimeMs;
  } catch {
    // Without the file, the other process loads its own copy.
  }
}

/** Takes the load lock. Null while another live process holds it. */
async function lock(file: string): Promise<(() => Promise<void>) | null> {
  const path = `${file}.lock`;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await mkdir(CACHE_DIR, { recursive: true, mode: 0o700 });
      const handle = await open(path, "wx");
      await handle.writeFile(String(process.pid));
      await handle.close();
      return () => unlink(path).catch(() => undefined);
    } catch (error) {
      // Loading unshared beats not loading.
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") return async () => undefined;
      if (!(await isStaleLock(path))) return null;
      // Two processes can both find it stale and both load once; that costs a query, not data.
      await unlink(path).catch(() => undefined);
    }
  }
  return null;
}

async function isStaleLock(path: string): Promise<boolean> {
  try {
    const [owner, info] = await Promise.all([readFile(path, "utf8"), stat(path)]);
    if (Date.now() - info.mtimeMs > LOCK_STALE_MS) return true;
    const pid = Number(owner);
    // Empty while its owner is still writing its process id.
    if (!Number.isInteger(pid) || pid <= 0) return false;
    process.kill(pid, 0);
    return false;
  } catch (error) {
    // Gone, or its process exited; EPERM means the process is alive.
    return (error as NodeJS.ErrnoException).code !== "EPERM";
  }
}
