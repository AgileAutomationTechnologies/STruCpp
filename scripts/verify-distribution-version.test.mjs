// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2025 Autonomy / OpenPLC Project

import assert from "node:assert/strict";
import test from "node:test";
import {
  validateTcGenDistributionVersion,
  validateTcGenReleaseTag,
} from "./verify-distribution-version.mjs";

test("accepts a namespaced revision on the exact upstream base", () => {
  assert.deepEqual(
    validateTcGenDistributionVersion("0.5.13", "0.5.13-tcgen.1"),
    {
      distributionVersion: "0.5.13-tcgen.1",
      downstreamRevision: 1,
    },
  );
  assert.equal(
    validateTcGenReleaseTag(
      "0.5.13",
      "0.5.13-tcgen.12",
      "v0.5.13-tcgen.12",
    ),
    "v0.5.13-tcgen.12",
  );
});

test("rejects wrong bases and invalid downstream revisions", () => {
  for (const invalid of [
    "0.5.13",
    "0.5.13-tcgen.0",
    "0.5.13-tcgen.01",
    "0.5.14-tcgen.1",
    "0.5.13-other.1",
  ]) {
    assert.throws(
      () => validateTcGenDistributionVersion("0.5.13", invalid),
      /must match/,
    );
  }
});

test("reserves the plain upstream release tag", () => {
  assert.throws(
    () =>
      validateTcGenReleaseTag(
        "0.5.13",
        "0.5.13-tcgen.1",
        "v0.5.13",
      ),
    /reserved for upstream/,
  );
});

test("rejects a mismatched downstream release tag", () => {
  assert.throws(
    () =>
      validateTcGenReleaseTag(
        "0.5.13",
        "0.5.13-tcgen.2",
        "v0.5.13-tcgen.1",
      ),
    /expected 'v0.5.13-tcgen.2'/,
  );
});
