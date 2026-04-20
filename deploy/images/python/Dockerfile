# x1agent preset: Python 3.13
#
# Latest stable CPython at image build time. Python doesn't have formal
# LTS, but each minor gets five years of security support, so 3.13 is
# effectively LTS through 2029. Installed via uv's standalone Python
# distribution so the binary is portable across glibc versions and both
# arm64 and amd64 without per-platform tweaks.
#
# Admins who need a different Python version copy this file and change
# the `uv python install` argument. The platform doesn't pin to 3.13
# elsewhere.
#
# BASE_IMAGE defaults to the local runtime-core tag. `mise run
# images:publish` and Kaniko (Phase 2) override it to the in-cluster
# registry path.

ARG BASE_IMAGE=x1agent/runtime-core:v1
FROM ${BASE_IMAGE}

USER root

RUN apt-get update && apt-get install -y --no-install-recommends \
      build-essential \
      ripgrep \
      jq \
  && rm -rf /var/lib/apt/lists/*

ENV UV_PYTHON_INSTALL_DIR=/opt/python
RUN curl -LsSf https://astral.sh/uv/install.sh | \
      env UV_INSTALL_DIR=/usr/local/bin sh \
  && uv python install 3.13 \
  && UV_PY="$(uv python find 3.13)" \
  && ln -sf "$UV_PY" /usr/local/bin/python3 \
  && ln -sf "$UV_PY" /usr/local/bin/python3.13 \
  && ln -sf /usr/local/bin/python3 /usr/local/bin/python \
  && python3 --version

USER node
