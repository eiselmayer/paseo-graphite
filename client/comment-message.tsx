import type { PluginTheme } from "@getpaseo/plugin";
import type { PluginClientContext, PluginTimelineItemProps } from "@getpaseo/plugin/client";
import { copyText, Icon } from "@getpaseo/plugin/client/react-native";
import { useEffect, useState } from "react";
import { Platform, Pressable, Text, View } from "react-native";
import { z } from "zod";
import { parseCommentsMessage, type SentComment } from "../shared/line-comment";
import { readTextSizes } from "./app-settings";
import { messageTextStyle, selectableRowStyle } from "./web";

/**
 * Paseo shows only the text of a message a plugin sent, so this redraws diff comments with their
 * file pill. Any plugin that hosts the diff panel can call it; the first registered one draws.
 */
export function addCommentMessages(client: PluginClientContext): void {
  client.addTimelineTransformer({
    id: "diff-comments",
    query: { itemType: "user_message" },
    transform({ item }) {
      const comments = parseCommentsMessage(item.text);
      if (!comments) return undefined;
      const data = { comments: comments.map((comment) => ({ ...comment })) };
      return { items: [{ type: "plugin", kind: "diff-comments", version: 1, data }] };
    },
  });
  client.addTimelineRenderer({
    kind: "diff-comments",
    version: 1,
    schema: sentCommentsSchema,
    Component: SentCommentsMessage,
  });
}

const sentCommentsSchema = z.object({
  comments: z.array(
    z.object({
      text: z.string(),
      ref: z.string(),
      file: z.string(),
      startLine: z.number(),
      endLine: z.number(),
    }),
  ),
});

// Paseo paints user messages in surface3, which plugin themes leave out. Each built-in theme has
// its own surface2, so look the bubble color up by it; themes from plugins use their border color
// for surface3. Values from packages/app/src/styles/theme.ts.
const BUBBLE_BY_SURFACE2: Readonly<Record<string, string>> = {
  "#f4f4f5": "#e4e4e7",
  "#272a29": "#434645",
  "#27272a": "#3f3f46",
  "#252731": "#3c3e4c",
  "#2f2d2b": "#4a4745",
  "#383c48": "#4a4f5e",
  "#111111": "#202020",
};

function bubbleColor(theme: PluginTheme): string {
  return BUBBLE_BY_SURFACE2[theme.colors.surface2.toLowerCase()] ?? theme.colors.border;
}

// Paseo's message time: "4:43 PM" today, "Wednesday 4:43 PM" this week, else with the date.
function messageTime(date: Date): string {
  const time = date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  const midnight = (day: Date) => new Date(day.getFullYear(), day.getMonth(), day.getDate()).getTime();
  const daysAgo = Math.round((midnight(new Date()) - midnight(date)) / 86_400_000);
  if (daysAgo === 0) return time;
  if (daysAgo > 0 && daysAgo < 7) return `${date.toLocaleDateString(undefined, { weekday: "long" })} ${time}`;
  return `${date.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" })}, ${time}`;
}

/** A comment's location as Paseo draws an attachment pill (packages/app/src/components/attachment-pill.tsx). */
export function CommentPill({ theme, comment }: { theme: PluginTheme; comment: Omit<SentComment, "text"> }) {
  const sizes = readTextSizes();
  const { ref, file, startLine, endLine } = comment;
  const lines = startLine === endLine ? `${startLine}` : `${startLine}-${endLine}`;
  return (
    <View style={{ alignSelf: "flex-start", borderRadius: 6, borderWidth: 1, borderColor: theme.colors.border, overflow: "hidden" }}>
      <View
        style={{
          height: 48,
          maxWidth: 260,
          flexDirection: "row",
          alignItems: "center",
          gap: 8,
          paddingHorizontal: 12,
          backgroundColor: theme.colors.surface1,
        }}
      >
        <View style={{ width: 18, alignItems: "center", justifyContent: "center" }}>
          <Icon name="FileText" size={14} color={theme.colors.foregroundMuted} />
        </View>
        <View style={{ minWidth: 0, flexShrink: 1 }}>
          <Text numberOfLines={1} style={{ color: theme.colors.foreground, fontSize: sizes.base }}>
            {file.slice(file.lastIndexOf("/") + 1)}
          </Text>
          <Text numberOfLines={1} style={{ color: theme.colors.foregroundMuted, fontSize: sizes.small }}>
            {`${ref}:${file} · ${lines}`}
          </Text>
        </View>
      </View>
    </View>
  );
}

/**
 * Comments sent from the diff, drawn as Paseo draws a message with attachments: each comment's
 * file pill above its text (packages/app/src/components/message.tsx).
 */
function SentCommentsMessage({ theme, layout, item, timestamp }: PluginTimelineItemProps<{ comments: SentComment[] }>) {
  const { comments } = item.data;
  const text = comments.map((comment) => comment.text).join("\n\n");
  const sizes = readTextSizes();
  const [hovered, setHovered] = useState(false);
  const [copied, setCopied] = useState(false);
  const [copyHovered, setCopyHovered] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1_500);
    return () => clearTimeout(timer);
  }, [copied]);
  const showActions = hovered || layout.compact || Platform.OS !== "web";

  return (
    <View style={[{ flexDirection: "row", justifyContent: "flex-end" }, selectableRowStyle]}>
      <View
        style={{ alignItems: "flex-end", maxWidth: "100%" }}
        onPointerEnter={() => setHovered(true)}
        onPointerLeave={() => setHovered(false)}
      >
        <View
          style={{
            backgroundColor: bubbleColor(theme),
            borderRadius: 16,
            borderTopRightRadius: 2,
            padding: 16,
            minWidth: 0,
            flexShrink: 1,
            gap: 16,
          }}
        >
          {comments.map((comment, index) => (
            <View key={index} style={{ gap: 8 }}>
              <CommentPill theme={theme} comment={comment} />
              <Text
                selectable
                style={[{ color: theme.colors.foreground, fontSize: sizes.content }, messageTextStyle(sizes.content)]}
              >
                {comment.text}
              </Text>
            </View>
          ))}
        </View>
        <View
          style={{
            alignSelf: "flex-end",
            flexDirection: "row",
            alignItems: "center",
            height: 24,
            gap: 8,
            marginTop: 8,
            opacity: showActions ? 1 : 0,
            pointerEvents: showActions ? "auto" : "none",
          }}
        >
          <Text style={{ color: theme.colors.foregroundMuted, fontSize: 13 }}>{messageTime(timestamp)}</Text>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={copied ? "Copied" : "Copy message"}
            onPress={() => void copyText(text).then(() => setCopied(true))}
            onHoverIn={() => setCopyHovered(true)}
            onHoverOut={() => setCopyHovered(false)}
            style={{ alignSelf: "center", padding: 4, marginRight: -4 }}
          >
            <Icon
              name={copied ? "Check" : "Copy"}
              size={14}
              color={copyHovered ? theme.colors.foreground : theme.colors.foregroundMuted}
            />
          </Pressable>
        </View>
      </View>
    </View>
  );
}
