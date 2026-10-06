import { defineRpc, defineSettings } from "@getpaseo/plugin";
import { z } from "zod";

export const attentionLevelSchema = z.enum(["action", "ready", "waiting", "done"]);
export type AttentionLevel = z.infer<typeof attentionLevelSchema>;

export const attentionReasonSchema = z.enum([
  "merge-conflict",
  "review-comments",
  "changes-requested",
  "checks-failed",
  "needs-restack",
  "remote-newer",
  "submit-required",
  "publish-required",
  "request-review",
  "ready-to-merge",
  "merge-queued",
  "checks-running",
  "waiting-for-review",
  "merged",
  "closed",
]);
export type AttentionReason = z.infer<typeof attentionReasonSchema>;

const checkSummarySchema = z.object({
  total: z.number().int().nonnegative(),
  passed: z.number().int().nonnegative(),
  pending: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  requiredTotal: z.number().int().nonnegative(),
  requiredPassed: z.number().int().nonnegative(),
  requiredPending: z.number().int().nonnegative(),
  requiredFailed: z.number().int().nonnegative(),
  failingNames: z.array(z.string()),
  requiredFailingNames: z.array(z.string()),
});

export const stackBranchSchema = z.object({
  branch: z.string(),
  parent: z.string().nullable(),
  current: z.boolean(),
  localStatus: z.string().nullable(),
  submittedVersion: z.string().nullable(),
  remoteStatus: z.string().nullable(),
  graphitePrStatus: z.string().nullable(),
  graphiteUrl: z.string().url().nullable(),
  pr: z
    .object({
      number: z.number().int().positive(),
      title: z.string(),
      url: z.string().url(),
      state: z.string(),
      isDraft: z.boolean(),
      author: z.string().nullable(),
      viewerIsAuthor: z.boolean(),
      baseBranch: z.string(),
      headBranch: z.string(),
      mergeable: z.string(),
      mergeStateStatus: z.string(),
      reviewDecision: z.string(),
      reviewRequests: z.array(z.string()),
      totalThreads: z.number().int().nonnegative(),
      resolvedThreads: z.number().int().nonnegative(),
      unresolvedThreads: z.number().int().nonnegative(),
      checks: checkSummarySchema,
      updatedAt: z.string(),
    })
    .nullable(),
  attention: z.object({
    level: attentionLevelSchema,
    reasons: z.array(attentionReasonSchema),
    label: z.string(),
    command: z.string().nullable(),
  }),
});
export type StackBranch = z.infer<typeof stackBranchSchema>;

// Next steps for the author, not something wrong with the PR. Shown in the accent color, not red.
const TODO_REASONS: ReadonlySet<AttentionReason> = new Set(["submit-required", "publish-required"]);

/** An action item that is only a next step (submit, publish) rather than a problem to fix. */
export function isTodoOnly(attention: StackBranch["attention"]): boolean {
  return attention.level === "action" && attention.reasons.every((reason) => TODO_REASONS.has(reason));
}

export const stackSnapshotSchema = z.object({
  workspaceId: z.string(),
  workspaceName: z.string(),
  directory: z.string(),
  currentBranch: z.string().nullable(),
  trunk: z.string().nullable(),
  repository: z
    .object({
      owner: z.string(),
      name: z.string(),
    })
    .nullable(),
  viewer: z.string().nullable(),
  inspectedAt: z.string(),
  available: z.boolean(),
  unavailable: z
    .object({
      kind: z.enum(["not-git", "not-graphite", "untracked", "missing-cli", "github", "unknown"]),
      message: z.string(),
      hint: z.string().nullable(),
    })
    .nullable(),
  summary: z.object({
    total: z.number().int().nonnegative(),
    action: z.number().int().nonnegative(),
    ready: z.number().int().nonnegative(),
    waiting: z.number().int().nonnegative(),
    done: z.number().int().nonnegative(),
    label: z.string(),
  }),
  branches: z.array(stackBranchSchema),
});
export type StackSnapshot = z.infer<typeof stackSnapshotSchema>;

export const getStack = defineRpc({
  name: "graphite.stack.get",
  input: z.object({
    workspaceId: z.string().min(1),
    refresh: z.boolean().optional(),
  }),
  output: stackSnapshotSchema,
});

// Tracks the workspace's current branch, parented on its nearest tracked ancestor.
// Answers once gt is done; read the stack again with getStack.
export const trackBranch = defineRpc({
  name: "graphite.branch.track",
  input: z.object({ workspaceId: z.string().min(1) }),
  output: z.object({}),
});

export const checkoutBranch = defineRpc({
  name: "graphite.branch.checkout",
  input: z.object({ workspaceId: z.string().min(1), branch: z.string().min(1) }),
  output: z.object({}),
});

const branchRangeSchema = z.object({
  workspaceId: z.string().min(1),
  branch: z.string().min(1),
  parent: z.string().min(1),
});
export type BranchRange = z.infer<typeof branchRangeSchema>;

const changedFileSchema = z.object({
  path: z.string(),
  oldPath: z.string().nullable(),
  status: z.enum(["added", "modified", "deleted", "renamed", "copied"]),
  // Null for binary files.
  additions: z.number().int().nonnegative().nullable(),
  deletions: z.number().int().nonnegative().nullable(),
});
export type ChangedFile = z.infer<typeof changedFileSchema>;

// Files a branch changes relative to its Graphite parent: the diff its PR shows.
export const getBranchChanges = defineRpc({
  name: "graphite.branch.changes",
  input: branchRangeSchema,
  output: z.object({ files: z.array(changedFileSchema) }),
});

const diffLineSchema = z.object({
  kind: z.enum(["hunk", "add", "delete", "context", "note"]),
  text: z.string(),
  oldNumber: z.number().int().nullable(),
  newNumber: z.number().int().nullable(),
  // Syntax-colored pieces of `text`; null when the language is unsupported or the file is too large.
  tokens: z.array(z.object({ text: z.string(), color: z.string().nullable() })).nullable(),
});
export type DiffLine = z.infer<typeof diffLineSchema>;

export const getFileDiff = defineRpc({
  name: "graphite.branch.file-diff",
  input: branchRangeSchema.extend({
    path: z.string().min(1),
    oldPath: z.string().nullable(),
    // Paseo's syntax theme (its appearance setting) and the light or dark variant of it.
    syntaxTheme: z.string(),
    scheme: z.enum(["light", "dark"]),
  }),
  output: z.object({ lines: z.array(diffLineSchema) }),
});

export const projectModeSchema = z.enum(["auto", "on", "off"]);
export type ProjectMode = z.infer<typeof projectModeSchema>;

// Per-project override of Graphite detection, keyed by Paseo project ID. Unlisted projects are "auto".
export const graphiteSettings = defineSettings({
  id: "graphite",
  scope: "host",
  version: 1,
  schema: z.object({
    projects: z.record(z.string(), z.enum(["on", "off"])).default({}),
  }),
});

export const getWorkspaceEnabled = defineRpc({
  name: "graphite.workspace.enabled",
  input: z.object({ workspaceId: z.string().min(1) }),
  output: z.object({ enabled: z.boolean() }),
});

export const listProjects = defineRpc({
  name: "graphite.projects.list",
  input: z.object({}),
  output: z.object({
    projects: z.array(
      z.object({
        projectId: z.string(),
        name: z.string(),
        rootPath: z.string(),
        detected: z.boolean(),
        mode: projectModeSchema,
      }),
    ),
  }),
});

export function countProblems(snapshot: StackSnapshot): number {
  return snapshot.branches.filter(
    (branch) => branch.attention.level === "action" && !isTodoOnly(branch.attention),
  ).length;
}

// Problems Fix All hands to an agent: review feedback and failing required checks.
const FIXABLE_REASONS: ReadonlySet<AttentionReason> = new Set([
  "review-comments",
  "changes-requested",
  "checks-failed",
]);

export function fixableBranches(snapshot: StackSnapshot): StackBranch[] {
  return snapshot.branches.filter((branch) =>
    branch.attention.reasons.some((reason) => FIXABLE_REASONS.has(reason)),
  );
}
