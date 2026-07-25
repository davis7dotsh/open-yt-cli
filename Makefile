.PHONY: dev build test check typecheck lint fmt fmt-check lock-check cross-build package site-check release-check

# Forward additional make goals and ARGS to the CLI, so both
# `make dev login` and `make dev ARGS="search cats --limit 5"` work.
dev:
	bun run src/main.ts $(filter-out dev,$(MAKECMDGOALS)) $(ARGS)

# Treat positional CLI arguments as no-op make targets after `dev` runs,
# while still failing normally for unknown standalone targets.
%:
	@if [ "$(filter dev,$(MAKECMDGOALS))" = "dev" ]; then :; else \
		echo "make: *** No rule to make target '$@'." >&2; exit 2; \
	fi

build:
	bun build --compile --outfile=bin/oytc src/main.ts

test:
	bun test

typecheck:
	./node_modules/.bin/tsc -p tsconfig.json

check: typecheck test

# Effect language-service diagnostics; advisory, beyond what tsc reports.
lint:
	./node_modules/.bin/effect-tsgo diagnostics --project tsconfig.json --format text

# --- release/site validation -------------------------------------------------

# No formatter is configured: the repo has no prettier/biome dependency and Bun
# ships no `bun fmt`. These targets exist so the documented workflow keeps
# working; CI enforces correctness through typecheck + tests instead.
fmt:
	@echo "fmt: no formatter configured for this repo; nothing to do"

fmt-check:
	@echo "fmt-check: no formatter configured for this repo; nothing to check"

# The committed lockfile must already satisfy package.json (CI's equivalent of
# the old `go mod tidy` check). Run standalone; it touches node_modules.
lock-check:
	bun install --frozen-lockfile
	git diff --exit-code bun.lock

# Compile every release platform without keeping artifacts. Mirrors PLATFORMS
# in scripts/package.sh and the cross-build job in .depot/workflows/ci.yml.
# windows/arm64 is absent: bun has no bun-windows-arm64 --compile target.
cross-build:
	@set -e; for target in bun-linux-x64 bun-linux-arm64 bun-darwin-x64 bun-darwin-arm64 bun-windows-x64; do \
		echo "== $$target =="; \
		out="$$(mktemp -d)"; \
		bun build --compile --target="$$target" --outfile "$$out/oytc" src/main.ts >/dev/null; \
		rm -rf "$$out"; \
	done

# Build local release archives + checksums: make package VERSION=v0.1.0
package:
	./scripts/package.sh $(or $(VERSION),v0.0.0-local) dist

site-check:
	sh -n site/install.sh
	sh -n scripts/package.sh
	sh -n dev
	test -f site/index.html
	test -f site/install.ps1
	grep -q 'davis7dotsh.github.io/open-yt-cli/install.sh' README.md

release-check: check cross-build site-check
	@echo "release-check OK"
