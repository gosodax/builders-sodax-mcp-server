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

The release workflows authenticate as a **GitHub App** rather than a personal access token, so the automation does not depend on any individual user's account or PAT lifetime.

- `RELEASE_BOT_APP_ID` — numeric App ID, found at the top of the App's settings page (`https://github.com/organizations/gosodax/settings/apps/<app-name>`).
- `RELEASE_BOT_PRIVATE_KEY` — entire contents of a `.pem` file generated under "Private keys" on the App's settings page (including the `-----BEGIN/END PRIVATE KEY-----` lines).

The App must be:
- **Owned by the `gosodax` org.**
- **Installed on this repository** (`gosodax/builders-sodax-mcp-server`).
- Granted these repository permissions:
  - `Contents`: Read and write
  - `Pull requests`: Read and write
  - `Metadata`: Read

At workflow runtime, [`actions/create-github-app-token@v1`](https://github.com/actions/create-github-app-token) mints a short-lived (~1h) installation token from these two secrets. The token is used for FF pushes to `development`, opening fallback sync PRs, and as the token release-please uses to open release PRs (so downstream CI fires on those PRs once CI exists).

To rotate the App's private key: regenerate it in the App's settings and update the `RELEASE_BOT_PRIVATE_KEY` repo secret. To replace the App entirely: install the new App, swap both secrets, update the bypass actor on the `development` ruleset.

## Required branch protection (admin setup)

- `master`:
  - Require pull request before merging.
  - Require status checks: CI only (e.g. the `ci.yml` from #15). Do **not** require `release-please` as a status check — it runs on `push` to `master` (post-merge), so it never reports a check on `development → master` PRs and would block every promotion.
  - Allow merge commits and squash merges. Disallow rebase merges.
  - Do NOT require linear history (we need merge commits from `development`).
- `development`:
  - Require pull request before merging.
  - Allow squash merges only.
  - **Bypass actor for the sync workflow.** The `sync-to-development` workflow fast-forward-pushes directly to `development`, which the PR requirement above would otherwise block. In the ruleset's *Bypass list*, add the **GitHub App** referenced by `RELEASE_BOT_APP_ID` (Bypass mode: *Always*). Without this bypass the FF push fails and every release falls back to opening a sync PR — defeating the silent-sync design.
