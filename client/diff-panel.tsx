import { type PluginWorkspacePanelProps, useRpc } from "@getpaseo/plugin/client";
import { ScrollView } from "@getpaseo/plugin/client/react-native";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { ActivityIndicator, Platform, ScrollView as HorizontalScroll, Text, View } from "react-native";
import { type DiffLine, getFileDiff } from "../shared/contracts";
import { ChangeIcon, DiffStat } from "./branch-changes";
import { readCodeAppearance } from "./app-settings";
import { useDiffSelection } from "./diff-store";

type Theme = PluginWorkspacePanelProps["theme"];

// Geometry of Paseo's diff document (packages/app/src/git/diff-document, components/code-insets.ts).
const DEFAULT_MONO = Platform.select({
  ios: "Menlo",
  android: "monospace",
  default: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
});
const NUMBER_RIGHT_INSET = 7;
const CODE_LEFT_PADDING = 8;
const CODE_RIGHT_PADDING = 16;
const HEADER_HEIGHT = 30;
// Rendering every line as views gets slow past this; the rest stays one click away in Graphite.
const MAX_LINES = 5_000;

// Plugins are not told the app's color scheme, so read it off the background.
function colorScheme(theme: Theme): "light" | "dark" {
  const hex = /^#([0-9a-f]{6})/i.exec(theme.colors.surface0)?.[1];
  if (!hex) return "dark";
  const [r, g, b] = [0, 2, 4].map((offset) => parseInt(hex.slice(offset, offset + 2), 16));
  return 0.299 * r + 0.587 * g + 0.114 * b > 128 ? "light" : "dark";
}

function withAlpha(color: string, alpha: number): string {
  const hex = /^#([0-9a-f]{6})$/i.exec(color)?.[1];
  if (!hex) return color;
  const [r, g, b] = [0, 2, 4].map((offset) => parseInt(hex.slice(offset, offset + 2), 16));
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function lineStyle(line: DiffLine, theme: Theme) {
  if (line.kind === "add") {
    return { background: withAlpha(theme.colors.statusSuccess, 0.15), number: theme.colors.statusSuccess };
  }
  if (line.kind === "delete") {
    return { background: withAlpha(theme.colors.statusDanger, 0.1), number: theme.colors.statusDanger };
  }
  return { background: theme.colors.surface0, number: theme.colors.foregroundMuted };
}

export function GraphiteDiffPanel({ theme, workspaceId }: PluginWorkspacePanelProps) {
  const selection = useDiffSelection(workspaceId);
  const fileDiff = useRpc(getFileDiff);
  const scheme = colorScheme(theme);
  // Read on every render: changing the setting in Paseo then shows on the next update here.
  const appearance = readCodeAppearance();
  const lineHeight = Math.round(appearance.fontSize * 1.5);
  const [codeWidth, setCodeWidth] = useState(0);
  const query = useQuery({
    queryKey: [
      "paseo-graphite",
      "diff",
      workspaceId,
      selection?.parent,
      selection?.branch,
      selection?.file.oldPath,
      selection?.file.path,
      appearance.syntaxTheme,
      scheme,
    ],
    queryFn: () =>
      fileDiff({
        workspaceId,
        branch: selection!.branch,
        parent: selection!.parent,
        path: selection!.file.path,
        oldPath: selection!.file.oldPath,
        syntaxTheme: appearance.syntaxTheme,
        scheme,
      }),
    enabled: selection !== null,
    staleTime: 30_000,
  });

  const screen = { flex: 1, backgroundColor: theme.colors.surface0 };
  const muted = { color: theme.colors.foregroundMuted, fontSize: 12 };
  if (!selection) {
    return (
      <View style={[screen, { alignItems: "center", justifyContent: "center", padding: 24 }]}>
        <Text style={muted}>Expand a branch in the Graphite stack panel and pick a file.</Text>
      </View>
    );
  }

  const { file } = selection;
  const slash = file.path.lastIndexOf("/");
  const allLines = query.data?.lines ?? [];
  const lines = allLines.slice(0, MAX_LINES);
  const largestNumber = lines.reduce((max, line) => Math.max(max, line.oldNumber ?? 0, line.newNumber ?? 0), 0);
  const gutterWidth = Math.max(2, String(largestNumber).length) * Math.ceil(appearance.fontSize * 0.62) + 12;
  const code = { fontFamily: appearance.fontFamily || DEFAULT_MONO, fontSize: appearance.fontSize, lineHeight };

  return (
    <View style={screen}>
      <View
        style={{
          height: HEADER_HEIGHT,
          flexDirection: "row",
          alignItems: "center",
          paddingLeft: 12,
          paddingRight: 8,
          gap: 8,
          borderBottomWidth: 1,
          borderBottomColor: theme.colors.border,
        }}
      >
        <Text numberOfLines={1} style={{ flex: 1, fontSize: 14 }}>
          <Text style={{ color: theme.colors.foreground }}>{file.path.slice(slash + 1)}</Text>
          {slash >= 0 ? <Text style={{ color: theme.colors.foregroundMuted }}> {file.path.slice(0, slash)}</Text> : null}
        </Text>
        <DiffStat additions={file.additions} deletions={file.deletions} theme={theme} />
        <ChangeIcon status={file.status} theme={theme} />
      </View>

      {query.isPending ? (
        <ActivityIndicator color={theme.colors.accent} style={{ marginTop: 24 }} />
      ) : query.error ? (
        <Text style={{ color: theme.colors.statusDanger, fontSize: 12, padding: 12 }}>{String(query.error)}</Text>
      ) : lines.length === 0 ? (
        <Text style={[muted, { padding: 12 }]}>
          {file.additions === null ? "Binary file, no text diff." : "No line changes (only a rename or mode change)."}
        </Text>
      ) : (
        <ScrollView>
          <View style={{ flexDirection: "row", borderBottomWidth: 1, borderBottomColor: theme.colors.border }}>
            {/* The gutter stays put while the code scrolls sideways, as in Paseo. */}
            <View style={{ width: gutterWidth, borderRightWidth: 1, borderRightColor: theme.colors.border }}>
              {lines.map((line, index) => {
                const style = lineStyle(line, theme);
                const number = line.kind === "delete" ? line.oldNumber : line.kind === "hunk" || line.kind === "note" ? null : line.newNumber;
                return (
                  <Text
                    key={index}
                    style={[code, { height: lineHeight, paddingRight: NUMBER_RIGHT_INSET, textAlign: "right", color: style.number, backgroundColor: style.background }]}
                  >
                    {number ?? ""}
                  </Text>
                );
              })}
            </View>
            <HorizontalScroll
              horizontal
              style={{ flex: 1 }}
              onLayout={(event) => setCodeWidth(event.nativeEvent.layout.width)}
              contentContainerStyle={{ minWidth: codeWidth, flexDirection: "column" }}
            >
              {lines.map((line, index) => (
                <Text
                  key={index}
                  style={[
                    code,
                    {
                      height: lineHeight,
                      paddingLeft: CODE_LEFT_PADDING,
                      paddingRight: CODE_RIGHT_PADDING,
                      color: line.kind === "hunk" || line.kind === "note" ? theme.colors.foregroundMuted : theme.colors.foreground,
                      backgroundColor: lineStyle(line, theme).background,
                    },
                    noWrap,
                  ]}
                >
                  {line.tokens
                    ? line.tokens.map((token, tokenIndex) => (
                        <Text key={tokenIndex} style={token.color ? { color: token.color } : undefined}>
                          {token.text}
                        </Text>
                      ))
                    : line.text || " "}
                </Text>
              ))}
            </HorizontalScroll>
          </View>
          {allLines.length > MAX_LINES ? (
            <Text style={[muted, { padding: 12 }]}>
              Showing the first {MAX_LINES.toLocaleString()} of {allLines.length.toLocaleString()} lines.
            </Text>
          ) : null}
        </ScrollView>
      )}
    </View>
  );
}

// React Native's types reject white-space; on web it keeps long lines on one row.
const noWrap = (Platform.OS === "web" ? { whiteSpace: "pre" } : {}) as object;
