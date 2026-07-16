# open-yt-cli

`oytc` is a command-line interface for public YouTube data.

The project is currently a minimal Go scaffold. Its API and command specification will be designed next.

## Development

Run the CLI directly:

```sh
./dev
```

Or use the Makefile:

```sh
make dev
```

Arguments passed to `./dev` are forwarded to the CLI:

```sh
./dev --help
```

## Common commands

```sh
make build  # Build bin/oytc
make test   # Run tests
make check  # Run go vet and tests
make fmt    # Format Go files
```
