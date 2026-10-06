import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import {
  highlightCode,
  type HighlightToken,
  isLanguageSupported,
  isSyntaxThemeId,
  resolveSyntaxColors,
} from "@getpaseo/highlight";
import type { BranchRange, ChangedFile, DiffLine } from "../shared/contracts";
import { parsePatch } from "../shared/patch";
import { findBinary, runCommand } from "./process";

type PaseoApi = PluginHandlerContext["paseo"];

async function gitIn(paseo: PaseoApi, workspaceId: string) {
  const workspace = await paseo.workspaces.ref(workspaceId).refresh();
  const directory = workspace?.workspaceDirectory;
  if (!directory) throw new Error("This workspace has no local directory.");
  const git = await findBinary("git");
  if (!git) throw new Error("Git is not available to the Paseo daemon.");
  return async (args: readonly string[]) => {
    const result = await runCommand(git, args, { cwd: directory, timeoutMs: 20_000 });
    if (!result.ok) {
      throw new Error(result.stderr.trim().split(/\r?\n/)[0] || "git diff failed or its output was too large.");
    }
    return result.stdout;
  };
}

// Three dots diff from the merge base, so a branch that needs a restack still shows only its own changes.
// --end-of-options keeps branch names that start with a dash from being read as options.
function range({ parent, branch }: BranchRange): string[] {
  return ["--end-of-options", `${parent}...${branch}`];
}

const STATUS: Record<string, ChangedFile["status"]> = {
  A: "added",
  C: "copied",
  D: "deleted",
  M: "modified",
  R: "renamed",
  T: "modified",
};

export async function branchChanges(paseo: PaseoApi, input: BranchRange): Promise<ChangedFile[]> {
  const git = await gitIn(paseo, input.workspaceId);
  const [names, counts] = await Promise.all([
    git(["diff", "--name-status", "-z", "-M", ...range(input)]),
    git(["diff", "--numstat", "-z", "-M", ...range(input)]),
  ]);
  return parseChangedFiles(names, counts);
}

/** Joins `git diff --name-status -z` and `git diff --numstat -z` output for the same range. */
export function parseChangedFiles(names: string, counts: string): ChangedFile[] {
  // --numstat -z: "added\tdeleted\tpath\0", or "added\tdeleted\t\0old\0new\0" for a rename. Binary files count "-".
  const stats = new Map<string, { additions: number | null; deletions: number | null }>();
  const countFields = counts.split("\0");
  for (let index = 0; index < countFields.length; index++) {
    const match = /^(-|\d+)\t(-|\d+)\t(.*)$/s.exec(countFields[index]);
    if (!match) continue;
    let path = match[3];
    if (path === "") {
      path = countFields[index + 2] ?? "";
      index += 2;
    }
    stats.set(path, {
      additions: match[1] === "-" ? null : Number(match[1]),
      deletions: match[2] === "-" ? null : Number(match[2]),
    });
  }

  // --name-status -z: "M\0path\0", or "R100\0old\0new\0" for renames and copies.
  const files: ChangedFile[] = [];
  const nameFields = names.split("\0");
  for (let index = 0; index + 1 < nameFields.length; ) {
    const code = nameFields[index];
    const moved = code.startsWith("R") || code.startsWith("C");
    const oldPath = moved ? nameFields[index + 1] : null;
    const path = moved ? nameFields[index + 2] : nameFields[index + 1];
    index += moved ? 3 : 2;
    if (!code || path === undefined) continue;
    const stat = stats.get(path) ?? { additions: null, deletions: null };
    files.push({ path, oldPath, status: STATUS[code[0]] ?? "modified", ...stat });
  }
  return files;
}

// Same limits as Paseo's own diff highlighting: past these, lezer gets slow.
const MAX_HIGHLIGHT_BYTES = 1024 * 1024;
const MAX_HIGHLIGHT_LINE_CHARS = 10_000;

function highlightable(content: string | null): content is string {
  return (
    content !== null &&
    content.length <= MAX_HIGHLIGHT_BYTES &&
    content.split("\n").every((line) => line.length <= MAX_HIGHLIGHT_LINE_CHARS)
  );
}

export async function fileDiff(
  paseo: PaseoApi,
  input: BranchRange & { path: string; oldPath: string | null; syntaxTheme: string; scheme: "light" | "dark" },
): Promise<DiffLine[]> {
  const git = await gitIn(paseo, input.workspaceId);
  const paths = input.oldPath ? [input.oldPath, input.path] : [input.path];
  const patch = parsePatch(await git(["diff", "-M", "--no-ext-diff", ...range(input), "--", ...paths]));
  if (!isLanguageSupported(input.path)) return patch.map((line) => ({ ...line, tokens: null }));

  // Highlight whole files, not hunks, so multi-line comments and strings color correctly.
  // An added file has no old side and a deleted one no new side; `git show` fails for those.
  const base = (await git(["merge-base", "--end-of-options", input.parent, input.branch])).trim();
  const show = (spec: string) => git(["show", "--end-of-options", spec]).catch(() => null);
  const [oldContent, newContent] = await Promise.all([
    show(`${base}:${input.oldPath ?? input.path}`),
    show(`${input.branch}:${input.path}`),
  ]);
  const oldTokens = highlightable(oldContent) ? highlightCode(oldContent, input.path) : null;
  const newTokens = highlightable(newContent) ? highlightCode(newContent, input.path) : null;

  const palette = resolveSyntaxColors(isSyntaxThemeId(input.syntaxTheme) ? input.syntaxTheme : "one", input.scheme);
  const colored = (tokens: HighlightToken[] | undefined) =>
    tokens?.map((token) => ({ text: token.text, color: token.style ? palette[token.style] : null })) ?? null;
  return patch.map((line) => {
    if (line.kind === "delete") return { ...line, tokens: colored(oldTokens?.[line.oldNumber! - 1]) };
    if (line.kind === "add" || line.kind === "context") {
      return { ...line, tokens: colored(newTokens?.[line.newNumber! - 1]) };
    }
    return { ...line, tokens: null };
  });
}
