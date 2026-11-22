<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/Amaretto-Software-Labs/borealis-cli/main/assets/borealis-mark.svg">
  <img alt="Borealis" src="https://raw.githubusercontent.com/Amaretto-Software-Labs/borealis-cli/main/assets/borealis-mark-light.svg" width="72" height="72">
</picture>

# Borealis CLI

The official command-line client for Borealis Cloud and standalone Borealis supervisors. It is distributed as a Node.js package.

Website: [borealishq.io](https://borealishq.io) · Built by [Amaretto Software Labs](https://amarettosoftware.com)

## Install

Node.js 22 or newer is required.

```bash
npx @amaretto-software-labs/borealis-cli --help
npm install --global @amaretto-software-labs/borealis-cli
```

Open a fresh interactive shell and run `borealis --version` to verify the command
is on your `PATH`. If you installed a user-local launcher under
`$HOME/.local/bin` and your shell cannot find it, add
`export PATH="$HOME/.local/bin:$PATH"` to the startup file your interactive shell
reads, such as `~/.bashrc` for a non-login Bash shell on WSL. Open a new shell and
run `borealis --version` again.

## Standalone runtime

To install from a signed Linux/KVM host bundle, install Python 3 and a system copy
of cosign.

```bash
borealis supervisor install --bundle /path/to/signed-bundle
borealis status
borealis doctor
borealis vm create --name dev --image ubuntu:24.04 --wait
borealis vm list
```

The CLI verifies the publisher and the bundle's file digests before running the
installer under sudo. It shows the release and system changes before application.
Add `--without-builder` for a host that will run prepared images. Host
prerequisites and VM readiness are separate checks detailed by the installer.
If the installer adds your user to the default `borealis` management group,
run `newgrp borealis` or open a fresh login session so the terminal picks up
the new group. This applies to existing WSL shells and SSH sessions too.
Run `borealis doctor` to check the local service, socket access for this
terminal, and builder health. It reports the local checks even if the API is
unreachable. With an SSH profile, `doctor` checks the remote supervisor API.

Run `borealis status` for the selected standalone host's health, capacity,
running VMs, and active or recent image builds. Use `--profile NAME` to check
another local or SSH host. `--json` includes inventory counts and indicates
when part of the inventory could not be read or fit within the overview limits.

For remote bootstrap, use
`borealis --profile <ssh-profile> supervisor install --bundle /absolute/path`
with the signed bundle staged on that host and authorized noninteractive sudo.

A fresh installation selects the `local` profile. An existing selection survives
installation. With a fresh CLI configuration, Borealis discovers and selects
an installed supervisor on `/run/borealis/supervisor.sock`; no Cloud login is
needed for local or SSH management. Run
`borealis auth whoami` to see the local OS identity and the supervisor host ID.
Run `borealis profile use local` to switch from another selected profile.
For a supervisor on a custom socket, register the path before selecting it.

```bash
borealis profile add local --local --socket /path/to/supervisor.sock
borealis profile use local
```

From a Linux or macOS client, add an OpenSSH profile. Configure the host alias
and verify the host key through your usual SSH process first. The remote
account needs permission to access the management socket.

```bash
borealis profile add lab --ssh lab-linux --socket /run/borealis/supervisor.sock
borealis profile list
borealis --profile lab vm list
borealis profile use lab
borealis vm list
```

`--profile` overrides the target for one command. Local and SSH calls use Unix
sockets and OS permissions. Unavailable targets fail in place. The Cloud URL,
organization and explicit token flags require a Cloud profile. Direct JSON
results contain `target` with the host identity alongside `result`.

### Build and manage microVMs

```bash
borealis image build --context . --dockerfile Dockerfile --wait
borealis image build --image ubuntu:24.04 --wait
borealis image list
borealis image build list
borealis image build status BUILD_ID --wait
borealis operation wait OPERATION_ID
```

The CLI respects `.dockerignore` and Dockerfile-specific ignore files. Contexts
contain regular files and directories and omit symlinks. `--archive` uploads a
supported local container archive. Build inputs are streamed by SHA-256 over the
selected socket, including when using an SSH profile. Configure private registry
credentials through `image registry create --secret-file` or `--secret-stdin` and
select a specific connection for a build with `--registry REGISTRY_ID`.

`vm create --image` requests the native architecture and resolves the
registry tag through the supervisor. Use a verified prepared revision with
`--prepared-image IMAGE_ID --revision REVISION`. Long operations
return an ID. Use `--wait` to see the current phase and elapsed time. The CLI
prints periodic updates after it confirms the same phase is still reported.
Local input preparation and upload report bytes as the CLI processes them.
Press Ctrl+C to stop watching while the host retains accepted work. Reconnect
with `operation wait OPERATION_ID` or `image build status BUILD_ID --wait` on
the same profile.
For an explicit snapshot policy, create with `--checkpoint-policy AgentTurn`
and use `vm snapshot create --sandbox VM_ID --wait`. For a lost response, retain the
reported `--idempotency-key` and original
request on the original profile. Progress is written to stderr.
Standalone image builds wait for up to 2 hours 2 minutes 30 seconds by default.
Source-image creation and `operation wait` default to 2 hours 32 minutes
30 seconds. Use `--timeout` to change the observation window.

```bash
borealis vm session create --sandbox VM_ID
borealis vm session attach SESSION_ID
borealis vm workspace export VM_ID ./workspace.tar
borealis vm workspace import VM_ID ./workspace.tar --keep
borealis --profile lab vm port register VM_ID --container-port 8080 --protocol tcp --forward
```

An SSH preview binds the client listener to loopback and stays open until the
host registration expires or the command is interrupted.

### Host configuration and service maintenance

Run privileged local host commands in a Linux terminal where sudo can prompt
for authorization. The CLI verifies the installed helper within that sudo
invocation. SSH host maintenance requires noninteractive sudo on the target.

`supervisor logs --limit 100` reads the selected host's bounded service journal.
Use `supervisor events` for durable operation receipts.

```bash
borealis supervisor config show
borealis supervisor config validate --file ./changes.json
borealis supervisor stop --yes
borealis supervisor config apply --file ./changes.json --revision CONFIG_REVISION --yes
borealis supervisor start
```

Configuration changes support `maximumConcurrentPhysicalStarts`,
`hostMemoryReserveMiB`, `minimumDiskFreeGiB` and `enableStageTimings`.
Show and validate return the current revision and omit unrelated settings and
secrets. Use the revision from validation when applying the change. Apply
requires a verified idle stop. The next start loads the new configuration.

Use `borealis supervisor builder install --yes` from the same stopped state
to enable the builder shipped with the installed signed release, then start the
supervisor. `borealis supervisor uninstall --yes` removes owned service
definitions and release binaries after a verified idle stop. It retains
configuration, trust, operation receipts, VM disks and checkpoints. The
dedicated bridge and firewall rules remain in the running host until reboot,
and the saved network configuration remains available for reinstall.
If cleanup was interrupted after the installed helper became unavailable,
run `borealis supervisor uninstall --bundle /path/to/original-bundle --yes`
with the signed release recorded by the host. On SSH profiles that path is on
the selected host.

### Host updates

Use a signed release bundle to plan an update and review its eligibility and
workload checks.

```bash
borealis supervisor update check --bundle /path/to/next-bundle
borealis supervisor update plan --bundle /path/to/next-bundle
borealis supervisor update apply --bundle /path/to/next-bundle --plan-id PLAN_ID --wait
borealis supervisor update status ATTEMPT_ID
borealis supervisor repair
```

Apply requires explicit confirmation. The host runs the transition independently
and retains its attempt status after the CLI disconnects. Use `repair --resume`
only when the recorded phase supports resuming. With an SSH profile, pass the
absolute path to a signed bundle already staged on that Linux host. Remote
update and repair commands require authorization for the fixed sudo helper.

### Optional Cloud attachment

Create an enrollment in the existing Cloud host pool for the supervisor's host
ID, available from `borealis supervisor status`. Supply the enrollment code by
owner-only file or stdin.

```bash
borealis supervisor cloud connect --control-plane https://CONTROL_PLANE --enrollment-code-file ./code
borealis supervisor cloud status
borealis supervisor cloud disconnect --yes
```

Attachment defaults to observability. Use `--enable-control` for an explicitly
authorized host with the existing Cloud runtime trust configured. A Control
attachment must drain admitted commands, native owners and connected builds
before the Host Agent stops. Local and SSH operations on the supervisor
continue independently.

## Cloud authentication

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

To add a Cloud profile when a local or SSH profile is selected, run `borealis --profile cloud auth login`, then `borealis profile use cloud` if you want to select it. Cloud sessions are isolated by profile. Sessions use the native macOS Keychain, Linux Secret Service, or Windows DPAPI. Storage fails closed when no secure provider is available. Plaintext owner-only files require an explicit `BOREALIS_CLI_ALLOW_INSECURE_FILE_SESSION=1` opt-in.

Automation should use one of these sources:

```bash
BOREALIS_ACCESS_TOKEN=... borealis auth whoami --json
borealis --profile cloud --token-file ./token vm list --json
```

`--token` remains available but prints a warning because command-line arguments may be visible in process listings and shell history. Only one token source may be supplied.

## Commands

The same vocabulary applies to local, SSH and Cloud targets. Run
`borealis --help` for command groups, or `borealis vm create --help` and
`borealis image build --help` for available options.

```bash
borealis vm list
borealis vm inspect VM_ID
borealis vm exec VM_ID --command uname --arg=-m
borealis vm stop VM_ID --wait
borealis vm delete VM_ID --wait
borealis image list
borealis image build status BUILD_ID
borealis --profile cloud network list
borealis --profile cloud cloud host list --pool POOL_ID
```

On a standalone host, `vm create --image` resolves and prepares an OCI source.
Cloud VM creation instead uses a prepared image and its exact revision:

```bash
borealis --profile cloud vm create \
  --name isolated-build \
  --prepared-image IMAGE_ID \
  --revision REVISION \
  --architecture x86_64 \
  --vcpu 2 \
  --memory-mib 4096 \
  --root-disk-gib 20
```

Use `image prepare IMAGE_ID REVISION` on Cloud to stage a published image for
its VM resource shape. Check the command's help for available options. Cloud
source-image build and VM creation are separate operations; direct `--image`
creation is supported by local and SSH supervisors.

`--json` preserves the Cloud API response. Direct supervisor JSON includes the
target and API result. Human output presents the same response. A failed
workspace import exits with code 3, including when `--wait` is used; its JSON
result is still written to stdout.

### Safety

- Destructive operations require a terminal confirmation or explicit `--yes`, then obtain a server-issued preflight token before mutation.
- Keyed operations accept `--idempotency-key`; otherwise the CLI generates a UUID and sends it in `Idempotency-Key`.
- Registry secrets should come from `BOREALIS_REGISTRY_SECRET`, `--secret-file`, or `--secret-stdin`. Direct `--secret` input emits a warning.
- Service-principal creation requires `--output <new-file>` or `--include-secret`. Output files are created owner-only and are never overwritten; failed delivery triggers compensating revocation.
- API, Identity, and application origins must use HTTPS. Loopback HTTP is accepted for local development only.
- Interactive session messages are capped at 4 MiB.

`BOREALIS_SOURCE_ROOT=/path/to/borealis pnpm parity:standalone` checks CLI
command mappings and representative request fields against a sibling checkout
of the supervisor.

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

The checked-in `src/operations.json` is imported from `Borealis.Api.Contracts.V1.BorealisOperationCatalog`. Use the Borealis source checkout to verify the 86 public operations against the canonical .NET catalog and client methods.

```bash
BOREALIS_SOURCE_ROOT=/path/to/borealis pnpm parity
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

## VM operations and image readiness

Accepted operations and completed operations are distinct. Use `--wait` or
`borealis operation wait OPERATION_ID` for a standalone operation; reconnect
with its original identifier after an interruption. Keep the original
idempotency key and request when recovering an ambiguous dispatch. A selected
target that is unavailable fails without switching to another profile.

For Cloud, prepare a published image for the intended resource shape before
creating a VM. A stage result with zero ready hosts means preparation is still
pending. Local checkpoints depend on the original host and disk; they are not
off-host backups. See `borealis vm --help`, `borealis image --help`, and
`borealis network --help` for the supported commands.

`BOREALIS_SOURCE_ROOT=/path/to/borealis pnpm parity` and `pnpm parity:runtime`
check the CLI's internal operation contracts against the source checkout.
