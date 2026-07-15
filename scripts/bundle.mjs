#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2025 Autonomy / OpenPLC Project
/**
 * Bundle the STruC++ CLI into a single CJS file using esbuild.
 * Injects the upstream package version by default. Downstream distributors
 * can provide a namespaced build identity without changing package.json.
 */

import { readFileSync } from "fs";
import { build } from "esbuild";
import { validateTcGenDistributionVersion } from "./verify-distribution-version.mjs";

const pkg = JSON.parse(readFileSync("package.json", "utf-8"));
const requestedDistributionVersion =
  process.env.STRUCPP_DISTRIBUTION_VERSION?.trim();
const bundleVersion = requestedDistributionVersion || pkg.version;
if (requestedDistributionVersion) {
  validateTcGenDistributionVersion(pkg.version, bundleVersion);
  console.log(
    `[bundle] Injecting distribution version ${bundleVersion} over upstream ${pkg.version}`,
  );
}

await build({
  entryPoints: ["dist/node/cli.js"],
  bundle: true,
  platform: "node",
  target: "node22",
  outfile: "dist/strucpp-bundle.cjs",
  format: "cjs",
  define: {
    STRUCPP_VERSION: JSON.stringify(bundleVersion),
  },
});
