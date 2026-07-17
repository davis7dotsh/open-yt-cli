# Releasing oytc

How releases, the website, and CI fit together, and the one-time repository settings the
owner must enable. Publishing is **tag-driven**: nothing is released just by pushing to
`main`.

## Artifact contract

Everything downstream agrees on one naming scheme. Do not change one side without the
others (CI has a consistency check):

| Artifact | Name |
| --- | --- |
| Linux/macOS archive | `oytc_<tag>_<os>_<arch>.tar.gz` containing a single `oytc` |
| Windows archive | `oytc_<tag>_windows_<arch>.zip` containing a single `oytc.exe` |
| Checksums | `checksums.txt` (sha256sum format, one line per archive) |

Platforms: `linux/amd64`, `linux/arm64`, `darwin/amd64`, `darwin/arm64`, `windows/amd64`,
`windows/arm64`. Producers/consumers of this contract:

- `scripts/package.sh` — builds the archives and `checksums.txt`
- `.depot/workflows/release.yml` — runs `package.sh` and uploads to the GitHub Release
- `site/install.sh` / `site/install.ps1` — download + verify + install
- `internal/update/update.go` (`AssetName`) — the self-updater

Version metadata is injected via
`-ldflags -X open-yt-cli/internal/version.{Version,Commit,Date}=…` and surfaced by
`oytc version`.

## CI system: Depot CI (not GitHub Actions)

All three workflows live in **`.depot/workflows/`** and run on
[Depot CI](https://depot.dev/docs/ci/overview) — Depot's own CI engine that executes
GitHub Actions-compatible YAML entirely on Depot compute, in x86_64 Ubuntu 24.04
sandboxes. This is a different product from Depot's GitHub Actions *runners*: nothing
here runs on GitHub Actions at all, and there is deliberately **no `.github/workflows/`
directory** (a copy there would execute every workflow twice — including releases and
site deploys).

Key facts (source: <https://depot.dev/docs/ci/overview>,
<https://depot.dev/docs/ci/compatibility>):

- **Sandbox labels**: `runs-on: depot-ubuntu-24.04` (2 CPU/8 GB; `-4`/`-8`/`-16`/`-32`/
  `-64` scale up; `depot-ubuntu-latest` aliases the current LTS). Non-Depot labels are
  treated as `depot-ubuntu-latest`. Arm, macOS, and Windows sandboxes do **not** exist in
  Depot CI (those labels are GitHub Actions runner labels only).
- **Triggers**: registered by the Depot Code Access GitHub App when workflow files are
  merged to the default branch. `push` (branches/tags/paths), `pull_request`,
  `workflow_dispatch`, `schedule`, and concurrency groups are all supported.
- **Marketplace actions** (JavaScript/composite/Docker) work, so pinned
  `actions/checkout`, `actions/setup-go`, and `softprops/action-gh-release` run unchanged.
- **Permissions**: Depot CI supports `contents`, `id-token`, `actions`, `checks`,
  `metadata`, `pull_requests`, `statuses`, `workflows`. It does **not** support
  `pages: write` or the `environment:` job key, and its `id-token` is a Depot OIDC token
  (`https://identity.depot.dev`), not the GitHub Actions runtime token — which is why the
  Pages workflow pushes a `gh-pages` branch instead of using `actions/deploy-pages` (see
  below).
- **Fork PRs**: Depot CI does not yet run `pull_request` workflows triggered from forks
  (support is planned). CI runs for branches in this repo; fork PRs simply get no Depot
  checks until Depot ships that support. No secrets are exposed either way — CI only
  requests `contents: read`.

## One-time setup (owner checklist)

1. **Depot organization + Code Access app.** Sign in to [Depot](https://depot.dev) (the
   org here is `davis7dotsh`), then Organization Settings → **GitHub Code Access** →
   Connect to GitHub, and install the **Depot Code Access** app on the
   `davis7dotsh/open-yt-cli` repository. Works fine on a personal GitHub account — an
   organization-owned repo is *not* required. Verify with
   `depot ci migrate preflight` from a clone.
2. **Merge the workflows.** Triggers are registered only after `.depot/workflows/` is
   pushed and merged into `main`. Until then, workflows can still be run manually with
   `depot ci run --workflow .depot/workflows/ci.yml`.
3. **GitHub Pages.** Settings → Pages → Build and deployment → Source:
   **Deploy from a branch**, branch `gh-pages`, folder `/ (root)`. The `Deploy Pages`
   workflow force-pushes the validated `site/` directory to `gh-pages`; GitHub serves the
   branch directly (no GitHub Actions involved). `install.sh` lands at
   `https://davis7dotsh.github.io/open-yt-cli/install.sh`. No custom domain needed.
4. **No secrets to import.** The workflows only use `GITHUB_TOKEN`, which Depot CI
   provides via the Code Access app installation; `depot ci migrate secrets-and-vars` is
   not needed. GitHub's Actions settings (allowed actions, workflow permissions) do not
   apply — Depot CI enforces the per-job `permissions:` blocks itself.

## Workflows

| Workflow | Trigger | What it does |
| --- | --- | --- |
| `.depot/workflows/ci.yml` | PRs and pushes to `main` | gofmt check (no rewrite), `go mod tidy` check, `go vet`, `go test -race`, build, cross-compile all six release targets, shell syntax + shellcheck, skill structure check, asset-naming consistency check, installer end-to-end test against locally packaged artifacts |
| `.depot/workflows/release.yml` | push of a `v*` tag, or `workflow_dispatch` with an existing tag | tests, `scripts/package.sh`, smoke-test of a packaged binary, create GitHub Release with archives + `checksums.txt` (prerelease flag auto-set for tags containing `-`) |
| `.depot/workflows/pages.yml` | push to `main` touching `site/**`, or manual | validate `site/` and publish it as an orphan commit force-pushed to the `gh-pages` branch |

All actions are pinned to commit SHAs. Concurrency groups prevent overlapping runs; the
release group never cancels in-progress publishes. Manual dispatch:
`depot ci dispatch` (or the Depot dashboard); run against the local tree without pushing:
`depot ci run --workflow .depot/workflows/ci.yml`.

## Cutting the first release

The initial push of `main` publishes the website but **no release** (installer and
`oytc update` will report "no published release" until one exists). When ready:

```sh
# on main, with a green CI run
git tag v0.1.0
git push origin v0.1.0
```

Then verify:

1. The `Release` workflow run is green in the Depot dashboard (or
   `depot ci run list`) and
   <https://github.com/davis7dotsh/open-yt-cli/releases> shows six archives plus
   `checksums.txt`.
2. `curl -fsSL https://davis7dotsh.github.io/open-yt-cli/install.sh | sh` installs and
   `oytc version` prints `v0.1.0`.
3. `oytc update --check` reports up-to-date.

Subsequent releases: bump the tag (`v0.1.1`, `v0.2.0`, …) and push it. Prereleases: use a
hyphenated tag (`v0.2.0-rc.1`); it is marked prerelease on GitHub, `releases/latest` (and
therefore the installer default and `oytc update`) ignores it, and users opt in with
`OYTC_VERSION=v0.2.0-rc.1` (installer) or `oytc update --version v0.2.0-rc.1`.

If asset upload fails mid-release, re-dispatch with the tag name — from the Depot
dashboard, or:

```sh
depot ci dispatch --repo davis7dotsh/open-yt-cli --workflow release.yml \
  --ref main --input tag=v0.1.0
```

`softprops/action-gh-release` updates the existing release idempotently.

## Local dry run

```sh
./scripts/package.sh v0.0.0-local dist   # build all archives + checksums locally
make release-check                       # packaging + installer sanity, no publishing
```
