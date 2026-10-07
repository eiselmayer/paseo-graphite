import {
  type PluginWorkspacePanelProps,
  usePaseo,
  useRpc,
  useWorkspace,
} from "@getpaseo/plugin/client";
import { Icon, useToast } from "@getpaseo/plugin/client/react-native";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, Text, View } from "react-native";
import {
  checkoutBranch,
  countProblems,
  fixableBranches,
  getStack,
  trackBranch,
} from "../shared/contracts";
import { agentsOnScreen, defaultAgent, trackScreenAgents, workspaceAgents } from "./agent-target";
import { BranchChanges } from "./branch-changes";
import { MenuRow } from "./comment-box";
import { dispatchFixAll, sendFixAll } from "./fix-all";
import { CompactPrRow } from "./pr-row";
import { withTimeout } from "./timeout";
import { publishStack, stackQueryKey } from "./status";

function Count({
  label,
  value,
  color,
  theme,
}: {
  label: string;
  value: number;
  color: string;
  theme: PluginWorkspacePanelProps["theme"];
}) {
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 4 }}>
      <Text style={{ color, fontSize: 12, fontWeight: "700" }}>{value}</Text>
      <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11 }}>{label}</Text>
    </View>
  );
}

// The server gives gt 30 seconds; this leaves room for the round trip.
const GT_TIMEOUT_MS = 45_000;

// Fix All's target when the user picks a fresh agent over an existing session.
const NEW_AGENT = "new";

export function GraphiteStackPanel({
  theme,
  layout,
  host,
  workspaceId,
  navigation,
}: PluginWorkspacePanelProps) {
  const workspace = useWorkspace(workspaceId, ({ name }) => ({ name }));
  const paseo = usePaseo();
  const toast = useToast();
  const inspect = useRpc(getStack);
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: stackQueryKey(workspaceId),
    queryFn: () => inspect({ workspaceId }),
    staleTime: 30_000,
    refetchInterval: 60_000,
  });
  const refresh = useMutation({
    mutationFn: () => inspect({ workspaceId, refresh: true }),
    onSuccess(data) {
      queryClient.setQueryData(stackQueryKey(workspaceId), data);
      publishStack(data);
    },
  });
  // Commands answer once gt is done; the server drops its cached stack, so a plain refetch reads it fresh.
  const reloadStack = () => queryClient.invalidateQueries({ queryKey: stackQueryKey(workspaceId) });
  const trackCurrent = useRpc(trackBranch);
  const track = useMutation({
    mutationFn: () =>
      withTimeout(trackCurrent({ workspaceId }), GT_TIMEOUT_MS, "gt track did not answer. Refresh to see if it worked."),
    onSuccess() {
      toast.show("Branch tracked with Graphite", { variant: "success" });
      void reloadStack();
    },
    onError(error) {
      toast.error(error instanceof Error ? error.message : "Could not track the branch.");
    },
  });
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const toggleExpanded = (branch: string) =>
    setExpanded((current) => {
      const next = new Set(current);
      if (!next.delete(branch)) next.add(branch);
      return next;
    });
  const checkoutRpc = useRpc(checkoutBranch);
  const checkout = useMutation({
    mutationFn: (branch: string) =>
      withTimeout(checkoutRpc({ workspaceId, branch }), GT_TIMEOUT_MS, "gt checkout did not answer. Refresh to see if it worked."),
    onSuccess(_data, branch) {
      toast.show(`Checked out ${branch}`, { variant: "success" });
      void reloadStack();
    },
    onError(error) {
      toast.error(error instanceof Error ? error.message : "Could not check out the branch.");
    },
  });
  // Fix All goes to the session picked under its button: by default the one the user was last in.
  useEffect(trackScreenAgents, []);
  const [fixTarget, setFixTarget] = useState<string | null>(null);
  const [choosingTarget, setChoosingTarget] = useState(false);
  const canFix = Boolean(query.data?.available && fixableBranches(query.data).length > 0);
  const agentsQuery = useQuery({
    queryKey: ["paseo-graphite", "agents", workspaceId],
    queryFn: () => workspaceAgents(paseo, workspaceId),
    enabled: canFix,
    staleTime: 5_000,
  });
  const agentChoices = (agentsQuery.data ?? []).map((agent) => ({
    id: agent.id,
    title: agent.title?.trim() || "Untitled agent",
  }));
  const target = fixTarget ?? defaultAgent(agentsQuery.data ?? [], agentsOnScreen(host.id, workspaceId)) ?? NEW_AGENT;
  const targetTitle =
    target === NEW_AGENT ? "a new agent" : (agentChoices.find((choice) => choice.id === target)?.title ?? "the agent");
  const fixAll = useMutation({
    mutationFn: async () => {
      if (!query.data) throw new Error("The stack is still loading.");
      if (target === NEW_AGENT) {
        return { agentId: await dispatchFixAll(paseo, workspaceId, query.data), outcome: "started" as const, agentTitle: "" };
      }
      return { agentId: target, ...(await sendFixAll(paseo, workspaceId, target, query.data)) };
    },
    onSuccess({ agentId, outcome, agentTitle }) {
      if (outcome === "started") toast.show("Fix All agent started", { variant: "success" });
      else if (outcome === "sent") toast.show(`Fix All sent to ${agentTitle}`, { variant: "success" });
      else toast.show(`${agentTitle} is working. Fix All goes out when it finishes.`, { variant: "info" });
      navigation?.openAgent({ agentId });
    },
    onError(error) {
      toast.error(error instanceof Error ? error.message : "Could not run Fix All.");
    },
  });
  useEffect(() => {
    if (query.data) publishStack(query.data);
  }, [query.data]);

  const styles = useMemo(
    () => ({
      // No fill: the Explorer host paints the sidebar color, which plugin themes do not carry.
      screen: { flex: 1 },
      content: { padding: layout.compact ? 10 : 12, gap: 9 },
      title: { color: theme.colors.foreground, fontSize: 18, fontWeight: "700" as const },
      detail: { color: theme.colors.foregroundMuted, fontSize: 11 },
    }),
    [theme, layout.compact],
  );

  if (query.isPending) {
    return (
      <View style={[styles.screen, { alignItems: "center", justifyContent: "center", gap: 10 }]}>
        <ActivityIndicator color={theme.colors.accent} />
        <Text style={styles.detail}>Reading the Graphite stack…</Text>
      </View>
    );
  }
  if (query.error) {
    return (
      <View style={[styles.screen, styles.content]}>
        <Text style={styles.title}>Graphite stack</Text>
        <Text style={{ color: theme.colors.statusDanger, fontSize: 12 }}>{String(query.error)}</Text>
        <Pressable onPress={() => query.refetch()} style={{ padding: 9, borderRadius: 8, backgroundColor: theme.colors.surface2 }}>
          <Text style={{ color: theme.colors.foreground }}>Try again</Text>
        </Pressable>
      </View>
    );
  }

  const snapshot = query.data!;
  const tracking = track.isPending || (track.isSuccess && query.isFetching);
  const problems = countProblems(snapshot);
  const fixable = fixableBranches(snapshot).length;
  const needYouColor = problems ? theme.colors.statusDanger : theme.colors.accent;
  const summaryColor = snapshot.summary.action
    ? needYouColor
    : snapshot.summary.ready
      ? theme.colors.statusSuccess
      : snapshot.summary.waiting
        ? theme.colors.statusWarning
        : theme.colors.foregroundMuted;

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
        <Icon name="GitPullRequest" size={20} color={summaryColor} />
        <View style={{ flex: 1 }}>
          <Text style={styles.title}>Graphite stack</Text>
          <Text numberOfLines={1} style={styles.detail}>{workspace?.name ?? snapshot.workspaceName}</Text>
        </View>
        {snapshot.available && fixable > 0 ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Fix review feedback and failing checks on ${fixable} pull ${fixable === 1 ? "request" : "requests"} in ${targetTitle}`}
            disabled={fixAll.isPending}
            onPress={() => fixAll.mutate()}
            style={{
              flexDirection: "row",
              alignItems: "center",
              gap: 5,
              paddingHorizontal: 9,
              paddingVertical: 7,
              borderRadius: 8,
              backgroundColor: theme.colors.accent,
              opacity: fixAll.isPending ? 0.65 : 1,
            }}
          >
            {fixAll.isPending ? (
              <ActivityIndicator size="small" color={theme.colors.accentForeground} />
            ) : (
              <Icon name="Wrench" size={14} color={theme.colors.accentForeground} />
            )}
            <Text style={{ color: theme.colors.accentForeground, fontSize: 12, fontWeight: "700" }}>
              Fix All
            </Text>
          </Pressable>
        ) : null}
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Refresh Graphite stack"
          disabled={refresh.isPending}
          onPress={() => refresh.mutate()}
          style={{ padding: 7, borderRadius: 8, backgroundColor: theme.colors.surface2 }}
        >
          <Icon name="RefreshCw" size={15} color={theme.colors.foreground} />
        </Pressable>
      </View>
      {snapshot.available && fixable > 0 ? (
        <View style={{ gap: 2 }}>
          <MenuRow
            theme={theme}
            label={`Fix All goes to ${targetTitle}. Choose another session`}
            active={choosingTarget}
            onPress={() => setChoosingTarget((open) => !open)}
            style={{ alignSelf: "flex-end", maxWidth: "100%", gap: 4, minHeight: 24, borderRadius: 8 }}
          >
            <Text style={styles.detail}>Sends to</Text>
            <Text numberOfLines={1} style={{ flexShrink: 1, color: theme.colors.foreground, fontSize: 11 }}>
              {targetTitle}
            </Text>
            <Icon name={choosingTarget ? "ChevronUp" : "ChevronDown"} size={12} color={theme.colors.foregroundMuted} />
          </MenuRow>
          {choosingTarget
            ? [...agentChoices, { id: NEW_AGENT, title: "New agent" }].map((choice) => (
                <MenuRow
                  key={choice.id}
                  theme={theme}
                  label={choice.id === NEW_AGENT ? "Start a new agent for Fix All" : `Send Fix All to ${choice.title}`}
                  onPress={() => {
                    setFixTarget(choice.id);
                    setChoosingTarget(false);
                  }}
                  style={{ gap: 8, paddingVertical: 6, borderRadius: 6 }}
                >
                  <View style={{ width: 14 }}>
                    {choice.id === target ? <Icon name="Check" size={14} color={theme.colors.accent} /> : null}
                  </View>
                  <Text numberOfLines={1} style={{ flex: 1, color: theme.colors.foreground, fontSize: 12 }}>
                    {choice.title}
                  </Text>
                </MenuRow>
              ))
            : null}
        </View>
      ) : null}

      {!snapshot.available ? (
        <View style={{ padding: 12, borderRadius: 10, gap: 5, backgroundColor: theme.colors.surface1 }}>
          <Text style={{ color: theme.colors.foreground, fontSize: 13, fontWeight: "600" }}>
            {snapshot.unavailable?.message ?? "No Graphite stack found"}
          </Text>
          {snapshot.unavailable?.hint ? <Text style={styles.detail}>{snapshot.unavailable.hint}</Text> : null}
          {snapshot.unavailable?.kind === "untracked" ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`Track ${snapshot.currentBranch ?? "this branch"} with Graphite`}
              disabled={tracking}
              onPress={() => track.mutate()}
              style={{
                alignSelf: "flex-start",
                flexDirection: "row",
                alignItems: "center",
                gap: 5,
                marginTop: 4,
                paddingHorizontal: 9,
                paddingVertical: 7,
                borderRadius: 8,
                backgroundColor: theme.colors.accent,
                opacity: tracking ? 0.65 : 1,
              }}
            >
              {tracking ? (
                <ActivityIndicator size="small" color={theme.colors.accentForeground} />
              ) : (
                <Icon name="GitBranchPlus" size={14} color={theme.colors.accentForeground} />
              )}
              <Text style={{ color: theme.colors.accentForeground, fontSize: 12, fontWeight: "700" }}>
                {track.isSuccess && query.isFetching ? "Reading stack…" : "Track with Graphite"}
              </Text>
            </Pressable>
          ) : null}
        </View>
      ) : (
        <>
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 12, paddingHorizontal: 2 }}>
            <Count label="need you" value={snapshot.summary.action} color={needYouColor} theme={theme} />
            <Count label="ready" value={snapshot.summary.ready} color={theme.colors.statusSuccess} theme={theme} />
            <Count label="waiting" value={snapshot.summary.waiting} color={theme.colors.statusWarning} theme={theme} />
            <Count label="done" value={snapshot.summary.done} color={theme.colors.foregroundMuted} theme={theme} />
          </View>
          {snapshot.unavailable?.kind === "github" ? (
            <Text style={{ color: theme.colors.statusWarning, fontSize: 11 }}>
              Partial status · {snapshot.unavailable.message}
            </Text>
          ) : null}
          <View style={{ borderWidth: 1, borderColor: theme.colors.border, borderRadius: 10, overflow: "hidden" }}>
            {snapshot.branches.map((branch) => (
              <CompactPrRow
                key={branch.branch}
                branch={branch}
                theme={theme}
                onCheckout={() => {
                  if (!checkout.isPending) checkout.mutate(branch.branch);
                }}
                checkingOut={checkout.isPending && checkout.variables === branch.branch}
                expanded={expanded.has(branch.branch)}
                onToggleExpanded={branch.parent ? () => toggleExpanded(branch.branch) : undefined}
              >
                {branch.parent ? (
                  <BranchChanges
                    workspaceId={workspaceId}
                    branch={branch.branch}
                    parent={branch.parent}
                    theme={theme}
                  />
                ) : null}
              </CompactPrRow>
            ))}
          </View>
        </>
      )}
      <Text style={[styles.detail, { textAlign: "center", paddingBottom: 4 }]}>
        Updated {new Date(snapshot.inspectedAt).toLocaleTimeString()}
      </Text>
    </ScrollView>
  );
}
