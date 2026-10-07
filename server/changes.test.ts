import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { highlightCode, resolveSyntaxColors } from "@getpaseo/highlight";

import { colorTokens, parseChangedFiles } from "./changes.ts";

test("parseChangedFiles joins name-status and numstat for every kind of change", () => {
  const directory = mkdtempSync(join(tmpdir(), "paseo-graphite-changes-"));
  const git = (...args: string[]) =>
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], {
      cwd: directory,
      encoding: "utf8",
    });
  try {
    git("init", "-q", "-b", "main");
    writeFileSync(join(directory, "edit.txt"), "one\ntwo\n");
    writeFileSync(join(directory, "gone.txt"), "bye\n");
    writeFileSync(join(directory, "old name.txt"), "a\nb\nc\nd\ne\nf\n");
    git("add", ".");
    git("commit", "-qm", "base");
    git("switch", "-qc", "feature");
    writeFileSync(join(directory, "edit.txt"), "one\n2\nthree\n");
    writeFileSync(join(directory, "new.txt"), "hello\n");
    writeFileSync(join(directory, "image.bin"), Buffer.from([0, 1, 2, 0, 255]));
    git("rm", "-q", "gone.txt");
    git("mv", "old name.txt", "new name.txt");
    git("add", ".");
    git("commit", "-qm", "feature");

    const range = ["--end-of-options", "main...feature"];
    const files = parseChangedFiles(
      git("diff", "--name-status", "-z", "-M", ...range),
      git("diff", "--numstat", "-z", "-M", ...range),
    );
    const byPath = new Map(files.map((file) => [file.path, file]));

    assert.equal(files.length, 5);
    assert.deepEqual(byPath.get("edit.txt"), {
      path: "edit.txt", oldPath: null, status: "modified", additions: 2, deletions: 1,
    });
    assert.deepEqual(byPath.get("new.txt"), {
      path: "new.txt", oldPath: null, status: "added", additions: 1, deletions: 0,
    });
    assert.deepEqual(byPath.get("gone.txt"), {
      path: "gone.txt", oldPath: null, status: "deleted", additions: 0, deletions: 1,
    });
    assert.deepEqual(byPath.get("new name.txt"), {
      path: "new name.txt", oldPath: "old name.txt", status: "renamed", additions: 0, deletions: 0,
    });
    assert.deepEqual(byPath.get("image.bin"), {
      path: "image.bin", oldPath: null, status: "added", additions: null, deletions: null,
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("styles missing from the palette, like Markdown's heading marks, get the default color", () => {
  const [heading] = highlightCode("## Setup\n", "README.md");
  const colors = colorTokens(heading, resolveSyntaxColors("one", "dark"));
  assert.ok(colors && colors.length > 0);
  assert.ok(colors.every((token) => token.color === null || typeof token.color === "string"));
  assert.equal(colors[0].text, "##");
  assert.equal(colors[0].color, null);
});
