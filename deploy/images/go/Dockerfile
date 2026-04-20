# x1agent preset: Go 1.24
#
# Go doesn't define LTS — the last two minors get security fixes. 1.24
# is the current stable release at image build time. Downloaded as the
# official static tarball from go.dev, which resolves GOARCH from the
# host platform so the image builds clean on arm64 and amd64.
#
# GOPATH is /home/node/go, consistent with the runtime-core user. The
# agent can install tools with `go install .../cmd/foo@latest` and
# they land in $GOPATH/bin which is on PATH.

ARG BASE_IMAGE=x1agent/runtime-core:v1
FROM ${BASE_IMAGE}

USER root

ARG GO_VERSION=1.24.0

RUN apt-get update && apt-get install -y --no-install-recommends \
      ripgrep \
      jq \
  && rm -rf /var/lib/apt/lists/*

RUN ARCH="$(dpkg --print-architecture)" \
  && case "$ARCH" in \
       amd64) GOARCH=amd64 ;; \
       arm64) GOARCH=arm64 ;; \
       *) echo "unsupported arch: $ARCH" && exit 1 ;; \
     esac \
  && curl -fsSL "https://go.dev/dl/go${GO_VERSION}.linux-${GOARCH}.tar.gz" -o /tmp/go.tgz \
  && tar -C /usr/local -xzf /tmp/go.tgz \
  && rm /tmp/go.tgz \
  && /usr/local/go/bin/go version

ENV PATH="/usr/local/go/bin:/home/node/go/bin:${PATH}"
ENV GOPATH="/home/node/go"

RUN mkdir -p /home/node/go && chown -R node:node /home/node/go

USER node
