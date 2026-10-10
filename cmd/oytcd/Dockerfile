# Build from the repo root: docker build -f cmd/oytcd/Dockerfile .
FROM golang:1.26 AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 go build -trimpath -o /oytcd ./cmd/oytcd

# Runs as root so it can write the Railway volume mounted at /data.
FROM gcr.io/distroless/static-debian12
COPY --from=build /oytcd /oytcd
ENTRYPOINT ["/oytcd"]
