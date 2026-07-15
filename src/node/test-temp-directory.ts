// SPDX-License-Identifier: GPL-3.0-or-later

import { mkdirSync, mkdtempSync, rmSync, statSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";

const TEST_TEMP_PREFIX = "strucpp-test-";

type WarningSink = (message: string) => void;

function createDirectoryBeneath(root: string): string {
  mkdirSync(root, { recursive: true });
  if (!statSync(root).isDirectory()) {
    throw new Error("configured path is not a directory");
  }
  return mkdtempSync(join(root, TEST_TEMP_PREFIX));
}

function singleLineError(error: unknown): string {
  const detail = error instanceof Error ? error.message : String(error);
  return detail.replace(/[\r\n]+/g, " ");
}

/**
 * Create the CLI test build directory under the host-owned root when one is
 * configured. The directory is accepted only after it can be created and a
 * child temp directory can be allocated beneath it. An unusable configured
 * root falls back to the OS temp directory without aborting the test run.
 */
export function createTestTempDirectory(
  configuredRoot: string | undefined = process.env.STRUCPP_TEST_TEMP_ROOT,
  fallbackRoot: string = tmpdir(),
  warn: WarningSink = (message) => console.warn(message),
): string {
  const resolvedFallbackRoot = resolve(fallbackRoot);
  if (configuredRoot === undefined || configuredRoot.trim().length === 0) {
    return createDirectoryBeneath(resolvedFallbackRoot);
  }

  let resolvedConfiguredRoot = configuredRoot;
  try {
    resolvedConfiguredRoot = resolve(configuredRoot);
    return createDirectoryBeneath(resolvedConfiguredRoot);
  } catch (error: unknown) {
    warn(
      "Warning: STRUCPP_TEST_TEMP_ROOT " +
        `${JSON.stringify(resolvedConfiguredRoot)} is not a usable directory; ` +
        `falling back to OS temp root ${JSON.stringify(resolvedFallbackRoot)}. ` +
        singleLineError(error),
    );
    return createDirectoryBeneath(resolvedFallbackRoot);
  }
}

/**
 * Remove a test-mode build directory before the CLI exits. Windows virus
 * scanners and compiler processes can briefly retain file handles after the
 * child process completes, so recursive removal gets a bounded retry window.
 */
export function cleanupTestTempDirectory(tempDir: string): void {
  try {
    rmSync(tempDir, {
      recursive: true,
      force: true,
      maxRetries: process.platform === "win32" ? 8 : 0,
      retryDelay: process.platform === "win32" ? 100 : 0,
    });
  } catch (error: unknown) {
    console.warn(
      `Warning: Could not remove temporary STruC++ test directory ${JSON.stringify(tempDir)}. ` +
        `Manual cleanup may be required. ${singleLineError(error)}`,
    );
  }
}
