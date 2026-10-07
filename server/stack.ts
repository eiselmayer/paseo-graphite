import type { GraphiteRepo } from "./graphite-data";

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
  // Commits the branch's PR head can be at: its last submitted one and its tip. Empty when unknown.
  knownHeads: string[];
}

/**
 * The stack `gt log short --stack` shows for a branch, top first: every branch stacked above it,
 * the branch, then its ancestors down to trunk, which is left out. Null when Graphite does not
 * track the branch.
 */
export function stackBranches(repo: GraphiteRepo, current: string): LocalBranch[] | null {
  if (!isTracked(repo, current)) return null;
  const children = new Map<string, string[]>();
  for (const [branch, { parent }] of repo.tracked) {
    if (!repo.tips.has(branch)) continue;
    children.set(parent, [...(children.get(parent) ?? []), branch]);
  }
  // Damaged metadata can hold a cycle; each branch is listed once.
  const seen = new Set([current]);
  const above: string[] = [];
  const climb = (branch: string) => {
    for (const child of (children.get(branch) ?? []).sort()) {
      if (seen.has(child)) continue;
      seen.add(child);
      climb(child);
      above.push(child);
    }
  };
  climb(current);
  const below: string[] = [];
  for (let branch = repo.tracked.get(current)?.parent; branch && isTracked(repo, branch) && !seen.has(branch); ) {
    seen.add(branch);
    below.push(branch);
    branch = repo.tracked.get(branch)?.parent;
  }
  return [...above, current, ...below].map((branch) => localBranch(repo, branch, branch === current));
}

function isTracked(repo: GraphiteRepo, branch: string): boolean {
  return branch !== repo.trunk && repo.tips.has(branch) && repo.tracked.has(branch);
}

function localBranch(repo: GraphiteRepo, branch: string, current: boolean): LocalBranch {
  const tracked = repo.tracked.get(branch)!;
  const pr = repo.prs.get(branch) ?? null;
  const tip = repo.tips.get(branch);
  const submitted = tracked.submitted;
  // As gt counts versions: the stored number, else the submitted commit's place in the PR's versions.
  const position = submitted && pr ? pr.versions.indexOf(submitted.headSha) + 1 : 0;
  const version = submitted?.versionNumber ?? (position || null);
  const remoteVersion = pr?.versions.length ?? 0;
  let remoteStatus: string | null = null;
  if (version !== null && remoteVersion > version) remoteStatus = `remote at v${remoteVersion}, need get`;
  else if (submitted && tip !== submitted.headSha) remoteStatus = "local changes, need submit";
  return {
    branch,
    current,
    localStatus: repo.tips.get(tracked.parent) === tracked.parentRevision ? null : "needs restack",
    parent: tracked.parent,
    submittedVersion: version === null ? null : `v${version}`,
    remoteStatus,
    graphitePrStatus: pr?.status ? statusText(pr.status) : null,
    graphiteUrl: pr?.url || null,
    prNumber: pr?.number ?? null,
    graphiteTitle: pr?.title || null,
    knownHeads: submitted ? [...new Set([submitted.headSha, tip ?? submitted.headSha])] : [],
  };
}

// gt's wording where it is not the status name itself, as QUEUED_TO_MERGE prints "Queued to merge".
const STATUS_TEXT: Record<string, string> = {
  BRANCH_LOCKED: "Trunk branch locked",
  CROSS_PARTITION_DOWNSTACK_IN_QUEUE: "Waiting on PRs in this stack to merge",
  FAILED_MQ_ENTRY_AT_CURRENT_HEAD: "Merge queue failed on current head commit",
  FAILING_REQUIRED: "Required checks failed",
  FAILURE_HANDLING: "Undergoing failure detection",
  HANDED_OFF_TO_EXTERNAL_MERGE_QUEUE: "Handed off to merge queue",
  HARD_WAITING_ON_DOWNSTACK: "Waiting on downstack",
  NEEDS_APPROVALS: "Needs more approvals",
  NEEDS_CODEOWNER_APPROVALS: "Needs approvals from file owners",
  NEEDS_RESTACK__BASE_BRANCH_MERGED: "Needs restack",
  NEEDS_RESTACK__BASE_INCORRECT: "Needs restack",
  NEEDS_REVIEWERS: "Needs more reviewers",
  READY_TO_MERGE_AS_STACK: "Ready to merge as stack",
  RUNNING: "Waiting on CI",
  STALE: "Stale, needs rebase onto trunk",
};

function statusText(status: string): string {
  const words = status.toLowerCase().replace(/_+/g, " ").trim();
  return STATUS_TEXT[status] ?? words.charAt(0).toUpperCase() + words.slice(1);
}
