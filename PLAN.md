# Paseo Graphite plugin plan

## Product promise

When a developer opens a Paseo workspace, the header and composer should answer one question without
another page load: **does this Graphite stack need me?** Opening the Explorer panel should explain
exactly which PR needs action, why, and what the safest next action is.

Graphite and GitHub have separate responsibilities:

- **Graphite CLI is authoritative for stack identity, branch order, parentage, and local stack
  health.** A chain of GitHub PR base branches is not treated as proof of Graphite membership.
- **GitHub is authoritative for PR state, review threads, reviews, checks, and mergeability.**
- **Paseo is authoritative for workspace and agent context.**

This distinction is observable in the local `hero-poc` repository: Graphite still records merged
PRs #1082 and #1083 as parent/child stack branches even though GitHub now reports `main` as the base
for both PRs.

## Information hierarchy

### At a glance

The workspace header button and each live agent's composer pill show:

- `Stack N · Fix M` when developer action is required;
- `Stack N · Merge M` when PRs are ready to merge;
- `Stack N` when the stack is waiting or complete.

The icon color supplies the second channel: red for action, green for ready, amber for waiting, and
muted when the workspace is not a Graphite stack.

### Explorer panel

The right-hand Explorer panel is a dense stack list designed to keep a full stack on one screen.
Each branch is a compact row with PR title and number, action state, resolved/total review-thread
count, check count, and a small Graphite link. Comment bodies and GitHub links stay out of this view.

### Graphite PR center

The global **Graphite PRs** surface is available from Paseo's left sidebar and Command Center. It
deduplicates stacks found across active workspaces and groups their PRs into needs-attention,
approved, waiting, and merged/closed sections. Every row can open its Paseo workspace or Graphite.

## Status model

Statuses are deliberately ranked. A PR with failing CI and pending CI is not merely "pending."

1. **Needs action**
   - merge conflict or GitHub `DIRTY` state;
   - unresolved review threads or changes requested;
   - completed failing checks that are required by the base branch protection rule;
   - Graphite `needs restack` or remote Graphite metadata newer than local;
   - tracked branch not yet submitted;
   - draft ready to be published;
   - review required but nobody requested.
2. **Ready**
   - Graphite reports `Ready to merge`; or
   - open, approved, mergeable, and no failed, missing, or pending required checks.
3. **Waiting**
   - checks are running or requested reviewers have not approved.
4. **Done**
   - merged or closed.

The summary counts branches by their highest-priority state. The panel preserves the individual
reasons so a branch can say both `Review comments` and `CI failed`.

## Current release (v0.2)

- Dense Explorer workspace panel.
- Global Graphite PR center in the left sidebar and Command Center.
- Workspace header button and per-agent composer pill.
- 10-second client refresh and manual forced refresh.
- Stack discovery from the files Graphite keeps in the repository's shared git directory, read
  once for all of its worktrees. `gt log short --stack` and `gt info <branch>` remain the
  fallback for gt versions that store them differently.
- GitHub GraphQL enrichment through the authenticated `gh` CLI: one batched query per
  repository at most once a minute, shared by its worktrees and by every plugin process that
  runs this server code.
- Resolved/total review-thread counts and check counts without comment bodies.
- `/pr-stack` to open the Explorer panel.
- A contextual hint to use the user's existing `/fix-pr` command for review feedback. The plugin
  deliberately does not register or intercept that command.
- **Fix All** creates a separate agent in the current workspace, cloning the latest agent's
  provider/model/mode configuration. Review-feedback prompts begin with the existing `/fix-pr`
  workflow. The plugin itself never registers `/fix-pr` and never merges a PR.

## Next releases

### v0.3 — better action quality

- Detect whether a failed check is stale relative to the latest submitted Graphite version.
- Show reviewer identities and approval freshness.
- Detect Graphite merge queue state when a stable supported source is available.
- Add action-specific agent prompts for conflicts, CI, feedback, restack, and submission.
- Add tests with recorded, redacted `gt` and GitHub payloads.

### v0.4 — safe one-tap workflows

- Per-PR `Fix with new agent` alongside the implemented stack-wide Fix All action.
- Agent-mediated restack and conflict resolution with explicit confirmation before mutations.
- Publish/request-review actions with confirmation and audit output.
- Optional desktop notifications only on transitions into `needs action` or `ready`.

### v1 — stack inbox

- Persisted, customizable sections on top of the implemented global deduplicated surface.
- Cross-host aggregation and filters.
- Persisted status history and time-to-action metrics.
- Plugin settings for polling, ignored checks, reviewer policy, and notification policy.

## Reliability and security

- Commands use argv arrays through `execFile`; no shell evaluates branch names or API data.
- `gt`, `git`, and `gh` have bounded execution time and output size.
- Expected states such as an untracked branch render as product states, not crashes.
- UI data collection is read-only. Fix All delegates repair work to a visible Paseo agent and tells
  it never to merge; Graphite and GitHub mutations remain agent-mediated and auditable.
- GitHub/Graphite credentials remain inside their existing CLIs and are never returned to the
  client or logged.
