import type { PluginClientContext } from "@getpaseo/plugin/client";
import { fixableBranches, type StackSnapshot } from "../shared/contracts";

type PaseoApi = PluginClientContext["paseo"];
type PaseoAgent = Awaited<ReturnType<PaseoApi["agents"]["list"]>>["entries"][number]["agent"];

function providerSelection(agent: PaseoAgent): string {
  if (!agent.model || agent.provider.includes("/")) return agent.provider;
  return `${agent.provider}/${agent.model}`;
}

// The /fix-pr skill owns the workflow, including never submitting without approval.
// The prompt only adds which PRs prompted the run; the skill treats that as a hint.
export function buildFixAllPrompt(snapshot: StackSnapshot): string {
  const lines = [
    "/fix-pr",
    "",
    "Fix All context: PRs with review feedback or failing checks when the button was pressed.",
    "",
    `Workspace: ${snapshot.workspaceName}`,
    `Repository: ${snapshot.repository ? `${snapshot.repository.owner}/${snapshot.repository.name}` : snapshot.directory}`,
    "",
  ];
  for (const branch of fixableBranches(snapshot)) {
    const identity = branch.pr ? `PR #${branch.pr.number}: ${branch.pr.title}` : branch.branch;
    lines.push(`- ${identity}`);
    lines.push(`  Graphite branch: ${branch.branch}`);
    lines.push(`  Issues: ${branch.attention.reasons.join(", ")}`);
    if (branch.pr?.checks.requiredFailingNames.length) {
      lines.push(`  Failing required checks: ${branch.pr.checks.requiredFailingNames.join(", ")}`);
    }
  }
  return lines.join("\n");
}

export async function dispatchFixAll(
  paseo: PaseoApi,
  workspaceId: string,
  snapshot: StackSnapshot,
) {
  const fixable = fixableBranches(snapshot).length;
  if (fixable === 0) throw new Error("This stack has no review feedback or failing checks to fix.");

  const listed = await paseo.agents.list({
    filter: { includeArchived: false },
    page: { limit: 200 },
  });
  const source = listed.entries
    .map(({ agent }) => agent)
    .filter((agent) => agent.workspaceId === workspaceId && !agent.archivedAt)
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0];
  if (!source) {
    throw new Error("Open an agent in this workspace once so Fix All can reuse its provider configuration.");
  }

  const config: {
    provider: string;
    modeId?: string;
    thinkingOptionId?: string;
  } = { provider: providerSelection(source) };
  if (source.currentModeId) config.modeId = source.currentModeId;
  const thinkingOptionId = source.effectiveThinkingOptionId ?? source.thinkingOptionId;
  if (thinkingOptionId) config.thinkingOptionId = thinkingOptionId;

  const agent = await paseo.workspaces.ref(workspaceId).agents.create({
    config,
    title: `Fix Graphite stack (${fixable})`,
    labels: {
      "paseo-graphite": "fix-all",
      "paseo-graphite-workspace": workspaceId,
    },
    prompt: buildFixAllPrompt(snapshot),
  });
  return agent.id;
}
