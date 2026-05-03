## [1.6.4](https://github.com/x1agent/x1agent/compare/v1.6.3...v1.6.4) (2026-05-03)

## [1.6.3](https://github.com/x1agent/x1agent/compare/v1.6.2...v1.6.3) (2026-05-03)


### Bug Fixes

* **agents:** MCP attach + env-binding add buttons trigger their own PUT ([#28](https://github.com/x1agent/x1agent/issues/28)) ([9392a83](https://github.com/x1agent/x1agent/commit/9392a83c018c4b218cb536909c8c928528ad1a40))

## [1.6.2](https://github.com/x1agent/x1agent/compare/v1.6.1...v1.6.2) (2026-05-03)


### Bug Fixes

* **agents:** surface MCP attachments + env bindings on the detail page ([#27](https://github.com/x1agent/x1agent/issues/27)) ([2216b72](https://github.com/x1agent/x1agent/commit/2216b72f684253ee3ea0e83707d93334b4a40c27))

## [1.6.1](https://github.com/x1agent/x1agent/compare/v1.6.0...v1.6.1) (2026-05-03)


### Bug Fixes

* **install:** COPY mcp-oauth-proxy package.json in all prod Dockerfiles ([#26](https://github.com/x1agent/x1agent/issues/26)) ([3e5f1c8](https://github.com/x1agent/x1agent/commit/3e5f1c81682749dd26920f5081d1432887e3ba2b)), closes [#25](https://github.com/x1agent/x1agent/issues/25) [#16](https://github.com/x1agent/x1agent/issues/16)

# [1.6.0](https://github.com/x1agent/x1agent/compare/v1.5.0...v1.6.0) (2026-05-03)


### Features

* **mcp-oauth:** pod-side proxy + session-launch token resolution (PR 3/3) ([#25](https://github.com/x1agent/x1agent/issues/25)) ([ae31f03](https://github.com/x1agent/x1agent/commit/ae31f031ead425fb744db63a26649e0bdcabc43b))

# [1.5.0](https://github.com/x1agent/x1agent/compare/v1.4.0...v1.5.0) (2026-05-03)


### Features

* **mcp-catalog:** per-user OAuth flow for remote_oauth MCPs (PR 2/3) ([#24](https://github.com/x1agent/x1agent/issues/24)) ([c40204f](https://github.com/x1agent/x1agent/commit/c40204fb132e37bd3259329ee4b5282a4a814c64))

# [1.4.0](https://github.com/x1agent/x1agent/compare/v1.3.0...v1.4.0) (2026-05-03)


### Features

* **mcp-catalog:** remote_oauth shape — discovery + DCR for hosted MCPs ([#23](https://github.com/x1agent/x1agent/issues/23)) ([d3bd3e9](https://github.com/x1agent/x1agent/commit/d3bd3e93f6871808d514f365eebd9fdd14e7bd4a))

# [1.3.0](https://github.com/x1agent/x1agent/compare/v1.2.0...v1.3.0) (2026-05-03)


### Features

* **mcp-catalog:** support 'command' shape (npx/uvx) alongside container image ([#22](https://github.com/x1agent/x1agent/issues/22)) ([aac37b4](https://github.com/x1agent/x1agent/commit/aac37b477b38fd02ddaf855b821318e86c51713d))

# [1.2.0](https://github.com/x1agent/x1agent/compare/v1.1.2...v1.2.0) (2026-05-03)


### Bug Fixes

* **admin:** query workspace_members, not nonexistent memberships table ([#18](https://github.com/x1agent/x1agent/issues/18)) ([aabcbd6](https://github.com/x1agent/x1agent/commit/aabcbd651018a7111cb1932157f4aecc8d8452ab))
* **agent:** direct the model to share — not emit_artifact — for deliverables ([dcd05c7](https://github.com/x1agent/x1agent/commit/dcd05c78053a55788261466f80601401e6cf27a3))
* **agent:** graceful shutdown on end_session — single terminal event ([1830dcc](https://github.com/x1agent/x1agent/commit/1830dccddafd2a31ce9f302de7b4804316aa92ad)), closes [#20](https://github.com/x1agent/x1agent/issues/20)
* **agent:** persist user messages so they survive page refresh ([9c0d3a6](https://github.com/x1agent/x1agent/commit/9c0d3a6574ca8ce4ca6d40c1a9f7b7355358da37))
* **agent:** readable share-tool errors instead of JSON-parse crash ([d7d8f63](https://github.com/x1agent/x1agent/commit/d7d8f6371347bbf2f5dc3680a9ca632861013c25))
* **agents:** include 'mcp' in TabKey union so the tab works ([#20](https://github.com/x1agent/x1agent/issues/20)) ([d2face6](https://github.com/x1agent/x1agent/commit/d2face6a01f3ce3cf9aaa7dc62df5215c881cf65)), closes [#13](https://github.com/x1agent/x1agent/issues/13)
* **agent:** surface initial prompt as a user.message event ([055f840](https://github.com/x1agent/x1agent/commit/055f8404e74ae28a89ccb3d9d65873dcc53184db))
* **api:** allow PATCH in CORS + clarify scheduler log ([60b9912](https://github.com/x1agent/x1agent/commit/60b9912dcb71cc7e0e49bda8d2b98beb0e8c147c))
* **api:** session status reconciler — two paths, events are truth ([fe69dbe](https://github.com/x1agent/x1agent/commit/fe69dbe8514096347d8bd4be29395a642a28821b))
* **api:** tear down previous-generation handles on hot reload ([595d59b](https://github.com/x1agent/x1agent/commit/595d59b88e40d7c1bdf0ef9339ad70e55f95ba09))
* **app:** local-echo sequences no longer poison the event watermark ([37084e3](https://github.com/x1agent/x1agent/commit/37084e3a535a7bc921e1bbb3b363ebde48cf0dea))
* **app:** style Markdown with explicit component overrides ([7f7c452](https://github.com/x1agent/x1agent/commit/7f7c4521c2a94554bfa698a505137122bac8ac9b))
* **app:** use apiFetch + API_BASE in shared-resources + image picker ([57750ef](https://github.com/x1agent/x1agent/commit/57750ef8b2a9781b36c5d1af05a379be0794940b))
* **deploy:** add agent-resources package manifests to provider Dockerfiles ([8829c83](https://github.com/x1agent/x1agent/commit/8829c83619e0b390ca70bf2e76357bf233394652))
* **dev:** auto-bootstrap NATS mTLS material on mise run dev ([d26920d](https://github.com/x1agent/x1agent/commit/d26920d131606d5f56969a7462e9a2b90b7c0e2f))
* **dev:** CoreDNS rewrite for preview.local.x1agent.dev in-cluster resolution ([dec7244](https://github.com/x1agent/x1agent/commit/dec7244270bbdf8b2afc838542b88906758302f4))
* **docker:** remove web COPY (extracted to x1agent/web), add workspace-secrets ([#8](https://github.com/x1agent/x1agent/issues/8)) ([81b0e31](https://github.com/x1agent/x1agent/commit/81b0e31dc90a83bf157298334c0043a3b459c46f))
* **docs ci:** pass --workspaces=false to npm ci ([#6](https://github.com/x1agent/x1agent/issues/6)) ([8453705](https://github.com/x1agent/x1agent/commit/8453705ffa071acd3d674f2b85c72b315902c791))
* **github:** install callback returns to the originating page ([200fa5d](https://github.com/x1agent/x1agent/commit/200fa5d35bc0163dd2ae66e59c13273124c9bc13))
* **iam:** grant aiplatform.user to api GSA for /admin model probes ([#4](https://github.com/x1agent/x1agent/issues/4)) ([7131a5c](https://github.com/x1agent/x1agent/commit/7131a5caaea67cf9203477126e3c4d069ccc3d2d))
* **images:** Node preset must use /home/agent to match credentials mount ([e860ddd](https://github.com/x1agent/x1agent/commit/e860ddd903d2c8c32207233fe5576fb9421d2e3b))
* **images:** use debian bookworm's default python3 in python-django preset ([a0e9570](https://github.com/x1agent/x1agent/commit/a0e95704d93c80b0797bc0a5110cb367fb8e5f72))
* **install:** COPY new domain package.jsons in all 4 prod Dockerfiles ([#16](https://github.com/x1agent/x1agent/issues/16)) ([e633cf3](https://github.com/x1agent/x1agent/commit/e633cf341546061ee2abf543a7dace31ae419f07)), closes [#13](https://github.com/x1agent/x1agent/issues/13)
* **jobs:** create the PVC before the Job for orchestrators ([0056cae](https://github.com/x1agent/x1agent/commit/0056caefb4d769681a1087dfced96bfad23d573e))
* **jobs:** watcher must not mark session failed on a single pod restart ([f59055f](https://github.com/x1agent/x1agent/commit/f59055fb46b6c21f7de13fb059a5599ef8488c3b))
* **mise:** deploy task accepts zero args via default='' ([#10](https://github.com/x1agent/x1agent/issues/10)) ([3e7ebca](https://github.com/x1agent/x1agent/commit/3e7ebca455e649e886cfce516b793bd387535e28))
* **models:** decouple Vertex catalog LIST region from inference region ([#19](https://github.com/x1agent/x1agent/issues/19)) ([07748bd](https://github.com/x1agent/x1agent/commit/07748bd9b9a8ef16d49ea51840e9481fb86e10b3))
* **models:** never auto-pick Vertex [@default](https://github.com/default) preview aliases ([0eb1cf0](https://github.com/x1agent/x1agent/commit/0eb1cf0e40b1ed60a37e8e21ed166aaf203862df))
* **models:** revert auto-probe; return full Vertex catalog ([ef94e66](https://github.com/x1agent/x1agent/commit/ef94e66b488a8bc7b25c9b9d45754605b56212dd))
* **nats:** cap verbosity to keep kubelet's log rotator out of the wedge pattern ([a5f0ce7](https://github.com/x1agent/x1agent/commit/a5f0ce743e618553fc0e1bc89b0d5ccadc087ac5))
* **rbac:** add StatefulSet/Service/Secret/PVC permissions for shared-agent-resources ([abd6ff9](https://github.com/x1agent/x1agent/commit/abd6ff97911cb2579eb0fcf1ba1597cf49ef6894))
* **sessions:** DB trigger enforces orchestrator singleton ([cfd43ad](https://github.com/x1agent/x1agent/commit/cfd43ada0c6b7ab3fd994aac8db09ba4a762c66a))
* **shares:** cross-origin credentials flow end-to-end ([660d0b5](https://github.com/x1agent/x1agent/commit/660d0b5cea8a31fa38868b12fb29aeced1d5c111))
* **sidecar:** run as uid 1000 so /workspace files are agent-writable ([40c6092](https://github.com/x1agent/x1agent/commit/40c60921bf91cd143de626dac23271d920b15c45))
* **terraform:** create x1agent-workspace-secrets-master-key in GSM ([#9](https://github.com/x1agent/x1agent/issues/9)) ([42686de](https://github.com/x1agent/x1agent/commit/42686de48d72e9a5f8cdbecc577967e68021079c))
* **workspace-secrets:** scrub vendor-specific example copy ([#11](https://github.com/x1agent/x1agent/issues/11)) ([16f7c2d](https://github.com/x1agent/x1agent/commit/16f7c2dc7b047f17f83c5b7afc62b8ea3a073eb6))


### Features

* **admin:** Claude model curation page ([be583b2](https://github.com/x1agent/x1agent/commit/be583b29a14e55b944006b2b90544241797615ba))
* **admin:** global admin section across workspaces ([ca7745c](https://github.com/x1agent/x1agent/commit/ca7745cfb61798119e09412dcf735a50c701cff3))
* **agent-repos:** per-repo branch, mount_path, auto_push ([ad4931b](https://github.com/x1agent/x1agent/commit/ad4931bed640d0a99db5713907c779629224689e))
* **agent-resources-postgres:** engine package with statefulset adapter ([3fc8022](https://github.com/x1agent/x1agent/commit/3fc802208cdd73e00be6349f9e91c2b797a56b85))
* **agent-resources-redis:** engine package with statefulset + ACL minter ([f1ea190](https://github.com/x1agent/x1agent/commit/f1ea19022b2042c8119083b409ba918650ccad37))
* **agent-resources:** shared domain package for workspace resources ([99e8cac](https://github.com/x1agent/x1agent/commit/99e8cac1d8ade73b6e7e6e461d708d444ae4e2ec))
* **agent:** Claude Agent SDK container + internal MCP ([7d7b30d](https://github.com/x1agent/x1agent/commit/7d7b30dfa292813f3243538d127440fa2870c10a))
* **agents:** agent CRUD domain with schedule + heartbeat config ([43ddc94](https://github.com/x1agent/x1agent/commit/43ddc945fada7bc9ba9b3b2fb5fe532b8cc90eea))
* **agents:** agents.kind discriminator (worker/orchestrator/scheduled) ([eaa252d](https://github.com/x1agent/x1agent/commit/eaa252d7f41df6d582db3322f89643bfcf47c141))
* **agents:** create UX polish (slug autofill, dropdown grouping, schedule label) ([#14](https://github.com/x1agent/x1agent/issues/14)) ([38ac770](https://github.com/x1agent/x1agent/commit/38ac770d00d942677d7d7b40fd4452803aada9cf))
* **agents:** image picker on the agent edit form ([e908913](https://github.com/x1agent/x1agent/commit/e9089139951a5d44f8889dc47b62c3d3ee2d1d17))
* **agents:** per-agent Claude model override ([470714a](https://github.com/x1agent/x1agent/commit/470714a18169b77eeb0d84221dcc1fb106034194))
* **agents:** server-driven Claude model dropdown ([f5a31a1](https://github.com/x1agent/x1agent/commit/f5a31a1c8a3e3de752c493d823d5f93b5cbcd4d0))
* **api:** add share subsystem — disk storage + workspace/internal routes ([20268ec](https://github.com/x1agent/x1agent/commit/20268eca3882125ae6248860c07e0f9d1a0dc358))
* **api:** branch reaper for stale shared-agent-resource DBs ([d348564](https://github.com/x1agent/x1agent/commit/d348564c4a2353958b44c1e2d28454c7115e0d89))
* **api:** compose domains into Hono app with migration runner ([e70dacf](https://github.com/x1agent/x1agent/commit/e70dacf039a2706706b9be682baf09d2ac52db5d))
* **api:** job-watcher assembles session_history.md for resumed sessions ([ee9c42d](https://github.com/x1agent/x1agent/commit/ee9c42d0649f99e202cf50132c1ba419e639feb6))
* **api:** job-watcher mints per-session credentials + augments prompt ([eba45d2](https://github.com/x1agent/x1agent/commit/eba45d20c73b22cabbaf5c40fdcc42de243e319e))
* **api:** K8s Job watcher spawns session pods ([d4a3d32](https://github.com/x1agent/x1agent/commit/d4a3d322779308995b627c144f318caae8600536))
* **api:** mount sessions domain and start scheduler tick ([556484a](https://github.com/x1agent/x1agent/commit/556484a8688f0b0d314835e475b4281499db3d12))
* **api:** workspace shared-agent-resources routes ([26e4c04](https://github.com/x1agent/x1agent/commit/26e4c0455f29181db463a4cee7dc9af8b290fa84))
* **app:** can-spawn card on agent detail ([78f78a6](https://github.com/x1agent/x1agent/commit/78f78a6e25fc35c5bd7865c4cb07b037a16eec11))
* **app:** Collections area + agent attach card ([45f9c5b](https://github.com/x1agent/x1agent/commit/45f9c5bdb8e4c2bec684f9c7bee1ec82345a0c35))
* **app:** frequency-first schedule builder ([a859435](https://github.com/x1agent/x1agent/commit/a8594353c4e83a6e6b2212784cdfd65e1f8b9575))
* **app:** GitHub installations card and per-agent repo picker ([af9eb96](https://github.com/x1agent/x1agent/commit/af9eb968086c1fba906a4da09ca8fd0a01bf1ae1))
* **app:** new-session card on the workspace sessions page ([7015891](https://github.com/x1agent/x1agent/commit/70158910389daed0cd90dd57af85ff803e32825d))
* **app:** optional initial prompt on Run now ([079cbd0](https://github.com/x1agent/x1agent/commit/079cbd00f1c1b356887a6bd9d61cd8882b2b453c))
* **app:** parent chip + children panel on session detail ([14c134f](https://github.com/x1agent/x1agent/commit/14c134f4ce3753e9f21d9aa787da25b51c90204d))
* **app:** preset-based schedule picker ([38af12b](https://github.com/x1agent/x1agent/commit/38af12b60120acd24a30fdeb064029c1bda47d0d))
* **app:** recent runs section on agent edit page ([2df4cec](https://github.com/x1agent/x1agent/commit/2df4cecd1d0a74d424ddee9e94a478c771582ba9))
* **app:** render agent.share events with ShareCard ([0c4e725](https://github.com/x1agent/x1agent/commit/0c4e725545b59354a223d364e1fb08fb37c6bfa1))
* **app:** render wake kinds + expose agent.kind picker in edit UI ([21739fe](https://github.com/x1agent/x1agent/commit/21739fe14c7f588a076b72f7087511527c606487))
* **app:** Resume button, resumed-from chip, prior events prepended ([a0d7f25](https://github.com/x1agent/x1agent/commit/a0d7f25590aad3d56b424e74520fd6cb2dec56aa))
* **app:** session detail page with live event stream ([4daee36](https://github.com/x1agent/x1agent/commit/4daee366ad04dfa51fc5cf2a4c03ef384de9a973))
* **app:** Shared agent resources panel in workspace settings ([de04371](https://github.com/x1agent/x1agent/commit/de04371c4a0115fcf4455ec70165865bd70adf6b))
* **app:** sidebar shell with workspace switcher + platform nav ([1e589f1](https://github.com/x1agent/x1agent/commit/1e589f1c4b5400c6d44a971a73353b9999429c6e))
* **app:** SPA-mode frontend with shadcn primitives and zustand stores ([70f2584](https://github.com/x1agent/x1agent/commit/70f25843517391ef16b860f781a54922c125fbda))
* **app:** split agent detail from edit ([a713699](https://github.com/x1agent/x1agent/commit/a71369900d18a1688438fb61837533b4837434eb))
* **app:** suppress duplicate MCP tool_call cards + visibility heartbeat ([69964b9](https://github.com/x1agent/x1agent/commit/69964b974f1a3cab919bbd15bb60022f5e2ba6f8))
* **app:** url-synced tabs, clickable registry rows, zustand stores ([d884f70](https://github.com/x1agent/x1agent/commit/d884f70722c61cd73918bb0f21ce869d488a6a27))
* **app:** workspace github page ([9eee528](https://github.com/x1agent/x1agent/commit/9eee528a95bd6678371288bcc77a9554adc02fe0))
* **app:** workspace sessions list page ([3118990](https://github.com/x1agent/x1agent/commit/3118990d630d97bad27ba4c01ca661cc99172a5d))
* **app:** workspace settings page ([8c8349b](https://github.com/x1agent/x1agent/commit/8c8349bfef6f0f4998f9244ab6ec38e6a6fa5661))
* **app:** workspace-level Shares page ([457ff5a](https://github.com/x1agent/x1agent/commit/457ff5a106cec1f0323dc3a1253c57cc78acb241))
* **auth:** DDD auth domain with swappable provider adapters ([94338a0](https://github.com/x1agent/x1agent/commit/94338a0aadf972811549b6e914254e0d5c1cd769))
* **auth:** email + password sign-in alongside Google SSO ([14fc9d7](https://github.com/x1agent/x1agent/commit/14fc9d7fc90e813830016d42d36abda2921ffe5a))
* **auth:** membership/invitation bypasses domain whitelist ([0aef518](https://github.com/x1agent/x1agent/commit/0aef518d0fecb79537533694fffd67916a2c603d))
* **capabilities:** hide UI surfaces when provider not installed ([ebd8a7b](https://github.com/x1agent/x1agent/commit/ebd8a7b364b843e2b68bd84d3374d5b1e8ed4cba))
* **claude:** enforce orbstack-only kubectl from this project ([8f081db](https://github.com/x1agent/x1agent/commit/8f081dba7bd519d789a4f3b83d85ea14fcb7a6c1))
* **cli:** mise run logs <component> against the active deployment ([#17](https://github.com/x1agent/x1agent/issues/17)) ([e7e2eb3](https://github.com/x1agent/x1agent/commit/e7e2eb36fe99034af66dce114ef3d7f9417aaeb2))
* **cli:** quickstart TUI wizard + remove Claude Code OAuth mount path ([b59106d](https://github.com/x1agent/x1agent/commit/b59106d3644e5f92c3850b9ae8a51213e255343c))
* **cli:** x1agent deploy command + helm pre-upgrade migration ([dfe76e8](https://github.com/x1agent/x1agent/commit/dfe76e8229a870d8cfc90135af826cde2a94fe4c))
* **collections:** configurable vector dimension + metric at create ([6af3cba](https://github.com/x1agent/x1agent/commit/6af3cbab1868cfd55a6621e87bbfde242ee885e5))
* **collections:** live graph_discover on detail page + SurrealDB shape fix ([035b1ca](https://github.com/x1agent/x1agent/commit/035b1ca764f7b5d58fd1833cf5ea3c1b4e816921))
* **collections:** migration + domain package ([26cc6e7](https://github.com/x1agent/x1agent/commit/26cc6e714c87df418048278b23268ff3cef812ae))
* **collections:** per-record-type records page with inline detail ([d7be5f5](https://github.com/x1agent/x1agent/commit/d7be5f565b0eb90bce04f09345d585ba52b33827))
* **collections:** REST API + NATS provider gateway ([2a53d94](https://github.com/x1agent/x1agent/commit/2a53d9413fc38b498b5a0f5b5e7b01b1a3cb1c06))
* **collections:** sidecar graph/vector routes + MCP tools + pod wiring ([5a79fd5](https://github.com/x1agent/x1agent/commit/5a79fd5b434dd6ebf73d7cd42a62dfe3cb099ba4))
* **deploy:** in-cluster registry for platform presets ([531396c](https://github.com/x1agent/x1agent/commit/531396c85c1d9032cf149415d345daf15a598bcf))
* **deploy:** NATS in OrbStack + api event subscriber ([88dfa18](https://github.com/x1agent/x1agent/commit/88dfa1874f740dcda58e146b9577703cb72fe923))
* **deploy:** OrbStack-K8s dev stack via devspace ([6b9e083](https://github.com/x1agent/x1agent/commit/6b9e0831a68e91eb018aa8a8f5dbcb0e8a2182fe))
* **dev:** dev:direct workflow — devspace-less local up ([8ed2314](https://github.com/x1agent/x1agent/commit/8ed23147f2b063bf7c3a0d39199f865c256ec2d3))
* **dev:** mise run dev:cold — same stack, no hot reload ([0a86700](https://github.com/x1agent/x1agent/commit/0a86700c8cb3a6b3fdb7d6b5df11bfe8c32490f4))
* **dev:** mise run images:session + doc the staleness trap ([cf0bd44](https://github.com/x1agent/x1agent/commit/cf0bd44b28f15cd73a6dde9d521b8249c44fb5fc))
* **dev:** run the app in cluster at https://app.local.x1agent.dev ([8fc967d](https://github.com/x1agent/x1agent/commit/8fc967d52a8c4d381185f097737eb58c6772a346))
* **docs:** Cloud Run CI/CD path with resource-scoped deployer ([#5](https://github.com/x1agent/x1agent/issues/5)) ([0aee614](https://github.com/x1agent/x1agent/commit/0aee6145f473c58dda81a4ef0e0f69567538f36b))
* **github:** allow_push attachment flag enforced at sidecar credential helper ([a448375](https://github.com/x1agent/x1agent/commit/a44837591d4efa4f963fac6de6598d5907f23180))
* **github:** GitHub App domain with installation + repo linking ([0e8aa97](https://github.com/x1agent/x1agent/commit/0e8aa97e98ed923dd14c25a91803ae44fa9d82f8))
* **grants:** Hono routes for agent grants + groups ([e1dba1f](https://github.com/x1agent/x1agent/commit/e1dba1f021c4d07a0ea6dfe3eb75148f0c5c6305))
* **grants:** subject_kind generalization + agent grants + groups schema ([3fa750a](https://github.com/x1agent/x1agent/commit/3fa750a8572ce877eeab52cd9396f664e6a63539))
* **grants:** subject_kind kernel + agent grants + groups domain ([cb53c1c](https://github.com/x1agent/x1agent/commit/cb53c1c35ff51cce5382b2817f8a0d181614a6d4))
* **graph,vector:** domain packages with ports + fakes + contracts ([769b15d](https://github.com/x1agent/x1agent/commit/769b15d6d045d76c3a4496413c19e7cdde6c79ca))
* **graph,vector:** graph-surrealdb provider service + dev stack ([9533b49](https://github.com/x1agent/x1agent/commit/9533b49f3300a047d11c481204edca2706fd78ae))
* **graph,vector:** SurrealDB adapters ([79288ee](https://github.com/x1agent/x1agent/commit/79288ee4aad48832661961556b89c1366d5fcb84))
* **image-catalog:** Dockerfile source on every agent_images row ([194a2c9](https://github.com/x1agent/x1agent/commit/194a2c919e635e7d243ea9527926c56e20482189))
* **image-catalog:** generic language presets (python, node, go, rust) ([65d45ec](https://github.com/x1agent/x1agent/commit/65d45ecb610f9ecae257a1b1dfc71fdf8561ab47))
* **image-catalog:** mise images:publish task + seed platform presets ([f530f24](https://github.com/x1agent/x1agent/commit/f530f2438300d58e49aeaa45e45a637fce8cb9d4))
* **image-catalog:** Phase 1 — migration, runtime-core rename, pod-spec lookup ([4c95295](https://github.com/x1agent/x1agent/commit/4c95295a917d101d8e0ea3659bc471d8c1606a24))
* **install:** ANTHROPIC_MODEL + GOOGLE_OAUTH_SCOPES configurable ([ed26280](https://github.com/x1agent/x1agent/commit/ed262806bfd2fc99e35600f62478dd551740c7c5))
* **installer:** GCP helm chart, terraform module, install/configure CLI ([c5c782b](https://github.com/x1agent/x1agent/commit/c5c782b65d44b7d14ab2841cbdfdaf4aea223cce))
* **install:** session pod images + sentry sidecar + WS public endpoint ([78b4f14](https://github.com/x1agent/x1agent/commit/78b4f145ed7e07c009ea380f1468b016811dfbe8))
* **invitations:** send/accept/revoke flow with cross-person guard ([d841afb](https://github.com/x1agent/x1agent/commit/d841afb99bf94dc40e7de3cd424614fe37c44367))
* **kernel:** shared value objects and domain primitives ([6a419cf](https://github.com/x1agent/x1agent/commit/6a419cfa7c66eababa64028a57766c15dc9a8107))
* MCP catalog + agent env (Zone 2) + preview secrets ([#13](https://github.com/x1agent/x1agent/issues/13)) ([fe681d2](https://github.com/x1agent/x1agent/commit/fe681d21d4c56d57f891f8ccf17a37cdfe8a1ddf))
* **messaging:** domain package with port + fake + contract suite ([a2b8b87](https://github.com/x1agent/x1agent/commit/a2b8b87e5d13536a34d5fd0f0267fca0d1b8ea6f))
* **messaging:** messaging-slack provider service + dev stack ([21f56f1](https://github.com/x1agent/x1agent/commit/21f56f1dd2658928a9caf645081613ac03dfa66f))
* **messaging:** sidecar bridge + post_message MCP tool ([f83159a](https://github.com/x1agent/x1agent/commit/f83159a3ffd4184a89dc03a4d9ca5a191d1d2159))
* **messaging:** Slack adapter for the messaging port ([9e1f120](https://github.com/x1agent/x1agent/commit/9e1f120bfbab5ee7886d60e197ad6daedd10a55a)), closes [#ops](https://github.com/x1agent/x1agent/issues/ops)
* **models:** strict admin curation for agent model dropdown ([#3](https://github.com/x1agent/x1agent/issues/3)) ([23aa35d](https://github.com/x1agent/x1agent/commit/23aa35dbb31b8f47584342956645f2b76e7c6092))
* **observability:** sentry app+api, otel telemetry package, debug page ([0f2b951](https://github.com/x1agent/x1agent/commit/0f2b951079905b59d5833c4ec56de8993a8240aa))
* **orchestration:** activity watchdog — silent-child detection with exp backoff ([2afb045](https://github.com/x1agent/x1agent/commit/2afb04545dc794c0500c7f38ede2690524aafdda))
* **orchestration:** checkup timer — cadence wake with children snapshot ([823a5b7](https://github.com/x1agent/x1agent/commit/823a5b73089b40a9e7247f0b95775466eede47f4))
* **orchestration:** expect_quiet_for — child hint suppresses watchdog ([bbec35a](https://github.com/x1agent/x1agent/commit/bbec35a3cb8ff8385a0f64ef5f4558c46347d854))
* **orchestration:** message_caller — child-initiated push signal ([f53a2d0](https://github.com/x1agent/x1agent/commit/f53a2d093c70b0335a73144cd5c0218095f35aa5))
* **orchestration:** read_child_output + inject_message MCP tools ([20db2a9](https://github.com/x1agent/x1agent/commit/20db2a9f105fad383703049b0aab2874e6861ad7))
* **orchestration:** spawn_session + list_spawnable_agents MCP tools ([0d093bf](https://github.com/x1agent/x1agent/commit/0d093bf67c3946a75d816acfe7ff437938f974d4))
* **orchestration:** state_change wake — parent auto-woken when child terminates ([3b6af6a](https://github.com/x1agent/x1agent/commit/3b6af6a713c5156ee7e6b999d64baef93c41a4c6))
* **permissions:** dangling-grant reaper + session-status join ([b82379b](https://github.com/x1agent/x1agent/commit/b82379bf31971ea9c7d4425cc9721e0a3e6e4a86))
* **permissions:** permission grants migration + domain package ([e83118c](https://github.com/x1agent/x1agent/commit/e83118c9b3959622dbb8792133415044f3d20065))
* **permissions:** postgres adapter + grants API ([bb5ec6b](https://github.com/x1agent/x1agent/commit/bb5ec6b40bcd4f4a5473cd0157e32922bc261dfe))
* **permissions:** request_grant MCP tool + inline approval card ([a991792](https://github.com/x1agent/x1agent/commit/a99179223725bdd97f62eac0e389029cc822fd57))
* provider OTel init, agent/api polish, ROADMAP, lockfile ([f9fde47](https://github.com/x1agent/x1agent/commit/f9fde477e349cfaed5902d4ebf9efaeb231bff99))
* **providers:** preview — Kaniko build + K8s apply, URL back to agent ([8788c8b](https://github.com/x1agent/x1agent/commit/8788c8b9d34c290eac4dc81b04968848618f1dfa))
* **scheduler:** heartbeat ticks inject into live orchestrator sessions ([0176315](https://github.com/x1agent/x1agent/commit/0176315cffd77969770f6402d8bb4e1f76424212))
* **security:** NATS mTLS with client cert verification ([7ce3def](https://github.com/x1agent/x1agent/commit/7ce3defb1422b91a729a55c6b895fe8953372553))
* **security:** NetworkPolicy for shared-agent-resources ([abc37aa](https://github.com/x1agent/x1agent/commit/abc37aab143f5c0ebc860e81536f8b73359cc51f))
* **security:** per-project gcloud safety hook ([1d55e55](https://github.com/x1agent/x1agent/commit/1d55e556de8e43c4cfedf374811446ee81be70a9))
* **security:** pod-level NetworkPolicy for every role ([0140bc6](https://github.com/x1agent/x1agent/commit/0140bc6f2e6fcee33c435e939f273112c88f97f6))
* **security:** PodSecurityContext on every app container ([2b4f543](https://github.com/x1agent/x1agent/commit/2b4f543ba2384912b9d50aebe96e26e46362a526))
* **security:** sidecar audit log — NATS bus + Postgres persistence ([f84706b](https://github.com/x1agent/x1agent/commit/f84706b5d170f3d24b17a11b5594a38e4af4da2b))
* **session:** end-to-end pipeline — agent auth, non-root, push-back ([b15eaf4](https://github.com/x1agent/x1agent/commit/b15eaf4a58b9fe03c6dc1fb1689d571ec6cfe2e8))
* **sessions:** event log + internal endpoints for the sidecar ([2106592](https://github.com/x1agent/x1agent/commit/2106592eff53dfcfb7c58e87fe089d1e2752cc6e))
* **sessions:** internal spawn endpoint + parent linkage ([3e7ff94](https://github.com/x1agent/x1agent/commit/3e7ff94af9072512b8e4699a117ed203ad4bb984))
* **sessions:** migration for per-user session shares ([f93c891](https://github.com/x1agent/x1agent/commit/f93c8917e71dcaeb64e84be4c5a52efd6989ca42))
* **sessions:** per-session token usage tracking ([53a7e38](https://github.com/x1agent/x1agent/commit/53a7e38a3feebf22ab75c06a0dee1848d9f06928))
* **sessions:** per-user share domain (no routes yet) ([c737c5b](https://github.com/x1agent/x1agent/commit/c737c5b29673170acc8c3bb7716700b146d69879))
* **sessions:** pod reconciler — ghost sessions flip to failed with parent wake ([f60e89b](https://github.com/x1agent/x1agent/commit/f60e89beddbe05a6c2be94ceecd4072c9affb34e))
* **sessions:** resume flow — domain, history builder, POST /resume ([e786565](https://github.com/x1agent/x1agent/commit/e78656573125cd90383ac40d9802a8d4bca6bd83))
* **sessions:** scheduler-driven session domain ([d88d68c](https://github.com/x1agent/x1agent/commit/d88d68ca3efe54d3f7176ed4176258b140ec0ea8))
* **sessions:** share routes + UI panel ([8615a61](https://github.com/x1agent/x1agent/commit/8615a61116212ff48c2f3c52c8ae01f4ca07006d))
* **shared-agent-resources:** /reset branch endpoint + catalog extraction ([fd1e67b](https://github.com/x1agent/x1agent/commit/fd1e67bf4081c54a9dcaf892ce42098907026e8c))
* **shared-agent-resources:** migration for catalog + per-branch tables ([c01feb8](https://github.com/x1agent/x1agent/commit/c01feb8d06dabf818758444b7b837f3bca8bd8da))
* **sidecar:** add share subsystem — POST /share ([ee4079f](https://github.com/x1agent/x1agent/commit/ee4079f0b3cbc12316f367a4e61f4f27e599852a))
* **sidecar:** Rust NATS bridge + git credential proxy ([cecd9e9](https://github.com/x1agent/x1agent/commit/cecd9e9211e4b0ed8ed11c91839ad3ef4e979f59))
* **web,docs:** marketing site + cloudflare docs deploy + GCP install guide ([271a0d0](https://github.com/x1agent/x1agent/commit/271a0d035d85d78d045722f3e5bd13b444008d40))
* workspace environment variables (v1: encrypted Postgres) ([#7](https://github.com/x1agent/x1agent/issues/7)) ([d41ae97](https://github.com/x1agent/x1agent/commit/d41ae97e612bc4f283dc97b55bb704e3b4f33a69))
* **workspaces:** bounded context for workspaces + memberships ([777aa3b](https://github.com/x1agent/x1agent/commit/777aa3b49e2747b33f89d8c184ce639550e4ba56))
* **workspaces:** create-workspace flow + no-access entry point ([620e096](https://github.com/x1agent/x1agent/commit/620e0966074861e708b450bc6817e5dd880e7601))
* **workspaces:** settings tabs + status reconciler + container registry panel ([0420b6a](https://github.com/x1agent/x1agent/commit/0420b6a221b86403c0a240fe879727df55a9745f))

## [1.1.2](https://github.com/x1agent/x1agent/compare/v1.1.1...v1.1.2) (2026-04-18)


### Bug Fixes

* **docs:** rename mermaid node 'graph' to 'graphProv' ([af43726](https://github.com/x1agent/x1agent/commit/af43726c298a05a4d7287f03833bb04ba3bdb45c))

## [1.1.1](https://github.com/x1agent/x1agent/compare/v1.1.0...v1.1.1) (2026-04-18)


### Bug Fixes

* **docs:** allow <br/> in mermaid labels ([4ee4972](https://github.com/x1agent/x1agent/commit/4ee4972be514a429539fa125965acc87365eb29f))

# [1.1.0](https://github.com/x1agent/x1agent/compare/v1.0.0...v1.1.0) (2026-04-18)


### Features

* **docs:** render mermaid diagrams client-side ([6813c05](https://github.com/x1agent/x1agent/commit/6813c054daa3f2113eef98dde0b457a333be036e))

# 1.0.0 (2026-04-18)


### Features

* initial project scaffolding with docs site and CI/CD ([2615caa](https://github.com/x1agent/x1agent/commit/2615caa74744494ab95271e40af8d91cd3229a46))
