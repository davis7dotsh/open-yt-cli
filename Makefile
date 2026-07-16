.PHONY: dev build test check fmt

dev:
	go run ./cmd/oytc

build:
	go build -o bin/oytc ./cmd/oytc

test:
	go test ./...

check:
	go vet ./...
	go test ./...

fmt:
	gofmt -w .
