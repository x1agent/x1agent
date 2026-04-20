# x1agent preset: Go 1.24
#
# Starts from Google's canonical Go image (bookworm) — GOPATH, GOROOT,
# and the optimized go toolchain are set up the way the Go team ships
# them — and layers the x1 agent overlay on top. Go has no formal LTS;
# this pins 1.24 and tracks patches via rebuilds.

ARG AGENT_OVERLAY=x1agent/runtime-core:v1
FROM ${AGENT_OVERLAY} AS x1

FROM golang:1.24-bookworm

# --- x1 agent overlay ---
COPY --from=x1 /x1 /x1

# --- language-agnostic dev tooling ---
RUN apt-get update && apt-get install -y --no-install-recommends \
      ripgrep \
      jq \
  && rm -rf /var/lib/apt/lists/*

# --- user + workspace + entrypoint wiring ---
# golang:1.24-bookworm runs as root. Create the uid 1000 user and hand
# GOPATH over. The Go image already puts go and GOROOT in sensible
# places; we don't touch those.
RUN id -u 1000 >/dev/null 2>&1 \
    || ( groupadd --system --gid 1000 agent \
      && useradd --system --uid 1000 --gid 1000 --home /home/agent \
           --create-home --shell /bin/bash agent ) \
  && ln -sf /x1/etc/gitconfig /etc/gitconfig \
  && mkdir -p /workspace /home/agent/go \
  && chown -R 1000:1000 /x1 /workspace /home/agent/go

USER 1000
ENV HOME=/home/agent
# GOPATH under the agent's home so `go install` lands in a writable
# path. /x1/bin in front for gh + git-credential-x1.
ENV GOPATH=/home/agent/go
ENV PATH="/x1/bin:${GOPATH}/bin:${PATH}"
WORKDIR /workspace

ENTRYPOINT ["/x1/bin/entrypoint"]
