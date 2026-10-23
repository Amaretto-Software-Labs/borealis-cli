<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/Amaretto-Software-Labs/borealis-cli/main/assets/borealis-mark.svg">
  <img alt="Borealis" src="https://raw.githubusercontent.com/Amaretto-Software-Labs/borealis-cli/main/assets/borealis-mark-light.svg" width="72" height="72">
</picture>

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

If browser sign-in fails or you cancel consent, keep the CLI running. The branded
recovery page offers **Try again** and **Use another account** (which signs out of
the web app before returning to sign-in). You can also press **Enter** in an
interactive terminal to start a fresh attempt, or open the recovery URL printed
by the CLI if you closed the browser. Each attempt uses new OAuth state and PKCE
values. Attempts time out after five minutes; the retry page remains available
for another ten minutes. **Ctrl+C** stops login and closes the local listener.
The success page is shown only after credentials are validated and securely saved.

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

The public package exposes exactly the 85 active, customer-facing operations in the Borealis v1 catalog. Platform-administration operations are intentionally excluded. Run `borealis --help` for groups and use the canonical command paths, for example:

```bash
borealis sandbox list --page 1 --page-size 50
borealis sandbox get 018f4c28-dc05-7e91-9f8e-11e421bb8a91 --json
borealis sandbox create --body '{"name":"demo","runtime":{"kind":"microvm","templateId":"base","templateRevision":1,"architecture":"aarch64"}}'
borealis host list --pool 018f4c28-dc05-7e91-9f8e-11e421bb8a91
borealis interactive attach 018f4c28-dc05-7e91-9f8e-11e421bb8a91
```

Sandbox creation follows the API's MicroVM default. To select a prepared ARM64
image explicitly, use its immutable template revision:

```bash
borealis sandbox create \
  --name isolated-build \
  --runtime microvm \
  --runtime-template ubuntu-24.04 \
  --template-revision 3 \
  --architecture aarch64 \
  --vcpu 2 \
  --memory-mib 4096 \
  --root-disk 20
```

Path identifiers are positional. Request fields can use their named kebab-case option or the transport-neutral forms:

```bash
borealis template create --set displayName=Node --set image=node:22
borealis template create --body '{"displayName":"Node","defaults":{"name":"Node","image":"node:22"}}'
```

All commands support `--json`. JSON output preserves the public response. Human output is a presentation of the same response. A workspace import that reaches `failed` exits with code 3, including when `--wait` is used; its JSON result is still written to stdout.

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

The checked-in `src/operations.json` is imported from `Borealis.Api.Contracts.V1.BorealisOperationCatalog`. In a Borealis source checkout, mechanically verify the 85 public commands against the canonical .NET catalog and client methods with:

```bash
BOREALIS_SOURCE_ROOT=/path/to/aurora-proto pnpm parity
```

When validating a source revision that still contains the former .NET CLI, the same gate also proves its registry is a one-to-one match.

## Release bootstrap

The release workflow validates and packages pushes to `main`. Its npm publish step runs only when the repository/environment variable `NPM_TRUSTED_PUBLISHING_ENABLED` is exactly `true`. An explicit workflow-dispatch release fails if publishing is disabled; it cannot finish successfully while silently skipping the requested publication.

First check `npm view @amaretto-software-labs/borealis-cli version dist-tags`. If the package already exists, configure its trusted publisher and select an unused release version; do not repeat the bootstrap or republish an existing version. Only when the package does not exist must a maintainer bootstrap it once from a locally validated tarball using an npm account with 2FA:

```bash
pnpm pack
npm publish ./amaretto-software-labs-borealis-cli-0.1.0.tgz --access public
```

After that first interactive publish, configure the npm trusted publisher for `Amaretto-Software-Labs/borealis-cli` and `.github/workflows/release.yml`, then set the GitHub repository variable `NPM_TRUSTED_PUBLISHING_ENABLED=true`. No long-lived npm token is used by the workflow.

## License

Apache-2.0. See [LICENSE](LICENSE).

## Runtime v2

The CLI includes 86 canonical customer operations plus 65 conditional runtime and networking commands. `logical-machine allocate` uses server-selected identity, including complete VM pools. Ordinary `sandbox create` follows the enabled API's MicroVM allocation default; explicit legacy container requests are rejected by the production API.

Standard sandbox start/resume/stop/delete inspect the resource runtime kind and logical binding. Runtime v2 dispatch requires an explicit UUID key and uses the conditional logical-machine endpoint; existing containers retain their lifecycle during migration.

Runtime v2 commands check `GET /api/v1/capabilities/runtime-v2` before dispatch. That response describes deployment support; normal organization, ownership, scope and preflight authorization still apply. Hosted MCP uses the same conditional catalogs, so disabled deployments do not advertise these tools.

Provide an explicit UUID key for every keyed Runtime v2 mutation. Keep the same key and payload on retry. Turn renewal extends a bounded activity lease; template retirement reconciles the same revision target state and prevents new activations while existing machines retain their recovery baseline.

```bash
borealis logical-machine allocate --idempotency-key "$REQUEST_ID" --body '{"name":"worker","runtime":{"kind":"microvm","templateId":"base","templateRevision":1,"architecture":"aarch64","resources":{"vcpu":1,"memoryMiB":1024,"rootDiskGiB":2}}}'
borealis logical-machine allocation by-request "$REQUEST_ID"
borealis logical-machine get "$VM_ID"
borealis logical-machine wake "$VM_ID" --idempotency-key "$WAKE_REQUEST_ID" --wait --timeout 60
borealis logical-machine turn begin "$VM_ID" --idempotency-key "$TURN_REQUEST_ID" --set leaseSeconds=300
borealis logical-machine turn renew "$VM_ID" "$TURN_ID" --set leaseSeconds=300
borealis logical-machine turn complete "$VM_ID" "$TURN_ID" --idempotency-key "$COMPLETE_REQUEST_ID" --body '{"captureBoundaryId":"CAPTURE_UUID","outputWatermark":42}'
borealis logical-machine operation get "$VM_ID" "$COMPLETE_REQUEST_ID"
borealis runtime-template retire "$TEMPLATE_ID" "$REVISION"
```

Allocation, wake, start and template activation support bounded `--wait`; a committed wake establishes execution readiness. Only successful independently verified checkpoint commit establishes durable turn output. Suspended processes preserve local state but make no progress, and external connections may need reconnecting.

Use `--json` for structured results. Exit codes are 0 for accepted/successful calls, 1 for input/local failures, 2 for authorization failures, 3 for API/terminal operation failures, 4 for ambiguous dispatch or `OutcomeUnknown`, and 130 for cancellation. Ambiguous JSON includes `idempotencyKey`; the CLI never silently resubmits. Recover a lost allocation response by its original request key, or query wake/operation/turn/checkpoint status with original identifiers. A successful acceptance without `--wait` does not claim final readiness. Deletion retains explicit confirmation and API-owned `sandbox.delete` preflight.

An idle, paused VM can release its resident RAM while keeping its local checkpoint:

```sh
borealis logical-machine hibernate "$VM_ID" --idempotency-key "$HIBERNATE_REQUEST_ID"
borealis logical-machine operation get "$VM_ID" "$HIBERNATE_REQUEST_ID"
```

The accepted response is pending work, not proof of hibernation. Wait for the operation to commit and the VM to reach `LocalDiskSuspended`; resume through the normal wake command. Reuse the same request ID after a timeout. Replaying a completed request after resume returns its original receipt without hibernating again. Active work must finish and the VM must be paused first. Local checkpoints depend on the original host and disk; they are not durable backups.

`BOREALIS_SOURCE_ROOT=/path/to/borealis pnpm parity` verifies the canonical customer catalog, and `pnpm parity:runtime` separately checks conditional catalog parity. Neither command builds another CLI in the backend repository.

### Recover turn activity

An expired turn activity can be recovered only for observing and settling its original execution. Preserve the original expired lease, incarnation, epoch and a fresh recovery request ID before dispatch:

```sh
borealis logical-machine turn activity recover "$VM_ID" "$TURN_ID" --idempotency-key "$RECOVERY_REQUEST_ID" --body '{"expectedActivityLeaseId":"OLD_LEASE_UUID","expectedIncarnationId":"INCARNATION_UUID","expectedOwnershipEpoch":2,"leaseSeconds":300}'
borealis logical-machine turn activity recovery get "$VM_ID" "$TURN_ID" "$RECOVERY_REQUEST_ID"
```

After recovery, renewal and completion bodies must include `expectedActivityLeaseId` from that exact recovery receipt. A lost response requires receipt reconciliation with the original request ID; never adopt another request's lease or replay execution. Recovery preserves cancellation intent and the expired lease.

### Contract parity

`pnpm catalog:check` validates the 86 public and 63 conditional operations for unique commands, API paths and ownership. CI and release packaging run this check, the CLI tests, and the packed-package smoke test without private-source credentials.

When updating the Borealis contracts, regenerate and compare both catalogs against the source checkout:

```sh
BOREALIS_SOURCE_ROOT=/path/to/borealis pnpm parity:update
BOREALIS_SOURCE_ROOT=/path/to/borealis pnpm parity:runtime:update
BOREALIS_SOURCE_ROOT=/path/to/borealis pnpm parity
BOREALIS_SOURCE_ROOT=/path/to/borealis pnpm parity:runtime
```

Borealis CI runs both parity checks against the CLI revision under review, using its own source checkout. They compare API contracts and SDK methods; Git ancestry, commit provenance and private-source access from this public repository are not required. Squashing either PR does not change contract compatibility. npm publication retains its existing trusted-publishing configuration and package validation.

### Prepare an image for a VM size

Image build/import and VM creation are separate operations. Stage the published revision for the resource shape and target host pool before allocation:

```sh
borealis runtime-image template stage custom-image 1 --body '{"placement":{"hostPoolId":"HOST_POOL_UUID"},"resources":{"vcpu":2,"memoryMiB":4096,"rootDiskGiB":16}}'
```

A stage result with `readyHosts: 0` means preparation is pending; repeat the same stage request to observe progress. A ready host has prepared this exact template baseline. Images are staged on demand, not replicated to every host. Different VM sizes need separate preparation. A complete paused VM pool is additional, demand-driven capacity; image readiness alone does not promise a pool hit.

### Managed sidecar image preparation

`runtime-image build` accepts the published build request with `enableManagedService: true` for a service image whose original ENTRYPOINT/CMD runs only after authorized launch. `sourceKind: "container_archive"` uses the existing build-context upload's digest reference for a Docker-save or OCI archive. Raw VM disks are not container archives.

Private OCI builds accept an explicit per-build `registryCredential` through the Borealis API and SDK. The CLI currently accepts build JSON only through command arguments; it has no private body-file or stdin input for these credentials. Use the SDK for private builds, and never place a token in `--body`, `--set`, or an image URL. Public pulls never borrow a saved organization registry credential. Keep request identity stable across transport retries; changing a credential does not replace an already accepted build or its immutable source.

The existing build/get/approve/stage commands retain their operation identities. Wait for signed validation, any required operator approval and exact geometry staging before VM allocation. Acceptance is separate from image readiness and service readiness.

### Computer durability

Computer durability belongs to the VM, independently of task retention. New MicroVMs default to ephemeral (no automatic snapshots). Change an existing computer with a stable request key and inspect protection while the first permanent checkpoint is published:

```bash
borealis logical-machine durability change "$VM_ID" --idempotency-key "$REQUEST_ID" --body '{"mode":"permanent"}'
borealis logical-machine durability get "$VM_ID"
```

Use `{"mode":"ephemeral"}` to stop future automatic checkpoints without replacing the computer. Promotion remains pending until the first fresh durable checkpoint; a permanent computer recovers through its last committed checkpoint.
