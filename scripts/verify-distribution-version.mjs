#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2025 Autonomy / OpenPLC Project

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function validateTcGenDistributionVersion(
  packageVersion,
  distributionVersion,
) {
  const match = new RegExp(
    `^${escapeRegExp(packageVersion)}-tcgen\\.([1-9]\\d*)$`,
  ).exec(distributionVersion);
  if (!match) {
    throw new Error(
      `Downstream version '${distributionVersion}' must match ` +
        `'${packageVersion}-tcgen.N' with N >= 1`,
    );
  }
  return { distributionVersion, downstreamRevision: Number(match[1]) };
}

export function validateTcGenReleaseTag(
  packageVersion,
  distributionVersion,
  releaseTag,
) {
  validateTcGenDistributionVersion(packageVersion, distributionVersion);
  const expectedTag = `v${distributionVersion}`;
  if (releaseTag !== expectedTag) {
    const detail =
      releaseTag === `v${packageVersion}`
        ? "plain versions and tags are reserved for upstream"
        : `expected '${expectedTag}'`;
    throw new Error(`Downstream release tag '${releaseTag}' is invalid: ${detail}`);
  }
  return expectedTag;
}

function tagsPointingAtHead() {
  try {
    return execFileSync("git", ["tag", "--points-at", "HEAD"], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    })
      .split(/\r?\n/)
      .map((tag) => tag.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

function main() {
  const pkg = JSON.parse(
    readFileSync(new URL("../package.json", import.meta.url), "utf-8"),
  );
  const distributionVersion =
    process.env.STRUCPP_DISTRIBUTION_VERSION?.trim();
  if (!distributionVersion) {
    throw new Error("STRUCPP_DISTRIBUTION_VERSION is required");
  }

  const identity = validateTcGenDistributionVersion(
    pkg.version,
    distributionVersion,
  );
  const releaseTag =
    process.env.STRUCPP_RELEASE_TAG?.trim() ||
    (process.env.GITHUB_REF_TYPE === "tag"
      ? process.env.GITHUB_REF_NAME?.trim()
      : undefined);
  if (releaseTag) {
    validateTcGenReleaseTag(pkg.version, distributionVersion, releaseTag);
  }

  const plainTagPattern = /^v\d+\.\d+\.\d+$/;
  const conflictingTag = tagsPointingAtHead().find((tag) =>
    plainTagPattern.test(tag),
  );
  if (conflictingTag) {
    throw new Error(
      `Downstream commit has plain tag '${conflictingTag}'; plain tags are reserved for upstream`,
    );
  }

  console.log(
    `[distribution] ${identity.distributionVersion} (upstream ${pkg.version}, revision ${identity.downstreamRevision})`,
  );
  if (releaseTag) console.log(`[distribution] release tag ${releaseTag}`);
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (invokedPath === resolve(fileURLToPath(import.meta.url))) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
