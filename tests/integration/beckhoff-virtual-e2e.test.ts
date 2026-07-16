import { execFileSync, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

function findGpp(): string | undefined {
  const configured = process.env.STRUCPP_GPP_PATH?.trim();
  if (configured && existsSync(configured)) return configured;
  const knownWindowsPath = "C:\\msys64\\ucrt64\\bin\\g++.exe";
  if (existsSync(knownWindowsPath)) return knownWindowsPath;
  try {
    const command = process.platform === "win32" ? "where.exe" : "which";
    return execFileSync(command, ["g++"], { encoding: "utf8" })
      .split(/\r?\n/)
      .map((entry) => entry.trim())
      .find(Boolean);
  } catch {
    return undefined;
  }
}

const gpp = findGpp();
const validationRoot = resolve("tests/st-validation/beckhoff_virtual");
const cli = resolve("dist/node/cli.js");

function runVirtualTest(testFile: string, fixtureFile: string): string {
  const result = spawnSync(
    process.execPath,
    [
      cli,
      resolve(validationRoot, "subject.st"),
      "--library-profile",
      "beckhoff-virtual",
      "--virtual-fixture",
      resolve(validationRoot, fixtureFile),
      "--gpp",
      gpp!,
      "--test",
      resolve(validationRoot, testFile),
    ],
    { encoding: "utf8", timeout: 120_000 },
  );
  const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  expect(result.error, output).toBeUndefined();
  expect(result.status, output).toBe(0);
  return output;
}

describe.skipIf(!gpp)("Beckhoff virtual native profile", () => {
  it("links the whole profile and executes motion and sandbox services", () => {
    const output = runVirtualTest("behavior.st", "fixture.json");
    expect(output).toContain("2 passed, 0 failed");
  });

  it("returns the stable injected simulator error", () => {
    const output = runVirtualTest("fault-behavior.st", "fault-fixture.json");
    expect(output).toContain("1 passed, 0 failed");
  });
});
