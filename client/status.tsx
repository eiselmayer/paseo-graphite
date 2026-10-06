import {
  type PluginButtonIconProps,
  useRpc,
} from "@getpaseo/plugin/client";
import { Icon } from "@getpaseo/plugin/client/react-native";
import { useQuery } from "@tanstack/react-query";
import { useEffect } from "react";
import { View } from "react-native";
import { countProblems, getStack, type StackSnapshot } from "../shared/contracts";

type Listener = (snapshot: StackSnapshot) => void;

const latest = new Map<string, StackSnapshot>();
const listeners = new Map<string, Set<Listener>>();

export const stackQueryKey = (workspaceId: string) => ["paseo-graphite", "stack", workspaceId] as const;

export function publishStack(snapshot: StackSnapshot): void {
  latest.set(snapshot.workspaceId, snapshot);
  for (const listener of listeners.get(snapshot.workspaceId) ?? []) listener(snapshot);
}

export function subscribeStack(workspaceId: string, listener: Listener): () => void {
  const group = listeners.get(workspaceId) ?? new Set<Listener>();
  group.add(listener);
  listeners.set(workspaceId, group);
  const current = latest.get(workspaceId);
  if (current) listener(current);
  return () => {
    group.delete(listener);
    if (group.size === 0) listeners.delete(workspaceId);
  };
}

export function buttonLabel(snapshot: StackSnapshot): string {
  if (!snapshot.available) return "No Graphite stack";
  const base = `Stack ${snapshot.summary.total}`;
  if (snapshot.summary.action) return `${base} · Fix ${snapshot.summary.action}`;
  if (snapshot.summary.ready) return `${base} · Merge ${snapshot.summary.ready}`;
  return base;
}

export function buttonTitle(snapshot: StackSnapshot): string {
  if (!snapshot.available) return snapshot.unavailable?.message ?? "Graphite stack unavailable";
  return `${snapshot.summary.label} across ${snapshot.summary.total} stack ${snapshot.summary.total === 1 ? "branch" : "branches"}`;
}

export function StackStatusIcon({ workspaceId, size, color, theme }: PluginButtonIconProps) {
  const inspect = useRpc(getStack);
  const query = useQuery({
    queryKey: stackQueryKey(workspaceId),
    queryFn: () => inspect({ workspaceId }),
    staleTime: 30_000,
    refetchInterval: 60_000,
  });
  useEffect(() => {
    if (query.data) publishStack(query.data);
  }, [query.data]);

  let tint = color;
  if (query.isError || (query.data && countProblems(query.data))) tint = theme.colors.statusDanger;
  else if (query.data?.summary.action) tint = theme.colors.accent;
  else if (query.data?.summary.ready) tint = theme.colors.statusSuccess;
  else if (query.data?.summary.waiting) tint = theme.colors.statusWarning;
  else if (query.data && !query.data.available) tint = theme.colors.foregroundMuted;

  return (
    <View style={{ width: size, height: size, alignItems: "center", justifyContent: "center" }}>
      <Icon name="GitPullRequest" size={size} color={tint} />
    </View>
  );
}
