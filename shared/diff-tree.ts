// The file tree of Paseo's Changes panel (packages/app/src/git/diff-tree.ts), rebuilt so the
// stack panel lists a branch's files the same way: folders first, plain ASCII order, and
// single-child folder chains merged into one row.

interface TreeFile {
  path: string;
  additions: number | null;
  deletions: number | null;
}

interface DirNode<File> {
  kind: "dir";
  // The deepest folder's full path; a merged row keeps it as its identity.
  dirPath: string;
  name: string;
  children: Array<DirNode<File> | FileNode<File>>;
}

interface FileNode<File> {
  kind: "file";
  name: string;
  file: File;
}

export type TreeRow<File> =
  | { kind: "folder"; dirPath: string; name: string; depth: number; additions: number; deletions: number }
  | { kind: "file"; name: string; depth: number; file: File };

function sortTree<File>(node: DirNode<File>): void {
  node.children.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === "dir" ? -1 : 1;
    // Plain ASCII, not localeCompare, like Paseo.
    if (a.name === b.name) return 0;
    return a.name < b.name ? -1 : 1;
  });
  for (const child of node.children) if (child.kind === "dir") sortTree(child);
}

function buildTree<File extends TreeFile>(files: readonly File[]): DirNode<File> {
  const root: DirNode<File> = { kind: "dir", dirPath: "", name: "", children: [] };
  const dirs = new Map<string, DirNode<File>>([["", root]]);
  function ensureDir(dirPath: string): DirNode<File> {
    const existing = dirs.get(dirPath);
    if (existing) return existing;
    const parts = dirPath.split("/");
    const node: DirNode<File> = { kind: "dir", dirPath, name: parts[parts.length - 1], children: [] };
    ensureDir(parts.slice(0, -1).join("/")).children.push(node);
    dirs.set(dirPath, node);
    return node;
  }
  for (const file of files) {
    const parts = file.path.split("/");
    ensureDir(parts.slice(0, -1).join("/")).children.push({ kind: "file", name: parts[parts.length - 1], file });
  }
  sortTree(root);
  return root;
}

function compress<File>(node: DirNode<File>): DirNode<File> {
  let { name, dirPath } = node;
  let children = node.children.map((child) => (child.kind === "dir" ? compress(child) : child));
  while (children.length === 1 && children[0].kind === "dir") {
    const only = children[0];
    name = name ? `${name}/${only.name}` : only.name;
    dirPath = only.dirPath;
    children = only.children;
  }
  return { kind: "dir", dirPath, name, children };
}

function totals<File extends TreeFile>(node: DirNode<File>): { additions: number; deletions: number } {
  let additions = 0;
  let deletions = 0;
  for (const child of node.children) {
    const stat = child.kind === "dir" ? totals(child) : { additions: child.file.additions ?? 0, deletions: child.file.deletions ?? 0 };
    additions += stat.additions;
    deletions += stat.deletions;
  }
  return { additions, deletions };
}

/** Rows to render, depth first. Children of folders in `collapsed` (by dirPath) are skipped. */
export function treeRows<File extends TreeFile>(files: readonly File[], collapsed: ReadonlySet<string>): TreeRow<File>[] {
  const root = buildTree(files);
  const rows: TreeRow<File>[] = [];
  function walk(children: DirNode<File>["children"], depth: number) {
    for (const child of children) {
      if (child.kind === "file") {
        rows.push({ kind: "file", name: child.name, depth, file: child.file });
        continue;
      }
      const merged = compress(child);
      rows.push({ kind: "folder", dirPath: merged.dirPath, name: merged.name, depth, ...totals(merged) });
      if (!collapsed.has(merged.dirPath)) walk(merged.children, depth + 1);
    }
  }
  walk(root.children, 0);
  return rows;
}

const compactFormatter = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 });

/** "1.2k", like Paseo's diff counts. */
export function formatDiffCount(value: number): string {
  return compactFormatter.format(value).toLowerCase();
}
