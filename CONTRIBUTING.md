# Contributing

## Branches

- `master` — production. Protected. Only release-please PRs and `development → master` promotion PRs merge here.
- `development` — integration / staging. Protected. All feature/fix branches land here via PR.
- `feat/*`, `fix/*`, `chore/*`, `docs/*` — short-lived working branches, branched off `development`.

## Commit messages

All commits must follow [Conventional Commits](https://www.conventionalcommits.org/). The commit *type* drives the version bump and the CHANGELOG section:

| Type | Bump | CHANGELOG section |
|---|---|---|
| `feat:` | minor | Features |
| `fix:` | patch | Bug Fixes |
| `perf:` | patch | Performance |
| `refactor:` | none (shown) | Refactors |
| `docs:` | none (shown) | Documentation |
| `build:` | none (shown) | Build System |
| `ci:` | none (shown) | Continuous Integration |
| `chore:` | none (shown) | Miscellaneous |
| `feat!:` / `BREAKING CHANGE:` footer | major | Features (with `!`) |

Scopes (e.g. `feat(drift-check): …`) are optional but encouraged.

## Merge strategies (important — do not deviate)

| PR | Strategy | Why |
|---|---|---|
| `feat/*` / `fix/*` / … → `development` | **Squash merge** | Keeps `development` linear; one commit per feature. |
| `development` → `master` | **Create a merge commit** (NOT squash) | So `master` is strictly ahead of `development` after the merge and the sync-back is a clean fast-forward. Squash-merging here will break the release automation. |
| release-please bot PR on `master` | **Squash merge** | One commit per release. |

If the GitHub merge-button defaults to the wrong strategy, use the dropdown to pick the correct one. Branch-protection rules restrict which strategies are available on each branch.

## Release flow

1. Merge feature/fix branches into `development` (squash).
2. When ready to release (weekly cadence), open a PR `development` → `master` and merge with **Create a merge commit**.
3. The [release-please](https://github.com/googleapis/release-please-action) workflow runs on `master` and opens (or updates) a **release PR** titled `chore(master): release X.Y.Z`. It bumps `package.json`, updates `CHANGELOG.md`, and — on merge — creates the git tag (`vX.Y.Z`) and a GitHub release.
4. Merge the release PR.
5. The `sync-to-development` workflow fast-forwards `development` to `master` automatically.

If release-please does not open a PR after a `development → master` merge, it means the release does not contain any `feat:`, `fix:`, `perf:`, or breaking commits — nothing to release. That's expected.

## Hotfixes

Hotfixes follow the same path as any other change: branch off `development`, PR into `development`, then immediately open a PR `development → master`. There is no separate hotfix-to-master path. Any unreleased work currently on `development` will ship together with the fix — keep `development` releasable at all times.

## Required secrets (admin setup)

- `SYNC_TOKEN` — fine-grained PAT with `contents: write` on this repo. Used by the `sync-to-development` workflow to push to the protected `development` branch. Upgrade to a GitHub App token later if desired.

## Required branch protection (admin setup)

- `master`:
  - Require pull request before merging.
  - Require status checks: CI (when #15 lands) + release-please.
  - Allow merge commits and squash merges. Disallow rebase merges.
  - Do NOT require linear history (we need merge commits from `development`).
- `development`:
  - Require pull request before merging.
  - Allow squash merges only.
