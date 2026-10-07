import type { PluginWorkspacePanelProps } from "@getpaseo/plugin/client";
import { Icon, TextInput } from "@getpaseo/plugin/client/react-native";
import { type ReactNode, type Ref, useState } from "react";
import {
  type LayoutChangeEvent,
  type NativeSyntheticEvent,
  Pressable,
  Text,
  type TextInput as NativeTextInput,
  type TextInputKeyPressEventData,
  View,
  type ViewStyle,
} from "react-native";
import { readTextSizes } from "./app-settings";
import { plainInputStyle } from "./web";

type Theme = PluginWorkspacePanelProps["theme"];

export interface AgentChoice {
  id: string;
  title: string;
  busy: boolean;
}

// Geometry of Paseo's inline review editor (packages/app/src/review/surface.tsx and geometry.ts,
// components/ui/button.tsx at size xs).
const EDITOR_MIN_HEIGHT = 132;
const INPUT_MIN_HEIGHT = 64;
const BUTTON_HEIGHT = 28;

// Web key events carry the modifier keys React Native's types leave out.
type KeyPress = TextInputKeyPressEventData & { metaKey?: boolean; ctrlKey?: boolean; shiftKey?: boolean };

export function CommentBox({
  theme,
  inputRef,
  body,
  onChangeBody,
  agents,
  agentId,
  onPickAgent,
  error,
  dragHint,
  onAdd,
  onCancel,
  onLayout,
}: {
  theme: Theme;
  inputRef: Ref<NativeTextInput>;
  body: string;
  onChangeBody: (body: string) => void;
  agents: readonly AgentChoice[];
  agentId: string | null;
  onPickAgent: (agentId: string) => void;
  error: string | null;
  dragHint: boolean;
  onAdd: () => void;
  onCancel: () => void;
  onLayout: (event: LayoutChangeEvent) => void;
}) {
  const sizes = readTextSizes();
  const [focused, setFocused] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const target = agents.find((agent) => agent.id === agentId) ?? null;
  const canAdd = body.trim().length > 0 && target !== null;
  const muted = { color: theme.colors.foregroundMuted, fontSize: sizes.small };

  // As in Paseo's editor: Escape cancels, Cmd/Ctrl+Enter submits, Enter alone is a new line.
  function handleKeyPress(event: NativeSyntheticEvent<TextInputKeyPressEventData>) {
    const key = event.nativeEvent as KeyPress;
    const submit = key.key === "Enter" && !key.shiftKey && (key.metaKey || key.ctrlKey);
    if (key.key !== "Escape" && !submit) return;
    event.preventDefault();
    event.stopPropagation();
    if (key.key === "Escape") onCancel();
    else if (canAdd) onAdd();
  }

  return (
    <View onLayout={onLayout} style={{ paddingVertical: 8, paddingHorizontal: 12 }}>
      <View
        style={{
          minHeight: EDITOR_MIN_HEIGHT,
          backgroundColor: theme.colors.surface2,
          borderWidth: 1,
          borderColor: theme.colors.border,
          borderRadius: 8,
          padding: 12,
          gap: 12,
        }}
      >
        <TextInput
          ref={inputRef}
          autoFocus
          multiline
          value={body}
          onChangeText={onChangeBody}
          onKeyPress={handleKeyPress}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          placeholder="Leave a comment"
          placeholderTextColor={theme.colors.foregroundMuted}
          accessibilityLabel="Comment for the agent"
          style={[
            {
              minHeight: INPUT_MIN_HEIGHT,
              color: theme.colors.foreground,
              backgroundColor: theme.colors.surface1,
              borderWidth: 1,
              borderColor: focused ? theme.colors.accent : theme.colors.border,
              borderRadius: 6,
              paddingHorizontal: 12,
              paddingVertical: 8,
              fontSize: sizes.content,
              lineHeight: Math.round(sizes.content * 1.4),
              textAlignVertical: "top",
            },
            plainInputStyle,
          ]}
        />
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
          <View style={{ flex: 1, flexDirection: "row" }}>
            {target ? (
              <MenuRow
                theme={theme}
                label={`Send to ${target.title}. Choose another agent`}
                active={menuOpen}
                onPress={() => setMenuOpen((open) => !open)}
                style={{ flexShrink: 1, gap: 6, minHeight: BUTTON_HEIGHT, borderRadius: 12 }}
              >
                <Icon name="Bot" size={14} color={theme.colors.foregroundMuted} />
                <Text numberOfLines={1} style={{ flexShrink: 1, color: theme.colors.foreground, fontSize: sizes.small }}>
                  {target.title}
                </Text>
                {target.busy ? <Text style={muted}>working</Text> : null}
                <Icon name={menuOpen ? "ChevronUp" : "ChevronDown"} size={14} color={theme.colors.foregroundMuted} />
              </MenuRow>
            ) : (
              <Text style={muted}>No agent in this workspace</Text>
            )}
          </View>
          <EditorButton theme={theme} size={sizes.small} label="Cancel" variant="ghost" onPress={onCancel} />
          <EditorButton
            theme={theme}
            size={sizes.small}
            label="Add"
            variant="default"
            disabled={!canAdd}
            onPress={onAdd}
          />
        </View>
        {menuOpen ? (
          <View style={{ gap: 2 }}>
            {agents.map((agent) => (
              <MenuRow
                key={agent.id}
                theme={theme}
                label={`Send to ${agent.title}`}
                onPress={() => {
                  onPickAgent(agent.id);
                  setMenuOpen(false);
                }}
                style={{ gap: 8, paddingVertical: 6, borderRadius: 6 }}
              >
                <View style={{ width: 14 }}>
                  {agent.id === agentId ? <Icon name="Check" size={14} color={theme.colors.accent} /> : null}
                </View>
                <Text numberOfLines={1} style={{ flex: 1, color: theme.colors.foreground, fontSize: sizes.small }}>
                  {agent.title}
                </Text>
                {agent.busy ? <Text style={muted}>working</Text> : null}
              </MenuRow>
            ))}
          </View>
        ) : null}
        {error ? <Text style={{ color: theme.colors.statusDanger, fontSize: sizes.small }}>{error}</Text> : null}
        {dragHint ? <Text style={muted}>Or drag the highlighted lines onto an agent's chat.</Text> : null}
      </View>
    </View>
  );
}

function MenuRow({
  theme,
  label,
  active = false,
  onPress,
  style,
  children,
}: {
  theme: Theme;
  label: string;
  active?: boolean;
  onPress: () => void;
  style: ViewStyle;
  children: ReactNode;
}) {
  const [hovered, setHovered] = useState(false);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      onHoverIn={() => setHovered(true)}
      onHoverOut={() => setHovered(false)}
      style={({ pressed }) => [
        {
          flexDirection: "row",
          alignItems: "center",
          paddingHorizontal: 8,
          backgroundColor: hovered || pressed || active ? theme.colors.surface1 : "transparent",
        },
        style,
      ]}
    >
      {children}
    </Pressable>
  );
}

export function EditorButton({
  theme,
  size,
  label,
  variant,
  disabled = false,
  onPress,
}: {
  theme: Theme;
  size: number;
  label: string;
  variant: "default" | "ghost";
  disabled?: boolean;
  onPress: () => void;
}) {
  const [hovered, setHovered] = useState(false);
  const filled = variant === "default";
  let color = theme.colors.foregroundMuted;
  if (filled) color = theme.colors.accentForeground;
  else if (hovered) color = theme.colors.foreground;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      onHoverIn={() => setHovered(true)}
      onHoverOut={() => setHovered(false)}
      hitSlop={8}
      style={({ pressed }) => ({
        minHeight: BUTTON_HEIGHT,
        paddingHorizontal: 12,
        borderRadius: 12,
        borderWidth: 1,
        alignItems: "center",
        justifyContent: "center",
        backgroundColor: filled ? theme.colors.accent : "transparent",
        borderColor: filled ? theme.colors.accent : "transparent",
        opacity: disabled ? 0.5 : pressed ? 0.85 : 1,
      })}
    >
      <Text style={{ color, fontSize: size }}>{label}</Text>
    </Pressable>
  );
}
