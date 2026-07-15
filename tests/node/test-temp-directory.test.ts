import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  existsSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { basename, dirname, join, resolve } from "path";
import {
  cleanupTestTempDirectory,
  createTestTempDirectory,
} from "../../src/node/test-temp-directory.js";

let sandbox: string;

describe("test-mode temporary directory root", () => {
  beforeEach(() => {
    sandbox = mkdtempSync(join(tmpdir(), "strucpp-temp-root-test-"));
  });

  afterEach(() => {
    rmSync(sandbox, {
      recursive: true,
      force: true,
      maxRetries: process.platform === "win32" ? 8 : 0,
      retryDelay: process.platform === "win32" ? 100 : 0,
    });
  });

  it("creates a missing configured root and allocates directly beneath it", () => {
    const configuredRoot = join(sandbox, "mcp-workspace", "test-temp");
    const fallbackRoot = join(sandbox, "os-temp");
    const warnings: string[] = [];

    const created = createTestTempDirectory(
      configuredRoot,
      fallbackRoot,
      (message) => warnings.push(message),
    );

    expect(dirname(created)).toBe(resolve(configuredRoot));
    expect(basename(created)).toMatch(/^strucpp-test-/);
    expect(existsSync(created)).toBe(true);
    expect(warnings).toEqual([]);

    cleanupTestTempDirectory(created);
    expect(existsSync(created)).toBe(false);
  });

  it("falls back when the configured root is an existing file", () => {
    const configuredRoot = join(sandbox, "not-a-directory");
    const fallbackRoot = join(sandbox, "os-temp");
    const warnings: string[] = [];
    writeFileSync(configuredRoot, "not a directory", "utf-8");

    const created = createTestTempDirectory(
      configuredRoot,
      fallbackRoot,
      (message) => warnings.push(message),
    );

    expect(dirname(created)).toBe(resolve(fallbackRoot));
    expect(existsSync(created)).toBe(true);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("STRUCPP_TEST_TEMP_ROOT");
    expect(warnings[0]).toContain("falling back to OS temp root");

    cleanupTestTempDirectory(created);
  });

  it("escapes malformed root values in its single-line fallback warning", () => {
    const configuredRoot = `${join(sandbox, "invalid")}\0forged\nwarning`;
    const fallbackRoot = join(sandbox, "os-temp");
    const warnings: string[] = [];

    const created = createTestTempDirectory(
      configuredRoot,
      fallbackRoot,
      (message) => warnings.push(message),
    );

    expect(dirname(created)).toBe(resolve(fallbackRoot));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).not.toMatch(/[\r\n]/);
    expect(warnings[0]).toContain("\\n");

    cleanupTestTempDirectory(created);
  });
});
