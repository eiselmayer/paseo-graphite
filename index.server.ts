import type { PluginServerContext } from "@getpaseo/plugin/server";
import { isEnabledFor, isWorkspaceEnabled, listProjectModes } from "./server/enablement";
import { emptySnapshot, inspectWorkspaceStack, invalidateStack } from "./server/inspect";
import { terminateAllCommands } from "./server/process";
import { checkoutBranch as checkout, trackCurrentBranch } from "./server/branch";
import { branchChanges, fileDiff } from "./server/changes";
import {
  checkoutBranch,
  getBranchChanges,
  getFileDiff,
  getStack,
  getWorkspaceEnabled,
  graphiteSettings,
  listProjects,
  trackBranch,
} from "./shared/contracts";

export default function contribute(server: PluginServerContext) {
  const settings = server.registerSettings(graphiteSettings);

  server.handle(getStack, async ({ workspaceId, refresh }, { paseo }) => {
    // Never run gt where Graphite is off: gt silently initializes Graphite in any repo it touches.
    const workspace = await paseo.workspaces.ref(workspaceId).refresh();
    if (workspace && !(await isEnabledFor(workspace, settings))) {
      return emptySnapshot({
        workspaceId,
        workspaceName: workspace.name || workspace.title || workspace.id,
        directory: workspace.workspaceDirectory ?? "",
        kind: "not-graphite",
        message: "Graphite is off for this project.",
        hint: "Turn it on under Settings → Plugins → paseo-graphite.",
      });
    }
    return inspectWorkspaceStack(paseo, workspaceId, refresh ?? false);
  });
  // Both run gt, so both are refused where Graphite is off, like getStack. They answer as
  // soon as gt is done: reading the stack again waits in the shared inspection queue.
  async function requireEnabled(paseo: Parameters<typeof isWorkspaceEnabled>[0], workspaceId: string) {
    if (!(await isWorkspaceEnabled(paseo, settings, workspaceId))) {
      throw new Error("Graphite is off for this project.");
    }
  }
  server.handle(trackBranch, async ({ workspaceId }, { paseo }) => {
    await requireEnabled(paseo, workspaceId);
    await trackCurrentBranch(paseo, workspaceId);
    invalidateStack(workspaceId);
    return {};
  });
  server.handle(checkoutBranch, async ({ workspaceId, branch }, { paseo }) => {
    await requireEnabled(paseo, workspaceId);
    await checkout(paseo, workspaceId, branch);
    invalidateStack(workspaceId);
    return {};
  });
  server.handle(getBranchChanges, async (input, { paseo }) => ({
    files: await branchChanges(paseo, input),
  }));
  server.handle(getFileDiff, async (input, { paseo }) => ({ lines: await fileDiff(paseo, input) }));
  server.handle(getWorkspaceEnabled, async ({ workspaceId }, { paseo }) => ({
    enabled: await isWorkspaceEnabled(paseo, settings, workspaceId),
  }));
  server.handle(listProjects, (_input, { paseo }) => listProjectModes(paseo, settings));
  return terminateAllCommands;
}
