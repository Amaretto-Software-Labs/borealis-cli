import { afterEach, describe, expect, it, vi } from "vitest";
import { observeProgress } from "./progress.js";

afterEach(() => vi.restoreAllMocks());

describe("public progress output", () => {
  it("prints periodic elapsed time only after another confirmed status and resets phase duration", () => {
    const stderr = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);
    let time = 0;
    const confirmed = observeProgress(
      { kind: "build", id: "build-1" },
      "oci",
      () => time,
    );
    confirmed("building", "assembly_execute");
    expect(stderr).toHaveBeenCalledOnce();
    expect(stderr).toHaveBeenCalledWith(
      expect.stringContaining("Pulling and preparing the registry image"),
    );
    time = 9_000;
    confirmed("building", "assembly_execute");
    expect(stderr).toHaveBeenCalledOnce();
    time = 25_000;
    expect(stderr).toHaveBeenCalledOnce();
    confirmed("building", "assembly_execute");
    expect(stderr).toHaveBeenLastCalledWith(
      expect.stringContaining("elapsed 25s, phase observed for 25s"),
    );
    time = 30_000;
    confirmed("validating", "assessment_malware");
    expect(stderr).toHaveBeenLastCalledWith(
      expect.stringContaining("Scanning for malware"),
    );
    time = 55_000;
    confirmed("validating", "assessment_malware");
    expect(stderr).toHaveBeenLastCalledWith(
      expect.stringContaining("elapsed 55s, phase observed for 25s"),
    );
  });
});
