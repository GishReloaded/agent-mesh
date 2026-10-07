# Releasing AgentMesh

The public packages are `@gish_reloaded/agentmesh-protocol`, `@gish_reloaded/agentmesh-sdk` and `@gish_reloaded/agentmesh-cli`.
Server/web are private workspaces distributed via source and the Docker build.
Keep public versions and internal dependency versions synchronized.

```bash
npm ci
npm run lint
npm run typecheck
npm test
npm run release:pack
```

Server tests require a dedicated throwaway PostgreSQL database whose name contains
`test`. A suite with skipped integration tests is not release validation. CI
provisions its own database and also checks the Docker build.

`release:pack` builds, inspects package contents and installs actual tarballs into
a fresh consumer outside the monorepo. It verifies protocol/SDK exports and CLI
help/version, then writes three tarballs and `SHA256SUMS` to ignored `tmp/release/`.
Update [CHANGELOG](../CHANGELOG.md), review the public docs, and tag the tested
commit `v<version>`. `release.yml` repeats checks and attaches the tarballs.

## First npm publication

An account needs ownership of `@gish_reloaded`, not just an ordinary npm login. If the
scope changes, update package names, imports, internal dependencies and docs together.
After `npm login` and release verification, publish in dependency order:

```bash
npm publish -w @gish_reloaded/agentmesh-protocol --access public
npm publish -w @gish_reloaded/agentmesh-sdk --access public
npm publish -w @gish_reloaded/agentmesh-cli --access public
```

Initial publication may need an interactive 2FA challenge. Verify `npm view` for
all three before claiming registry availability in README.

## Later releases: trusted publishing

For each existing npm package configure GitHub owner `GishReloaded`, repository
`agent-mesh`, workflow filename `publish-npm.yml`, and allow direct publishing.
No GitHub environment is used by this workflow.

Dispatch the workflow with a published release tag. It checks versions and runs
verification before publishing in dependency order via OIDC, without a long-lived
token. Do not run it until npm-side trusted publishers are configured.
See [npm's trusted publishing guide](https://docs.npmjs.com/trusted-publishers/).
