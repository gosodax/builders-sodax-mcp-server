# Changelog

## [1.5.0](https://github.com/gosodax/builders-sodax-mcp-server/compare/builders-sodax-mcp-server-v1.4.0...builders-sodax-mcp-server-v1.5.0) (2026-07-06)


### Features

* clarify solver quote token guidance and add error hints ([#65](https://github.com/gosodax/builders-sodax-mcp-server/issues/65)) ([7914d32](https://github.com/gosodax/builders-sodax-mcp-server/commit/7914d3234dca161cba2a0eae2aa85ebc15370371))


### Miscellaneous

* promote development to master ([f53f3ec](https://github.com/gosodax/builders-sodax-mcp-server/commit/f53f3ec55f1342163e97de49570d89b30eb13ee4))

## [1.4.0](https://github.com/gosodax/builders-sodax-mcp-server/compare/builders-sodax-mcp-server-v1.3.2...builders-sodax-mcp-server-v1.4.0) (2026-06-15)


### Features

* add sodax_get_volume_stats tool for /solver/volume/stats ([#62](https://github.com/gosodax/builders-sodax-mcp-server/issues/62)) ([ea0eecc](https://github.com/gosodax/builders-sodax-mcp-server/commit/ea0eecc2699a75d558e677ea464c79b06407934f))
* Discord alerts, CI checks (drift + docker build), and .env loading ([#16](https://github.com/gosodax/builders-sodax-mcp-server/issues/16), [#38](https://github.com/gosodax/builders-sodax-mcp-server/issues/38), [#54](https://github.com/gosodax/builders-sodax-mcp-server/issues/54)) ([#60](https://github.com/gosodax/builders-sodax-mcp-server/issues/60)) ([a977a2b](https://github.com/gosodax/builders-sodax-mcp-server/commit/a977a2bdd100d2587742508b4b51d307747f8815))


### Miscellaneous

* promote development to master ([5e26114](https://github.com/gosodax/builders-sodax-mcp-server/commit/5e26114f4f90ae98efefd4d3be00d882981bf576))

## [1.3.2](https://github.com/gosodax/builders-sodax-mcp-server/compare/builders-sodax-mcp-server-v1.3.1...builders-sodax-mcp-server-v1.3.2) (2026-05-21)


### Bug Fixes

* **docker:** skip lifecycle scripts on prod install ([#55](https://github.com/gosodax/builders-sodax-mcp-server/issues/55)) ([d9899dc](https://github.com/gosodax/builders-sodax-mcp-server/commit/d9899dc40adc77c98abbc1087099a8a74d53bee1))

## [1.3.1](https://github.com/gosodax/builders-sodax-mcp-server/compare/builders-sodax-mcp-server-v1.3.0...builders-sodax-mcp-server-v1.3.1) (2026-05-21)


### Bug Fixes

* **ci:** exclude package.json from biome formatter ([#44](https://github.com/gosodax/builders-sodax-mcp-server/issues/44)) ([0eb3b2d](https://github.com/gosodax/builders-sodax-mcp-server/commit/0eb3b2dbea16d2d860860ae05e875360b24764a7))
* sync runtime version from package.json ([#48](https://github.com/gosodax/builders-sodax-mcp-server/issues/48)) ([91bb10f](https://github.com/gosodax/builders-sodax-mcp-server/commit/91bb10f8b6cc905072dcbf750e8c6c23808b4835))


### Miscellaneous

* remove internal Marketing MCP link, blank PostHog defaults in .env.example ([#50](https://github.com/gosodax/builders-sodax-mcp-server/issues/50)) ([abe9e55](https://github.com/gosodax/builders-sodax-mcp-server/commit/abe9e550d7c47dc7bd33f342181438ed34d60d5c))

## [1.3.0](https://github.com/gosodax/builders-sodax-mcp-server/compare/builders-sodax-mcp-server-v1.2.0...builders-sodax-mcp-server-v1.3.0) (2026-05-21)


### Features

* add vitest ([#33](https://github.com/gosodax/builders-sodax-mcp-server/issues/33)) ([56a1e23](https://github.com/gosodax/builders-sodax-mcp-server/commit/56a1e236a4f19e0f6ea7b5266c7dd2d51e1a73a8))
* integrate solver and relay endpoints ([#37](https://github.com/gosodax/builders-sodax-mcp-server/issues/37)) ([#39](https://github.com/gosodax/builders-sodax-mcp-server/issues/39)) ([a6848c3](https://github.com/gosodax/builders-sodax-mcp-server/commit/a6848c39fc249e253d8b47e21fd742cf9a4dfdee))
* remove axios and fix drifts ([#30](https://github.com/gosodax/builders-sodax-mcp-server/issues/30)) ([bd26ff7](https://github.com/gosodax/builders-sodax-mcp-server/commit/bd26ff7e2cd2753f72fc90ce5fb51d31d324cbe7))
* structured logging ([#32](https://github.com/gosodax/builders-sodax-mcp-server/issues/32)) ([3d02ac9](https://github.com/gosodax/builders-sodax-mcp-server/commit/3d02ac9a3a0e6315de04ef71494ae405af8a2df3))


### Bug Fixes

* remove URLs ([#36](https://github.com/gosodax/builders-sodax-mcp-server/issues/36)) ([cf00bc1](https://github.com/gosodax/builders-sodax-mcp-server/commit/cf00bc1f4ce1c6f07731615642f77ffff0ec6287))


### Continuous Integration

* add Biome, husky, commitlint, and CI workflow ([#34](https://github.com/gosodax/builders-sodax-mcp-server/issues/34)) ([340b12d](https://github.com/gosodax/builders-sodax-mcp-server/commit/340b12daf7bd411cc3e475d067d16620b87a77f5))

## [1.2.0](https://github.com/gosodax/builders-sodax-mcp-server/compare/builders-sodax-mcp-server-v1.1.0...builders-sodax-mcp-server-v1.2.0) (2026-04-25)


### Features

* add 17 new API tools and startup drift detection ([7196f75](https://github.com/gosodax/builders-sodax-mcp-server/commit/7196f75a2a43ba6368f6a576400d439e27316975))
* add Google Tag Manager to landing page ([4340c06](https://github.com/gosodax/builders-sodax-mcp-server/commit/4340c06bbb11aec3922ed3cc0b8a09d0450b4b67))
* add legacy SSE transport for clients without streamable HTTP support ([0dfa6c1](https://github.com/gosodax/builders-sodax-mcp-server/commit/0dfa6c1644e103f1b9cd52b614ce0cd529f01656))
* add MCP directory badges to README and landing page ([5209499](https://github.com/gosodax/builders-sodax-mcp-server/commit/5209499c7e5be4f45ccf520e78a879ab12639e66))
* add PostHog analytics for automatic tool call tracking ([cc06149](https://github.com/gosodax/builders-sodax-mcp-server/commit/cc061492706903ba61a73fb7888f2ab0bf926c7d))
* add title field to server.json for search findability ([dd3082b](https://github.com/gosodax/builders-sodax-mcp-server/commit/dd3082ba87393942b5e2fd5ba64570535823d3a8))
* collapsible tool accordions on landing page ([b18c27b](https://github.com/gosodax/builders-sodax-mcp-server/commit/b18c27ba5c366ec047e1483ef14111e42d4f1031))
* **drift-check:** detect param, required-flag, and response-field drift ([b058d7e](https://github.com/gosodax/builders-sodax-mcp-server/commit/b058d7e61739abb597809ffe993d02d60f4c73f7)), closes [#9](https://github.com/gosodax/builders-sodax-mcp-server/issues/9)
* **drift-check:** params, required flags, and response fields ([d95a314](https://github.com/gosodax/builders-sodax-mcp-server/commit/d95a31473806e863cc2e680012301d40096b0b73))
* live health status topbar with total tool count ([b63efb9](https://github.com/gosodax/builders-sodax-mcp-server/commit/b63efb9739985e3cb48861a0f3b7ae3a9f2e9b6c))
* SEO/GEO overhaul — cross-network keywords, FAQ, topbar updates ([652b98e](https://github.com/gosodax/builders-sodax-mcp-server/commit/652b98ea93ac3799c80d4c9d805f32593a65d731))
* track unique users in PostHog via hashed client IP ([c64d239](https://github.com/gosodax/builders-sodax-mcp-server/commit/c64d239e0baf2d9c8111af03743c974c44ad0570))


### Bug Fixes

* **ci:** pass App token to actions/checkout in sync workflow ([#27](https://github.com/gosodax/builders-sodax-mcp-server/issues/27)) ([b2c525a](https://github.com/gosodax/builders-sodax-mcp-server/commit/b2c525a5dfedc0c79f37ff04d1fc2ccd12455734)), closes [#26](https://github.com/gosodax/builders-sodax-mcp-server/issues/26)
* correct server.json schema URL and remote transport format ([545e7d8](https://github.com/gosodax/builders-sodax-mcp-server/commit/545e7d8075bb071ac79e811193eda6b0b430cf9d))
* enable trust proxy for Coolify reverse proxy ([f7885cf](https://github.com/gosodax/builders-sodax-mcp-server/commit/f7885cf8e4a49efbe70c004b1b5925e2a2b6254e))
* handle GET and DELETE on /mcp endpoint for full streamable HTTP spec compliance ([9650ce6](https://github.com/gosodax/builders-sodax-mcp-server/commit/9650ce6e34ec489285d07875c6837e3b34687ec4))
* make inputToken and outputToken required for volume endpoint ([7c63c6d](https://github.com/gosodax/builders-sodax-mcp-server/commit/7c63c6d7a15d94a5555ff9f6ffb257bd6556f72c))
* resolve all dependency vulnerabilities ([dcbbfae](https://github.com/gosodax/builders-sodax-mcp-server/commit/dcbbfaed747cc515d2413c9972b40c0c64ce7377))
* server-per-request isolation for parallel HTTP requests ([43a8204](https://github.com/gosodax/builders-sodax-mcp-server/commit/43a820463a010b979e1bbe7a586b3bd4c2808313))
* shorten server.json description to meet registry 100-char limit ([8e0db38](https://github.com/gosodax/builders-sodax-mcp-server/commit/8e0db38c8300193bffb41503c8e4a88f97c9e256))
* **tools:** reconcile 16 drifts from check:drift ([#14](https://github.com/gosodax/builders-sodax-mcp-server/issues/14)) ([8bce31e](https://github.com/gosodax/builders-sodax-mcp-server/commit/8bce31ea933abe820cab830014a495dc948e90d8))
* update SODAX API endpoints to match actual backend API paths ([519a99e](https://github.com/gosodax/builders-sodax-mcp-server/commit/519a99e06befbe405d9fd90adcef95a52e6a9477))
* update volume endpoint to match actual API schema ([47760d1](https://github.com/gosodax/builders-sodax-mcp-server/commit/47760d166bcbc0e58502001e1bf6fb1f4f18941e))


### Documentation

* add copilot instructions to keep PostHog analytics in sync ([0360584](https://github.com/gosodax/builders-sodax-mcp-server/commit/03605846567a7e935f01256e8079f99cc3eb0f90))
* document staging and production environments ([e615c7a](https://github.com/gosodax/builders-sodax-mcp-server/commit/e615c7a20c3bf19b8ab8f58ac1f6d545259e72d5))
* document staging and production environments ([5049b1f](https://github.com/gosodax/builders-sodax-mcp-server/commit/5049b1ffa9bbe50031037db83a9f1aef1c8d1825)), closes [#7](https://github.com/gosodax/builders-sodax-mcp-server/issues/7)


### Continuous Integration

* add release-please and master→development sync workflows ([#21](https://github.com/gosodax/builders-sodax-mcp-server/issues/21)) ([8bdfa7f](https://github.com/gosodax/builders-sodax-mcp-server/commit/8bdfa7fa95fa677593889503370cd96652112632))
* use GitHub App token for release and sync workflows ([#22](https://github.com/gosodax/builders-sodax-mcp-server/issues/22)) ([5168711](https://github.com/gosodax/builders-sodax-mcp-server/commit/51687110ca6214cd01e19732a78a64150bc89630))


### Miscellaneous

* add Glama badge to README ([eaad249](https://github.com/gosodax/builders-sodax-mcp-server/commit/eaad2495fbcd1b8773fc42da82c90654f84ad9a3))
* add glama.json for Glama MCP directory listing ([1fd35db](https://github.com/gosodax/builders-sodax-mcp-server/commit/1fd35db9c3f3d630afb1cd0f5139d590f6fa8886))
* add MIT LICENSE file for marketplace compliance ([2f7d505](https://github.com/gosodax/builders-sodax-mcp-server/commit/2f7d505a6d7cd1734bef472ff7a396d2f991a1ea))
* make PORT env-driven for Coolify migration ([b6d9eff](https://github.com/gosodax/builders-sodax-mcp-server/commit/b6d9eff9a0c45e6cacce7ed003bd7cabcfe5f93b))
* make PORT env-driven, remove Docker/compose hardcoding ([ab80bd1](https://github.com/gosodax/builders-sodax-mcp-server/commit/ab80bd1e4707448ab48c4532ecc755d502c867f0)), closes [#3](https://github.com/gosodax/builders-sodax-mcp-server/issues/3)
* prepare for public repo and MCP registry listing ([94439f2](https://github.com/gosodax/builders-sodax-mcp-server/commit/94439f23369eea13c99c8408c730f66e15ec1465))
* update dependencies ([136362b](https://github.com/gosodax/builders-sodax-mcp-server/commit/136362b468f4320ff51cbae223f41cd551d8b19c))
* use curl-based Docker healthcheck ([b513401](https://github.com/gosodax/builders-sodax-mcp-server/commit/b513401903a58c60e653da802c9fa4ddcd3bc49f))
* use curl-based Docker healthcheck ([9bedb8d](https://github.com/gosodax/builders-sodax-mcp-server/commit/9bedb8d012cc4c087f4da9d57fce468c2b32349f)), closes [#3](https://github.com/gosodax/builders-sodax-mcp-server/issues/3)

## Changelog

All notable changes to this project are documented in this file. This file is maintained automatically by [release-please](https://github.com/googleapis/release-please-action) based on [Conventional Commits](https://www.conventionalcommits.org/). Do not edit by hand — changes made here will be overwritten.
