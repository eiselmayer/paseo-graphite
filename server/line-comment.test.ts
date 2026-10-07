import assert from "node:assert/strict";
import { test } from "node:test";

import {
  commentContext,
  commentsMessage,
  commentTitle,
  lineReference,
  parseCommentsMessage,
  rangeWithinHunk,
  rowAtOffset,
  selectLines,
  workspaceFileDragPayload,
} from "../shared/line-comment.ts";
import { parsePatch } from "../shared/patch.ts";

const lines = parsePatch(
  [
    "diff --git a/src/cache.ts b/src/cache.ts",
    "--- a/src/cache.ts",
    "+++ b/src/cache.ts",
    "@@ -40,4 +40,6 @@ export class Store {",
    " const a = 1;",
    "-const old = 2;",
    "+const cache = new Map<string, Entry>();",
    "+export function read(key: string) {",
    "+  return cache.get(key);",
    " }",
    "@@ -90,2 +92,2 @@",
    " x",
    "-y",
    "+z",
  ].join("\n"),
).map((line) => ({ ...line, tokens: null }));
const source = { branch: "feature-b", parent: "feature-a", base: null, path: "src/cache.ts", oldPath: null };

test("a range stops at the hunk edge in either direction", () => {
  assert.deepEqual(rangeWithinHunk(lines, 3, 10), { start: 3, end: 6 });
  assert.deepEqual(rangeWithinHunk(lines, 9, 0), { start: 8, end: 9 });
  assert.deepEqual(rangeWithinHunk(lines, 4, 4), { start: 4, end: 4 });
});

test("added and mixed lines count in the branch, removed-only lines in the merge base", () => {
  const added = selectLines(lines, { start: 3, end: 5 }, source);
  assert.deepEqual(
    { ref: added?.ref, file: added?.file, start: added?.startLine, end: added?.endLine, removed: added?.removed },
    { ref: "feature-b", file: "src/cache.ts", start: 41, end: 43, removed: false },
  );

  const removed = selectLines(lines, { start: 2, end: 2 }, { ...source, path: "src/new.ts", oldPath: "src/cache.ts" });
  assert.deepEqual(
    { ref: removed?.ref, file: removed?.file, start: removed?.startLine, end: removed?.endLine },
    { ref: "feature-a", file: "src/cache.ts", start: 41, end: 41 },
  );

  assert.equal(selectLines(lines, { start: 0, end: 0 }, source), null);
});

test("the agent gets the branch, the line numbers and the lines", () => {
  const selection = selectLines(lines, { start: 2, end: 5 }, source)!;
  assert.equal(commentTitle(selection, source), "feature-b · src/cache.ts:41-43");
  assert.equal(
    commentContext(selection, source),
    [
      "Comment on Graphite branch feature-b (its parent is feature-a)",
      "src/cache.ts, lines 41-43 in feature-b:",
      "```",
      "41 - const old = 2;",
      "41 + const cache = new Map<string, Entry>();",
      "42 + export function read(key: string) {",
      "43 +   return cache.get(key);",
      "```",
    ].join("\n"),
  );

  const single = selectLines(lines, { start: 9, end: 9 }, source)!;
  assert.match(commentContext(single, source), /^src\/cache\.ts, line 91 in feature-a \(removed in feature-b\):$/m);

  // The parent may have moved on; deleted lines are numbered as at the merge base.
  const forked = { ...source, base: "0123456789abcdef0123456789abcdef01234567" };
  const atBase = selectLines(lines, { start: 9, end: 9 }, forked)!;
  assert.equal(atBase.ref, "0123456789");
  assert.match(
    commentContext(atBase, forked),
    /^src\/cache\.ts, line 91 at 0123456789, where feature-b branches off feature-a \(removed in feature-b\):$/m,
  );
});

test("the code fence outgrows backticks in the code", () => {
  const markdown = parsePatch("@@ -1 +1 @@\n+```ts").map((line) => ({ ...line, tokens: null }));
  const context = commentContext(selectLines(markdown, { start: 1, end: 1 }, source)!, source);
  assert.deepEqual(context.split("\n").slice(2), ["````", "1 + ```ts", "````"]);
});

test("rows by vertical offset, skipping the comment box gap", () => {
  assert.equal(rowAtOffset(-5, 18, 11, null), 0);
  assert.equal(rowAtOffset(17.9, 18, 11, null), 0);
  assert.equal(rowAtOffset(18, 18, 11, null), 1);
  assert.equal(rowAtOffset(1_000, 18, 11, null), 10);
  const gap = { afterRow: 2, height: 100 };
  assert.equal(rowAtOffset(53, 18, 11, gap), 2);
  assert.equal(rowAtOffset(60, 18, 11, gap), 2);
  assert.equal(rowAtOffset(154, 18, 11, gap), 3);
});

test("dragged lines become a workspace-file attachment that names the branch", () => {
  const selection = selectLines(lines, { start: 3, end: 5 }, source)!;
  assert.deepEqual(JSON.parse(workspaceFileDragPayload({ serverId: "srv_1", workspaceId: "wks_1", selection })), {
    version: 1,
    serverId: "srv_1",
    workspaceId: "wks_1",
    attachment: {
      kind: "workspace_file",
      path: "feature-b:src/cache.ts",
      selection: { kind: "line_range", startLine: 41, endLine: 43 },
    },
  });
  assert.equal(lineReference(selection), "feature-b:src/cache.ts:41-43");
});

test("one message carries every comment with its location, and the chat reads them back", () => {
  const first = { text: "  why is it 28?\n\nand not 30?  ", ref: "feature/cache-days", file: "src/cache.ts", startLine: 36, endLine: 36 };
  const second = { text: "Rename this.", ref: "0123456789", file: "src/old.ts", startLine: 41, endLine: 43 };
  const message = commentsMessage([first, second]);
  assert.equal(
    message,
    [
      "why is it 28?",
      "",
      "and not 30?",
      "",
      "(Graphite diff comment on feature/cache-days:src/cache.ts, line 36)",
      "",
      "Rename this.",
      "",
      "(Graphite diff comment on 0123456789:src/old.ts, lines 41-43)",
    ].join("\n"),
  );
  assert.deepEqual(parseCommentsMessage(message), [
    { ...first, text: "why is it 28?\n\nand not 30?" },
    second,
  ]);

  assert.equal(parseCommentsMessage("why is it 28?"), null);
  // A location line with no comment, or the user's own text after the last one, is not ours.
  assert.equal(parseCommentsMessage("(Graphite diff comment on main:a.ts, line 1)"), null);
  assert.equal(parseCommentsMessage(`${message}\n\nThanks!`), null);
});
