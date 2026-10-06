export interface PatchLine {
  kind: "hunk" | "add" | "delete" | "context" | "note";
  text: string;
  oldNumber: number | null;
  newNumber: number | null;
}

/** Lines of a single-file unified diff, numbered, without the file header. */
export function parsePatch(patch: string): PatchLine[] {
  const lines: PatchLine[] = [];
  let oldNumber = 0;
  let newNumber = 0;
  let inHunk = false;
  for (const raw of patch.split("\n")) {
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
    if (hunk) {
      inHunk = true;
      oldNumber = Number(hunk[1]);
      newNumber = Number(hunk[2]);
      lines.push({ kind: "hunk", text: raw, oldNumber: null, newNumber: null });
      continue;
    }
    if (!inHunk) continue;
    if (raw.startsWith("diff --git ")) {
      inHunk = false;
    } else if (raw.startsWith("+")) {
      lines.push({ kind: "add", text: raw.slice(1), oldNumber: null, newNumber: newNumber++ });
    } else if (raw.startsWith("-")) {
      lines.push({ kind: "delete", text: raw.slice(1), oldNumber: oldNumber++, newNumber: null });
    } else if (raw.startsWith(" ")) {
      lines.push({ kind: "context", text: raw.slice(1), oldNumber: oldNumber++, newNumber: newNumber++ });
    } else if (raw.startsWith("\\")) {
      lines.push({ kind: "note", text: raw.slice(2), oldNumber: null, newNumber: null });
    }
  }
  return lines;
}
