import { join } from "node:path";
import { findBinary, runCommand } from "./process";

const DETECT_CACHE_MS = 60_000;
const detections = new Map<string, { expiresAt: number; value: Promise<boolean> }>();

/**
 * A repository uses Graphite when Graphite tracks at least one branch with a parent.
 * Running `gt` in any repository silently initializes Graphite there with only the trunk
 * recorded, so the presence of Graphite's files alone does not count.
 */
export function detectGraphite(directory: string): Promise<boolean> {
  const cached = detections.get(directory);
  if (cached && cached.expiresAt > Date.now()) return cached.value;
  const value = detect(directory).catch(() => false);
  detections.set(directory, { expiresAt: Date.now() + DETECT_CACHE_MS, value });
  return value;
}

async function detect(directory: string): Promise<boolean> {
  const git = await findBinary("git");
  if (!git) return false;
  const [commonDir, legacyRefs] = await Promise.all([
    runCommand(git, ["rev-parse", "--path-format=absolute", "--git-common-dir"], {
      cwd: directory,
      timeoutMs: 8_000,
    }),
    // Older gt versions kept branch metadata in refs instead of the SQLite database.
    runCommand(git, ["for-each-ref", "--count=1", "--format=%(refname)", "refs/branch-metadata"], {
      cwd: directory,
      timeoutMs: 8_000,
    }),
  ]);
  if (!commonDir.ok) return false;
  if (legacyRefs.ok && legacyRefs.stdout.trim()) return true;
  return hasTrackedBranch(join(commonDir.stdout.trim(), ".graphite_metadata.db"));
}

async function hasTrackedBranch(databasePath: string): Promise<boolean> {
  const { DatabaseSync } = await import("node:sqlite");
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const row = database
      .prepare("select 1 from branch_metadata where parent_branch_name is not null limit 1")
      .get();
    return row !== undefined;
  } finally {
    database.close();
  }
}
