# Changelog

## 1.0.0 (2026-04-21)


### Features

* add unit tests for chunker, config, and dotProduct ([5279c40](https://github.com/samfoy/pi-knowledge-search/commit/5279c409d7937d24f20a10a17ec90b1d3c452996))
* content-aware markdown chunking for improved search quality ([57f73e6](https://github.com/samfoy/pi-knowledge-search/commit/57f73e6c8b529aaf237e58aff5a225063880dec7))
* initial release — semantic search over local files for pi ([577418d](https://github.com/samfoy/pi-knowledge-search/commit/577418d797a10d6288466b203b6711f59a65c694))


### Bug Fixes

* correct GitHub username in repo URLs ([8ce5679](https://github.com/samfoy/pi-knowledge-search/commit/8ce5679e939c6f660e68e37055d513d7bfa9537d))
* debounce watcher, clean deleted files, rate limit handling, proper shutdown ([36ed2c6](https://github.com/samfoy/pi-knowledge-search/commit/36ed2c638e533c5e59ad8e1a224b3231e08c48ea))
* fork sync to child process to prevent startup hang ([20a16ed](https://github.com/samfoy/pi-knowledge-search/commit/20a16ed7b44c3083ac74d9a9f56b53d8db2ea9bb))
* handle FSWatcher errors from transient files ([b259447](https://github.com/samfoy/pi-knowledge-search/commit/b2594476c2c0f7efbca98cc6e49cbf29d01ce15d))
* loadSync/load async confusion, dotProduct length guard, remove dead FileWatcher import ([a178d88](https://github.com/samfoy/pi-knowledge-search/commit/a178d88cd205ba80fb36c305948215d233f395ea))
* make indexing non-blocking so session startup doesn't hang ([c78dab8](https://github.com/samfoy/pi-knowledge-search/commit/c78dab8380941aa28f7c8711a9a891b69701f3d5))
* prevent null vector crash in knowledge search ([7eff704](https://github.com/samfoy/pi-knowledge-search/commit/7eff704cab66e8c69773f02bcb5d2d677e04d33d))
* remove dead FileWatcher code, cap worker restart attempts ([645064f](https://github.com/samfoy/pi-knowledge-search/commit/645064fc3f26d2f35b659670f7f1739c7333f54d))
* remove FileWatcher to prevent UI freezes ([d38a81f](https://github.com/samfoy/pi-knowledge-search/commit/d38a81f846bd2a29a4deaabeeb75eafa60add913))
* replace CodeArtifact registry with public npm registry ([175ac7b](https://github.com/samfoy/pi-knowledge-search/commit/175ac7b103e8475433b580d553e88331d90bcd44))
* resolve stash conflict in package.json ([052201f](https://github.com/samfoy/pi-knowledge-search/commit/052201fb7515478f2a3af0ad907a89d220b22bbf))
* use tsx loader entry point for Node v24 compatibility ([3b8addb](https://github.com/samfoy/pi-knowledge-search/commit/3b8addba0bb1e7bb97eb868e2161ffceb3ca81f3))


### Reverts

* use default HTTP/2 for Bedrock embedder ([1057c85](https://github.com/samfoy/pi-knowledge-search/commit/1057c851564de039be2956b28d9da6bc3177fd35))
