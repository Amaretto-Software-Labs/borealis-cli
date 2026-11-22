// This code is shipped with the CLI. It runs with explicit elevation so that
// only the verified copy of the signed installer will ever run as root.
export const installerBootstrap = String.raw`
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import sys
import tempfile

PUBLISHER = "https://github.com/Amaretto-Software-Labs/borealis/.github/workflows/release-standalone-host.yml@refs/heads/main"
ISSUER = "https://token.actions.githubusercontent.com"
SYSTEM_PATH = "/usr/sbin:/usr/bin:/sbin:/bin:/usr/local/bin"
REQUIRED_FILES = {
    "host.tar.gz", "firecracker", "jailer", "builder-bootstrap", "builder-profile",
    "borealis-host", "borealis-launcher", "distribution.py", "doctor.py", "package-host.py",
    "borealis-microvm-production-cgroup", "host_configuration.py",
}
MANIFEST = "manifest.json"
SIGNATURE = "manifest.json.sigstore.json"
MAX_FILE_BYTES = 32 * 1024 ** 3
OPEN_FLAGS = os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC | os.O_NONBLOCK

def root_executable(name):
    for directory in SYSTEM_PATH.split(":"):
        path = Path(directory, name).resolve()
        if not path.is_file():
            continue
        if any(p.stat().st_uid != 0 or p.stat().st_mode & 0o022 for p in (path, *path.parents)):
            continue
        if path.stat().st_mode & stat.S_IXUSR:
            return str(path)
    raise ValueError("A root-controlled system installation of " + name + " is required")

def copy_verified(src, dest, limit, dir_fd=None, configuration=False):
    fd = os.open(src, OPEN_FLAGS, dir_fd=dir_fd)
    with os.fdopen(fd, "rb") as data:
        info = os.fstat(data.fileno())
        if not stat.S_ISREG(info.st_mode) or not 0 < info.st_size <= limit:
            raise ValueError(f"Expected a bounded regular file: {src}")
        if configuration and (info.st_uid != 0 or info.st_mode & 0o077):
            raise ValueError("Configuration must be root-owned with mode 0600")
        digest = hashlib.sha256()
        total = 0
        with dest.open("xb") as out:
            while block := data.read(1024 * 1024):
                total += len(block)
                if total > limit:
                    raise ValueError(f"File exceeded its bound: {src}")
                digest.update(block)
                out.write(block)
        return total, digest.hexdigest()

def stage_bundle(bundle, staged, env):
    directory = os.open(bundle, OPEN_FLAGS | os.O_DIRECTORY)
    try:
        _, manifest_digest = copy_verified(MANIFEST, staged / MANIFEST, 1024 * 1024, directory)
        copy_verified(SIGNATURE, staged / SIGNATURE, 4 * 1024 * 1024, directory)
        subprocess.run([
            root_executable("cosign"), "verify-blob", "--bundle", str(staged / SIGNATURE),
            "--certificate-identity", PUBLISHER, "--certificate-oidc-issuer", ISSUER,
            str(staged / MANIFEST),
        ], check=True, env=env, stdout=subprocess.DEVNULL)
        manifest = json.loads((staged / MANIFEST).read_text())
        if (manifest.get("schemaVersion") != 1 or manifest.get("product") != "borealis-standalone-host"
                or not re.fullmatch(r"[0-9a-f]{40}", manifest.get("releaseId", ""))
                or manifest.get("architecture") not in ("x86_64", "aarch64")):
            raise ValueError("Invalid standalone release identity")
        files = manifest.get("files", [])
        if (not isinstance(files, list) or not len(REQUIRED_FILES) <= len(files) <= 32
                or any(not isinstance(entry, dict) or not isinstance(entry.get("path"), str) for entry in files)
                or len({entry["path"] for entry in files}) != len(files)
                or not REQUIRED_FILES.issubset({entry["path"] for entry in files})
                or any(not re.fullmatch(r"[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}", entry["path"])
                       or entry["path"] in (MANIFEST, SIGNATURE) for entry in files)):
            raise ValueError("Invalid standalone release inventory")
        for entry in files:
            size, digest = entry.get("bytes"), entry.get("sha256")
            if type(size) is not int or not 0 < size <= MAX_FILE_BYTES or not re.fullmatch(r"[0-9a-f]{64}", digest or ""):
                raise ValueError("Invalid byte count or SHA-256 in standalone manifest")
            name = entry["path"]
            if copy_verified(name, staged / name, size, directory) != (size, digest):
                raise ValueError("Standalone release content mismatch: " + name)
        return manifest_digest
    finally:
        os.close(directory)

def main():
    if os.geteuid() != 0:
        raise ValueError("Explicit root authorization is required")
    command, bundle, configuration, builder, *expected = sys.argv[1:]
    if command not in ("preflight", "install", "uninstall") or len(expected) != (2 if command == "install" else 0):
        raise ValueError("Invalid standalone bootstrap action")
    os.umask(0o077)
    env = {"PATH": SYSTEM_PATH, "HOME": "/root", "LANG": "C.UTF-8"}
    for name in ("SUDO_USER", "SUDO_UID"):
        if name in os.environ:
            env[name] = os.environ[name]
    build_options = ["--without-builder"] if builder == "without-builder" else []
    uid = os.environ.get("SUDO_UID", "")
    management_options = ["--management-uid", uid] if re.fullmatch(r"[0-9]+", uid) and int(uid) > 0 else []
    with tempfile.TemporaryDirectory(prefix="borealis-install-", dir="/var/tmp") as stage:
        internal = Path(stage)
        staged = internal / "bundle"
        staged.mkdir()
        trusted_tools = internal / "bin"
        trusted_tools.mkdir()
        (trusted_tools / "cosign").symlink_to(root_executable("cosign"))
        env["PATH"] = str(trusted_tools) + ":" + SYSTEM_PATH
        manifest_digest = stage_bundle(bundle, staged, env)
        if command == "uninstall":
            recovery = (
                "import json, sys; sys.path.insert(0, sys.argv[1]); "
                "from host_configuration import uninstall; "
                "print(json.dumps(uninstall(recovery_manifest=sys.argv[2])))"
            )
            return subprocess.run([
                "/usr/bin/python3", "-I", "-B", "-c", recovery, str(staged), manifest_digest,
            ], env=env, cwd=internal).returncode
        helper = ["/usr/bin/python3", "-B", "-E", "-s", str(staged / "borealis-host")]
        config = internal / "configuration.json"
        if configuration:
            _, config_digest = copy_verified(configuration, config, 1024 * 1024, configuration=True)
        else:
            defaults = subprocess.run([
                *helper, "defaults", "--bundle", str(staged), *build_options, *management_options,
            ], env=env, cwd=internal, stdout=subprocess.PIPE, check=True).stdout
            if not 0 < len(defaults) <= 1024 * 1024:
                raise ValueError("Generated configuration exceeded its bound")
            config.write_bytes(defaults)
            config_digest = hashlib.sha256(defaults).hexdigest()
        if command == "install" and expected != [manifest_digest, config_digest]:
            raise ValueError("Bundle or configuration changed after preflight. Review a new preflight.")
        result = subprocess.run([
            *helper, command, "--bundle", str(staged), "--configuration", str(config), *build_options,
        ], env=env, cwd=internal, stdout=subprocess.PIPE)
        if result.stdout:
            report = json.loads(result.stdout)
            report["bundleDigest"] = manifest_digest
            report["configurationDigest"] = config_digest
            print(json.dumps(report))
        return result.returncode

try:
    sys.exit(main())
except (OSError, ValueError, TypeError, subprocess.SubprocessError) as error:
    print(str(error), file=sys.stderr)
    sys.exit(1)
`;
