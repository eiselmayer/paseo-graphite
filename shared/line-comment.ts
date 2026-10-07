import { z } from "zod";
import type { DiffLine } from "./contracts";

/** Diff rows a comment can point at: code, not hunk headers or "no newline" notes. */
export function isCodeLine(line: DiffLine | undefined): boolean {
  return line?.kind === "add" || line?.kind === "delete" || line?.kind === "context";
}

/** Inclusive row indices into the diff's lines. */
export interface RowRange {
  start: number;
  end: number;
}

/** Rows from `anchor` toward `focus`, stopped at the hunk edge, so the line numbers stay contiguous. */
export function rangeWithinHunk(lines: readonly DiffLine[], anchor: number, focus: number): RowRange {
  const step = focus < anchor ? -1 : 1;
  let reach = anchor;
  while (reach !== focus && isCodeLine(lines[reach + step])) reach += step;
  return step > 0 ? { start: anchor, end: reach } : { start: reach, end: anchor };
}

/** The row at `offsetY` in a column of equal rows, with an optional gap (the comment box) after one row. */
export function rowAtOffset(
  offsetY: number,
  lineHeight: number,
  rowCount: number,
  gap: { afterRow: number; height: number } | null,
): number {
  let y = offsetY;
  if (gap) {
    const gapTop = (gap.afterRow + 1) * lineHeight;
    if (y >= gapTop && y < gapTop + gap.height) return gap.afterRow;
    if (y >= gapTop + gap.height) y -= gap.height;
  }
  return Math.min(rowCount - 1, Math.max(0, Math.floor(y / lineHeight)));
}

export interface DiffSource {
  branch: string;
  parent: string;
  /** Merge base of parent and branch: the diff starts there, so it numbers the deleted lines. */
  base: string | null;
  path: string;
  oldPath: string | null;
}

// git takes an abbreviated commit wherever it takes a branch name.
const shortCommit = (sha: string) => sha.slice(0, 10);

export interface LineSelection {
  /** Branch or commit whose version of `file` the line numbers count in. */
  ref: string;
  file: string;
  startLine: number;
  endLine: number;
  /** Every selected line was deleted, so the numbers count in the merge base's version. */
  removed: boolean;
  rows: DiffLine[];
}

export function selectLines(lines: readonly DiffLine[], range: RowRange, source: DiffSource): LineSelection | null {
  const rows = lines.slice(range.start, range.end + 1).filter(isCodeLine);
  if (rows.length === 0) return null;
  const kept = rows.flatMap((row) => (row.newNumber === null ? [] : [row.newNumber]));
  const removed = kept.length === 0;
  const numbers = removed ? rows.flatMap((row) => (row.oldNumber === null ? [] : [row.oldNumber])) : kept;
  return {
    ref: removed ? (source.base ? shortCommit(source.base) : source.parent) : source.branch,
    file: removed ? (source.oldPath ?? source.path) : source.path,
    startLine: Math.min(...numbers),
    endLine: Math.max(...numbers),
    removed,
    rows,
  };
}

function lineSpan({ startLine, endLine }: LineSelection): string {
  return startLine === endLine ? `${startLine}` : `${startLine}-${endLine}`;
}

/** Short label for the attachment pill, like `feature-b · src/cache.ts:42-44`. */
export function commentTitle(selection: LineSelection, source: DiffSource): string {
  return `${source.branch} · ${selection.file}:${lineSpan(selection)}`;
}

/** What the agent reads after the comment: where the lines are and the lines themselves. */
export function commentContext(selection: LineSelection, source: DiffSource): string {
  const lines = `${selection.startLine === selection.endLine ? "line" : "lines"} ${lineSpan(selection)}`;
  let where = `${selection.file}, ${lines} in ${source.branch}:`;
  if (selection.removed) {
    // The parent may have moved on since the branch left it; the merge base is what the diff shows.
    const version = source.base
      ? `at ${selection.ref}, where ${source.branch} branches off ${source.parent}`
      : `in ${source.parent}`;
    where = `${selection.file}, ${lines} ${version} (removed in ${source.branch}):`;
  }
  // Numbered like the diff gutter: deleted lines by their old number, the rest by their new one.
  const numbers = selection.rows.map((row) => String((row.kind === "delete" ? row.oldNumber : row.newNumber) ?? ""));
  const width = Math.max(...numbers.map((number) => number.length));
  const code = selection.rows.map((row, index) => {
    const marker = row.kind === "add" ? "+" : row.kind === "delete" ? "-" : " ";
    return `${numbers[index].padStart(width)} ${marker} ${row.text}`;
  });
  const longestTicks = Math.max(0, ...code.flatMap((line) => line.match(/`+/g) ?? []).map((run) => run.length));
  const fence = "`".repeat(Math.max(3, longestTicks + 1));
  return [`Comment on Graphite branch ${source.branch} (its parent is ${source.parent})`, where, fence, ...code, fence].join(
    "\n",
  );
}

// Paseo's timeline keeps a message's text but not its attachments, so each comment's location also
// rides in the text, on the line after the comment. The agent reads it; the plugin turns it back
// into a file pill in the chat (client/comment-message.tsx).
const LOCATION_LINES = /^\(Graphite diff comment on ([^\s:]+):(.+), lines? (\d+)(?:-(\d+))?\)$/gm;

export interface SentComment {
  text: string;
  ref: string;
  file: string;
  startLine: number;
  endLine: number;
}

/** One message for any number of comments: each comment, then its location line. */
export function commentsMessage(comments: readonly SentComment[]): string {
  return comments
    .map(({ text, ref, file, startLine, endLine }) => {
      const lines = startLine === endLine ? `line ${startLine}` : `lines ${startLine}-${endLine}`;
      return `${text.trim()}\n\n(Graphite diff comment on ${ref}:${file}, ${lines})`;
    })
    .join("\n\n");
}

/** A comment written on the diff, waiting with its agent until the user sends them all. */
export const waitingCommentSchema = z.object({
  id: z.string(),
  workspaceId: z.string(),
  agentId: z.string(),
  text: z.string(),
  ref: z.string(),
  file: z.string(),
  startLine: z.number(),
  endLine: z.number(),
  // Pill title and the context the agent gets, fixed when the comment was written.
  title: z.string(),
  context: z.string(),
});
export type WaitingComment = z.infer<typeof waitingCommentSchema>;

/** A message sent from the diff, split back into its comments; null for any other message. */
export function parseCommentsMessage(message: string): SentComment[] | null {
  const comments: SentComment[] = [];
  let start = 0;
  for (const match of message.matchAll(LOCATION_LINES)) {
    const text = message.slice(start, match.index).trim();
    if (!text) return null;
    const startLine = Number(match[3]);
    comments.push({ text, ref: match[1], file: match[2], startLine, endLine: match[4] ? Number(match[4]) : startLine });
    start = match.index + match[0].length;
  }
  // Ours end on a location line; text after the last one makes it someone's own message.
  return comments.length > 0 && message.slice(start).trim() === "" ? comments : null;
}

// Paseo's composer accepts files dragged from its file tree in this format
// (packages/app/src/attachments/workspace-file-drag.ts) and sends them as `Workspace file: <path>`
// plus `Lines: a-b`. The path carries the branch in git's `<branch>:<path>` form.
export const WORKSPACE_FILE_DRAG_MIME = "application/x-paseo-workspace-file+json";

export function workspaceFileDragPayload(input: {
  serverId: string;
  workspaceId: string;
  selection: LineSelection;
}): string {
  const { selection } = input;
  return JSON.stringify({
    version: 1,
    serverId: input.serverId,
    workspaceId: input.workspaceId,
    attachment: {
      kind: "workspace_file",
      path: `${selection.ref}:${selection.file}`,
      selection: { kind: "line_range", startLine: selection.startLine, endLine: selection.endLine },
    },
  });
}

/** Plain-text form of the same reference, for drops outside Paseo's composer. */
export function lineReference(selection: LineSelection): string {
  return `${selection.ref}:${selection.file}:${lineSpan(selection)}`;
}
