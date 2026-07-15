/**
 * CLI test-mode temporary directory cleanup regressions.
 *
 * Each child process receives a dedicated OS temp root. This lets the tests
 * prove that runTestMode removes its own strucpp-test-* directory without
 * enumerating or deleting historical directories from earlier installations.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawnSync, type SpawnSyncReturns } from "child_process";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";
import { hasGpp } from "../integration/test-helpers.js";

const CLI_PATH = resolve(__dirname, "../../dist/node/cli.js");

let isolatedTempRoot: string;
let configuredTestTempRoot: string;
let sourcePath: string;
let testPath: string;

function runTestCLI(
  testSource: string,
  extraArgs: string[] = [],
): SpawnSyncReturns<string> {
  writeFileSync(
    sourcePath,
    `
PROGRAM CleanupSubject
  VAR_OUTPUT
    value : INT;
  END_VAR
  value := 42;
END_PROGRAM
`,
    "utf-8",
  );
  writeFileSync(testPath, testSource, "utf-8");

  return spawnSync(
    process.execPath,
    [CLI_PATH, sourcePath, "--gpp", "g++", ...extraArgs, "--test", testPath],
    {
      encoding: "utf-8",
      timeout: 30000,
      env: {
        ...process.env,
        TMP: isolatedTempRoot,
        TEMP: isolatedTempRoot,
        TMPDIR: isolatedTempRoot,
        STRUCPP_TEST_TEMP_ROOT: configuredTestTempRoot,
      },
    },
  );
}

function expectNoTestBuildDirectory(): void {
  const leakedDirectories = readdirSync(configuredTestTempRoot, {
    withFileTypes: true,
  })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((name) => name.startsWith("strucpp-test-"));

  expect(leakedDirectories).toEqual([]);
}

describe.skipIf(!hasGpp)("CLI test-mode temporary directory cleanup", () => {
  beforeEach(() => {
    expect(existsSync(CLI_PATH)).toBe(true);
    isolatedTempRoot = mkdtempSync(join(tmpdir(), "strucpp-cli-cleanup-"));
    configuredTestTempRoot = join(isolatedTempRoot, "mcp-owned-test-temp");
    sourcePath = join(isolatedTempRoot, "subject.st");
    testPath = join(isolatedTempRoot, "subject.test.st");
  });

  afterEach(() => {
    rmSync(isolatedTempRoot, {
      recursive: true,
      force: true,
      maxRetries: process.platform === "win32" ? 8 : 0,
      retryDelay: process.platform === "win32" ? 100 : 0,
    });
  });

  it("removes its build directory after a passing test run", () => {
    const result = runTestCLI(`
TEST 'passes'
  VAR uut : CleanupSubject; END_VAR
  uut();
  ASSERT_EQ(uut.value, 42);
END_TEST
`);

    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("[PASS] passes");
    expectNoTestBuildDirectory();
  });

  it("removes its build directory after C++ compilation fails", () => {
    const result = runTestCLI(
      `
TEST 'would pass'
  VAR uut : CleanupSubject; END_VAR
  uut();
  ASSERT_EQ(uut.value, 42);
END_TEST
`,
      ["--cxx-flags", "-fstrucpp-intentional-invalid-option"],
    );

    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Error: C++ compilation failed:");
    expectNoTestBuildDirectory();
  });

  it("removes its build directory after an assertion failure", () => {
    const result = runTestCLI(`
TEST 'fails'
  VAR uut : CleanupSubject; END_VAR
  uut();
  ASSERT_EQ(uut.value, 7);
END_TEST
`);

    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    expect(result.stdout).toContain("[FAIL] fails");
    expectNoTestBuildDirectory();
  });
});
