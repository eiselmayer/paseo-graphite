// Paseo saves each workspace's tab layout in localStorage under this key on web and desktop.
// The shape is the app's own (packages/app/src/stores/workspace-layout-store.ts), so it is read
// defensively: anything unexpected yields no agents.
export const WORKSPACE_LAYOUT_KEY = "workspace-layout-state";

export interface ScreenAgents {
  /** The agent tab selected in the focused pane, when that pane shows an agent. */
  focused: string | null;
  /** Agent tabs selected in any visible pane, in layout order. */
  shown: string[];
}

type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json => typeof value === "object" && value !== null;

// Agent tabs, and plugin panels opened for an agent, as the app's Command Center counts them.
function agentOf(target: unknown): string | null {
  if (!isObject(target) || typeof target.agentId !== "string") return null;
  if (target.kind === "agent") return target.agentId;
  return target.kind === "plugin" && target.context === "agent" ? target.agentId : null;
}

function panesOf(node: unknown, found: Json[] = []): Json[] {
  if (!isObject(node)) return found;
  if (node.kind === "pane" && isObject(node.pane)) found.push(node.pane);
  if (node.kind === "group" && isObject(node.group) && Array.isArray(node.group.children)) {
    for (const child of node.group.children) panesOf(child, found);
  }
  return found;
}

/**
 * The agent to remember for a workspace after a fresh look at its layout: the focused pane's
 * agent, else the remembered one while it stays on screen, else any agent on screen. With no
 * agent on screen, as when the diff tab covers the agent's, the earlier one stays.
 */
export function rememberedAgent(previous: string | undefined, agents: ScreenAgents | undefined): string | undefined {
  if (!agents) return previous;
  if (agents.focused) return agents.focused;
  if (previous && agents.shown.includes(previous)) return previous;
  return agents.shown[0] ?? previous;
}

/** Agents on screen in each saved layout, keyed like the app: `<serverId>:<workspaceId>`. */
export function screenAgents(raw: string | null): Map<string, ScreenAgents> {
  const result = new Map<string, ScreenAgents>();
  let layouts: unknown;
  try {
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    layouts = isObject(parsed) && isObject(parsed.state) ? parsed.state.layoutByWorkspace : null;
  } catch {
    return result;
  }
  if (!isObject(layouts)) return result;
  for (const [key, layout] of Object.entries(layouts)) {
    if (!isObject(layout)) continue;
    const agents: ScreenAgents = { focused: null, shown: [] };
    for (const pane of panesOf(layout.root)) {
      if (pane.hidden === true || !Array.isArray(pane.tabs)) continue;
      const tab: unknown = pane.tabs.find((candidate) => isObject(candidate) && candidate.tabId === pane.focusedTabId);
      const agentId = isObject(tab) ? agentOf(tab.target) : null;
      if (!agentId) continue;
      agents.shown.push(agentId);
      if (pane.id === layout.focusedPaneId) agents.focused = agentId;
    }
    result.set(key, agents);
  }
  return result;
}
