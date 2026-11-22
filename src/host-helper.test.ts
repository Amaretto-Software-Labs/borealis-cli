import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { elevatedHostHelperArgs, helperPath } from "./host-helper.js";

const pythonHarness = `
import json, os, stat, sys
from types import SimpleNamespace

fixture = json.loads(sys.argv[1])
bootstrap = sys.argv[2]
sys.argv = ["-c", *sys.argv[3:]]
os.geteuid = lambda: fixture.get("euid", 0)
launcher = ${JSON.stringify(helperPath)}
checked = []

def lstat(path):
    checked.append(path)
    if path == fixture.get("missing"):
        raise FileNotFoundError(path)
    if path == launcher:
        kind = stat.S_IFREG
        mode = 0o700
    else:
        kind = stat.S_IFDIR
        mode = 0o700 if path == "/usr/libexec/borealis" else 0o755
    uid = 0
    if path == fixture.get("unsafe"):
        kind = stat.S_IFLNK if fixture.get("symlink") else kind
        mode = fixture.get("mode", mode)
        uid = fixture.get("uid", 0)
    return SimpleNamespace(st_mode=kind | mode, st_uid=uid)

def launch(path, args):
    print(json.dumps({"path": path, "args": args, "checked": checked, "input": sys.stdin.read()}))
    raise SystemExit(fixture.get("exitCode", 0))

os.lstat = lstat
os.execv = launch
exec(bootstrap, {})
`;

function runElevatedVerifier(
  fixture: Record<string, unknown>,
  args: string[] = ["cloud-status"],
  input = "",
) {
  const command = elevatedHostHelperArgs(args);
  const script = command[command.indexOf("-c") + 1]!;
  return spawnSync(
    "python3",
    ["-I", "-B", "-c", pythonHarness, JSON.stringify(fixture), script, ...args],
    { input, encoding: "utf8", timeout: 5_000 },
  );
}

describe.skipIf(process.platform === "win32")(
  "privileged installed host helper",
  () => {
    it("takes one sudo invocation and supports noninteractive observation", () => {
      const args = ["cloud-status"];
      const interactive = elevatedHostHelperArgs(args);
      expect(interactive.slice(0, 5)).toEqual([
        "--",
        "/usr/bin/python3",
        "-I",
        "-B",
        "-c",
      ]);
      expect(interactive.at(-1)).toBe("cloud-status");
      expect(elevatedHostHelperArgs(args, true)).toEqual([
        "-n",
        ...interactive,
      ]);
    });

    it("executes the fixed launcher under a private root directory with exact argv, stdin and exit status", () => {
      const args = [
        "config-apply",
        "--file",
        "/tmp/operator's literal path $(unexpanded)",
      ];
      const input = JSON.stringify({ fixture: "streamed only on stdin" });
      const result = runElevatedVerifier({ exitCode: 23 }, args, input);
      expect(result.status, result.stderr).toBe(23);
      expect(result.stderr).toBe("");
      expect(JSON.parse(result.stdout)).toEqual({
        path: helperPath,
        args: [helperPath, ...args],
        input,
        checked: [
          "/",
          "/usr",
          "/usr/libexec",
          "/usr/libexec/borealis",
          helperPath,
        ],
      });
    });

    it.each([
      ["not root", { euid: 1000 }, "requires root"],
      [
        "missing launcher",
        { missing: helperPath },
        "Install it from a verified",
      ],
      [
        "launcher symlink",
        { unsafe: helperPath, symlink: true },
        "must be root-owned",
      ],
      [
        "ancestor symlink",
        { unsafe: "/usr/libexec", symlink: true },
        "must be root-owned",
      ],
      [
        "user-owned launcher",
        { unsafe: helperPath, uid: 1000 },
        "must be root-owned",
      ],
      [
        "group-writable directory",
        { unsafe: "/usr/libexec/borealis", mode: 0o770 },
        "must be root-owned",
      ],
      [
        "non-executable launcher",
        { unsafe: helperPath, mode: 0o600 },
        "must be root-owned",
      ],
    ])("fails closed with %s", (_name, fixture, expected) => {
      const result = runElevatedVerifier(fixture);
      expect(result.status).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain(expected);
    });
  },
);
