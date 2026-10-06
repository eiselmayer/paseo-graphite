import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import { findBinary, runCommand, stripAnsi } from "./process";

type PaseoApi = PluginHandlerContext["paseo"];

async function runGt(paseo: PaseoApi, workspaceId: string, args: readonly string[]): Promise<void> {
  const workspace = await paseo.workspaces.ref(workspaceId).refresh();
  const directory = workspace?.workspaceDirectory;
  if (!directory) throw new Error("This workspace has no local directory.");
  const gt = await findBinary("gt");
  if (!gt) throw new Error("Graphite CLI (gt) is not available to the Paseo daemon.");

  const result = await runCommand(gt, [...args, "--no-interactive"], {
    cwd: directory,
    timeoutMs: 30_000,
  });
  if (!result.ok) {
    const output = stripAnsi(`${result.stderr}\n${result.stdout}`).trim();
    throw new Error(output.split(/\r?\n/)[0] || `gt ${args[0]} failed.`);
  }
}

/** Runs `gt track` on the current branch; `--force` picks the nearest tracked ancestor as parent. */
export function trackCurrentBranch(paseo: PaseoApi, workspaceId: string): Promise<void> {
  return runGt(paseo, workspaceId, ["track", "--force"]);
}

export function checkoutBranch(paseo: PaseoApi, workspaceId: string, branch: string): Promise<void> {
  // A leading dash would be read as an option.
  if (branch.startsWith("-")) throw new Error(`Not a branch name: ${branch}`);
  return runGt(paseo, workspaceId, ["checkout", branch]);
}
