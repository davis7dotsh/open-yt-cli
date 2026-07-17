.PHONY: dev build test check fmt fmt-check tidy-check cross-build package site-check release-check

# Forward additional make goals and ARGS to the CLI, so both
# `make dev login` and `make dev ARGS="search cats --limit 5"` work.
dev:
	go run ./cmd/oytc $(filter-out dev,$(MAKECMDGOALS)) $(ARGS)

# Treat positional CLI arguments as no-op make targets after `dev` runs,
# while still failing normally for unknown standalone targets.
%:
	@if [ "$(filter dev,$(MAKECMDGOALS))" = "dev" ]; then :; else \
		echo "make: *** No rule to make target '$@'." >&2; exit 2; \
	fi

build:
	go build -o bin/oytc ./cmd/oytc

test:
	go test ./...

check:
	go vet ./...
	go test ./...

fmt:
	gofmt -w .

# --- release/site validation -------------------------------------------------

fmt-check:
	@unformatted="$$(gofmt -l .)"; if [ -n "$$unformatted" ]; then \
		echo "gofmt required for:" >&2; echo "$$unformatted" >&2; exit 1; fi

tidy-check:
	go mod tidy
	git diff --exit-code go.mod go.sum

# Cross-compile every release platform without producing artifacts.
cross-build:
	@set -e; for platform in linux/amd64 linux/arm64 darwin/amd64 darwin/arm64 windows/amd64 windows/arm64; do \
		echo "== $$platform =="; \
		CGO_ENABLED=0 GOOS="$${platform%/*}" GOARCH="$${platform#*/}" \
			go build -trimpath -o /dev/null ./cmd/oytc; \
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

release-check: fmt-check check cross-build site-check
	go test -race ./...
