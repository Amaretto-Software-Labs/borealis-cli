# Borealis CLI

The official, open-source command-line client for the versioned Borealis public API. The CLI is an ordinary Node.js package: there are no platform-specific executables to download or unpack.

Website: [borealishq.io](https://borealishq.io) · Built by [Amaretto Software Labs](https://amarettosoftware.com)

## Install

Node.js 22 or newer is required.

```bash
npx @amaretto-software-labs/borealis-cli --help
npm install --global @amaretto-software-labs/borealis-cli
borealis auth login
```

## Authentication

Interactive login uses OAuth authorization code flow with S256 PKCE and refresh tokens:

```bash
borealis auth login
borealis auth whoami
borealis auth logout
```

Named profiles are isolated with `--profile <name>`. Sessions use the native macOS Keychain, Linux Secret Service, or Windows DPAPI. Storage fails closed when no secure provider is available. Plaintext owner-only files require an explicit `BOREALIS_CLI_ALLOW_INSECURE_FILE_SESSION=1` opt-in.

Automation should use one of these sources:

```bash
BOREALIS_ACCESS_TOKEN=... borealis context show --json
borealis --token-file ./token sandbox list --json
```

`--token` remains available but prints a warning because command-line arguments may be visible in process listings and shell history. Only one token source may be supplied.

## Commands

The public package exposes exactly the 75 active, customer-facing operations in the Borealis v1 catalog. Platform-administration operations are intentionally excluded. Run `borealis --help` for groups and use the canonical command paths, for example:

```bash
borealis sandbox list --page 1 --page-size 50
borealis sandbox get 018f4c28-dc05-7e91-9f8e-11e421bb8a91 --json
borealis sandbox create --body '{"name":"demo","image":"ubuntu:24.04"}'
borealis host list --pool 018f4c28-dc05-7e91-9f8e-11e421bb8a91
borealis interactive attach 018f4c28-dc05-7e91-9f8e-11e421bb8a91
```

Path identifiers are positional. Request fields can use their named kebab-case option or the transport-neutral forms:

```bash
borealis template create --set displayName=Node --set image=node:22
borealis template create --body '{"displayName":"Node","defaults":{"name":"Node","image":"node:22"}}'
```

All commands support `--json`. JSON output preserves the public response. Human output is a presentation of the same response.

### Safety

- Destructive operations require a terminal confirmation or explicit `--yes`, then obtain a server-issued preflight token before mutation.
- Keyed operations accept `--idempotency-key`; otherwise the CLI generates a UUID and sends it in `Idempotency-Key`.
- Registry secrets should come from `BOREALIS_REGISTRY_SECRET`, `--secret-file`, or `--secret-stdin`. Direct `--secret` input emits a warning.
- Service-principal creation requires `--output <new-file>` or `--include-secret`. Output files are created owner-only and are never overwritten; failed delivery triggers compensating revocation.
- API, Identity, and application origins must use HTTPS. Loopback HTTP is accepted for local development only.
- Interactive session messages are capped at 4 MiB.

## Shell completion

```bash
borealis completion bash
borealis completion zsh
borealis completion fish
```

## Development

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm test
pnpm typecheck
pnpm lint
pnpm format:check
pnpm build
pnpm pack
```

The checked-in `src/operations.json` is imported from `Borealis.Api.Contracts.V1.BorealisOperationCatalog`. In a Borealis source checkout, mechanically verify the 75 public commands against the canonical .NET catalog and client methods with:

```bash
BOREALIS_SOURCE_ROOT=/path/to/aurora-proto pnpm parity
```

When validating a source revision that still contains the former .NET CLI, the same gate also proves its registry is a one-to-one match.

## Release bootstrap

The release workflow always validates and packages pushes to `main`, but its npm publish step remains disabled until the repository variable `NPM_TRUSTED_PUBLISHING_ENABLED` is exactly `true`.

Because npm trusted publishing requires the package to exist first, a maintainer must bootstrap `@amaretto-software-labs/borealis-cli` once from a locally validated tarball using an npm account with 2FA:

```bash
pnpm pack
npm publish ./amaretto-software-labs-borealis-cli-0.1.0.tgz --access public
```

After that first interactive publish, configure the npm trusted publisher for `Amaretto-Software-Labs/borealis-cli` and `.github/workflows/release.yml`, then set the GitHub repository variable `NPM_TRUSTED_PUBLISHING_ENABLED=true`. No long-lived npm token is used by the workflow.

## License

Apache-2.0. See [LICENSE](LICENSE).
