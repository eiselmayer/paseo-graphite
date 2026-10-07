import type { PluginClientContext } from "@getpaseo/plugin/client";
import { Platform } from "react-native";
import { rememberedAgent, screenAgents, WORKSPACE_LAYOUT_KEY } from "../shared/workspace-layout";
import { readAppStorage } from "./web";

type PaseoApi = PluginClientContext["paseo"];
type AgentPage = Awaited<ReturnType<PaseoApi["agents"]["list"]>>;
type PaseoAgent = AgentPage["entries"][number]["agent"];

// Paseo does not tell plugins which agent is on screen; its saved tab layout does, on web and
// desktop. The app writes it from this same window, which fires no storage event, so poll.
const POLL_MS = 1_000;
// Paseo labels a subagent with its parent; comments go to the agents the user talks to.
const PARENT_AGENT_LABEL = "paseo.parent-agent-id";

// Per layout key: the agent last on screen, kept while a non-agent tab such as the diff covers it.
const remembered = new Map<string, string>();
let shown = new Map<string, string[]>();
let lastRaw: string | null | undefined;

export function sampleScreenAgents(): void {
  const raw = readAppStorage(WORKSPACE_LAYOUT_KEY);
  if (raw === lastRaw) return;
  lastRaw = raw;
  const next = new Map<string, string[]>();
  for (const [key, agents] of screenAgents(raw)) {
    const agentId = rememberedAgent(remembered.get(key), agents);
    if (agentId) remembered.set(key, agentId);
    next.set(key, agents.shown);
  }
  shown = next;
}

let trackers = 0;
let timer: ReturnType<typeof setInterval> | null = null;

/** Follows focus while something needs it; every caller gets its own stop function. */
export function trackScreenAgents(): () => void {
  if (Platform.OS !== "web") return () => {};
  sampleScreenAgents();
  trackers += 1;
  timer ??= setInterval(sampleScreenAgents, POLL_MS);
  let stopped = false;
  return () => {
    if (stopped) return;
    stopped = true;
    trackers -= 1;
    if (trackers === 0 && timer) {
      clearInterval(timer);
      timer = null;
    }
  };
}

/** Agents to address first: the one last on screen in the workspace, then any others on screen. */
export function agentsOnScreen(serverId: string, workspaceId: string): string[] {
  sampleScreenAgents();
  const key = `${serverId}:${workspaceId}`;
  const last = remembered.get(key);
  return [...new Set([...(last ? [last] : []), ...(shown.get(key) ?? [])])];
}

const lastMessaged = (agent: PaseoAgent) => agent.lastUserMessageAt ?? agent.updatedAt;

// The agent directory cannot filter by workspace, so read all of it, within reason.
const MAX_AGENT_PAGES = 20;

/** The workspace's agents, most recently messaged first. */
export async function workspaceAgents(paseo: PaseoApi, workspaceId: string): Promise<PaseoAgent[]> {
  const agents: PaseoAgent[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < MAX_AGENT_PAGES; page++) {
    const { entries, pageInfo }: AgentPage = await paseo.agents.list({
      filter: { includeArchived: false },
      page: { limit: 200, ...(cursor ? { cursor } : {}) },
    });
    agents.push(...entries.map(({ agent }) => agent));
    cursor = pageInfo.hasMore ? pageInfo.nextCursor : null;
    if (!cursor) break;
  }
  return agents
    .filter((agent) => agent.workspaceId === workspaceId && !agent.archivedAt && !agent.labels[PARENT_AGENT_LABEL])
    .sort((left, right) => lastMessaged(right).localeCompare(lastMessaged(left)));
}

/** The agent on screen, else the one messaged last: what phones, without a saved layout, get. */
export function defaultAgent(agents: readonly PaseoAgent[], onScreen: readonly string[]): string | null {
  return onScreen.find((id) => agents.some((agent) => agent.id === id)) ?? agents[0]?.id ?? null;
}
