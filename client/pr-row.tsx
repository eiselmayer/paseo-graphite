import type { PluginWorkspacePanelProps } from "@getpaseo/plugin/client";
import { Icon } from "@getpaseo/plugin/client/react-native";
import type { ReactNode } from "react";
import { ActivityIndicator, Pressable, Text, View } from "react-native";
import { type AttentionLevel, isTodoOnly, type StackBranch } from "../shared/contracts";
import { openExternal } from "./web";

type Theme = PluginWorkspacePanelProps["theme"];

export function levelColor(level: AttentionLevel, theme: Theme): string {
  if (level === "action") return theme.colors.statusDanger;
  if (level === "ready") return theme.colors.statusSuccess;
  if (level === "waiting") return theme.colors.statusWarning;
  return theme.colors.foregroundMuted;
}

export function CompactPrRow({
  branch,
  theme,
  context,
  onOpenWorkspace,
  onCheckout,
  checkingOut,
  expanded,
  onToggleExpanded,
  children,
}: {
  branch: StackBranch;
  theme: Theme;
  context?: string;
  onOpenWorkspace?: () => void;
  onCheckout?: () => void;
  checkingOut?: boolean;
  expanded?: boolean;
  onToggleExpanded?: () => void;
  // Shown under the status line while expanded.
  children?: ReactNode;
}) {
  const tint = isTodoOnly(branch.attention)
    ? theme.colors.accent
    : levelColor(branch.attention.level, theme);
  const pr = branch.pr;
  const title = pr ? `#${pr.number} ${pr.title}` : branch.branch;
  const checks = pr?.checks;
  const checkPassed = checks && checks.requiredTotal > 0 ? checks.requiredPassed : checks?.passed ?? 0;
  const checkTotal = checks && checks.requiredTotal > 0 ? checks.requiredTotal : checks?.total ?? 0;
  const checkFailed = checks && checks.requiredTotal > 0 ? checks.requiredFailed : checks?.failed ?? 0;
  const checkPending = checks && checks.requiredTotal > 0 ? checks.requiredPending : checks?.pending ?? 0;
  // Lines under the title start where the title does, after the chevron and the dot.
  const indent = onToggleExpanded ? 25 : 15;
  const titleContent = (
    <Text numberOfLines={1} style={{ color: theme.colors.foreground, fontSize: 13, fontWeight: "600" }}>
      {title}
    </Text>
  );

  return (
    <View
      style={{
        paddingHorizontal: 10,
        paddingVertical: 9,
        gap: 5,
        borderBottomWidth: 1,
        borderBottomColor: theme.colors.border,
        backgroundColor: branch.current ? theme.colors.surface2 : theme.colors.surface1,
      }}
    >
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
        {onToggleExpanded ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`${expanded ? "Hide" : "Show"} changes in ${branch.branch}`}
            accessibilityState={{ expanded: !!expanded }}
            onPress={onToggleExpanded}
            hitSlop={6}
            style={{ marginLeft: -4, marginRight: -4 }}
          >
            <Icon name={expanded ? "ChevronDown" : "ChevronRight"} size={14} color={theme.colors.foregroundMuted} />
          </Pressable>
        ) : null}
        <View style={{ width: 7, height: 7, borderRadius: 4, backgroundColor: tint }} />
        <View style={{ flex: 1 }}>
          {branch.graphiteUrl ? (
            <Pressable
              accessibilityRole="link"
              accessibilityLabel={`Open ${title} in Graphite`}
              onPress={() => openExternal(branch.graphiteUrl!)}
            >
              {titleContent}
            </Pressable>
          ) : titleContent}
          {pr ? (
            <Text numberOfLines={1} style={{ color: theme.colors.foregroundMuted, fontSize: 11, marginTop: 1 }}>
              {branch.branch}
            </Text>
          ) : null}
        </View>
        {onCheckout && !branch.current ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Check out ${branch.branch}`}
            disabled={checkingOut}
            onPress={onCheckout}
            hitSlop={8}
            style={{ padding: 3, opacity: checkingOut ? 0.65 : 1 }}
          >
            {checkingOut ? (
              <ActivityIndicator size="small" color={theme.colors.foregroundMuted} />
            ) : (
              <Icon name="GitBranch" size={14} color={theme.colors.foregroundMuted} />
            )}
          </Pressable>
        ) : null}
        {onOpenWorkspace ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Open Paseo workspace"
            onPress={onOpenWorkspace}
            hitSlop={8}
            style={{ padding: 3 }}
          >
            <Icon name="FolderOpen" size={14} color={theme.colors.foregroundMuted} />
          </Pressable>
        ) : null}
        {branch.graphiteUrl ? (
          <Pressable
            accessibilityRole="link"
            accessibilityLabel={`Open ${title} in Graphite`}
            onPress={() => openExternal(branch.graphiteUrl!)}
            hitSlop={8}
            style={{ padding: 3 }}
          >
            <Icon name="ExternalLink" size={14} color={theme.colors.foregroundMuted} />
          </Pressable>
        ) : null}
      </View>

      <View style={{ paddingLeft: indent, flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: 7 }}>
        <Text style={{ color: tint, fontSize: 11, fontWeight: "600" }}>
          {branch.attention.label}
        </Text>
        {pr?.mergeWhenReady && pr.state === "OPEN" ? (
          <View
            accessibilityLabel="Merge when ready is on"
            style={{ flexDirection: "row", alignItems: "center", gap: 3 }}
          >
            <Icon name="GitMerge" size={11} color={theme.colors.accent} />
            <Text style={{ color: theme.colors.accent, fontSize: 11 }}>Merge when ready</Text>
          </View>
        ) : null}
        {pr && pr.totalThreads > 0 ? (
          <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11 }}>
            {pr.resolvedThreads}/{pr.totalThreads} comments
          </Text>
        ) : null}
        {pr && checkTotal > 0 ? (
          <Text
            style={{
              color: checkFailed > 0
                ? theme.colors.statusDanger
                : checkPending > 0
                  ? theme.colors.statusWarning
                  : theme.colors.foregroundMuted,
              fontSize: 11,
            }}
          >
            {checkPassed}/{checkTotal} {pr.checks.requiredTotal > 0 ? "required" : "checks"}
          </Text>
        ) : null}
        {branch.attention.command ? (
          <Text style={{ color: theme.colors.accent, fontSize: 11 }}>{branch.attention.command}</Text>
        ) : null}
        {context ? (
          <Text numberOfLines={1} style={{ color: theme.colors.foregroundMuted, fontSize: 11 }}>
            {context}
          </Text>
        ) : null}
      </View>
      {expanded && children ? <View style={{ paddingLeft: indent, paddingTop: 2 }}>{children}</View> : null}
    </View>
  );
}
