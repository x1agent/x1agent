# x1agent preset image: Python / Django
#
# Layered on top of the platform-maintained runtime-core. runtime-core owns
# node, tsx, the agent entrypoint, git, gh, the git-credential-x1 shim, and
# the `agent` user at uid 1000. This image adds only the Python toolchain
# and system packages Django-family projects need.
#
# See docs/architecture/runtime-images.md for the FROM-pattern contract
# and the validated reject-list (no USER 0 at the end, no privileged ports,
# no baked secrets, no ENTRYPOINT override).
#
# Built and pushed by the admin UI via Kaniko as part of the image-catalog
# arc. At agent-run time the platform selects this image via the agent's
# image_id column and composes it into a session pod alongside the sidecar
# and any declared siblings.
#
# BASE_IMAGE defaults to the local tag `x1agent/runtime-core:v1`. The
# `mise run images:publish` task builds and loads runtime-core before
# building this image, so the local tag resolves. Kaniko in Phase 2
# overrides BASE_IMAGE with the in-cluster registry path.

ARG BASE_IMAGE=x1agent/runtime-core:v1
FROM ${BASE_IMAGE}

USER root

RUN apt-get update && apt-get install -y --no-install-recommends \
      python3.12 \
      python3.12-dev \
      python3.12-venv \
      build-essential \
      libpq-dev \
      postgresql-client \
      ripgrep \
      jq \
  && rm -rf /var/lib/apt/lists/*

# uv for fast Python dependency installs. Agents can still fall back to pip.
RUN curl -LsSf https://astral.sh/uv/install.sh | \
      env UV_INSTALL_DIR=/usr/local/bin sh

# Drop back to the non-root user runtime-core established. The final USER
# directive is `agent` per the runtime-images.md contract.
USER agent
