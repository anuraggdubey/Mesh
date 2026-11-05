FROM --platform=$BUILDPLATFORM golang:1.27.3-alpine3.24 AS build

WORKDIR /src
COPY go.mod main.go .

ARG TARGETOS
ARG TARGETARCH
RUN CGO_ENABLED=0 GOOS=$TARGETOS GOARCH=$TARGETARCH go build -trimpath -ldflags="-s -w" -o /out/mesh-render .

FROM scratch
COPY --from=build /out/mesh-render /mesh-render
ENTRYPOINT ["/mesh-render"]
