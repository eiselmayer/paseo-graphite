import { type PluginSurfaceProps, useRpc, useSettings } from "@getpaseo/plugin/client";
import { SettingsCard, SettingsSection, SettingsSelect } from "@getpaseo/plugin/client/ui";
import { useQuery } from "@tanstack/react-query";
import { Text } from "react-native";
import { graphiteSettings, listProjects, type ProjectMode } from "../shared/contracts";
import { notifyEnablementChanged } from "./enablement";

export function ProjectSettings({ theme }: PluginSurfaceProps) {
  const settings = useSettings(graphiteSettings);
  const list = useRpc(listProjects);
  const projects = useQuery({
    queryKey: ["paseo-graphite", "projects"],
    queryFn: () => list({}),
  });

  async function setMode(projectId: string, mode: ProjectMode) {
    if (settings.status !== "ready") return;
    const next = { ...settings.values.projects };
    if (mode === "auto") delete next[projectId];
    else next[projectId] = mode;
    if (await settings.save({ ...settings.values, projects: next }, settings.revision)) {
      notifyEnablementChanged();
    }
  }

  const message = (text: string, color = theme.colors.foregroundMuted) => (
    <Text style={{ color, paddingVertical: 8 }}>{text}</Text>
  );

  return (
    <SettingsSection
      title="Projects"
      info="Auto turns the plugin on where Graphite tracks at least one branch. Off hides the stack button and never runs gt in that project."
    >
      {projects.isError || settings.status === "error" || settings.status === "invalid"
        ? message(
            projects.error instanceof Error
              ? projects.error.message
              : settings.status === "error" || settings.status === "invalid"
                ? settings.error
                : "Could not load projects.",
            theme.colors.statusDanger,
          )
        : !projects.data || settings.status === "loading"
          ? message("Loading projects…")
          : projects.data.projects.length === 0
            ? message("No git projects yet.")
            : (
                <SettingsCard>
                  {projects.data.projects.map((project) => (
                    <SettingsSelect<ProjectMode>
                      key={project.projectId}
                      label={project.name}
                      hint={project.rootPath}
                      value={settings.values.projects[project.projectId] ?? "auto"}
                      options={[
                        {
                          label: `Auto (${project.detected ? "Graphite detected" : "not detected"})`,
                          value: "auto",
                        },
                        { label: "On", value: "on" },
                        { label: "Off", value: "off" },
                      ]}
                      disabled={settings.saving}
                      onValueChange={(mode) => void setMode(project.projectId, mode)}
                    />
                  ))}
                </SettingsCard>
              )}
      {settings.saveError ? message(settings.saveError, theme.colors.statusDanger) : null}
    </SettingsSection>
  );
}
