#!/usr/bin/env node
// EZ-002 / mid-build review item 3 -- source-level half of the rule-6 rail.
// Added 2026-09-08 by Claude Code, ticket EZ-002.
//
// check:bundle catches a secret that reached .output. That is one build too late:
// by then the value is in a build artifact, and on CI it may already be in a cache
// or an uploaded artifact. This runs on TRACKED SOURCE, so a secret is refused
// before it is ever built -- and, wired into CI, before the PR can merge.
//
// TRACKED, not on-disk, on purpose: `.env` is git-ignored and holds Andrew's real
// local values. Scanning it would pull a live credential into CI logs to prove it
// is not in CI. `git ls-files` sees only what is actually committed.

import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { findCredentialValues, findPublishedSecretNames, isBinary } from "./credential-shapes.mjs";

// Structured args, never a shell string (CLAUDE.md rule 26).
const tracked = execFileSync("git", ["ls-files", "-z", "--", "src", ".env*", "*.env"], {
  encoding: "utf8",
  maxBuffer: 32 * 1024 * 1024,
})
  .split("\0")
  .filter(Boolean);

if (tracked.length === 0) {
  console.error("assert-no-secret-source: no tracked files matched — run from the repo root.");
  process.exit(1);
}

const hits = [];
for (const file of tracked) {
  let buf;
  try {
    buf = readFileSync(file);
  } catch {
    continue; // deleted-but-still-indexed during a rebase
  }
  if (isBinary(buf)) continue;

  const text = buf.toString("utf8");
  for (const why of [...findPublishedSecretNames(text), ...findCredentialValues(text)]) {
    hits.push({ file, why });
  }
}

if (hits.length > 0) {
  console.error("\nFAIL — credential material in tracked source:\n");
  for (const h of hits) console.error(`  ${h.file}  <-  ${h.why}`);
  console.error(
    "\nThis is a rule-6 stop. A VITE_ name is published to every browser that loads the app.\n" +
      "Secrets belong in Supabase Edge secrets, never in this repo. If a real key was\n" +
      "committed, rotate it — deleting the line does not un-publish it from git history.\n",
  );
  process.exit(1);
}

console.log(
  `assert-no-secret-source: OK — scanned ${tracked.length} tracked files, no credential material.`,
);
