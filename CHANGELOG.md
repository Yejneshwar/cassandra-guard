# Changelog

## [3.0.1](https://github.com/Yejneshwar/cassandra-guard/compare/cassandra-guard-v3.0.0...cassandra-guard-v3.0.1) (2026-08-12)


### Bug Fixes

* add auth to client connections ([926c18e](https://github.com/Yejneshwar/cassandra-guard/commit/926c18eaf2fc2b73d8f5d7207cb65a6870b7b942))
* nested-UDT frozen-ness is representation, not schema — normalize it in compatibility checks ([d65ac5b](https://github.com/Yejneshwar/cassandra-guard/commit/d65ac5b37bcf9bf2c3dbbc9a53bee06b4e976023))

## [3.0.0](https://github.com/Yejneshwar/cassandra-guard/compare/cassandra-guard-v2.3.0...cassandra-guard-v3.0.0) (2026-07-27)


### ⚠ BREAKING CHANGES

* update db auth handling

### Features

* update db auth handling ([c260bb2](https://github.com/Yejneshwar/cassandra-guard/commit/c260bb2e4ac777dbc36c685421c2ed5451d367ec))

## [2.3.0](https://github.com/Yejneshwar/cassandra-guard/compare/cassandra-guard-v2.2.0...cassandra-guard-v2.3.0) (2026-07-06)


### Features

* add Version-aware validation: ([7cf4107](https://github.com/Yejneshwar/cassandra-guard/commit/7cf41075ba32febc1bc441aab493b51612901228))
* TTL/WRITETIME projections and Map element delition support ([eec243f](https://github.com/Yejneshwar/cassandra-guard/commit/eec243ffcadbed99274dd822ff421a9323357826))


### Bug Fixes

* TTL issue ([ffe558c](https://github.com/Yejneshwar/cassandra-guard/commit/ffe558cb3b89c2b6844dba0c2985e9d0846bb9fd))

## [2.2.0](https://github.com/Yejneshwar/cassandra-guard/compare/cassandra-guard-v2.1.0...cassandra-guard-v2.2.0) (2026-05-25)


### Features

* add live schema compatibility checker for CI/CD ([e3c7800](https://github.com/Yejneshwar/cassandra-guard/commit/e3c78008ca6cfdb74c8ab52f14be1853173fd857))

## [2.1.0](https://github.com/Yejneshwar/cassandra-guard/compare/cassandra-guard-v2.0.0...cassandra-guard-v2.1.0) (2026-05-14)


### Features

* update dependencies ([597640d](https://github.com/Yejneshwar/cassandra-guard/commit/597640dbaf9e4ff5c7fa49730be8a952f4bce145))

## [2.0.0](https://github.com/Yejneshwar/cassandra-guard/compare/cassandra-guard-v1.2.1...cassandra-guard-v2.0.0) (2026-04-30)


### ⚠ BREAKING CHANGES

* Prior to this version, registry ran validations only for json schema

### Features

* UDT validation during schema registration ([1593a4b](https://github.com/Yejneshwar/cassandra-guard/commit/1593a4b019f5d59ac8de31fca25ca680cc0ca3aa))

## [1.2.1](https://github.com/Yejneshwar/cassandra-guard/compare/cassandra-guard-v1.2.0...cassandra-guard-v1.2.1) (2026-04-29)


### Bug Fixes

* **package.json:** repo url AGAIN (it was a case issue 😔) ([9e4ade4](https://github.com/Yejneshwar/cassandra-guard/commit/9e4ade4e26963be42b1f53b416dadd54a939a865))

## [1.2.0](https://github.com/Yejneshwar/cassandra-guard/compare/cassandra-guard-v1.1.1...cassandra-guard-v1.2.0) (2026-04-29)


### Features

* update readme ([5dadb21](https://github.com/Yejneshwar/cassandra-guard/commit/5dadb219f1eca6bb1fdc4e835b316e55256bc5eb))

## [1.1.1](https://github.com/Yejneshwar/cassandra-guard/compare/cassandra-guard-v1.1.0...cassandra-guard-v1.1.1) (2026-04-29)


### Bug Fixes

* **package.json:** repo url fix and bin fix ([0ad6c86](https://github.com/Yejneshwar/cassandra-guard/commit/0ad6c86d2ca21c88637015a30045996eb16543d8))

## [1.1.0](https://github.com/Yejneshwar/cassandra-guard/compare/cassandra-guard-v1.0.1...cassandra-guard-v1.1.0) (2026-04-29)


### Features

* add UDT subfield updates, TTL=0 support, and whitelisted CQL functions ([0d55b76](https://github.com/Yejneshwar/cassandra-guard/commit/0d55b760723f54faabab0927a26373d33336dacc))

## [1.0.1](https://github.com/Yejneshwar/cassandra-guard/compare/cassandra-guard-v1.0.0...cassandra-guard-v1.0.1) (2026-04-29)


### Bug Fixes

* update actions to Node 24 ([fed62f6](https://github.com/Yejneshwar/cassandra-guard/commit/fed62f6d783f1d5e0a74df1d0a563476cbec9798))
* update readme ([30de131](https://github.com/Yejneshwar/cassandra-guard/commit/30de1312230e1d203230d212e54204bf6d08b507))
