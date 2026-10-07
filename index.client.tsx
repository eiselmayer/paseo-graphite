import type {
  PluginButtonRegistration,
  PluginClientContext,
} from "@getpaseo/plugin/client";
import { GraphitePrCenter } from "./client/center";
import { addCommentMessages } from "./client/comment-message";
import { stopCommentQueue } from "./client/comment-queue";
import { subscribeWaitingComments, waitingComments } from "./client/waiting-comments";
import { WaitingCommentsPopover } from "./client/waiting-comments-popover";
import { GraphiteDiffPanel } from "./client/diff-panel";
import { setDiffPanelOpener } from "./client/diff-store";
import { onEnablementChanged } from "./client/enablement";
import { GraphiteStackPanel } from "./client/panel";
import { ProjectSettings } from "./client/settings";
import {
  buttonLabel,
  buttonTitle,
  StackStatusIcon,
  subscribeStack,
} from "./client/status";
import { getWorkspaceEnabled } from "./shared/contracts";

// Picks up repositories that start or stop using Graphite without a settings change.
const ENABLEMENT_RECHECK_MS = 5 * 60_000;

export default function contribute(client: PluginClientContext) {
  client.addSettingsScreen({
    id: "projects",
    title: "Projects",
    icon: "FolderGit2",
    Component: ProjectSettings,
  });

  client.addSurface("graphite-prs", GraphitePrCenter);
  client.addSidebarItem({
    id: "graphite-prs",
    title: "Graphite PRs",
    icon: "GitPullRequest",
    surface: "graphite-prs",
  });

  client.addCommandCenterItem({
    id: "open-graphite-prs",
    title: "Open Graphite PRs",
    icon: "GitPullRequest",
    keywords: ["graphite", "pull request", "inbox", "review", "stacks"],
    context: "global",
    onSelect({ openSurface }) {
      openSurface("graphite-prs");
    },
  });

  client.addWorkspacePanel({
    id: "graphite-stack",
    title: "Graphite stack",
    icon: "GitPullRequest",
    context: "workspace",
    locations: ["explorer"],
    Component: GraphiteStackPanel,
  });
  client.addWorkspacePanel({
    id: "graphite-diff",
    title: "Graphite diff",
    icon: "FileDiff",
    context: "workspace",
    locations: ["workspace"],
    Component: GraphiteDiffPanel,
  });
  setDiffPanelOpener((workspaceId) =>
    client.openPanel("graphite-diff", { workspaceId, location: "workspace" }),
  );
  addCommentMessages(client);

  // Comments added in the diff wait on a pill on their agent's chat box until the user sends them.
  const commentPills = new Map<string, PluginButtonRegistration>();
  function syncCommentPills() {
    const waiting = new Map<string, { workspaceId: string; count: number }>();
    for (const comment of waitingComments()) {
      const entry = waiting.get(comment.agentId) ?? { workspaceId: comment.workspaceId, count: 0 };
      entry.count += 1;
      waiting.set(comment.agentId, entry);
    }
    for (const [agentId, pill] of commentPills) {
      if (waiting.has(agentId)) continue;
      pill.remove();
      commentPills.delete(agentId);
    }
    for (const [agentId, { workspaceId, count }] of waiting) {
      const label = count === 1 ? "1 comment" : `${count} comments`;
      const pill = commentPills.get(agentId);
      if (pill) pill.update({ label });
      else {
        commentPills.set(
          agentId,
          client.addComposerPill({
            id: "waiting-comments",
            workspaceId,
            agentId,
            button: {
              title: "Diff comments waiting to be sent",
              icon: "MessageSquareText",
              label,
              behavior: { kind: "popover", Content: WaitingCommentsPopover },
            },
          }),
        );
      }
    }
  }
  syncCommentPills();
  const unsubscribeWaitingComments = subscribeWaitingComments(syncCommentPills);

  client.addCommandCenterItem({
    id: "open-graphite-stack",
    title: "Open Graphite PR stack",
    icon: "GitPullRequest",
    keywords: ["pull request", "review", "checks", "comments", "stack"],
    context: "workspace",
    onSelect({ openPanel }) {
      openPanel("graphite-stack", { location: "explorer" });
    },
  });

  client.addSlashCommand({
    name: "pr-stack",
    description: "Open this workspace's Graphite PR stack",
    argumentHint: "",
    context: "agent",
    onSubmit({ openPanel }) {
      openPanel("graphite-stack", { location: "explorer" });
    },
  });

  type RegisteredButton = {
    workspaceId: string;
    button: PluginButtonRegistration;
    unsubscribeStatus: () => void;
  };
  const headers = new Map<string, RegisteredButton>();
  const pills = new Map<string, RegisteredButton>();
  const enabled = new Map<string, boolean>();
  const checks = new Map<string, number>();
  const agents = new Map<string, { id: string; workspaceId?: string | null; status?: string }>();
  let stopped = false;

  function descriptor(workspaceId: string) {
    return {
      title: "Open Graphite PR stack",
      icon: StackStatusIcon,
      label: "PR stack",
      behavior: {
        kind: "action" as const,
        onPress() {
          client.openPanel("graphite-stack", { workspaceId, location: "explorer" });
        },
      },
    };
  }

  function registerHeader(workspaceId: string) {
    if (headers.has(workspaceId)) return;
    const button = client.addHeaderButton({ id: "graphite-stack", workspaceId, button: descriptor(workspaceId) });
    const unsubscribeStatus = subscribeStack(workspaceId, (snapshot) =>
      button.update({ label: buttonLabel(snapshot), title: buttonTitle(snapshot) }),
    );
    headers.set(workspaceId, { workspaceId, button, unsubscribeStatus });
  }

  function removeHeader(workspaceId: string) {
    const entry = headers.get(workspaceId);
    entry?.button.remove();
    entry?.unsubscribeStatus();
    headers.delete(workspaceId);
  }

  function registerPill(agent: { id: string; workspaceId?: string | null; status?: string }) {
    agents.set(agent.id, agent);
    if (!agent.workspaceId || agent.status === "closed") return;
    if (!enabled.get(agent.workspaceId)) return removePill(agent.id);
    const agentId = agent.id;
    const workspaceId = agent.workspaceId;
    const existing = pills.get(agentId);
    if (existing?.workspaceId === workspaceId) return;
    existing?.button.remove();
    existing?.unsubscribeStatus();
    const button = client.addComposerPill({
      id: "graphite-stack",
      workspaceId,
      agentId,
      button: descriptor(workspaceId),
    });
    const unsubscribeStatus = subscribeStack(workspaceId, (snapshot) =>
      button.update({ label: buttonLabel(snapshot), title: buttonTitle(snapshot) }),
    );
    pills.set(agentId, { workspaceId, button, unsubscribeStatus });
  }

  function removePill(agentId: string) {
    const entry = pills.get(agentId);
    entry?.button.remove();
    entry?.unsubscribeStatus();
    pills.delete(agentId);
  }

  // Buttons and pills appear only in workspaces whose project has Graphite turned on.
  async function syncWorkspace(workspaceId: string) {
    const check = (checks.get(workspaceId) ?? 0) + 1;
    checks.set(workspaceId, check);
    let isEnabled = false;
    try {
      isEnabled = (await client.rpc(getWorkspaceEnabled, { workspaceId })).enabled;
    } catch (error) {
      console.error("[paseo-graphite] enablement check failed", error);
    }
    if (stopped || checks.get(workspaceId) !== check) return;
    enabled.set(workspaceId, isEnabled);
    if (isEnabled) registerHeader(workspaceId);
    else removeHeader(workspaceId);
    for (const agent of agents.values()) {
      if (agent.workspaceId === workspaceId) registerPill(agent);
    }
  }

  function forgetWorkspace(workspaceId: string) {
    enabled.delete(workspaceId);
    checks.delete(workspaceId);
    removeHeader(workspaceId);
  }

  function recheckAll() {
    for (const workspaceId of enabled.keys()) void syncWorkspace(workspaceId);
  }
  const unsubscribeEnablement = onEnablementChanged(recheckAll);
  const recheckTimer = setInterval(recheckAll, ENABLEMENT_RECHECK_MS);

  const unsubscribeWorkspaces = client.paseo.workspaces.subscribe((update) => {
    if (stopped) return;
    if (update.kind === "remove") forgetWorkspace(update.id);
    else if (!checks.has(update.workspace.id)) void syncWorkspace(update.workspace.id);
  });
  void client.paseo.workspaces
    .list()
    .then(({ entries }) => {
      if (stopped) return;
      for (const workspace of entries) {
        if (!checks.has(workspace.id)) void syncWorkspace(workspace.id);
      }
    })
    .catch((error) => {
      if (!stopped) console.error("[paseo-graphite] workspace observation failed", error);
    });

  const unsubscribeAgents = client.paseo.agents.subscribe((update) => {
    if (stopped) return;
    if (update.kind === "remove") {
      agents.delete(update.agentId);
      removePill(update.agentId);
    } else registerPill(update.agent);
  });
  void client.paseo.agents
    .list()
    .then(({ entries }) => {
      if (stopped) return;
      for (const { agent } of entries) registerPill(agent);
    })
    .catch((error) => {
      if (!stopped) console.error("[paseo-graphite] agent observation failed", error);
    });

  return () => {
    stopped = true;
    setDiffPanelOpener(null);
    stopCommentQueue();
    unsubscribeWaitingComments();
    for (const pill of commentPills.values()) pill.remove();
    clearInterval(recheckTimer);
    unsubscribeEnablement();
    unsubscribeWorkspaces();
    unsubscribeAgents();
    for (const id of [...headers.keys()]) removeHeader(id);
    for (const id of [...pills.keys()]) removePill(id);
  };
}
