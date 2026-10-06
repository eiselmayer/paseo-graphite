import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import type {
  AttentionReason,
  StackBranch,
  StackSnapshot,
} from "../shared/contracts";
import { findBinary, runCommand, stripAnsi } from "./process";

type PaseoApi = PluginHandlerContext["paseo"];

const CACHE_MS = 30_000;
const MAX_CACHE_ENTRIES = 128;
const COMMAND_CONCURRENCY = 1;
const cache = new Map<string, { expiresAt: number; value: StackSnapshot }>();
const inFlight = new Map<string, Promise<StackSnapshot>>();
let inspectionTail: Promise<unknown> = Promise.resolve();

function enqueueInspection(work: () => Promise<StackSnapshot>): Promise<StackSnapshot> {
  const request = inspectionTail.then(work, work);
  inspectionTail = request.then(
    () => undefined,
    () => undefined,
  );
  return request;
}

type JsonObject = Record<string, unknown>;

export interface LocalBranch {
  branch: string;
  current: boolean;
  localStatus: string | null;
  parent: string | null;
  submittedVersion: string | null;
  remoteStatus: string | null;
  graphitePrStatus: string | null;
  graphiteUrl: string | null;
  prNumber: number | null;
  graphiteTitle: string | null;
}

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

const PR_QUERY = `
query($owner:String!,$name:String!,$number:Int!){
  viewer{login}
  repository(owner:$owner,name:$name){
    pullRequest(number:$number){
      number title url state isDraft updatedAt headRefName baseRefName mergeable mergeStateStatus reviewDecision
      author{login}
      baseRef{branchProtectionRule{requiresStatusChecks requiredStatusCheckContexts}}
      reviewRequests(first:20){nodes{requestedReviewer{... on User{login} ... on Team{slug}}}}
      reviewThreads(first:100){totalCount nodes{isResolved}}
      commits(last:1){nodes{commit{statusCheckRollup{contexts(first:100){nodes{
        ... on CheckRun{name status conclusion detailsUrl}
        ... on StatusContext{context state targetUrl}
      }}}}}}
    }
  }
}`;

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

export function emptySnapshot(input: {
  workspaceId: string;
  workspaceName: string;
  directory: string;
  currentBranch?: string | null;
  kind: NonNullable<StackSnapshot["unavailable"]>["kind"];
  message: string;
  hint?: string | null;
}): StackSnapshot {
  return {
    workspaceId: input.workspaceId,
    workspaceName: input.workspaceName,
    directory: input.directory,
    currentBranch: input.currentBranch ?? null,
    trunk: null,
    repository: null,
    viewer: null,
    inspectedAt: new Date().toISOString(),
    available: false,
    unavailable: {
      kind: input.kind,
      message: input.message,
      hint: input.hint ?? null,
    },
    summary: { total: 0, action: 0, ready: 0, waiting: 0, done: 0, label: "No stack" },
    branches: [],
  };
}

function parseOrigin(remote: string): { owner: string; name: string } | null {
  const value = remote.trim().replace(/\.git$/, "");
  const ssh = value.match(/^(?:ssh:\/\/)?git@github\.com[:/]([^/]+)\/([^/]+)$/i);
  const https = value.match(/^https?:\/\/github\.com\/([^/]+)\/([^/]+)$/i);
  const match = ssh ?? https;
  return match ? { owner: match[1], name: match[2] } : null;
}

export function parseGraphiteLog(output: string, trunk: string | null): LocalBranch[] {
  const branches: LocalBranch[] = [];
  for (const raw of stripAnsi(output).split(/\r?\n/)) {
    const match = raw.match(/^\s*([◉◯◆])\s+([^\s()]+)(?:\s+\(([^)]+)\))?\s*$/u);
    if (!match) continue;
    const branch = match[2];
    if (trunk !== null && branch === trunk) continue;
    branches.push({
      branch,
      current: match[1] === "◉",
      localStatus: match[3]?.trim() || null,
      parent: null,
      submittedVersion: null,
      remoteStatus: null,
      graphitePrStatus: null,
      graphiteUrl: null,
      prNumber: null,
      graphiteTitle: null,
    });
  }
  return branches;
}

export function parseGraphiteInfo(branch: LocalBranch, output: string): LocalBranch {
  const clean = stripAnsi(output);
  const firstLine = clean.split(/\r?\n/).find((line) => line.trim() !== "")?.trim() ?? "";
  const first = firstLine.match(/^[^\s()]+(?:\s+\(([^)]+)\))?$/);
  const prLine = clean.match(/^PR #(\d+)(?: \(([^)]+)\))?\s+(.+)$/m);
  const url = clean.match(/^https:\/\/app\.graphite\.com\/github\/pr\/[^\s]+$/m)?.[0] ?? null;
  const parent = clean.match(/^Parent:\s+(.+)$/m)?.[1]?.trim() ?? null;
  const submitted = clean.match(/^Last submitted version:\s+([^\s]+)(?:\s+\(([^)]+)\))?$/m);
  return {
    ...branch,
    localStatus: first?.[1]?.trim() || branch.localStatus,
    parent,
    submittedVersion: submitted?.[1] ?? null,
    remoteStatus: submitted?.[2]?.trim() ?? null,
    graphitePrStatus: prLine?.[2]?.trim() ?? null,
    graphiteUrl: url,
    prNumber: prLine ? Number(prLine[1]) : null,
    graphiteTitle: prLine?.[3]?.trim() ?? null,
  };
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

export function parseGithubPr(payload: unknown): { viewer: string | null; pr: GithubPr | null } {
  const root = object(payload);
  const data = object(root?.data);
  const viewer = text(object(data?.viewer)?.login) || null;
  const repository = object(data?.repository);
  const pr = object(repository?.pullRequest);
  if (!pr) return { viewer, pr: null };

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

  return {
    viewer,
    pr: {
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
      reviewRequests,
      totalThreads,
      resolvedThreads,
      unresolvedThreads,
      checks: checkSummary(contexts, requiredContexts),
      updatedAt: text(pr.updatedAt),
    },
  };
}

function actionAttention(reasons: AttentionReason[]): StackBranch["attention"] {
  const label = reasons.includes("merge-conflict")
    ? "Resolve merge conflict"
    : reasons.includes("review-comments") || reasons.includes("changes-requested")
      ? "Fix review feedback"
      : reasons.includes("checks-failed")
        ? "Fix failing checks"
        : reasons.includes("needs-restack")
          ? "Restack and submit"
          : reasons.includes("remote-newer")
            ? "Get remote changes"
            : reasons.includes("submit-required")
              ? "Submit this stack"
              : "Publish for review";
  return {
    level: "action",
    reasons,
    label,
    command:
      reasons.includes("review-comments") || reasons.includes("changes-requested")
        ? "/fix-pr"
        : null,
  };
}

export function attention(local: LocalBranch, pr: GithubPr | null): StackBranch["attention"] {
  const reasons: AttentionReason[] = [];
  const localState = `${local.localStatus ?? ""} ${local.remoteStatus ?? ""}`.toLowerCase();
  const graphitePrStatus = local.graphitePrStatus?.toLowerCase() ?? "";

  if (pr === null) reasons.push("submit-required");
  if (pr?.state === "MERGED" || localState.includes("merged")) {
    return { level: "done", reasons: ["merged"], label: "Merged", command: null };
  }
  if (pr?.state === "CLOSED") {
    return { level: "done", reasons: ["closed"], label: "Closed", command: null };
  }
  if (pr?.mergeable === "CONFLICTING" || pr?.mergeStateStatus === "DIRTY") {
    reasons.push("merge-conflict");
  }
  if (pr && pr.unresolvedThreads > 0) reasons.push("review-comments");
  if (pr?.reviewDecision === "CHANGES_REQUESTED") reasons.push("changes-requested");
  if (pr && pr.checks.requiredFailed > 0) reasons.push("checks-failed");
  if (pr?.isDraft) reasons.push("publish-required");

  if (reasons.length > 0) {
    return actionAttention(reasons);
  }

  if (graphitePrStatus.startsWith("queued to merge")) {
    return {
      level: "waiting",
      reasons: ["merge-queued"],
      label: "Queued to merge",
      command: null,
    };
  }

  if (pr && pr.checks.requiredPending > 0) {
    return { level: "waiting", reasons: ["checks-running"], label: "Checks running", command: null };
  }
  if (pr?.reviewDecision === "REVIEW_REQUIRED") {
    if (pr.reviewRequests.length === 0) {
      return {
        level: "action",
        reasons: ["request-review"],
        label: "Request a reviewer",
        command: null,
      };
    }
    return {
      level: "waiting",
      reasons: ["waiting-for-review"],
      label: "Waiting for review",
      command: null,
    };
  }
  if (
    graphitePrStatus === "ready to merge" ||
    (pr?.state === "OPEN" &&
      pr.reviewDecision === "APPROVED" &&
      pr.mergeable === "MERGEABLE" &&
      pr.checks.requiredFailed === 0 &&
      pr.checks.requiredPending === 0)
  ) {
    return {
      level: "ready",
      reasons: ["ready-to-merge"],
      label: "Ready to merge",
      command: null,
    };
  }

  if (localState.includes("needs restack")) reasons.push("needs-restack");
  if (localState.includes("need get") || localState.includes("remote at")) reasons.push("remote-newer");
  if (reasons.length > 0) return actionAttention(reasons);

  return { level: "waiting", reasons: [], label: "No action right now", command: null };
}

async function mapLimit<T, R>(values: readonly T[], limit: number, work: (value: T) => Promise<R>): Promise<R[]> {
  const result = new Array<R>(values.length);
  let cursor = 0;
  async function worker() {
    for (;;) {
      const index = cursor++;
      if (index >= values.length) return;
      result[index] = await work(values[index]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, values.length) }, () => worker()));
  return result;
}

async function inspect(paseo: PaseoApi, workspaceId: string): Promise<StackSnapshot> {
  const workspace = await paseo.workspaces.ref(workspaceId).refresh();
  if (!workspace) throw new Error(`Workspace not found: ${workspaceId}`);
  const directory = workspace.workspaceDirectory;
  const workspaceName = workspace.name || workspace.title || workspace.id;
  if (!directory) {
    return emptySnapshot({ workspaceId, workspaceName, directory: "", kind: "not-git", message: "This workspace has no local directory." });
  }

  const [git, gt, gh] = await Promise.all([findBinary("git"), findBinary("gt"), findBinary("gh")]);
  if (!git || !gt) {
    return emptySnapshot({
      workspaceId,
      workspaceName,
      directory,
      kind: "missing-cli",
      message: !gt ? "Graphite CLI (gt) is not available to the Paseo daemon." : "Git is not available to the Paseo daemon.",
      hint: "Install the missing CLI and reload the plugin.",
    });
  }

  const branchResult = await runCommand(git, ["branch", "--show-current"], { cwd: directory, timeoutMs: 8_000 });
  const currentBranch = branchResult.stdout.trim() || null;
  if (!branchResult.ok || !currentBranch) {
    return emptySnapshot({ workspaceId, workspaceName, directory, currentBranch, kind: "not-git", message: "The workspace is not on a Git branch." });
  }

  const [trunkResult, originResult] = await Promise.all([
    runCommand(gt, ["trunk", "--no-interactive"], { cwd: directory, timeoutMs: 10_000 }),
    runCommand(git, ["remote", "get-url", "origin"], { cwd: directory, timeoutMs: 8_000 }),
  ]);
  const trunk = trunkResult.ok ? stripAnsi(trunkResult.stdout).trim().split(/\s+/).at(-1) ?? null : null;
  const repository = originResult.ok ? parseOrigin(originResult.stdout) : null;

  const logResult = await runCommand(gt, ["log", "short", "--stack", "--no-interactive"], {
    cwd: directory,
    timeoutMs: 15_000,
  });
  if (!logResult.ok) {
    const detail = `${logResult.stdout}\n${logResult.stderr}`;
    const untracked = /untracked branch/i.test(detail);
    return {
      ...emptySnapshot({
        workspaceId,
        workspaceName,
        directory,
        currentBranch,
        kind: untracked ? "untracked" : "not-graphite",
        message: untracked
          ? `${currentBranch} is not tracked by Graphite.`
          : "Graphite could not read a stack for this workspace.",
        hint: untracked ? "Tracking stacks it on its nearest tracked ancestor." : detail.trim().split(/\r?\n/)[0] || null,
      }),
      trunk,
      repository,
    };
  }

  let localBranches = parseGraphiteLog(logResult.stdout, trunk);
  if (localBranches.length === 0) {
    return {
      ...emptySnapshot({ workspaceId, workspaceName, directory, currentBranch, kind: "not-graphite", message: "Graphite returned no tracked branches for this stack." }),
      trunk,
      repository,
    };
  }

  localBranches = await mapLimit(localBranches, COMMAND_CONCURRENCY, async (branch) => {
    const info = await runCommand(gt, ["info", branch.branch, "--no-interactive"], {
      cwd: directory,
      timeoutMs: 15_000,
    });
    return info.ok ? parseGraphiteInfo(branch, info.stdout) : branch;
  });

  let viewer: string | null = null;
  const githubByNumber = new Map<number, GithubPr>();
  const submittedBranches = localBranches.filter((branch) => branch.prNumber !== null);
  let githubFailures = 0;
  if (gh && repository) {
    await mapLimit(
      submittedBranches,
      COMMAND_CONCURRENCY,
      async (branch) => {
        const result = await runCommand(
          gh,
          [
            "api",
            "graphql",
            "-f",
            `owner=${repository.owner}`,
            "-f",
            `name=${repository.name}`,
            "-F",
            `number=${branch.prNumber}`,
            "-f",
            `query=${PR_QUERY}`,
          ],
          { cwd: directory, timeoutMs: 25_000 },
        );
        if (!result.ok) {
          githubFailures += 1;
          return;
        }
        try {
          const parsed = parseGithubPr(JSON.parse(result.stdout));
          if (parsed.viewer) viewer = parsed.viewer;
          if (parsed.pr && branch.prNumber !== null) githubByNumber.set(branch.prNumber, parsed.pr);
          else githubFailures += 1;
        } catch {
          // A malformed response leaves Graphite-local data visible instead of hiding the stack.
          githubFailures += 1;
        }
      },
    );
  }

  const branches: StackBranch[] = localBranches.map((local) => {
    const pr = local.prNumber === null ? null : githubByNumber.get(local.prNumber) ?? null;
    const fallbackPr =
      pr ??
      (local.prNumber !== null && local.graphiteUrl
        ? {
            number: local.prNumber,
            title: local.graphiteTitle ?? local.branch,
            url: local.graphiteUrl.replace("app.graphite.com/github/pr", "github.com").replace(/\/(\d+)$/, "/pull/$1"),
            state: local.localStatus?.toLowerCase() === "merged" ? "MERGED" : "OPEN",
            isDraft: false,
            author: null,
            viewerIsAuthor: false,
            baseBranch: local.parent ?? trunk ?? "",
            headBranch: local.branch,
            mergeable: "UNKNOWN",
            mergeStateStatus: "UNKNOWN",
            reviewDecision: "",
            reviewRequests: [],
            totalThreads: 0,
            resolvedThreads: 0,
            unresolvedThreads: 0,
            checks: {
              total: 0,
              passed: 0,
              pending: 0,
              failed: 0,
              requiredTotal: 0,
              requiredPassed: 0,
              requiredPending: 0,
              requiredFailed: 0,
              failingNames: [],
              requiredFailingNames: [],
            },
            updatedAt: new Date().toISOString(),
          }
        : null);
    return {
      branch: local.branch,
      parent: local.parent,
      current: local.current,
      localStatus: local.localStatus,
      submittedVersion: local.submittedVersion,
      remoteStatus: local.remoteStatus,
      graphitePrStatus: local.graphitePrStatus,
      graphiteUrl: local.graphiteUrl,
      pr: fallbackPr,
      attention: attention(local, fallbackPr),
    };
  });

  const summary = {
    total: branches.length,
    action: branches.filter((branch) => branch.attention.level === "action").length,
    ready: branches.filter((branch) => branch.attention.level === "ready").length,
    waiting: branches.filter((branch) => branch.attention.level === "waiting").length,
    done: branches.filter((branch) => branch.attention.level === "done").length,
    label: "",
  };
  summary.label = summary.action
    ? `${summary.action} need you`
    : summary.ready
      ? `${summary.ready} ready to merge`
      : summary.waiting
        ? "Waiting on others"
        : "Stack clear";

  const missingGithub = submittedBranches.length - githubByNumber.size;
  const githubWarning = submittedBranches.length > 0 && missingGithub > 0
    ? {
        kind: "github" as const,
        message: !gh
          ? "GitHub CLI (gh) is unavailable, so review and check status could not be loaded."
          : !repository
            ? "This Git remote is not a GitHub repository, so review and check status could not be loaded."
            : `GitHub status could not be loaded for ${missingGithub} of ${submittedBranches.length} PRs.`,
        hint: !gh
          ? "Install and authenticate gh, then refresh."
          : githubFailures > 0
            ? "Check gh authentication and repository access, then refresh."
            : "Check the origin remote and refresh.",
      }
    : null;

  return {
    workspaceId,
    workspaceName,
    directory,
    currentBranch,
    trunk,
    repository,
    viewer,
    inspectedAt: new Date().toISOString(),
    available: true,
    unavailable: githubWarning,
    summary,
    branches,
  };
}

// Bumped by invalidateStack so an inspection that started earlier does not cache its stale result.
const generations = new Map<string, number>();

/** Drops the cached and in-flight stack after a command changed the repository. */
export function invalidateStack(workspaceId: string): void {
  cache.delete(workspaceId);
  inFlight.delete(workspaceId);
  generations.set(workspaceId, (generations.get(workspaceId) ?? 0) + 1);
}

export async function inspectWorkspaceStack(
  paseo: PaseoApi,
  workspaceId: string,
  refresh = false,
): Promise<StackSnapshot> {
  const cached = cache.get(workspaceId);
  if (!refresh && cached && cached.expiresAt > Date.now()) return cached.value;
  const running = inFlight.get(workspaceId);
  if (running) return running;
  const generation = generations.get(workspaceId) ?? 0;
  const request = enqueueInspection(() => inspect(paseo, workspaceId))
    .then((value) => {
      if ((generations.get(workspaceId) ?? 0) !== generation) return value;
      const now = Date.now();
      for (const [key, entry] of cache) {
        if (entry.expiresAt <= now) cache.delete(key);
      }
      cache.delete(workspaceId);
      while (cache.size >= MAX_CACHE_ENTRIES) {
        const oldest = cache.keys().next().value;
        if (oldest === undefined) break;
        cache.delete(oldest);
      }
      cache.set(workspaceId, { expiresAt: now + CACHE_MS, value });
      return value;
    })
    .finally(() => {
      if (inFlight.get(workspaceId) === request) inFlight.delete(workspaceId);
    });
  inFlight.set(workspaceId, request);
  return request;
}
