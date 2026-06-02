# [1.39.0](https://github.com/x1agent/x1agent/compare/v1.38.0...v1.39.0) (2026-06-01)


### Bug Fixes

* **api:** close agent-existence leak in requireAgentWrite ([e254ccb](https://github.com/x1agent/x1agent/commit/e254ccb27a0d6007bf8ba4020efb27c2bb5e7475))
* **api:** expose agent reads to any workspace member ([89aa31a](https://github.com/x1agent/x1agent/commit/89aa31afa3d56bc33f49461e3d0bc590e9fa8613))
* **app:** always fetch MCP + env on agent detail page ([3408940](https://github.com/x1agent/x1agent/commit/340894004100d27a0af19616a3265527884488bc))
* **chart:** allow http01 cert solver + gate preview wildcard ([d9fe37a](https://github.com/x1agent/x1agent/commit/d9fe37acaa1652faa7d88c60e25a26661627cda8))
* **db:** renumber users_timezone migration to 063 to clear 062 collision ([560a67f](https://github.com/x1agent/x1agent/commit/560a67f2c1ea29dbd846fe313a90fc718f240f1b))
* **domains:** redact env_json literal values on the wire ([8afd256](https://github.com/x1agent/x1agent/commit/8afd256f76d43f29bf445fc4592aab7544ebe514))
* **groups:** scope legacy slug uniqueness to active+manual groups ([5f716e0](https://github.com/x1agent/x1agent/commit/5f716e002f0127e6cd1143fec946c6ec4c1cb480))


### Features

* **domains:** split agent route factories into read + write guards ([d3229b2](https://github.com/x1agent/x1agent/commit/d3229b27befb06dacd92fce8e4a463fe06501e49))
* **workspaces:** groups backend foundation (X1A-107) ([d55932c](https://github.com/x1agent/x1agent/commit/d55932c4e57c87a7ab1dacadda1b688678f674d7))

# [1.38.0](https://github.com/x1agent/x1agent/compare/v1.37.1...v1.38.0) (2026-05-19)


### Features

* **agent-codex:** spike v0 Codex harness package ([ffc5680](https://github.com/x1agent/x1agent/commit/ffc5680321c86c2b63e368ab142fb049fa43ad56))
* **api:** pod-spec OPENAI_API_KEY branch for Codex runtime spike ([2fd9afd](https://github.com/x1agent/x1agent/commit/2fd9afd1c8f67025c3ab615546d45509fa6c5cfc))

## [1.37.1](https://github.com/x1agent/x1agent/compare/v1.37.0...v1.37.1) (2026-05-17)


### Bug Fixes

* **app:** don't 403-storm on agent detail page for non-admin members ([bce4429](https://github.com/x1agent/x1agent/commit/bce442911621326987a735b665002bc96e6b4a93))
* **docker:** add domain-preview-environments to every dev Dockerfile ([8a3a953](https://github.com/x1agent/x1agent/commit/8a3a953d422fc6cefb3ac394ff2cd217017aba2d))
* **observability:** suppress Sentry init in dev-shaped environments ([2699886](https://github.com/x1agent/x1agent/commit/269988617d64b025be5740df4850ee8e701a1d84))
* **sidecar:** wire Sentry end-to-end — DSN propagation + tracing layer ([db76dc9](https://github.com/x1agent/x1agent/commit/db76dc9e9c5db86b4a91502bba8bd6e61f2febaf))


### Features

* **auth,app:** users.timezone + ScheduleBuilder local↔UTC + /account picker ([#145](https://github.com/x1agent/x1agent/issues/145)) ([cb6e25c](https://github.com/x1agent/x1agent/commit/cb6e25c68c61c4ae2164711112a3f5dbbe82c769))

# [1.37.0](https://github.com/x1agent/x1agent/compare/v1.36.1...v1.37.0) (2026-05-17)


### Features

* **agents:** per-agent collaborate grants + open-by-default Permissions tab ([#143](https://github.com/x1agent/x1agent/issues/143)) ([b4de510](https://github.com/x1agent/x1agent/commit/b4de510ebdf87c0fe75737e04dc3f8962ae2e9d5)), closes [#142](https://github.com/x1agent/x1agent/issues/142)

## [1.36.1](https://github.com/x1agent/x1agent/compare/v1.36.0...v1.36.1) (2026-05-17)


### Bug Fixes

* **shares:** GCS-backed share storage + resume-chain auth ([#142](https://github.com/x1agent/x1agent/issues/142)) ([3376548](https://github.com/x1agent/x1agent/commit/337654879310bc0ab98fa5ad72957fed1705f3b8))

# [1.36.0](https://github.com/x1agent/x1agent/compare/v1.35.1...v1.36.0) (2026-05-17)


### Bug Fixes

* **api:** orchestration — tighter watchdog backoff + no-hang pullFromChild ([d2b2714](https://github.com/x1agent/x1agent/commit/d2b2714997158167740c08d71bb5aa7c27740c61))
* **app:** align summarizer-model URL with backend route ([d6a9f4b](https://github.com/x1agent/x1agent/commit/d6a9f4b988d9c35a7e23f69329277575117400ed))
* **auth:** re-resolve platform-admin flag on /me + account switch ([fccdca5](https://github.com/x1agent/x1agent/commit/fccdca5fa4052787df6076be99270a0946b12609))


### Features

* **api:** admin/anthropic/summary-model endpoints + summarizer wire-up ([35fd493](https://github.com/x1agent/x1agent/commit/35fd4932e0d30b00910f674d1f1262f1fa5c5a68))
* **app:** Model Settings — tabbed page replaces standalone Claude models ([8c9e78a](https://github.com/x1agent/x1agent/commit/8c9e78aa7b66bded52a21ead37ed6a95549a24df))
* **sessions:** per-call modelResolver on Anthropic summarizers ([82dd6a7](https://github.com/x1agent/x1agent/commit/82dd6a745569241c576a256192996703dc48c809))

## [1.35.1](https://github.com/x1agent/x1agent/compare/v1.35.0...v1.35.1) (2026-05-17)


### Bug Fixes

* **scheduler:** orchestrator schedules don't fire silently when anchor is stale ([dd646e9](https://github.com/x1agent/x1agent/commit/dd646e9bf0dc584c57845f45b0058179998a28e7))

# [1.35.0](https://github.com/x1agent/x1agent/compare/v1.34.1...v1.35.0) (2026-05-17)


### Bug Fixes

* **agent-prompt:** worker drops share guidance; orchestrator gets update-mode ([1bd1f98](https://github.com/x1agent/x1agent/commit/1bd1f986f7e60d25a94322ef22a1cb6629f17a90))
* **app:** iOS keyboard leaves no stuck gap below the composer (dvh) ([e62dae5](https://github.com/x1agent/x1agent/commit/e62dae5184c8a321328d86560f41fdc44b2e10b4))
* **app:** keep agent image binding visible while the image is rebuilding ([1cf5fcc](https://github.com/x1agent/x1agent/commit/1cf5fccb06869b3a2af2d6145727b86fe1b98c01))
* **chart:** allow CN=session-sidecar to publish x1.session.*.input ([d4e7d99](https://github.com/x1agent/x1agent/commit/d4e7d9900e67ddac85fff6aff395f54c13ce354b))


### Features

* **agent:** pull_from_child MCP tool + orchestrator/worker prompt split ([9dcf90c](https://github.com/x1agent/x1agent/commit/9dcf90c13e6953a0d3684b3013bb0073f16780df))
* **api:** pull_from_child — orchestrator pulls a worker's /workspace ([4b9c7a4](https://github.com/x1agent/x1agent/commit/4b9c7a49dedd1f776f9975957610a0118bb7321a))
* **sidecar:** pull_from_child handler — relay to api with parent stamp ([bb1be5c](https://github.com/x1agent/x1agent/commit/bb1be5c1a7103eecea761c074357ddb7e44d7690))


### Performance Improvements

* **app:** drop JS scrollHeight autosize for pure-CSS grid auto-grow ([94b3cb3](https://github.com/x1agent/x1agent/commit/94b3cb334c9ad9500bf3ac0d89cebfac5774008e))
* **app:** per-session selectors + memo EventCard + content-visibility rows ([4069e68](https://github.com/x1agent/x1agent/commit/4069e680c30e7559ed7d39312fa630b540a1e60c))
* **app:** stable callbacks + memo TurnComposer so WS events don't tear down the composer ([3a1bb87](https://github.com/x1agent/x1agent/commit/3a1bb879a2f2f0da0a203fea0e62633b1d5d2bb1))

## [1.34.1](https://github.com/x1agent/x1agent/compare/v1.34.0...v1.34.1) (2026-05-16)


### Bug Fixes

* **sessions:** use unprefixed Vertex host when CLOUD_ML_REGION=global ([5f231d4](https://github.com/x1agent/x1agent/commit/5f231d47b7a145e2d56fe8041a973f169284f88b))

# [1.34.0](https://github.com/x1agent/x1agent/compare/v1.33.0...v1.34.0) (2026-05-16)


### Bug Fixes

* **agent-prompt:** make 'user cannot see your /workspace' explicit on the share tool ([662398a](https://github.com/x1agent/x1agent/commit/662398a6f0f78135bab1a5704fb97866638a4c40))
* **app:** make cost amounts clickable to open the worker-breakdown panel ([70427f5](https://github.com/x1agent/x1agent/commit/70427f5f05c6987f247f6f5fb1af746ddf8fe69b))
* **app:** poll children while session is running so the active-workers counter tracks reality (X1A-60) ([ea3b0c8](https://github.com/x1agent/x1agent/commit/ea3b0c8aa0aed661be39cdbafae2dcd5bdf4cb4b))
* **app:** refresh session record on children poll + single-pill typing indicator + better session-page title ([22a211d](https://github.com/x1agent/x1agent/commit/22a211dd96750191fe631a2ca24493f649a770ff))
* **comments:** server-stamp NATS payload so live + REST comments sort consistently ([1ae710e](https://github.com/x1agent/x1agent/commit/1ae710e68fa2e64fff248152a5469b09d8045ffe))
* **wake:** tell agent not to narrate on main timeline when replying to a comment ([4d3d67d](https://github.com/x1agent/x1agent/commit/4d3d67d0b6482ac14702cc88dfa59202e7f1efe0))


### Features

* **sessions:** GET /sessions/:id/children for live worker counts ([fe1ca2d](https://github.com/x1agent/x1agent/commit/fe1ca2d9144a19995dd30e1765b85d4091c88441))


### Reverts

* **app:** restore original hash + colorField in RailCanvas shader ([4f0bbc6](https://github.com/x1agent/x1agent/commit/4f0bbc6f8c9d420a29e637e7f572809127e0ce52))

# [1.33.0](https://github.com/x1agent/x1agent/compare/v1.32.0...v1.33.0) (2026-05-16)


### Bug Fixes

* **agent:** probe sidecar health on :9091, not :9090 ([c7248c5](https://github.com/x1agent/x1agent/commit/c7248c51a5869421eca605e647af0cd6b7cc6294))
* **api:** reject preview-deploy for repos not linked to the agent ([83e4623](https://github.com/x1agent/x1agent/commit/83e46233fa02cad3690ff75814f4c881a032b4fc)), closes [#139](https://github.com/x1agent/x1agent/issues/139)
* **api:** typecheck-clean uploads + job-watcher + uploads-raw response ([1acb0b1](https://github.com/x1agent/x1agent/commit/1acb0b128fe91a14d1605de5ef5a36cf6fbabff5))
* **app:** style Delete button as an actual destructive button ([02fdb45](https://github.com/x1agent/x1agent/commit/02fdb45004d45c5ead7c3f672241f4218fa774d5))
* **chart:** hybrid TLS solver — preview wildcard on DNS-01, app/api on HTTP-01 ([ea05f4d](https://github.com/x1agent/x1agent/commit/ea05f4d0052b8ccbd5f2fc4577d0d91d2bc83bc7))
* **composition:** hoist workspaceBindingRepo above internalRoutes (TDZ) ([95005f8](https://github.com/x1agent/x1agent/commit/95005f89ad4535fb780f2df9577b27b556a6e621))
* **composition:** hoist workspaceSecrets{Repo,Service} above internalRoutes (TDZ) ([8e9d452](https://github.com/x1agent/x1agent/commit/8e9d452633c4033850ae423661281a1efe6ff23d))
* **domains:** real prod typecheck errors that bun-test let through ([de63a9a](https://github.com/x1agent/x1agent/commit/de63a9a3d0240b636f42b80e8d327dad82eec05e)), closes [#139](https://github.com/x1agent/x1agent/issues/139)
* **migrations/058:** drop now() from partial-index predicate ([421baa9](https://github.com/x1agent/x1agent/commit/421baa9843ff129df13f314b9139a75558f3f290))
* **preview:** make kaniko pod unpack base images + fix bun TLS to k8s API ([9f96262](https://github.com/x1agent/x1agent/commit/9f96262c6ff23272a671338b04730e8c4be928da))
* **preview:** rename NATS subject from x1.providers.preview to x1.provider.preview ([f18c6d2](https://github.com/x1agent/x1agent/commit/f18c6d2d91514c47a914a4ba0b0b427ab4bd253d))


### Features

* **admin:** New-workspace button on /admin/workspaces ([896eca5](https://github.com/x1agent/x1agent/commit/896eca55acff1413d84a53db2012a6afdfeb0563))
* **api:** pre-deploy upsert with status=provisioning ([1c8fbd9](https://github.com/x1agent/x1agent/commit/1c8fbd95f655d6b38cd33f16e85aae4382128475))
* **api:** preview-environments routes + provider deploy upsert ([8cafa96](https://github.com/x1agent/x1agent/commit/8cafa963035a529dd4d9ae03deb97cc11e97729c))
* **api:** right-size session pod resources ([b47721b](https://github.com/x1agent/x1agent/commit/b47721b29a00fbb3bdd723b04a635ce37eb09e00))
* **api:** wire workspace env-bindings into composition + mount route ([4c56aad](https://github.com/x1agent/x1agent/commit/4c56aadfeb7aa1f48ee9de28dc49d4d838f318f4))
* **app:** access-grants panel under workspace settings → Members ([a5c9ab0](https://github.com/x1agent/x1agent/commit/a5c9ab0b55edf456d932df7c5e13f8698786c193))
* **app:** env-bindings UI — workspace settings panel + preview-env picker ([fc422d9](https://github.com/x1agent/x1agent/commit/fc422d9c25aff99962b7f65ff902ebf8f5c8e54c))
* **app:** environment detail page with rename + delete ([0345e82](https://github.com/x1agent/x1agent/commit/0345e82700c7763b3bbe35900870d645de413464))
* **app:** Environments sidebar entry + workspace list page ([26f55ef](https://github.com/x1agent/x1agent/commit/26f55efda57e31eeffbc67cdd5aba838188e9db7))
* **chart:** preview provider template — namespace, RBAC, cert, deployment ([9d05e3c](https://github.com/x1agent/x1agent/commit/9d05e3c25ffa992d5db8176603a8f0f606c7273f))
* **cli:** render providers.preview block in install values ([ecf3c44](https://github.com/x1agent/x1agent/commit/ecf3c44e607479d4e4f98a3d087806a5da40282d))
* **env-bindings,image-builder:** preview-deploy resolves workspace bindings + image-catalog Kaniko gets a writer SA ([5f5fdd4](https://github.com/x1agent/x1agent/commit/5f5fdd42d1b4642a3c9528c990812063e09ccb65))
* **env-bindings:** workspace-scope bindings + preview env-var-names ([aeb04e5](https://github.com/x1agent/x1agent/commit/aeb04e5bd739af14a52bfdb28e7734d73d89e5b3))
* **preview-environments:** new domain package + migration ([f935846](https://github.com/x1agent/x1agent/commit/f9358467e1b35954231c719fb0631f52b3ffb7dd))
* **preview:** plumb buildServiceAccount through the Kaniko Job spec ([f662d75](https://github.com/x1agent/x1agent/commit/f662d752e480df5f1e6d6239b791bf1b029bd424))
* **preview:** teardown subject + slug in failure replies + delete fires teardown ([4cd2bff](https://github.com/x1agent/x1agent/commit/4cd2bff0e30bdbc52f3290d268ba7bea19a083f1))
* **terraform/gcp:** preview build GSA with AR writer + WI binding ([288d2d4](https://github.com/x1agent/x1agent/commit/288d2d41d34254baea6a4107074e93aad8d48b8a))
* **workspaces:** per-workspace access grants — domain + email allowlists ([42a15cd](https://github.com/x1agent/x1agent/commit/42a15cdbc1c0c26a8be6e3a99bcc7e8086e5210e))

# [1.32.0](https://github.com/x1agent/x1agent/compare/v1.31.0...v1.32.0) (2026-05-16)


### Bug Fixes

* **app:** center agent detail page and move Edit inline beside title ([c945854](https://github.com/x1agent/x1agent/commit/c9458546458b61b7c6f079494d43f569da8ee05b))
* **app:** disambiguate prepend vs append in EventStream anchor logic ([ffaad4e](https://github.com/x1agent/x1agent/commit/ffaad4e0ed59f21c7e5077f922b04b6592bb8a5d))
* **app:** don't halt drift cycle on theme/resize during a tween ([c71ac86](https://github.com/x1agent/x1agent/commit/c71ac866f122f9ef4c56bff8fd4bf7e664d62f84))
* **app:** stop EventStream from grabbing scroll on every new event ([1d1bb89](https://github.com/x1agent/x1agent/commit/1d1bb893b05a9775a82a6d533242d500fb704152))
* **sessions:** switch comments load-older cursor from seq to created_at ([c36a489](https://github.com/x1agent/x1agent/commit/c36a489b1029a284b53924c7a8c910056c9b9177))
* **shares:** zip-slip guard on download endpoint ([8c031ef](https://github.com/x1agent/x1agent/commit/8c031ef9564327ac6d11130d5be784eb8b05d32b))


### Features

* **app:** center timeline on deep-linked share ([510e0ca](https://github.com/x1agent/x1agent/commit/510e0cabc20549e5766b13281f9a7e40ad4bebea))
* **app:** collapse comments sidebar when share is opened via deep-link ([9c6f4f0](https://github.com/x1agent/x1agent/commit/9c6f4f071d7d39c023138d56eeb2d7a9d5f6fecd))
* **app:** MCP picker hidden by default + fuzzy search (X1A-86) ([b20bd17](https://github.com/x1agent/x1agent/commit/b20bd17fe66afc26c18b263aa062193cefc68d61))
* **app:** paginate + fuzzy-search agent env bindings (X1A-86) ([33cb578](https://github.com/x1agent/x1agent/commit/33cb57816d1e643c8c55ffae08ae975ef45c2719))
* **app:** paginate + fuzzy-search available repos on agent edit (X1A-86) ([fe6b5ac](https://github.com/x1agent/x1agent/commit/fe6b5ac74164ded240c6cb0e53f36e8972521aeb))
* **app:** paginate comments sidebar with scroll-up to load older (X1A-72.4) ([ebefd0b](https://github.com/x1agent/x1agent/commit/ebefd0b173cc5f1a2e87b9452efd70fd41cd85a7))
* **app:** paginate session event load with scroll-up to load older (X1A-72.3) ([a67128d](https://github.com/x1agent/x1agent/commit/a67128de8f4a6032b197f8ff8019eb1be51b2cf7))
* **app:** render comment bodies as markdown (X1A-72.1) ([ef70a97](https://github.com/x1agent/x1agent/commit/ef70a974d78a66785bf15a5f4ef4a72a7d42ce92))
* **app:** shares index links open the share in fullscreen mode ([165d140](https://github.com/x1agent/x1agent/commit/165d140dfc8c1fb9287728a0d4dc34398511bea5))
* **app:** visual distinction for self-authored comments (X1A-72.2) ([effe270](https://github.com/x1agent/x1agent/commit/effe27060934ac0936510a85ed2cdbe1a056c815))
* **sessions:** add PlatformAdminGuard port ([d920507](https://github.com/x1agent/x1agent/commit/d920507a226c6ef8eea11bc891b5841afd77088b))
* **sessions:** hide superseded resume-chain entries from list queries ([b3d9751](https://github.com/x1agent/x1agent/commit/b3d9751b139bca436cff11c9f854d2413a02c0d2))
* **sessions:** listBySession + events endpoint support before_seq (X1A-72.3 backend) ([3d4bd23](https://github.com/x1agent/x1agent/commit/3d4bd238c8048ac6d845fb31121895558aa31c8d))
* **sessions:** listByShare + comments endpoint support thread pagination (X1A-72.4 backend) ([c5bbacc](https://github.com/x1agent/x1agent/commit/c5bbacc70a17a094fadc4a4af8e69e8f615761d4))
* **sessions:** platform admin replaces workspace admin in visibility checks ([2f7ed40](https://github.com/x1agent/x1agent/commit/2f7ed40f454558a8bc26ede76c8616803e507859))
* **sessions:** wire platform-admin guard through session/share routes ([a951391](https://github.com/x1agent/x1agent/commit/a95139105f9a702627fed71cd1c4f8df0fef7ed9))
* **shares:** download icon returns a zip of the whole share ([f53ed11](https://github.com/x1agent/x1agent/commit/f53ed116dcbd7574dcf202a53636201040773fd5))


### Performance Improvements

* **app:** draw RailCanvas once on iPad / Android tablet instead of running 60fps shader ([b86e139](https://github.com/x1agent/x1agent/commit/b86e139f94ac8afe89137c037c99fccb3654ac2d))
* **app:** drift-mode canvas + shader micro-optimizations ([acf4978](https://github.com/x1agent/x1agent/commit/acf497880c8e1a267f0bc2aa9400ba323dbf806d))

# [1.31.0](https://github.com/x1agent/x1agent/compare/v1.30.0...v1.31.0) (2026-05-15)


### Bug Fixes

* **agent:** clarify request_permission is platform-internal scopes only ([f1225ea](https://github.com/x1agent/x1agent/commit/f1225eaa31339388fd0b33d3b7f364f789623692))
* **api:** honour google oauth scope hierarchy in user-oauth-token check ([377b80f](https://github.com/x1agent/x1agent/commit/377b80f7677101f8d629be022bf7c17909d906a0))
* **api:** soft-skip zone-3 MCPs without an OAuth token instead of failing the session ([182ddcf](https://github.com/x1agent/x1agent/commit/182ddcf7ba6f65cfc5b6baf184acb79512ad7077))
* **google-workspace:** include shared drives on every Drive API call ([f8c9b0b](https://github.com/x1agent/x1agent/commit/f8c9b0b5db126fb633b14f40cc6646aa8820f7dd))


### Features

* **agents:** per-agent idle timeout override + UI knob ([406c8ba](https://github.com/x1agent/x1agent/commit/406c8ba608b415352c822c5c6f59a0a0d90496b6))
* **api:** summarizer prefers vertex → anthropic api key → openai ([3f3bf4e](https://github.com/x1agent/x1agent/commit/3f3bf4e15f582a639d59d740e2581318b50c2f25))
* **app:** collapse session cost to a [$] button by default, persist visibility ([d152be7](https://github.com/x1agent/x1agent/commit/d152be7fd466f0035944ba8b12b21f3466f93648))

# [1.30.0](https://github.com/x1agent/x1agent/compare/v1.29.0...v1.30.0) (2026-05-15)


### Bug Fixes

* **chart:** allow session sidecar to publish on x1.provider.{graph,vector}.> ([5b901d9](https://github.com/x1agent/x1agent/commit/5b901d979e72c3d9208c44dbf598758ff1e3fb00))
* **chart:** include packages/domains/ in messaging-slack image ([e848059](https://github.com/x1agent/x1agent/commit/e8480598c411181ebd8011b2624783c5c3022fd6))
* **chart:** widen session sidecar publish allowlist to all x1.provider.> ([b1029d5](https://github.com/x1agent/x1agent/commit/b1029d5123d99d91476dd965005d4bf42450a70a))
* **mise:** collapse duplicate `tasks.script` into the per-deployment runner ([c52f6a1](https://github.com/x1agent/x1agent/commit/c52f6a10f27d7ad789c05513ca4f419544098d31))


### Features

* **agent:** cancel_session + share_to_child MCP tools, suppress share-comment timeline emit ([17f4b89](https://github.com/x1agent/x1agent/commit/17f4b89cc3bdb9eb9d16abb1291faac6b05acd75))
* **api:** orchestrator MCP fan-out + silent-worker reaper + wake envelope ([a4b2019](https://github.com/x1agent/x1agent/commit/a4b20193019703fdf9a39ac87c3f93ff369a4784))
* **chart:** ship google-workspace provider as a chart-rendered Deployment ([3850f23](https://github.com/x1agent/x1agent/commit/3850f233f5306d0214738b6819c063810ac34c9a))
* **chart:** ship messaging-slack provider as a chart-rendered Deployment ([ab96046](https://github.com/x1agent/x1agent/commit/ab96046bc7e1990b82775982ccc06987e1417107))
* **mise:** add `mise run script <name>` for per-deployment ad-hoc scripts ([9d46daa](https://github.com/x1agent/x1agent/commit/9d46daa694c30ec72e969ba53a857888f341b3a3))
* **sessions:** parent-initiated cancelChildSession use case ([f478079](https://github.com/x1agent/x1agent/commit/f47807941b4df2b4f298c58219ceb1af1a46e806))
* **sidecar:** cancel_session + share_to_child + read_share + wake envelope ([6d72320](https://github.com/x1agent/x1agent/commit/6d723206d9b8a694dc68c854c0e90eb00adf6e6d))

# [1.29.0](https://github.com/x1agent/x1agent/compare/v1.28.0...v1.29.0) (2026-05-15)


### Bug Fixes

* **api:** flip pending→running on session.started event (X1A-66) ([b72fc38](https://github.com/x1agent/x1agent/commit/b72fc3887c5e0b5dd545f1a4931c2604a61f42ed))
* **app:** client-side status pill flips pending→running on session.started (X1A-66) ([e81089f](https://github.com/x1agent/x1agent/commit/e81089fc297293091480b40b73ad5356d4b66160))


### Features

* **api:** wire K8sJobTerminator into session-cancel composition (X1A-70) ([18aea3b](https://github.com/x1agent/x1agent/commit/18aea3b1f481ec91375826d6f4d6f7f552ad6559))
* **app:** cache-buster on share content URLs for live-update (X1A-92) ([b8e4a5f](https://github.com/x1agent/x1agent/commit/b8e4a5f1759ed5e2d2dbf4c339231d2d252564a4))
* **sessions:** Pause kills the K8s Job + clearer dup-tick errors (X1A-70) ([4969e9c](https://github.com/x1agent/x1agent/commit/4969e9c4cc244bf159922b61cc96937f05ad917d))
* **sidecar:** emit updated_at_ms on agent.share + harden path normalization ([fc67765](https://github.com/x1agent/x1agent/commit/fc67765f47d35d048091bd1fab0dd67f06e73f71))

# [1.28.0](https://github.com/x1agent/x1agent/compare/v1.27.1...v1.28.0) (2026-05-14)


### Bug Fixes

* **api:** send strategic-merge-patch Content-Type from platform-secrets store ([6401676](https://github.com/x1agent/x1agent/commit/6401676a9f3e663e9f43e61f98a3f3a8faad32a4))
* **sessions:** members can trigger and cancel their own sessions (X1A-126) ([7a3352b](https://github.com/x1agent/x1agent/commit/7a3352b01f3ffd8d37c78f4439989f18741e56bc))


### Features

* **app:** active members card, role-edit on invitations, hide admin nav from members (X1A-127, X1A-129, X1A-130, X1A-131) ([65e8814](https://github.com/x1agent/x1agent/commit/65e8814f0f55b7c36a5ee45d99ac24d084ad7d99))
* **auth:** auto-accept pending invitations on first sign-in (X1A-128) ([f7d5b05](https://github.com/x1agent/x1agent/commit/f7d5b05b883743314851f1bab403e6f3ba979aa1))
* **invitations:** edit pending role + revoke returns row (X1A-129, X1A-130) ([8f3a603](https://github.com/x1agent/x1agent/commit/8f3a603f66953aeca92d88af09e7c4b3a6a79cb9))
* **mise:** add operator-scratchpad script task ([52e5b08](https://github.com/x1agent/x1agent/commit/52e5b084c3f3ff7cd4785f2adbe38d2ddb2adca4))
* **workspace-members:** PATCH role + DELETE member API (X1A-127) ([3529e56](https://github.com/x1agent/x1agent/commit/3529e567228c30302f0aa7f8447b2dca6e4e4d45))

## [1.27.1](https://github.com/x1agent/x1agent/compare/v1.27.0...v1.27.1) (2026-05-14)


### Bug Fixes

* **app:** share content + comments live-update from agent ([3aa8131](https://github.com/x1agent/x1agent/commit/3aa81318fe8fd4bb758ca589c2e27053ab141d51)), closes [#132](https://github.com/x1agent/x1agent/issues/132)

# [1.27.0](https://github.com/x1agent/x1agent/compare/v1.26.0...v1.27.0) (2026-05-14)


### Features

* **shares:** add read_share MCP tool + content-read api route (PRD 0006 Slice A) ([eff9472](https://github.com/x1agent/x1agent/commit/eff947288a813f0099bf61e2092cc377e62efcd1))

# [1.26.0](https://github.com/x1agent/x1agent/compare/v1.25.2...v1.26.0) (2026-05-14)


### Bug Fixes

* **auth:** enforce OAuth state + PKCE on Google sign-in flow ([c6d4186](https://github.com/x1agent/x1agent/commit/c6d4186ffe368fada4ee4f15768941b6226367fa)), closes [#1](https://github.com/x1agent/x1agent/issues/1)
* **chart:** allow http01 cert solver + gate preview wildcard ([fc9cb50](https://github.com/x1agent/x1agent/commit/fc9cb506aefdaddc926cf7afc7c724ab6af3c674)), closes [#132](https://github.com/x1agent/x1agent/issues/132)
* **chart:** drop redundant default true on session.networkPolicy.enabled ([acccd69](https://github.com/x1agent/x1agent/commit/acccd69e3c5c1db2623e4e73ac41a73f75211abc)), closes [124/#129](https://github.com/x1agent/x1agent/issues/129)
* **chart:** restore session.networkPolicy values dropped by [#132](https://github.com/x1agent/x1agent/issues/132) merge ([a1b3c62](https://github.com/x1agent/x1agent/commit/a1b3c628daff8e333a464e17623c7bd58bba08e9)), closes [#124](https://github.com/x1agent/x1agent/issues/124) [#129](https://github.com/x1agent/x1agent/issues/129)
* **graph:** reject USE / multi-statement SurrealQL from agents ([8e1ea9a](https://github.com/x1agent/x1agent/commit/8e1ea9a4ad6178f9742f4cfbf2b0e08125f51f5d)), closes [#2](https://github.com/x1agent/x1agent/issues/2)
* **helm:** remove anonymous NATS WebSocket listener mapping to api super-user ([3052216](https://github.com/x1agent/x1agent/commit/30522160d7b23279370281266fdb3173b88e9161))
* **mcp-catalog:** close SSRF holes in OAuth metadata + DCR fetches ([0dccfb2](https://github.com/x1agent/x1agent/commit/0dccfb220c884ba97675d248070c8ebca4c76205))
* **migrations:** renumber oauth_login_states 053→054 (collision with collections_backend_namespace) ([70e8d4f](https://github.com/x1agent/x1agent/commit/70e8d4f907ddc2b385b8045a442fd3bc4f039ce4))
* **sidecar:** bind credential routes to localhost + add session NetworkPolicy ([b432c74](https://github.com/x1agent/x1agent/commit/b432c740e32a72cc59e1ec7ae740517b1fc6fe7b))
* **sidecar:** delete unauthenticated /user-oauth-token sidecar route ([bd8853c](https://github.com/x1agent/x1agent/commit/bd8853c3d169f9f4ab0115f6c725bb0182306392))
* **sidecar:** drop API_INTERNAL_TOKEN from agent container — relay upload reads through sidecar ([a2040e5](https://github.com/x1agent/x1agent/commit/a2040e5bf5a263885d2e9edf089108ee682a328d))
* **tests:** switch JSDoc to line comments to unblock bun parser ([4067293](https://github.com/x1agent/x1agent/commit/4067293429e862ab7b0dcea14755ac7e9e6630ad))


### Features

* **graph:** per-workspace SurrealDB namespace isolation ([9cb7437](https://github.com/x1agent/x1agent/commit/9cb74378252d27533cb8f4010b06e67aba0bae19)), closes [#2](https://github.com/x1agent/x1agent/issues/2) [#128](https://github.com/x1agent/x1agent/issues/128) [#128](https://github.com/x1agent/x1agent/issues/128)
* **security:** add agent-session egress NetworkPolicy to Helm chart ([de0715f](https://github.com/x1agent/x1agent/commit/de0715f4609b27fc2d2e4c8398541fdb9c1ce9fb)), closes [#1](https://github.com/x1agent/x1agent/issues/1)

## [1.25.2](https://github.com/x1agent/x1agent/compare/v1.25.1...v1.25.2) (2026-05-14)


### Bug Fixes

* **chart:** drop nginx variable from apex-redirect annotation ([3f54c09](https://github.com/x1agent/x1agent/commit/3f54c09c97c08a9cc7de89196ead3dc295ad04f6))

## [1.25.1](https://github.com/x1agent/x1agent/compare/v1.25.0...v1.25.1) (2026-05-14)


### Bug Fixes

* **api:** authenticated WS bridge replaces public NATS exposure ([5e4b06f](https://github.com/x1agent/x1agent/commit/5e4b06f7e87695380963178c5e79e8ced74649c7))
* **cli:** per-deployment kubeconfig + tfstate isolation ([4f07387](https://github.com/x1agent/x1agent/commit/4f073871e15cf562087058ebd6fbaa04346a4378))
* **docker:** glob workspace manifests so deploy:prod stops drifting ([b842fa9](https://github.com/x1agent/x1agent/commit/b842fa91be26c435b1412f66aadbfa72e0d91eb4))

# [1.25.0](https://github.com/x1agent/x1agent/compare/v1.24.9...v1.25.0) (2026-05-13)


### Bug Fixes

* **cli:** parse multi-line quoted values in installs env file ([b41f7d0](https://github.com/x1agent/x1agent/commit/b41f7d09c91451be6fd1a34752fb7c232f2a9f0a))
* **comments:** chronological order + threaded layout + See-more clamp (X1A-105) ([fd16c5a](https://github.com/x1agent/x1agent/commit/fd16c5a0225e71993cc95bc790961aaf672dff10))
* **comments:** clear reply target on shareId change ([49879c5](https://github.com/x1agent/x1agent/commit/49879c52f4b3ace7412ed702e2d70987156696a8))
* **comments:** hide share-comment wakes from session timeline (X1A-110 Bug A) ([6c68409](https://github.com/x1agent/x1agent/commit/6c684094213457de4bdbe487f5a15b9457f85f7f))
* **comments:** keep SharePill snippet inline; drop dead agent fallback ([81366c9](https://github.com/x1agent/x1agent/commit/81366c9d6d4f47547aa9a52726d884510326b011))
* **sessions:** join sessions to agents for workspace scope in rollupForAgent ([b1fa7bf](https://github.com/x1agent/x1agent/commit/b1fa7bfdbe42f1e5e6852cfcbb89a03d73b1e6ad))
* **uploads:** write image bytes to /workspace/.x1/uploads + ownership guard + pill render ([c716d2a](https://github.com/x1agent/x1agent/commit/c716d2aecb76ed51cc2d0e7e67bef627d2f690bb)), closes [#2](https://github.com/x1agent/x1agent/issues/2)


### Features

* **app:** X1A-104 typing indicator UI for agent thinking ([bafd3ff](https://github.com/x1agent/x1agent/commit/bafd3ff8733e9b37d78d89ab78b363f8ed7c2daf))
* **comments:** reply-nesting on share comments (X1A-110 Bug B) ([b07fe69](https://github.com/x1agent/x1agent/commit/b07fe690dcbf11608ae5ec69a430268952397c50))
* **cost:** click-outside + Escape close the floating tree dropdown ([f2f014d](https://github.com/x1agent/x1agent/commit/f2f014d2fe79df38c0368c487e98f273b5cf2a1b))
* **cost:** collapse session-tree by default; expand on caret click ([6bd7555](https://github.com/x1agent/x1agent/commit/6bd7555aef4dda7e3add867e20edf0a1c05a39f2))
* **cost:** collapsible top sessions + sparkline day-hover (X1A-115) ([f26fa8d](https://github.com/x1agent/x1agent/commit/f26fa8d2ee58b35b27e3727786c66c267a5d5623))
* **install:** optional apex-redirect Ingress + configure prompt ([5057288](https://github.com/x1agent/x1agent/commit/50572888c840c5c27f59b843e98c6fdd65d1a994))
* **prompt-tokens:** shared parser for [image: <uuid>] wire format ([f6f1140](https://github.com/x1agent/x1agent/commit/f6f1140ed57995627f5501cd5e60de27c3e648ef))
* **sessions:** emit transient session.agent_thinking event on wake ([dffb580](https://github.com/x1agent/x1agent/commit/dffb5805ac514ff92e0c65495f9ec328c216ea30))
* **uploads:** composer drag/drop + in-prompt pill + agent-side fetch (X1A-98 / X1A-96) ([ea37b59](https://github.com/x1agent/x1agent/commit/ea37b598ce230e3d95c5ea450927ed821221ce8c))
* **uploads:** image upload backend foundation (X1A-96) ([691b2de](https://github.com/x1agent/x1agent/commit/691b2dedf68e4b9624d6bf5151e8a980d9e1b66b))

## [1.24.9](https://github.com/x1agent/x1agent/compare/v1.24.8...v1.24.9) (2026-05-13)


### Bug Fixes

* **agent:** share tool returns share_id + usage hints ([d70d924](https://github.com/x1agent/x1agent/commit/d70d924c2e1b3b528ab77de6abf878403a6dfaa0))

## [1.24.8](https://github.com/x1agent/x1agent/compare/v1.24.7...v1.24.8) (2026-05-13)


### Bug Fixes

* **nats:** widen ACL for api comment-wake + sidecar archive subjects ([16d23bb](https://github.com/x1agent/x1agent/commit/16d23bbb34d7ff72f66e9c8342670011dda128d8))

## [1.24.7](https://github.com/x1agent/x1agent/compare/v1.24.6...v1.24.7) (2026-05-13)


### Bug Fixes

* **helm:** expose port 30001 on prod api Service for in-cluster callers ([d9b67e2](https://github.com/x1agent/x1agent/commit/d9b67e23d4f2e18b7a22bf80c6fb36ee159878ee))
* **input:** make user-input durable via JetStream + drop stale on consumer ([13ec6a8](https://github.com/x1agent/x1agent/commit/13ec6a8a4f109de6ae73ccbfce41b8647d9e589a))

## [1.24.6](https://github.com/x1agent/x1agent/compare/v1.24.5...v1.24.6) (2026-05-12)


### Bug Fixes

* **app:** gate scheduled-run-as default on workspaceMembers load ([57308b8](https://github.com/x1agent/x1agent/commit/57308b894963cba7c97d3f6dfb9deace3100fe22))
* **migrate:** fail loudly on duplicate numeric prefixes ([47cba20](https://github.com/x1agent/x1agent/commit/47cba20e3f5a4765e7316e667c7a1bf06bf0f6be))


### Reverts

* Revert "fix(app): minimal two-step create form for new agents" ([3a83b20](https://github.com/x1agent/x1agent/commit/3a83b20bdb9e6026d85826d58b35fbe26ecf5c7a))

## [1.24.5](https://github.com/x1agent/x1agent/compare/v1.24.4...v1.24.5) (2026-05-12)


### Bug Fixes

* **app:** minimal two-step create form for new agents ([ecb725a](https://github.com/x1agent/x1agent/commit/ecb725af80bb4525175088031ea63eac2cca4390)), closes [#185](https://github.com/x1agent/x1agent/issues/185)

## [1.24.4](https://github.com/x1agent/x1agent/compare/v1.24.3...v1.24.4) (2026-05-12)


### Bug Fixes

* **helm:** pass stream name positional to nats stream edit/add ([8c3902d](https://github.com/x1agent/x1agent/commit/8c3902dc0a75b9530c2fab4dbbe3a9817a779e62)), closes [#101](https://github.com/x1agent/x1agent/issues/101)

## [1.24.3](https://github.com/x1agent/x1agent/compare/v1.24.2...v1.24.3) (2026-05-12)


### Bug Fixes

* **app:** switch agent-edit page to per-field zustand selectors ([3ba6af0](https://github.com/x1agent/x1agent/commit/3ba6af058f3a0ddde4c7a7cf752be7c07029c828)), closes [#185](https://github.com/x1agent/x1agent/issues/185)

## [1.24.2](https://github.com/x1agent/x1agent/compare/v1.24.1...v1.24.2) (2026-05-12)


### Bug Fixes

* **install:** unblock end-to-end mise run install:prod against a fresh prod cluster ([ff92d1b](https://github.com/x1agent/x1agent/commit/ff92d1bcd4a35f4ee42c148e0add360a1be1b861))

## [1.24.1](https://github.com/x1agent/x1agent/compare/v1.24.0...v1.24.1) (2026-05-12)


### Bug Fixes

* **docker:** add missing workspace COPYs in prod Dockerfiles ([3cbb2d0](https://github.com/x1agent/x1agent/commit/3cbb2d0948dd534394613570d76a638dafb3928e))

# [1.24.0](https://github.com/x1agent/x1agent/compare/v1.23.0...v1.24.0) (2026-05-12)


### Bug Fixes

* **dev:** default KEYCHAIN in bootstrap-cert-manager.sh so set -u doesn't kill mise run dev ([b1829e3](https://github.com/x1agent/x1agent/commit/b1829e337c11c8cddc3fca702577f1c8f5657c72))
* **security:** derive subscriber session_id from NATS subject, not body ([5868aec](https://github.com/x1agent/x1agent/commit/5868aec3272cbcfcf7ca66bfc3bbe2d6e4a56592))


### Features

* **mise:** intent-first prod verbs — plan:prod, status:prod, destroy:prod ([fe018b8](https://github.com/x1agent/x1agent/commit/fe018b804497525e1e0542d97ae47b4814da11db))

# [1.23.0](https://github.com/x1agent/x1agent/compare/v1.22.0...v1.23.0) (2026-05-12)


### Bug Fixes

* **sessions:** adapter writes subject_kind/subject_id on session_user_shares upsert ([a21f26f](https://github.com/x1agent/x1agent/commit/a21f26f2684c561d17b6831d34955b33885c7127)), closes [#89](https://github.com/x1agent/x1agent/issues/89)
* **sessions:** drop duplicate resolveSessionVisibility re-export from index ([3c50fa7](https://github.com/x1agent/x1agent/commit/3c50fa77bd7d2d6d33d8a45ce2a7ef9643b67b25))


### Features

* **sessions:** unify session+share visibility under one primitive ([606db10](https://github.com/x1agent/x1agent/commit/606db10746e17682cbc9dc292428381a8e4e8e90))

# [1.22.0](https://github.com/x1agent/x1agent/compare/v1.21.0...v1.22.0) (2026-05-12)


### Features

* **spawn:** add optional model arg to spawn_session for per-spawn override ([266451b](https://github.com/x1agent/x1agent/commit/266451be324311811baffd9033339affb893cbc4))

# [1.21.0](https://github.com/x1agent/x1agent/compare/v1.20.0...v1.21.0) (2026-05-12)


### Features

* **cost:** surface per-session, per-tree, per-agent cost (X1A-37) ([bcd86a6](https://github.com/x1agent/x1agent/commit/bcd86a610b039ac9f5577db31bdad8fd26927b40))

# [1.20.0](https://github.com/x1agent/x1agent/compare/v1.19.0...v1.20.0) (2026-05-12)


### Bug Fixes

* **agent:** route gh CLI through sidecar shim ([434923b](https://github.com/x1agent/x1agent/commit/434923bd641d817d97c802d81143565fce1d333b)), closes [x1/libexec/#real](https://github.com/x1/libexec//issues/real)
* **api:** rethrow unknown errors so app.onError → Sentry fires ([aaccc33](https://github.com/x1agent/x1agent/commit/aaccc330a516e76a0f67359d8c2a33ed999a6114))
* **comments:** live update on new comments + clip long bodies ([f7554a3](https://github.com/x1agent/x1agent/commit/f7554a3f2ba5443fc35dcbadf1ddb6d62076cbb9))
* **comments:** unblock doc-commenting v1 smoke ([14e415e](https://github.com/x1agent/x1agent/commit/14e415ec2e5874f2760cf15ec66867f18e04ad5d)), closes [#92](https://github.com/x1agent/x1agent/issues/92) [#185](https://github.com/x1agent/x1agent/issues/185)
* **comments:** use destructured composedSessions in wake subscriber wiring ([f2fed23](https://github.com/x1agent/x1agent/commit/f2fed23426540e09ae54726b92a7228d5a924d96))
* **security:** harden comment-wake routing + mutable share + share fullscreen selector ([a49b490](https://github.com/x1agent/x1agent/commit/a49b4904271226037b564a0213bfd9ed441e0445)), closes [#185](https://github.com/x1agent/x1agent/issues/185)
* **sessions:** inherit triggered_by_user_id on agent-spawned children ([0b53314](https://github.com/x1agent/x1agent/commit/0b53314b750c99d39cf8f4f42176f87501bf98cc))
* **sessions:** relax sessions_trigger_source_shape for agent spawns ([c3c4ede](https://github.com/x1agent/x1agent/commit/c3c4ede05aaf4f946dbb9f8eaa5908728fea0bc4)), closes [#61](https://github.com/x1agent/x1agent/issues/61)


### Features

* **admin:** admin settings + LLM provider keys (X1A-46) ([ddcc7f6](https://github.com/x1agent/x1agent/commit/ddcc7f67fd5f352e1ab1fcae0065cf71063dd375))
* **comments:** document commenting v1 (X1A-52/53/54) ([59f623d](https://github.com/x1agent/x1agent/commit/59f623d49a660fc579e296d8395040ea75d16bf9))
* **comments:** mandate brevity in share_comment replies ([2290e2f](https://github.com/x1agent/x1agent/commit/2290e2f453cdecf10492137549995e3d4703ef56))
* **comments:** wake producing session on comment add + resolve ([1ac1037](https://github.com/x1agent/x1agent/commit/1ac10372470769b8f2bde3e07d22286d7ca33875))
* **share:** mutable share — agent re-shares with same id, pill updates in place ([65355c3](https://github.com/x1agent/x1agent/commit/65355c337e72d234132385419133114dbefb3af1))
* **sidecar:** /share_comment + /share_comment_resolve routes (X1A-52) ([00af2d5](https://github.com/x1agent/x1agent/commit/00af2d52cd765258d998a67804d9ac7367ab39a6))

# [1.19.0](https://github.com/x1agent/x1agent/compare/v1.18.0...v1.19.0) (2026-05-11)


### Features

* **auth:** account-level git identity for worker commits ([d6bef4f](https://github.com/x1agent/x1agent/commit/d6bef4fd4b98de3c169bc07f0f14659da7815df3))

# [1.18.0](https://github.com/x1agent/x1agent/compare/v1.17.2...v1.18.0) (2026-05-11)


### Bug Fixes

* **api:** remove dangling fragments in pod-spec.ts ([6d64de9](https://github.com/x1agent/x1agent/commit/6d64de9da310cf9dafe3a2e919c54331901fbe31))
* **api:** restore missing JSDoc opener in slack.ts ([ccb6ea8](https://github.com/x1agent/x1agent/commit/ccb6ea8d4e04258d999d79145b05c706c25e0155))
* **app:** chronological compact timeline with status + tool grouping (X1A-41) ([37bfe8f](https://github.com/x1agent/x1agent/commit/37bfe8fb5112d232c9cf1e1f8e900728062a49f4))
* **app:** derive agent detail badge from session state, not is_active ([2622f01](https://github.com/x1agent/x1agent/commit/2622f01c70025ea14eaed9a0e4c5b0048a032496))
* **app:** share flyout document viewer fills viewport height (X1A-19) ([19292c1](https://github.com/x1agent/x1agent/commit/19292c1c933e4ad7cd1c414226db35061e10017d))
* **ci:** close the pre-existing scheduler-test + workflow-coverage gap ([9cf6935](https://github.com/x1agent/x1agent/commit/9cf69358de06252521242a7e47ab7e8de6f66666))
* clean up dangling fragments in dev manifests + agent pod-spec ([b2f64f7](https://github.com/x1agent/x1agent/commit/b2f64f7fda4c1e7dbfc6a91722363b9d17f96a7a))
* **sessions:** make wake-pill detection actually fire end-to-end ([c202484](https://github.com/x1agent/x1agent/commit/c2024842c127ef488c06f57b43a04941cf6d6f85))
* **sessions:** mb-[5px] one-off to vertically center share button ([4cc3957](https://github.com/x1agent/x1agent/commit/4cc39570f687de6c9af4bdbbd04cec846090ccb4))
* **sessions:** one-off translate-y-px on share button for vertical centering ([7bee3cc](https://github.com/x1agent/x1agent/commit/7bee3cc5075dada12542587e6c486e3a0891ada3))
* **sessions:** share dialog 404, recipient picker, light-mode, alignment (X1A-44) ([841b955](https://github.com/x1agent/x1agent/commit/841b955ce947f0b91223087cda4ace5d4bbedfc5))


### Features

* **app:** collapse platform wake messages into pills in session timeline ([fe24d1a](https://github.com/x1agent/x1agent/commit/fe24d1af9ca68d46cb33995f2034b5de6b6c8971))
* **app:** collapse session timeline to latest public event in default mode ([#74](https://github.com/x1agent/x1agent/issues/74)) ([f43f090](https://github.com/x1agent/x1agent/commit/f43f0909ce30d5bb30a6aabc84eff5cdfcbd8888))
* **app:** replace inline child-worker area with composer-side counter (X1A-34) ([#76](https://github.com/x1agent/x1agent/issues/76)) ([b627439](https://github.com/x1agent/x1agent/commit/b6274392f70f9a3d7cf2c3d0f791d2586b044259))
* **mcp-catalog:** add 12 hosted SaaS + 3 coding-tool MCPs ([#73](https://github.com/x1agent/x1agent/issues/73)) ([056b867](https://github.com/x1agent/x1agent/commit/056b867938d00edb68300680d49f466f696bdb24))
* **sessions:** LLM-generated session descriptions in detail header ([#75](https://github.com/x1agent/x1agent/issues/75)) ([591d9b2](https://github.com/x1agent/x1agent/commit/591d9b20a0a1817135f7f6478a3ae19f89c97c65))
* **sessions:** natural-language wake pills + clickable child links ([b532172](https://github.com/x1agent/x1agent/commit/b5321729a0747b74f97648bc6fb615330000ffa8))
* **sessions:** OpenAI summarizer fallback ([74b1e3a](https://github.com/x1agent/x1agent/commit/74b1e3a835386809fc193ea173d6bdcc672b65fe))
* **sessions:** share dialog UX — show owner, filter self, gated revoke ([54f82a5](https://github.com/x1agent/x1agent/commit/54f82a5ecb4e097c56c5cebffe80b6f82126ccee))


### Performance Improvements

* **app:** cache compactTimeline in sessionDetailStore ([0c09cce](https://github.com/x1agent/x1agent/commit/0c09cce1cc45a468a08f50edf813b5041160a5bd))

## [1.17.2](https://github.com/x1agent/x1agent/compare/v1.17.1...v1.17.2) (2026-05-10)


### Bug Fixes

* **app:** session timeline groups status + tool runs (X1A-41) ([#80](https://github.com/x1agent/x1agent/issues/80)) ([f374dab](https://github.com/x1agent/x1agent/commit/f374dabff7aa92275e116c43c8f2d04edc1ba456)), closes [#75](https://github.com/x1agent/x1agent/issues/75) [#73](https://github.com/x1agent/x1agent/issues/73) [#74](https://github.com/x1agent/x1agent/issues/74) [#76](https://github.com/x1agent/x1agent/issues/76)

## [1.17.1](https://github.com/x1agent/x1agent/compare/v1.17.0...v1.17.1) (2026-05-09)


### Bug Fixes

* **app:** align workspace switcher popover with chip top edge (X1A-12) ([#64](https://github.com/x1agent/x1agent/issues/64)) ([e0bbb50](https://github.com/x1agent/x1agent/commit/e0bbb50ace6fac5c0767bca15a593bd305b43a50))

# [1.17.0](https://github.com/x1agent/x1agent/compare/v1.16.3...v1.17.0) (2026-05-09)


### Features

* **app:** style scrollbars to match app visual language ([#65](https://github.com/x1agent/x1agent/issues/65)) ([59f2a54](https://github.com/x1agent/x1agent/commit/59f2a5457043b38c81998ea435fd3662680f9894))

## [1.16.3](https://github.com/x1agent/x1agent/compare/v1.16.2...v1.16.3) (2026-05-09)


### Bug Fixes

* **app:** point agent MCP card to settings/integrations/mcp ([#66](https://github.com/x1agent/x1agent/issues/66)) ([6cecbf9](https://github.com/x1agent/x1agent/commit/6cecbf907d9b99ab3da6a1f5341d1e747d0fe6d8))

## [1.16.2](https://github.com/x1agent/x1agent/compare/v1.16.1...v1.16.2) (2026-05-09)


### Bug Fixes

* **app:** stabilize images selector on new-agent form ([#69](https://github.com/x1agent/x1agent/issues/69)) ([c4f7ae2](https://github.com/x1agent/x1agent/commit/c4f7ae2d64066168297595702c4be889a16bc9a5))

## [1.16.1](https://github.com/x1agent/x1agent/compare/v1.16.0...v1.16.1) (2026-05-09)


### Bug Fixes

* **app:** expose allow_push toggle when attaching/managing agent repos ([#70](https://github.com/x1agent/x1agent/issues/70)) ([7afe5e0](https://github.com/x1agent/x1agent/commit/7afe5e0d3d07ac4b6b9c2a2c93026cc1e72dbc43))

# [1.16.0](https://github.com/x1agent/x1agent/compare/v1.15.1...v1.16.0) (2026-05-09)


### Features

* **nats:** JetStream substrate + Waves 1-3 + chart + dev postgres PVC ([#71](https://github.com/x1agent/x1agent/issues/71)) ([83b707c](https://github.com/x1agent/x1agent/commit/83b707c28d6f54eab013497bc2440cf57994338e))

## [1.15.1](https://github.com/x1agent/x1agent/compare/v1.15.0...v1.15.1) (2026-05-09)


### Bug Fixes

* **sessions:** allow scheduler rows to carry triggered_by_user_id ([#63](https://github.com/x1agent/x1agent/issues/63)) ([600351c](https://github.com/x1agent/x1agent/commit/600351cfe89c5a6a61e7f3381fde164d02107c81)), closes [#61](https://github.com/x1agent/x1agent/issues/61)

# [1.15.0](https://github.com/x1agent/x1agent/compare/v1.14.2...v1.15.0) (2026-05-09)


### Features

* **agents:** per-agent "Run as" user for scheduler-triggered sessions ([#61](https://github.com/x1agent/x1agent/issues/61)) ([b8fa878](https://github.com/x1agent/x1agent/commit/b8fa878b361c5ff268dc73f35f8d2097e6ebbb94))

## [1.14.2](https://github.com/x1agent/x1agent/compare/v1.14.1...v1.14.2) (2026-05-09)


### Bug Fixes

* **app:** replace 'heartbeat' placeholder on agent create form ([#62](https://github.com/x1agent/x1agent/issues/62)) ([cb32a0b](https://github.com/x1agent/x1agent/commit/cb32a0b72fc3f5ff6d9c7f4c9934f8e88d941d69))

## [1.14.1](https://github.com/x1agent/x1agent/compare/v1.14.0...v1.14.1) (2026-05-08)


### Bug Fixes

* **deploy:** graph-surrealdb / messaging-slack / preview dev Dockerfiles missed workspace manifests ([#60](https://github.com/x1agent/x1agent/issues/60)) ([202daff](https://github.com/x1agent/x1agent/commit/202daff8c0449e6fa18972b62a7327591942a30c)), closes [#56](https://github.com/x1agent/x1agent/issues/56)

# [1.14.0](https://github.com/x1agent/x1agent/compare/v1.13.1...v1.14.0) (2026-05-08)


### Features

* **agents:** collapse seven edit tabs into a single Connections tab ([#59](https://github.com/x1agent/x1agent/issues/59)) ([fff2f99](https://github.com/x1agent/x1agent/commit/fff2f99ccebd4bdd75a99db9c62727ded9091b5f))

## [1.13.1](https://github.com/x1agent/x1agent/compare/v1.13.0...v1.13.1) (2026-05-08)


### Bug Fixes

* **collections:** hooks below early-return broke the page (X1A-21) ([#57](https://github.com/x1agent/x1agent/issues/57)) ([d061ec4](https://github.com/x1agent/x1agent/commit/d061ec45f1936557ae4c58103edd2eaa0819bcc3))

# [1.13.0](https://github.com/x1agent/x1agent/compare/v1.12.0...v1.13.0) (2026-05-08)


### Features

* **dev:** turn on the surrealdb graph + vector providers in OrbStack ([#58](https://github.com/x1agent/x1agent/issues/58)) ([8de89da](https://github.com/x1agent/x1agent/commit/8de89daad0976b7f75b637396ee52d00bab9aab7))

# [1.12.0](https://github.com/x1agent/x1agent/compare/v1.11.0...v1.12.0) (2026-05-08)


### Features

* **image-catalog:** Phase 2 — workspace-authored container images ([#56](https://github.com/x1agent/x1agent/issues/56)) ([fd4a5f8](https://github.com/x1agent/x1agent/commit/fd4a5f86f83d36e9042a52bfede928bac30b1ca2))

# [1.11.0](https://github.com/x1agent/x1agent/compare/v1.10.5...v1.11.0) (2026-05-08)


### Features

* Google Workspace integration — user-OAuth substrate + Drive read-only provider ([#55](https://github.com/x1agent/x1agent/issues/55)) ([e57d406](https://github.com/x1agent/x1agent/commit/e57d406472b5fa3c9c474b07a31ea45310cce6c9))

## [1.10.5](https://github.com/x1agent/x1agent/compare/v1.10.4...v1.10.5) (2026-05-06)


### Bug Fixes

* **api:** host-allowlist rejects in-cluster Service hostnames (regression) ([#52](https://github.com/x1agent/x1agent/issues/52)) ([88809d9](https://github.com/x1agent/x1agent/commit/88809d970357b8b0d1cb21bab6416b8513d895a5)), closes [#45](https://github.com/x1agent/x1agent/issues/45)

## [1.10.4](https://github.com/x1agent/x1agent/compare/v1.10.3...v1.10.4) (2026-05-06)


### Bug Fixes

* **mcp:** RFC 9728 suffix-on-origin variant in OAuth discovery ([#51](https://github.com/x1agent/x1agent/issues/51)) ([3199737](https://github.com/x1agent/x1agent/commit/3199737fb6422fc86ec65552225a56849852fbdf))

## [1.10.3](https://github.com/x1agent/x1agent/compare/v1.10.2...v1.10.3) (2026-05-06)


### Bug Fixes

* orchestrator can read Linear/Sentry MCPs and write to its repo ([#53](https://github.com/x1agent/x1agent/issues/53)) ([c7a234f](https://github.com/x1agent/x1agent/commit/c7a234f46a6a01960e6e2f45826150976515c1f1))

## [1.10.2](https://github.com/x1agent/x1agent/compare/v1.10.1...v1.10.2) (2026-05-06)


### Bug Fixes

* **workspaces:** correct JSONB merge in updateSettings ([#50](https://github.com/x1agent/x1agent/issues/50)) ([2e68ad3](https://github.com/x1agent/x1agent/commit/2e68ad350c5b3dd501635d47adba64878e31268d))

## [1.10.1](https://github.com/x1agent/x1agent/compare/v1.10.0...v1.10.1) (2026-05-06)


### Bug Fixes

* **install:** rotate-surrealdb-password script + render wiring ([#49](https://github.com/x1agent/x1agent/issues/49)) ([5fb9ca4](https://github.com/x1agent/x1agent/commit/5fb9ca44de298deb3392a2eac41119586c699ba9))

# [1.10.0](https://github.com/x1agent/x1agent/compare/v1.9.0...v1.10.0) (2026-05-06)


### Features

* **workspaces:** per-workspace policy for OAuth MCPs on orchestrators ([#47](https://github.com/x1agent/x1agent/issues/47)) ([724a802](https://github.com/x1agent/x1agent/commit/724a8021d44d1228dacea1245fe7dcb7a727a4c5))

# [1.9.0](https://github.com/x1agent/x1agent/compare/v1.8.2...v1.9.0) (2026-05-06)


### Bug Fixes

* **api:** cookie Secure attribute + Host header allowlist ([#45](https://github.com/x1agent/x1agent/issues/45)) ([1fa1379](https://github.com/x1agent/x1agent/commit/1fa1379336ad20dabe4e6806565d979a3a2fe27c))


### Features

* **app:** port marketing shader nebula to sidebar background ([#46](https://github.com/x1agent/x1agent/issues/46)) ([00c2af9](https://github.com/x1agent/x1agent/commit/00c2af9b3889633701f2bb7df0a9ae433edf2509))
* **messaging:** per-bot Slack onboarding + BSL 1.1 license ([#42](https://github.com/x1agent/x1agent/issues/42)) ([03e0ffc](https://github.com/x1agent/x1agent/commit/03e0ffc57843a3c440e41d7ade1b45720df5e826)), closes [#7](https://github.com/x1agent/x1agent/issues/7) [#3](https://github.com/x1agent/x1agent/issues/3) [#2](https://github.com/x1agent/x1agent/issues/2) [#2](https://github.com/x1agent/x1agent/issues/2) [#3](https://github.com/x1agent/x1agent/issues/3) [#1](https://github.com/x1agent/x1agent/issues/1) [#2](https://github.com/x1agent/x1agent/issues/2) [#5](https://github.com/x1agent/x1agent/issues/5) [#7](https://github.com/x1agent/x1agent/issues/7) [#2](https://github.com/x1agent/x1agent/issues/2) [#5](https://github.com/x1agent/x1agent/issues/5) [#1](https://github.com/x1agent/x1agent/issues/1) [#13](https://github.com/x1agent/x1agent/issues/13) [#27](https://github.com/x1agent/x1agent/issues/27) [#3](https://github.com/x1agent/x1agent/issues/3) [#12](https://github.com/x1agent/x1agent/issues/12) [#20](https://github.com/x1agent/x1agent/issues/20) [#31](https://github.com/x1agent/x1agent/issues/31) [#9](https://github.com/x1agent/x1agent/issues/9) [#4](https://github.com/x1agent/x1agent/issues/4) [#16](https://github.com/x1agent/x1agent/issues/16) [#25](https://github.com/x1agent/x1agent/issues/25) [#21](https://github.com/x1agent/x1agent/issues/21) [#10](https://github.com/x1agent/x1agent/issues/10) [#11](https://github.com/x1agent/x1agent/issues/11) [#9](https://github.com/x1agent/x1agent/issues/9)
* **messaging:** wire Slack platform credentials through Helm + ESO ([#44](https://github.com/x1agent/x1agent/issues/44)) ([7fe4b9c](https://github.com/x1agent/x1agent/commit/7fe4b9cb754456a3cae36ca8c808d7e2172dddef))

## [1.8.2](https://github.com/x1agent/x1agent/compare/v1.8.1...v1.8.2) (2026-05-05)

## [1.8.1](https://github.com/x1agent/x1agent/compare/v1.8.0...v1.8.1) (2026-05-05)

# [1.8.0](https://github.com/x1agent/x1agent/compare/v1.7.0...v1.8.0) (2026-05-05)


### Features

* **app:** visual language v2 — surface ladder, light mode, redesigne… ([#37](https://github.com/x1agent/x1agent/issues/37)) ([3a2c4c4](https://github.com/x1agent/x1agent/commit/3a2c4c422cd8bbde751e5cb09e1facb34086bd82)), closes [#c2613e](https://github.com/x1agent/x1agent/issues/c2613e)

# [1.7.0](https://github.com/x1agent/x1agent/compare/v1.6.7...v1.7.0) (2026-05-04)


### Features

* **settings:** overview screen + MCP registry picker ([#36](https://github.com/x1agent/x1agent/issues/36)) ([06c94fc](https://github.com/x1agent/x1agent/commit/06c94fc94722666b7789ea59d076c32963fc1921)), closes [hi#level](https://github.com/hi/issues/level) [#mcp-add-form](https://github.com/x1agent/x1agent/issues/mcp-add-form)

## [1.6.7](https://github.com/x1agent/x1agent/compare/v1.6.6...v1.6.7) (2026-05-03)


### Bug Fixes

* **agents:** show incompatible MCPs as disabled with reason, not silently hidden ([#33](https://github.com/x1agent/x1agent/issues/33)) ([63076e9](https://github.com/x1agent/x1agent/commit/63076e95eefa8b5813e6efc56ae7000620c77db1))

## [1.6.6](https://github.com/x1agent/x1agent/compare/v1.6.5...v1.6.6) (2026-05-03)


### Bug Fixes

* **agents:** shorten Kind dropdown options; describe choice in helper text ([#32](https://github.com/x1agent/x1agent/issues/32)) ([0913a09](https://github.com/x1agent/x1agent/commit/0913a09e2792e90962adf775c222af5cc99b67d5))

## [1.6.5](https://github.com/x1agent/x1agent/compare/v1.6.4...v1.6.5) (2026-05-03)


### Bug Fixes

* **agents:** stabilize zustand selectors so the MCP & env tab renders ([#31](https://github.com/x1agent/x1agent/issues/31)) ([9e193f1](https://github.com/x1agent/x1agent/commit/9e193f1f4c5f84e66d1218546d8258bd5a82de0c)), closes [#185](https://github.com/x1agent/x1agent/issues/185)

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
