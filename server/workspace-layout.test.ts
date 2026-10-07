import assert from "node:assert/strict";
import { test } from "node:test";

import { rememberedAgent, screenAgents } from "../shared/workspace-layout.ts";

const pane = (id: string, focusedTabId: string, targets: Record<string, object>, extra: object = {}) => ({
  kind: "pane",
  pane: {
    id,
    tabIds: Object.keys(targets),
    focusedTabId,
    tabs: Object.entries(targets).map(([tabId, target]) => ({ tabId, target, createdAt: 1 })),
    ...extra,
  },
});
const group = (...children: object[]) => ({
  kind: "group",
  group: { id: "workspace-root", direction: "horizontal", children, sizes: children.map(() => 1 / children.length) },
});

test("the focused pane's agent, and every agent shown in a pane", () => {
  const raw = JSON.stringify({
    state: {
      layoutByWorkspace: {
        "srv_1:wks_a": {
          root: group(
            pane("main", "t2", { t1: { kind: "agent", agentId: "agent-1" }, t2: { kind: "agent", agentId: "agent-2" } }),
            pane("side", "t3", {
              t3: { kind: "plugin", pluginId: "paseo-graphite", panelId: "graphite-diff", context: "workspace" },
            }),
            pane("split", "t4", { t4: { kind: "plugin", pluginId: "x", panelId: "y", context: "agent", agentId: "agent-4" } }),
            pane("hidden", "t5", { t5: { kind: "agent", agentId: "agent-5" } }, { hidden: true }),
          ),
          focusedPaneId: "side",
        },
        "srv_1:wks_b": { root: pane("main", "t9", { t9: { kind: "agent", agentId: "agent-9" } }), focusedPaneId: "main" },
      },
    },
    version: 3,
  });
  assert.deepEqual(Object.fromEntries(screenAgents(raw)), {
    "srv_1:wks_a": { focused: null, shown: ["agent-2", "agent-4"] },
    "srv_1:wks_b": { focused: "agent-9", shown: ["agent-9"] },
  });
});

test("missing or unreadable layouts yield nothing", () => {
  assert.equal(screenAgents(null).size, 0);
  assert.equal(screenAgents("{not json").size, 0);
  assert.equal(screenAgents(JSON.stringify({ state: { layoutByWorkspace: 3 } })).size, 0);
});

test("the agent on screen is remembered until another one shows", () => {
  // Focus is in the Explorer while the agent shows in the main pane.
  assert.equal(rememberedAgent(undefined, { focused: null, shown: ["a"] }), "a");
  // The diff tab now covers it.
  assert.equal(rememberedAgent("a", { focused: null, shown: [] }), "a");
  assert.equal(rememberedAgent("a", { focused: "b", shown: ["a", "b"] }), "b");
  assert.equal(rememberedAgent("b", { focused: null, shown: ["a", "b"] }), "b");
  assert.equal(rememberedAgent("c", { focused: null, shown: ["a"] }), "a");
  assert.equal(rememberedAgent("a", undefined), "a");
});
