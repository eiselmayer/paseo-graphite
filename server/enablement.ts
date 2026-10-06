import type { PaseoApi, PaseoWorkspace } from "@getpaseo/client";
import type { PluginSettings } from "@getpaseo/plugin/server";
import type { graphiteSettings, ProjectMode } from "../shared/contracts";
import { detectGraphite } from "./detect";

export type GraphiteSettingsHandle = PluginSettings<typeof graphiteSettings.schema>;

async function projectModes(settings: GraphiteSettingsHandle): Promise<Record<string, "on" | "off">> {
  const state = await settings.read();
  return state.status === "ready" ? state.values.projects : {};
}

/** Whether the plugin should run for a workspace: its project's override, else detection. */
export async function isEnabledFor(
  workspace: PaseoWorkspace,
  settings: GraphiteSettingsHandle,
): Promise<boolean> {
  if (!workspace.workspaceDirectory) return false;
  const mode = (await projectModes(settings))[workspace.projectId];
  if (mode) return mode === "on";
  return detectGraphite(workspace.workspaceDirectory);
}

export async function isWorkspaceEnabled(
  paseo: PaseoApi,
  settings: GraphiteSettingsHandle,
  workspaceId: string,
): Promise<boolean> {
  const workspace = await paseo.workspaces.ref(workspaceId).refresh();
  return workspace ? isEnabledFor(workspace, settings) : false;
}

export async function listProjectModes(paseo: PaseoApi, settings: GraphiteSettingsHandle) {
  const [{ projects }, modes] = await Promise.all([paseo.projects.list(), projectModes(settings)]);
  const gitProjects = projects.filter((project) => project.projectKind === "git");
  return {
    projects: await Promise.all(
      gitProjects.map(async (project) => ({
        projectId: project.projectId,
        name: project.projectCustomName || project.projectDisplayName,
        rootPath: project.projectRootPath,
        detected: await detectGraphite(project.projectRootPath),
        mode: (modes[project.projectId] ?? "auto") as ProjectMode,
      })),
    ),
  };
}
