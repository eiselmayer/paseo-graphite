import assert from "node:assert/strict";
import { test } from "node:test";

import { formatDiffCount, treeRows } from "../shared/diff-tree.ts";

const file = (path: string, additions = 1, deletions = 0) => ({ path, additions, deletions });
const labels = (rows: ReturnType<typeof treeRows>) =>
  rows.map((row) => `${"  ".repeat(row.depth)}${row.kind === "folder" ? `${row.name}/ +${row.additions}` : row.name}`);

test("folders first, ASCII order, single-child chains merged like Paseo's Changes panel", () => {
  const rows = treeRows(
    [
      file("automations/patient-sync/sidekick-jobs/agent.ts", 157, 5),
      file("automations/patient-sync/sidekick-jobs/AGENTS.md", 8, 1),
      file("automations/patient-sync/cerbo.ts", 24, 8),
      file("README.md"),
      file("apps/api/src/main.ts"),
    ],
    new Set(),
  );
  assert.deepEqual(labels(rows), [
    "apps/api/src/ +1",
    "  main.ts",
    "automations/patient-sync/ +189",
    "  sidekick-jobs/ +165",
    "    AGENTS.md",
    "    agent.ts",
    "  cerbo.ts",
    "README.md",
  ]);
});

test("collapsed folders hide their children but keep totals", () => {
  const rows = treeRows([file("a/b/x.ts", 3, 2), file("a/c.ts", 1, 1)], new Set(["a"]));
  assert.deepEqual(rows, [{ kind: "folder", dirPath: "a", name: "a", depth: 0, additions: 4, deletions: 3 }]);
});

test("compact counts", () => {
  assert.equal(formatDiffCount(157), "157");
  assert.equal(formatDiffCount(1290), "1.3k");
});
