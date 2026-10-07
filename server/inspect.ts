import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import type {
  AttentionReason,
  StackBranch,
  StackSnapshot,
} from "../shared/contracts";
import { forgetGraphiteRepo, type GraphiteRepo, parseOrigin, readGraphiteRepo, readHead } from "./graphite-data";
import { type GithubPr, loadPrs, type PrLookup, type Repository } from "./github";
import { findBinary, runCommand, stripAnsi } from "./process";
import { type LocalBranch, stackBranches } from "./stack";

export type { GithubPr } from "./github";
export type { LocalBranch } from "./stack";

type PaseoApi = PluginHandlerContext["paseo"];

const inFlight = new Map<string, { forced: boolean; snapshot: Promise<StackSnapshot> }>();
// Each inspected workspace's shared git directory, to drop its repository's data after a gt command.
const commonDirs = new Map<string, string>();
// Reading a stack through gt takes half a second per branch, so those stacks are reused a while.
const GT_STACK_TTL_MS = 30_000;
const gtStacks = new Map<string, { readAt: number; branch: string; value: Promise<LocalStack> }>();
// And read one at a time, as gt is heavy.
let gtQueue: Promise<unknown> = Promise.resolve();

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
      knownHeads: [],
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

type Problem = Pick<Parameters<typeof emptySnapshot>[0], "kind" | "message" | "hint">;

type LocalStack = { trunk: string | null; repository: Repository | null } & (
  | { branches: LocalBranch[] }
  | { problem: Problem }
);

function untracked(branch: string): Problem {
  return {
    kind: "untracked",
    message: `${branch} is not tracked by Graphite.`,
    hint: "Tracking stacks it on its nearest tracked ancestor.",
  };
}

function onTrunk(trunk: string): Problem {
  // Graphite lists every tracked branch there, not a stack of this workspace.
  return { kind: "not-graphite", message: `On ${trunk}, no stack.`, hint: null };
}

function repoStack(repo: GraphiteRepo, currentBranch: string): LocalStack {
  const { trunk, repository } = repo;
  if (currentBranch === trunk) return { trunk, repository, problem: onTrunk(trunk) };
  const branches = stackBranches(repo, currentBranch);
  return branches ? { trunk, repository, branches } : { trunk, repository, problem: untracked(currentBranch) };
}

/** The stack as gt prints it, a command per branch. For gt versions whose files `readGraphiteRepo` cannot read. */
async function gtStack(gt: string, git: string, directory: string, currentBranch: string): Promise<LocalStack> {
  const [trunkResult, originResult] = await Promise.all([
    runCommand(gt, ["trunk", "--no-interactive"], { cwd: directory, timeoutMs: 10_000 }),
    runCommand(git, ["remote", "get-url", "origin"], { cwd: directory, timeoutMs: 8_000 }),
  ]);
  const trunk = trunkResult.ok ? stripAnsi(trunkResult.stdout).trim().split(/\s+/).at(-1) ?? null : null;
  const repository = originResult.ok ? parseOrigin(originResult.stdout) : null;
  if (trunk !== null && currentBranch === trunk) return { trunk, repository, problem: onTrunk(trunk) };

  const logResult = await runCommand(gt, ["log", "short", "--stack", "--no-interactive"], {
    cwd: directory,
    timeoutMs: 15_000,
  });
  if (!logResult.ok) {
    const detail = `${logResult.stdout}\n${logResult.stderr}`;
    if (/untracked branch/i.test(detail)) return { trunk, repository, problem: untracked(currentBranch) };
    return {
      trunk,
      repository,
      problem: {
        kind: "not-graphite",
        message: "Graphite could not read a stack for this workspace.",
        hint: detail.trim().split(/\r?\n/)[0] || null,
      },
    };
  }

  const branches: LocalBranch[] = [];
  for (const branch of parseGraphiteLog(logResult.stdout, trunk)) {
    const info = await runCommand(gt, ["info", branch.branch, "--no-interactive"], {
      cwd: directory,
      timeoutMs: 15_000,
    });
    branches.push(info.ok ? parseGraphiteInfo(branch, info.stdout) : branch);
  }
  if (branches.length === 0) {
    return {
      trunk,
      repository,
      problem: { kind: "not-graphite", message: "Graphite returned no tracked branches for this stack.", hint: null },
    };
  }
  return { trunk, repository, branches };
}

async function inspect(paseo: PaseoApi, workspaceId: string, refresh: boolean): Promise<StackSnapshot> {
  const workspace = await paseo.workspaces.ref(workspaceId).refresh();
  if (!workspace) throw new Error(`Workspace not found: ${workspaceId}`);
  const directory = workspace.workspaceDirectory;
  const workspaceName = workspace.name || workspace.title || workspace.id;
  if (!directory) {
    return emptySnapshot({ workspaceId, workspaceName, directory: "", kind: "not-git", message: "This workspace has no local directory." });
  }

  const [git, gt, gh] = await Promise.all([findBinary("git"), findBinary("gt"), findBinary("gh")]);
  const missingCli = (message: string) =>
    emptySnapshot({
      workspaceId,
      workspaceName,
      directory,
      kind: "missing-cli",
      message,
      hint: "Install the missing CLI and reload the plugin.",
    });
  if (!git) return missingCli("Git is not available to the Paseo daemon.");

  // Graphite keeps its data in the git directory all of the repository's worktrees share.
  const head = await readHead(git, directory);
  const currentBranch = head?.branch ?? null;
  if (!head || !currentBranch) {
    return emptySnapshot({ workspaceId, workspaceName, directory, kind: "not-git", message: "The workspace is not on a Git branch." });
  }
  const { commonDir } = head;
  commonDirs.set(workspaceId, commonDir);

  const repo = await readGraphiteRepo(git, commonDir, directory, refresh);
  let stack: LocalStack;
  if (repo) stack = repoStack(repo, currentBranch);
  else if (gt) {
    const cached = gtStacks.get(workspaceId);
    if (refresh || cached?.branch !== currentBranch || Date.now() - cached.readAt > GT_STACK_TTL_MS) {
      const value = gtQueue.then(() => gtStack(gt, git, directory, currentBranch));
      gtQueue = value.catch(() => undefined);
      gtStacks.set(workspaceId, { readAt: Date.now(), branch: currentBranch, value });
    }
    stack = await gtStacks.get(workspaceId)!.value;
  } else return missingCli("Graphite CLI (gt) is not available to the Paseo daemon.");
  const { trunk, repository } = stack;
  if ("problem" in stack) {
    return {
      ...emptySnapshot({ workspaceId, workspaceName, directory, currentBranch, ...stack.problem }),
      trunk,
      repository,
    };
  }

  const localBranches = stack.branches;
  const github = gh && repository
    ? await loadPrs(
        gh,
        directory,
        repository,
        // Branches gt submitted but no longer lists a PR for, as after a merge, are looked up by name.
        localBranches.flatMap(({ branch, prNumber, knownHeads }): PrLookup[] => {
          if (prNumber !== null) return [{ branch, number: prNumber }];
          return knownHeads.length > 0 ? [{ branch, number: null, heads: knownHeads }] : [];
        }),
        refresh,
      )
    : null;

  const branches: StackBranch[] = localBranches.map((local) => {
    const pr = github?.prs.get(local.branch) ?? null;
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

  const submitted = localBranches.filter((branch) => branch.prNumber !== null).length;
  const missingGithub = github ? github.failed : submitted;
  const githubWarning = submitted > 0 && missingGithub > 0
    ? {
        kind: "github" as const,
        message: !gh
          ? "GitHub CLI (gh) is unavailable, so review and check status could not be loaded."
          : !repository
            ? "This Git remote is not a GitHub repository, so review and check status could not be loaded."
            : `GitHub status could not be loaded for ${missingGithub} of ${submitted} PRs.`,
        hint: !gh
          ? "Install and authenticate gh, then refresh."
          : !repository
            ? "Check the origin remote and refresh."
            : "Check gh authentication and repository access, then refresh.",
      }
    : null;

  return {
    workspaceId,
    workspaceName,
    directory,
    currentBranch,
    trunk,
    repository,
    viewer: github?.viewer ?? null,
    inspectedAt: new Date().toISOString(),
    available: true,
    unavailable: githubWarning,
    summary,
    branches,
  };
}

/** Drops what a gt command changed: the repository's Graphite data and any inspection under way. */
export function invalidateStack(workspaceId: string): void {
  inFlight.delete(workspaceId);
  gtStacks.delete(workspaceId);
  const commonDir = commonDirs.get(workspaceId);
  if (commonDir) forgetGraphiteRepo(commonDir);
}

export function inspectWorkspaceStack(
  paseo: PaseoApi,
  workspaceId: string,
  refresh = false,
): Promise<StackSnapshot> {
  // A manual refresh does not settle for a poll that is already under way.
  const running = inFlight.get(workspaceId);
  if (running && (running.forced || !refresh)) return running.snapshot;
  const snapshot = inspect(paseo, workspaceId, refresh).finally(() => {
    if (inFlight.get(workspaceId)?.snapshot === snapshot) inFlight.delete(workspaceId);
  });
  inFlight.set(workspaceId, { forced: refresh, snapshot });
  return snapshot;
}
