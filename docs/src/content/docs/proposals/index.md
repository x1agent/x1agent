---
title: Proposals
description: Design sketches for features that are not yet shipping architecture. These documents are non-binding and may change substantially before implementation.
sidebar:
  order: 0
---

Documents under **Proposals** describe ideas that have been thought through but are not committed to the architecture. Unlike the [Architecture](/architecture/overview) section -- where every document is binding on the code and implementation reality must match the docs -- proposals are sketches. They record design intent, identify open questions, and list the work required if the proposal is accepted.

A proposal can be promoted to architecture when:

1. The design has been validated against the rest of the system,
2. The implementation scope is agreed,
3. The doc is moved into the relevant architecture section and stripped of proposal language.

Until a proposal is promoted, code should not be written against it, and other architecture documents should not reference it as if it existed. Cross-references from architecture docs to proposals must be labeled "(proposal)" or "parked" to avoid misleading implementers.

## Current proposals

- [Branch deploys](/proposals/branch-deploys) -- deploying the applications agents build back into the cluster, with per-branch preview environments.
