import { type PluginWorkspacePanelProps, useRpc } from "@getpaseo/plugin/client";
import { Icon } from "@getpaseo/plugin/client/react-native";
import { useQuery } from "@tanstack/react-query";
import { type ReactNode, useState } from "react";
import { ActivityIndicator, Image, Pressable, Text, View } from "react-native";
import { type ChangedFile, getBranchChanges } from "../shared/contracts";
import { formatDiffCount, treeRows } from "../shared/diff-tree";
import { showDiff, useDiffSelection } from "./diff-store";
import { fileIconUri } from "./file-icons";

type Theme = PluginWorkspacePanelProps["theme"];

// Sizes from Paseo's Changes panel (packages/app/src/components/tree-primitives.tsx,
// git/file-header.tsx, components/diff-stat.tsx).
const INDENT = 12;
const NAME_SIZE = 14;
const STAT_SIZE = 12;
const ICON_SIZE = 16;

/** Paseo's file change icon: lucide square-plus, square-minus or square-dot. */
export function ChangeIcon({ status, theme }: { status: ChangedFile["status"]; theme: Theme }) {
  if (status === "added") return <Icon name="SquarePlus" size={14} color={theme.colors.statusSuccess} />;
  if (status === "deleted") return <Icon name="SquareMinus" size={14} color={theme.colors.statusDanger} />;
  return <Icon name="SquareDot" size={14} color={theme.colors.statusWarning} />;
}

export function DiffStat({
  additions,
  deletions,
  theme,
}: {
  additions: number | null;
  deletions: number | null;
  theme: Theme;
}) {
  return (
    <View style={{ height: 20, flexDirection: "row", alignItems: "center", gap: 4 }}>
      {additions ? (
        <Text style={{ fontSize: STAT_SIZE, color: theme.colors.statusSuccess }}>+{formatDiffCount(additions)}</Text>
      ) : null}
      {deletions ? (
        <Text style={{ fontSize: STAT_SIZE, color: theme.colors.statusDanger }}>-{formatDiffCount(deletions)}</Text>
      ) : null}
    </View>
  );
}

export function BranchChanges({
  workspaceId,
  branch,
  parent,
  theme,
}: {
  workspaceId: string;
  branch: string;
  parent: string;
  theme: Theme;
}) {
  const changes = useRpc(getBranchChanges);
  const selection = useDiffSelection(workspaceId);
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const query = useQuery({
    queryKey: ["paseo-graphite", "changes", workspaceId, parent, branch],
    queryFn: () => changes({ workspaceId, branch, parent }),
    staleTime: 30_000,
  });

  if (query.isPending) {
    return <ActivityIndicator size="small" color={theme.colors.foregroundMuted} style={{ alignSelf: "flex-start" }} />;
  }
  if (query.error) {
    return <Text style={{ color: theme.colors.statusDanger, fontSize: 11 }}>{String(query.error)}</Text>;
  }
  if (query.data.files.length === 0) {
    return <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11 }}>No changes against {parent}.</Text>;
  }

  const toggle = (dirPath: string) =>
    setCollapsed((current) => {
      const next = new Set(current);
      if (!next.delete(dirPath)) next.add(dirPath);
      return next;
    });
  const shownFile = selection?.branch === branch ? selection.file.path : null;

  return (
    <View style={{ marginHorizontal: -4 }}>
      {treeRows(query.data.files, collapsed).map((row) =>
        row.kind === "folder" ? (
          <TreeRow
            key={`d:${row.dirPath}`}
            depth={row.depth}
            theme={theme}
            label={`${collapsed.has(row.dirPath) ? "Expand" : "Collapse"} ${row.name}`}
            onPress={() => toggle(row.dirPath)}
            leading={
              <View style={{ transform: [{ rotate: collapsed.has(row.dirPath) ? "0deg" : "90deg" }], opacity: 0.7 }}>
                <Icon name="ChevronRight" size={ICON_SIZE} color={theme.colors.foregroundMuted} />
              </View>
            }
            name={row.name}
            trailing={<DiffStat additions={row.additions} deletions={row.deletions} theme={theme} />}
          />
        ) : (
          <TreeRow
            key={`f:${row.file.path}`}
            depth={row.depth}
            theme={theme}
            selected={row.file.path === shownFile}
            label={`Show diff of ${row.file.path}`}
            onPress={() => showDiff(workspaceId, { branch, parent, file: row.file })}
            leading={<Image source={{ uri: fileIconUri(row.name) }} style={{ width: ICON_SIZE, height: ICON_SIZE }} />}
            name={row.name}
            trailing={
              <>
                {row.file.additions === null ? (
                  <Text style={{ fontSize: STAT_SIZE, color: theme.colors.foregroundMuted }}>binary</Text>
                ) : (
                  <DiffStat additions={row.file.additions} deletions={row.file.deletions} theme={theme} />
                )}
                <ChangeIcon status={row.file.status} theme={theme} />
              </>
            }
          />
        ),
      )}
    </View>
  );
}

function TreeRow({
  depth,
  theme,
  selected,
  label,
  onPress,
  leading,
  name,
  trailing,
}: {
  depth: number;
  theme: Theme;
  selected?: boolean;
  label: string;
  onPress: () => void;
  leading: ReactNode;
  name: string;
  trailing: ReactNode;
}) {
  const [hovered, setHovered] = useState(false);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      onHoverIn={() => setHovered(true)}
      onHoverOut={() => setHovered(false)}
      style={({ pressed }) => ({
        flexDirection: "row",
        alignItems: "center",
        gap: 8,
        paddingVertical: 6,
        paddingRight: 8,
        paddingLeft: 4 + depth * INDENT,
        borderRadius: 6,
        backgroundColor: hovered || pressed || selected ? theme.colors.surface2 : "transparent",
      })}
    >
      {leading}
      <Text
        numberOfLines={1}
        style={{ flex: 1, fontSize: NAME_SIZE, color: theme.colors.foreground, opacity: hovered || selected ? 1 : 0.76 }}
      >
        {name}
      </Text>
      {trailing}
    </Pressable>
  );
}
