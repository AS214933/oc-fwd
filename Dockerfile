# ---- build stage ----
FROM golang:1.24-alpine AS build
WORKDIR /src
RUN apk add --no-cache ca-certificates git
COPY go.mod go.sum ./
RUN go mod download
COPY . .
ARG TARGETOS=linux
ARG TARGETARCH=amd64
RUN CGO_ENABLED=0 GOOS=${TARGETOS} GOARCH=${TARGETARCH} \
    go build -trimpath -ldflags="-s -w" -o /out/zen-proxy ./cmd/zenproxy

# ---- runtime stage ----
FROM alpine:3.21
RUN apk add --no-cache ca-certificates tzdata \
    && addgroup -S app && adduser -S -G app -u 10001 app
COPY --from=build /out/zen-proxy /usr/local/bin/zen-proxy
USER app
EXPOSE 8080
ENTRYPOINT ["/usr/local/bin/zen-proxy"]
