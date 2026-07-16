// SPDX-License-Identifier: GPL-3.0-or-later
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  parseBeckhoffVirtualFixture,
  type BeckhoffVirtualFixture,
} from "../testing/virtual-fixture.js";

export interface LoadedBeckhoffVirtualFixture {
  fixture: BeckhoffVirtualFixture;
  sha256: string;
}

export function loadBeckhoffVirtualFixture(
  path: string,
): LoadedBeckhoffVirtualFixture {
  const bytes = readFileSync(path);
  const fixture = parseBeckhoffVirtualFixture(
    JSON.parse(bytes.toString("utf8")),
  );
  return {
    fixture,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

function cppString(value: string): string {
  return JSON.stringify(value)
    .replaceAll("\\u2028", "\\u2028")
    .replaceAll("\\u2029", "\\u2029");
}

export function generateBeckhoffVirtualFixtureHeader(
  fixture: BeckhoffVirtualFixture,
): string {
  const lines = [
    "#pragma once",
    '#include "beckhoff_virtual.hpp"',
    "inline void strucpp_apply_virtual_fixture() {",
    "  auto& environment = beckhoff_virtual::environment();",
    "  environment.clear();",
  ];
  if (fixture.scanPeriodNanoseconds !== undefined) {
    lines.push(
      `  environment.scanPeriodNanoseconds = ${fixture.scanPeriodNanoseconds}ULL;`,
    );
  }
  if (fixture.monotonicNanoseconds !== undefined) {
    lines.push(
      `  environment.monotonicNanoseconds = ${fixture.monotonicNanoseconds}LL;`,
    );
  }
  if (fixture.utcUnixNanoseconds !== undefined) {
    lines.push(
      `  environment.utcUnixNanoseconds = ${fixture.utcUnixNanoseconds}LL;`,
    );
  }
  if (fixture.timeZone !== undefined) {
    lines.push(`  environment.timeZone = ${cppString(fixture.timeZone)};`);
  }
  for (const resource of fixture.resources) {
    lines.push(
      `  environment.baselineResources[${cppString(resource.key)}] = ${cppString(JSON.stringify(resource))};`,
    );
    const payload =
      resource.value ??
      resource.content ??
      resource.data ??
      resource.rows ??
      resource.registers;
    if (payload !== undefined) {
      lines.push(
        `  environment.baselinePayloads[${cppString(resource.key)}] = ${cppString(typeof payload === "string" ? payload : JSON.stringify(payload))};`,
      );
    }
    if (resource.kind === "motionAxis") {
      const ads = resource.ads as number;
      const axisKey = `axis:${ads}`;
      lines.push(
        `  environment.baselineResources[${cppString(axisKey)}] = ${cppString(JSON.stringify(resource))};`,
        `  environment.baselineAxes[${ads}U] = {${Number(resource.position ?? 0)}, ${Number(resource.velocity ?? 0)}, ${Number(resource.acceleration ?? 0)}, ${Boolean(resource.enabled)}, ${Boolean(resource.error)}, ${Number(resource.errorId ?? 0)}U};`,
      );
    }
  }
  for (const fault of fixture.faults) {
    lines.push(
      `  environment.baselineFaults.push_back({${cppString(fault.target)}, ` +
        `${cppString(fault.resourceKey ?? "")}, ${fault.callNumber ?? 0}ULL, ` +
        `${fault.delayScans ?? 0}U, ${fault.errorId ?? 0xf0000005}U});`,
    );
  }
  lines.push(
    "  environment.reset();",
    "  strucpp::__CURRENT_TIME_NS = environment.monotonicNanoseconds;",
    "  strucpp::__CURRENT_DT_NS = environment.utcUnixNanoseconds;",
    "}",
    "",
  );
  return lines.join("\n");
}
