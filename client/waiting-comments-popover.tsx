import { type PluginButtonContentProps, usePaseo } from "@getpaseo/plugin/client";
import { Icon, useToast } from "@getpaseo/plugin/client/react-native";
import { useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { readTextSizes } from "./app-settings";
import { EditorButton } from "./comment-box";
import { CommentPill } from "./comment-message";
import { removeWaitingComments, sendWaitingComments, useWaitingComments } from "./waiting-comments";

/** Opened from the "N comments" pill on an agent's chat box: the comments waiting for that agent. */
export function WaitingCommentsPopover(props: PluginButtonContentProps) {
  const { theme, close } = props;
  const agentId = props.context === "agent" ? props.agentId : null;
  const paseo = usePaseo();
  const toast = useToast();
  const sizes = readTextSizes();
  const comments = useWaitingComments().filter((comment) => comment.agentId === agentId);
  const [sending, setSending] = useState(false);
  const count = comments.length === 1 ? "1 comment" : `${comments.length} comments`;

  async function send() {
    if (!agentId) return;
    setSending(true);
    try {
      const sent = await sendWaitingComments(paseo, agentId);
      if (sent.outcome === "sent") toast.show(`Sent ${count}`, { variant: "success" });
      else toast.show(`${sent.agentTitle} is working. The comments go out when it finishes.`, { variant: "info" });
      close();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not send the comments.");
    } finally {
      setSending(false);
    }
  }

  return (
    <View style={{ width: 360, maxWidth: "100%", padding: 12, gap: 12 }}>
      <Text style={{ color: theme.colors.foreground, fontSize: sizes.base, fontWeight: "600" }}>{count} to send</Text>
      <ScrollView style={{ maxHeight: 360 }} contentContainerStyle={{ gap: 12 }}>
        {comments.map((comment) => (
          <View key={comment.id} style={{ flexDirection: "row", gap: 8 }}>
            <View style={{ flex: 1, minWidth: 0, gap: 6 }}>
              <CommentPill theme={theme} comment={comment} />
              <Text numberOfLines={3} style={{ color: theme.colors.foreground, fontSize: sizes.base }}>
                {comment.text}
              </Text>
            </View>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Remove this comment"
              hitSlop={8}
              onPress={() => removeWaitingComments([comment.id])}
              style={{ padding: 4, alignSelf: "flex-start" }}
            >
              <Icon name="X" size={14} color={theme.colors.foregroundMuted} />
            </Pressable>
          </View>
        ))}
      </ScrollView>
      <View style={{ flexDirection: "row", justifyContent: "flex-end", gap: 8 }}>
        <EditorButton
          theme={theme}
          size={sizes.small}
          label="Discard all"
          variant="ghost"
          onPress={() => {
            removeWaitingComments(comments.map((comment) => comment.id));
            close();
          }}
        />
        <EditorButton
          theme={theme}
          size={sizes.small}
          label="Send"
          variant="default"
          disabled={sending || comments.length === 0}
          onPress={() => void send()}
        />
      </View>
    </View>
  );
}
