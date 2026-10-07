import { type PluginWorkspacePanelProps, useAgent, usePaseo, useRpc } from "@getpaseo/plugin/client";
import { Icon, ScrollView, useToast } from "@getpaseo/plugin/client/react-native";
import { useQuery } from "@tanstack/react-query";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  type GestureResponderEvent,
  Platform,
  Pressable,
  ScrollView as HorizontalScroll,
  Text,
  type TextInput as NativeTextInput,
  View,
} from "react-native";
import { type DiffLine, getFileDiff } from "../shared/contracts";
import {
  commentContext,
  commentTitle,
  type DiffSource,
  isCodeLine,
  lineReference,
  rangeWithinHunk,
  type RowRange,
  rowAtOffset,
  selectLines,
  WORKSPACE_FILE_DRAG_MIME,
  workspaceFileDragPayload,
} from "../shared/line-comment";
import { agentsOnScreen, defaultAgent, trackScreenAgents, workspaceAgents } from "./agent-target";
import { ChangeIcon, DiffStat } from "./branch-changes";
import { readCodeAppearance } from "./app-settings";
import { CommentBox } from "./comment-box";
import { cancelQueued, isBusy, useCommentQueue } from "./comment-queue";
import { useDiffSelection } from "./diff-store";
import { addWaitingComment, useWaitingComments, waitingComments } from "./waiting-comments";
import { bindLineDrag, bindLinePicking, grabbableStyle, type LineDrag, type LinePicking, pickableStyle } from "./web";

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
// Paseo's add-comment button, overhanging the gutter's right edge (review/surface.tsx).
const ADD_BUTTON_SIZE = 22;
const ADD_BUTTON_OVERHANG = 10;
// Room held for the comment box until it has measured itself.
const BOX_HEIGHT_GUESS = 148;
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

type Pick = { anchor: number; focus: number } | null;

function rowsKey(lines: readonly DiffLine[], range: RowRange): string {
  return lines
    .slice(range.start, range.end + 1)
    .map((line) => `${line.kind}:${line.oldNumber}:${line.newNumber}:${line.text}`)
    .join("\n");
}

export function GraphiteDiffPanel({ theme, workspaceId, host }: PluginWorkspacePanelProps) {
  const selection = useDiffSelection(workspaceId);
  const fileDiff = useRpc(getFileDiff);
  const paseo = usePaseo();
  const toast = useToast();
  const scheme = colorScheme(theme);
  // Read on every render: changing the setting in Paseo then shows on the next update here.
  const appearance = readCodeAppearance();
  const lineHeight = Math.round(appearance.fontSize * 1.5);
  const fontFamily = appearance.fontFamily || DEFAULT_MONO;
  const fontSize = appearance.fontSize;
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
  const allLines = query.data?.lines ?? [];
  const lines = useMemo(() => (query.data?.lines ?? []).slice(0, MAX_LINES), [query.data]);
  const source: DiffSource | null = selection
    ? {
        branch: selection.branch,
        parent: selection.parent,
        base: query.data?.base ?? null,
        path: selection.file.path,
        oldPath: selection.file.oldPath,
      }
    : null;

  // Lines picked for a comment, from the row a press started on to the row the pointer reached.
  // The refs let pointer handlers see a pick made since the last render.
  const [pick, setPick] = useState<Pick>(null);
  const pickRef = useRef<Pick>(null);
  const [picking, setPicking] = useState(false);
  const pickingRef = useRef(false);
  // The comment box sits under this row; null while it is closed.
  const [boxRow, setBoxRow] = useState<number | null>(null);
  const [boxHeight, setBoxHeight] = useState(BOX_HEIGHT_GUESS);
  const [hoverRow, setHoverRow] = useState<number | null>(null);
  const [body, setBody] = useState("");
  const bodyRef = useRef(body);
  bodyRef.current = body;
  // The agent picked in the box; it stays picked for the next comments.
  const [chosenAgent, setChosenAgent] = useState<string | null>(null);
  const inputRef = useRef<NativeTextInput>(null);
  // What the picked rows held when the box opened, to notice a refetched diff changing them.
  const pickedRows = useRef<string | null>(null);

  function updatePick(next: Pick) {
    pickRef.current = next;
    setPick(next);
  }
  function updatePicking(next: boolean) {
    pickingRef.current = next;
    setPicking(next);
  }
  function openBox(range: RowRange) {
    pickedRows.current = rowsKey(lines, range);
    setBoxRow(range.end);
  }
  function dropPick() {
    updatePick(null);
    updatePicking(false);
    setBoxRow(null);
    pickedRows.current = null;
  }
  function closeBox() {
    dropPick();
    setBody("");
  }

  const fileKey = selection ? [selection.branch, selection.parent, selection.file.path].join("\0") : "";
  useEffect(closeBox, [fileKey]);
  // A refetched diff can change the picked rows, as when an agent amends the branch: drop the
  // pick but keep the text. A diff still loading, as after a theme change, has no rows yet.
  useEffect(() => {
    const current = pickRef.current;
    if (!query.data || !current || pickedRows.current === null) return;
    const range = rangeWithinHunk(lines, current.anchor, current.focus);
    if (isCodeLine(lines[current.anchor]) && rowsKey(lines, range) === pickedRows.current) return;
    dropPick();
    toast.show("The diff changed. Pick the lines again.", { variant: "warning" });
  }, [lines]);
  useEffect(() => {
    if (boxRow !== null && !picking) inputRef.current?.focus();
  }, [boxRow, picking]);

  const range = pick ? rangeWithinHunk(lines, pick.anchor, pick.focus) : null;
  const picked = range && source ? selectLines(lines, range, source) : null;
  const gap = boxRow === null ? null : { afterRow: boxRow, height: boxHeight };
  const rowTop = (row: number) => row * lineHeight + (gap && row > gap.afterRow ? gap.height : 0);

  const linePicking: LinePicking = {
    rowAt(offsetY) {
      if (lines.length === 0) return null;
      const gapTop = gap ? (gap.afterRow + 1) * lineHeight : 0;
      if (gap && offsetY >= gapTop && offsetY < gapTop + gap.height) return null;
      return rowAtOffset(offsetY, lineHeight, lines.length, gap);
    },
    hover: setHoverRow,
    press(row, extend) {
      if (!isCodeLine(lines[row])) return;
      const current = pickRef.current;
      pickedRows.current = null;
      updatePicking(true);
      updatePick(extend && current ? { anchor: current.anchor, focus: row } : { anchor: row, focus: row });
    },
    drag(row) {
      const current = pickRef.current;
      if (pickingRef.current && current) updatePick({ anchor: current.anchor, focus: row });
    },
    release() {
      const current = pickRef.current;
      if (!pickingRef.current || !current) return;
      updatePicking(false);
      openBox(rangeWithinHunk(lines, current.anchor, current.focus));
    },
  };
  const linePickingRef = useRef(linePicking);
  linePickingRef.current = linePicking;
  const [rowsElement, setRowsElement] = useState<unknown>(null);
  const gutterElement = useRef<unknown>(null);
  useEffect(() => bindLinePicking(rowsElement, gutterElement, linePickingRef), [rowsElement]);
  // Phones have no hover or drag: tapping a line number picks that line.
  const tapToPick =
    Platform.OS === "web"
      ? null
      : {
          onStartShouldSetResponder: () => true,
          onResponderRelease: (event: GestureResponderEvent) => {
            const row = linePicking.rowAt(event.nativeEvent.locationY);
            if (row === null || !isCodeLine(lines[row])) return;
            updatePick({ anchor: row, focus: row });
            openBox({ start: row, end: row });
          },
        };

  // Picked lines dragged onto an agent's composer land there as an attachment instead.
  const lineDrag = useRef<LineDrag | null>(null);
  lineDrag.current =
    picked && source
      ? {
          mime: WORKSPACE_FILE_DRAG_MIME,
          payload: workspaceFileDragPayload({ serverId: host.id, workspaceId, selection: picked }),
          text: lineReference(picked),
          label: commentTitle(picked, source),
          colors: { background: theme.colors.surface2, foreground: theme.colors.foreground, border: theme.colors.border },
        }
      : null;
  const [dragElement, setDragElement] = useState<unknown>(null);
  useEffect(
    () =>
      bindLineDrag(dragElement, lineDrag, () => {
        if (!bodyRef.current.trim()) closeBox();
      }),
    [dragElement],
  );

  // While the diff is open, remember which agent the user visits last.
  useEffect(trackScreenAgents, []);
  const boxOpen = boxRow !== null;
  const agentsQuery = useQuery({
    queryKey: ["paseo-graphite", "agents", workspaceId],
    queryFn: () => workspaceAgents(paseo, workspaceId),
    enabled: boxOpen,
    staleTime: 5_000,
  });
  // Read when the box opens: the agent the user was in before coming to the diff.
  const onScreen = useMemo(() => (boxOpen ? agentsOnScreen(host.id, workspaceId) : []), [boxOpen, host.id, workspaceId]);
  const agents = agentsQuery.data ?? [];
  const waiting = useWaitingComments();
  // Comments already waiting for an agent pull the next ones to it.
  const collecting = waiting.filter((comment) => comment.workspaceId === workspaceId);
  const collectingFor = collecting[collecting.length - 1]?.agentId;
  const targetId =
    chosenAgent ??
    (collectingFor && agents.some((agent) => agent.id === collectingFor) ? collectingFor : defaultAgent(agents, onScreen));
  const targetStatus = useAgent(targetId ?? "", (agent) => agent.status);
  const choices = agents.map((agent) => ({
    id: agent.id,
    title: agent.title?.trim() || "Untitled agent",
    busy: isBusy(agent.id === targetId ? (targetStatus ?? agent.status) : agent.status),
  }));
  function addComment() {
    const target = choices.find((choice) => choice.id === targetId);
    if (!picked || !source || !target || !body.trim()) return;
    addWaitingComment({
      workspaceId,
      agentId: target.id,
      text: body.trim(),
      ref: picked.ref,
      file: picked.file,
      startLine: picked.startLine,
      endLine: picked.endLine,
      title: commentTitle(picked, source),
      context: commentContext(picked, source),
    });
    const count = waitingComments().filter((comment) => comment.agentId === target.id).length;
    toast.show(`${count} ${count === 1 ? "comment waits" : "comments wait"} for ${target.title}. Send from its chat box.`, {
      variant: "success",
    });
    closeBox();
  }
  const queued = useCommentQueue().filter((item) => item.workspaceId === workspaceId);

  const gutterWidth = useMemo(() => {
    const largestNumber = lines.reduce((max, line) => Math.max(max, line.oldNumber ?? 0, line.newNumber ?? 0), 0);
    return Math.max(2, String(largestNumber).length) * Math.ceil(fontSize * 0.62) + 12;
  }, [lines, fontSize]);
  // Built once per diff and box position, so hovering and picking only redraw the overlays.
  const columns = useMemo(() => {
    const code = { fontFamily, fontSize, lineHeight };
    const numbers: ReactNode[] = [];
    const texts: ReactNode[] = [];
    lines.forEach((line, index) => {
      const style = lineStyle(line, theme);
      const number = line.kind === "delete" ? line.oldNumber : line.kind === "hunk" || line.kind === "note" ? null : line.newNumber;
      numbers.push(
        <Text
          key={index}
          style={[code, { height: lineHeight, paddingRight: NUMBER_RIGHT_INSET, textAlign: "right", color: style.number, backgroundColor: style.background }]}
        >
          {number ?? ""}
        </Text>,
      );
      texts.push(
        <Text
          key={index}
          style={[
            code,
            {
              height: lineHeight,
              paddingLeft: CODE_LEFT_PADDING,
              paddingRight: CODE_RIGHT_PADDING,
              color: line.kind === "hunk" || line.kind === "note" ? theme.colors.foregroundMuted : theme.colors.foreground,
              backgroundColor: style.background,
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
        </Text>,
      );
      if (index === boxRow) {
        numbers.push(<View key="comment-box" style={{ height: boxHeight }} />);
        texts.push(<View key="comment-box" style={{ height: boxHeight }} />);
      }
    });
    return { numbers, texts };
  }, [lines, theme, fontFamily, fontSize, lineHeight, boxRow, boxHeight]);

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
  const settled = range !== null && boxOpen && !picking;
  const showAdd =
    Platform.OS === "web" &&
    hoverRow !== null &&
    !picking &&
    isCodeLine(lines[hoverRow]) &&
    !(settled && hoverRow >= range.start && hoverRow <= range.end);

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
      {queued.map((item) => (
        <View
          key={item.id}
          style={{
            flexDirection: "row",
            alignItems: "center",
            gap: 8,
            paddingLeft: 12,
            paddingRight: 8,
            paddingVertical: 6,
            borderBottomWidth: 1,
            borderBottomColor: theme.colors.border,
          }}
        >
          <Icon name="Clock" size={14} color={theme.colors.foregroundMuted} />
          <Text numberOfLines={1} style={[muted, { flex: 1 }]}>
            {item.what} queued for {item.agentTitle}, sent when it finishes
          </Text>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Cancel the queued ${item.what} for ${item.agentTitle}`}
            hitSlop={8}
            onPress={() => cancelQueued(item.id)}
          >
            <Text style={{ color: theme.colors.accent, fontSize: 12 }}>Cancel</Text>
          </Pressable>
        </View>
      ))}

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
          <View
            ref={setRowsElement}
            style={{ flexDirection: "row", borderBottomWidth: 1, borderBottomColor: theme.colors.border }}
          >
            {/* The gutter stays put while the code scrolls sideways, as in Paseo. */}
            <View
              ref={(node) => {
                gutterElement.current = node;
              }}
              {...tapToPick}
              style={[{ width: gutterWidth, borderRightWidth: 1, borderRightColor: theme.colors.border }, pickableStyle]}
            >
              <View style={{ pointerEvents: "none" }}>{columns.numbers}</View>
            </View>
            <HorizontalScroll
              horizontal
              style={{ flex: 1 }}
              onLayout={(event) => setCodeWidth(event.nativeEvent.layout.width)}
              contentContainerStyle={{ minWidth: codeWidth, flexDirection: "column" }}
            >
              {columns.texts}
            </HorizontalScroll>

            {range ? (
              // Picked lines: tinted numbers, an accent edge, and a neutral wash that shows on
              // added and deleted lines alike in light and dark themes.
              <View
                style={{
                  position: "absolute",
                  left: 0,
                  right: 0,
                  top: rowTop(range.start),
                  height: rowTop(range.end) + lineHeight - rowTop(range.start),
                  flexDirection: "row",
                  pointerEvents: "none",
                }}
              >
                <View style={{ width: gutterWidth, backgroundColor: theme.colors.accent, opacity: 0.28 }} />
                <View style={{ width: 2, backgroundColor: theme.colors.accent }} />
                <View style={{ flex: 1, backgroundColor: theme.colors.foreground, opacity: 0.06 }} />
              </View>
            ) : null}
            {showAdd ? (
              <View
                style={{
                  position: "absolute",
                  left: gutterWidth + ADD_BUTTON_OVERHANG - ADD_BUTTON_SIZE,
                  top: rowTop(hoverRow) + (lineHeight - ADD_BUTTON_SIZE) / 2,
                  width: ADD_BUTTON_SIZE,
                  height: ADD_BUTTON_SIZE,
                  borderRadius: 6,
                  alignItems: "center",
                  justifyContent: "center",
                  backgroundColor: theme.colors.accent,
                  pointerEvents: "none",
                }}
              >
                <Icon name="Plus" size={16} color={theme.colors.accentForeground} />
              </View>
            ) : null}
            {settled && Platform.OS === "web" ? (
              <View
                ref={setDragElement}
                accessibilityLabel="Drag these lines onto an agent's chat"
                style={[
                  {
                    position: "absolute",
                    left: gutterWidth,
                    right: 0,
                    top: rowTop(range.start),
                    height: rowTop(range.end) + lineHeight - rowTop(range.start),
                  },
                  grabbableStyle,
                ]}
              />
            ) : null}
            {boxRow !== null ? (
              <View
                style={{
                  position: "absolute",
                  left: 0,
                  right: 0,
                  top: (boxRow + 1) * lineHeight,
                  backgroundColor: theme.colors.surface0,
                }}
              >
                <CommentBox
                  theme={theme}
                  inputRef={inputRef}
                  body={body}
                  onChangeBody={setBody}
                  agents={choices}
                  agentId={targetId}
                  onPickAgent={setChosenAgent}
                  error={agentsQuery.error ? String(agentsQuery.error) : null}
                  dragHint={Platform.OS === "web"}
                  onAdd={addComment}
                  onCancel={closeBox}
                  onLayout={(event) => setBoxHeight(Math.ceil(event.nativeEvent.layout.height))}
                />
              </View>
            ) : null}
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
