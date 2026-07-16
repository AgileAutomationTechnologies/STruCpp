// SPDX-License-Identifier: GPL-3.0-or-later

export const BECKHOFF_VIRTUAL_RESOURCE_KINDS = [
  "adsSymbol",
  "sandboxFile",
  "motionAxis",
  "fieldbusDevice",
  "registerBank",
  "messageEndpoint",
  "transferEndpoint",
  "opcUaNode",
  "databaseTable",
  "diagnosticParameter",
] as const;

export type BeckhoffVirtualResourceKind =
  (typeof BECKHOFF_VIRTUAL_RESOURCE_KINDS)[number];

export interface BeckhoffVirtualResource {
  kind: BeckhoffVirtualResourceKind;
  key: string;
  [field: string]: unknown;
}

export interface BeckhoffVirtualFaultRule {
  target: string;
  resourceKey?: string;
  callNumber?: number;
  delayScans?: number;
  errorId?: number;
}

export interface BeckhoffVirtualFixture {
  schemaVersion: 1;
  profile: "beckhoff-virtual-v1";
  scanPeriodNanoseconds?: number;
  monotonicNanoseconds?: number;
  utcUnixNanoseconds?: number;
  timeZone?: string;
  resources: BeckhoffVirtualResource[];
  faults: BeckhoffVirtualFaultRule[];
}

function optionalSafeInteger(
  value: unknown,
  field: string,
): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(
      `virtual fixture: ${field} must be a non-negative safe integer`,
    );
  }
  return value as number;
}

export function parseBeckhoffVirtualFixture(
  input: unknown,
): BeckhoffVirtualFixture {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new Error("virtual fixture: expected an object");
  }
  const value = input as Record<string, unknown>;
  const allowedFields = new Set([
    "schemaVersion",
    "profile",
    "scanPeriodNanoseconds",
    "monotonicNanoseconds",
    "utcUnixNanoseconds",
    "timeZone",
    "resources",
    "faults",
  ]);
  for (const field of Object.keys(value)) {
    if (!allowedFields.has(field)) {
      throw new Error(`virtual fixture: unsupported field ${field}`);
    }
  }
  if (value.schemaVersion !== 1) {
    throw new Error("virtual fixture: schemaVersion must be 1");
  }
  if (value.profile !== "beckhoff-virtual-v1") {
    throw new Error('virtual fixture: profile must be "beckhoff-virtual-v1"');
  }
  if (value.resources !== undefined && !Array.isArray(value.resources)) {
    throw new Error("virtual fixture: resources must be an array");
  }
  if (value.faults !== undefined && !Array.isArray(value.faults)) {
    throw new Error("virtual fixture: faults must be an array");
  }
  const allowedKinds = new Set<string>(BECKHOFF_VIRTUAL_RESOURCE_KINDS);
  const resourceKeys = new Set<string>();
  const resources = (value.resources ?? []).map((raw, index) => {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      throw new Error(`virtual fixture: resources[${index}] must be an object`);
    }
    const resource = raw as Record<string, unknown>;
    if (typeof resource.kind !== "string" || !allowedKinds.has(resource.kind)) {
      throw new Error(
        `virtual fixture: resources[${index}].kind is unsupported`,
      );
    }
    if (typeof resource.key !== "string" || resource.key.length === 0) {
      throw new Error(
        `virtual fixture: resources[${index}].key must be non-empty`,
      );
    }
    if (resourceKeys.has(resource.key)) {
      throw new Error(
        `virtual fixture: duplicate resource key ${resource.key}`,
      );
    }
    if (resource.kind === "sandboxFile") {
      validateSandboxPath(resource.key);
    }
    if (
      resource.kind === "motionAxis" &&
      (!Number.isSafeInteger(resource.ads) || (resource.ads as number) < 0)
    ) {
      throw new Error(
        `virtual fixture: resources[${index}].ads must identify the AXIS_REF ADS value`,
      );
    }
    resourceKeys.add(resource.key);
    return { ...resource } as BeckhoffVirtualResource;
  });
  const faults = (value.faults ?? []).map((raw, index) => {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      throw new Error(`virtual fixture: faults[${index}] must be an object`);
    }
    const fault = raw as Record<string, unknown>;
    if (
      typeof fault.target !== "string" ||
      !/^[A-Za-z_]\w*\.[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)?$/.test(fault.target)
    ) {
      throw new Error(`virtual fixture: faults[${index}].target is invalid`);
    }
    if (
      fault.resourceKey !== undefined &&
      typeof fault.resourceKey !== "string"
    ) {
      throw new Error(
        `virtual fixture: faults[${index}].resourceKey must be a string`,
      );
    }
    const callNumber = optionalSafeInteger(
      fault.callNumber,
      `faults[${index}].callNumber`,
    );
    const delayScans = optionalSafeInteger(
      fault.delayScans,
      `faults[${index}].delayScans`,
    );
    const errorId = optionalSafeInteger(
      fault.errorId,
      `faults[${index}].errorId`,
    );
    return {
      target: fault.target,
      ...(fault.resourceKey !== undefined
        ? { resourceKey: fault.resourceKey }
        : {}),
      ...(callNumber !== undefined ? { callNumber } : {}),
      ...(delayScans !== undefined ? { delayScans } : {}),
      ...(errorId !== undefined ? { errorId } : {}),
    };
  });
  const scanPeriodNanoseconds = optionalSafeInteger(
    value.scanPeriodNanoseconds,
    "scanPeriodNanoseconds",
  );
  const monotonicNanoseconds = optionalSafeInteger(
    value.monotonicNanoseconds,
    "monotonicNanoseconds",
  );
  const utcUnixNanoseconds = optionalSafeInteger(
    value.utcUnixNanoseconds,
    "utcUnixNanoseconds",
  );
  if (value.timeZone !== undefined && typeof value.timeZone !== "string") {
    throw new Error("virtual fixture: timeZone must be a string");
  }
  return {
    schemaVersion: 1,
    profile: "beckhoff-virtual-v1",
    ...(scanPeriodNanoseconds !== undefined ? { scanPeriodNanoseconds } : {}),
    ...(monotonicNanoseconds !== undefined ? { monotonicNanoseconds } : {}),
    ...(utcUnixNanoseconds !== undefined ? { utcUnixNanoseconds } : {}),
    ...(typeof value.timeZone === "string" ? { timeZone: value.timeZone } : {}),
    resources,
    faults,
  };
}

function validateSandboxPath(path: string): void {
  if (/^(?:\\\\|\/\/)/.test(path)) {
    throw new Error("virtual fixture: sandbox files cannot use network shares");
  }
  const withoutDrive = path.replace(/^[A-Za-z]:[\\/]/, "");
  if (/^[\\/]/.test(withoutDrive)) {
    throw new Error(
      "virtual fixture: sandbox files cannot use absolute host paths",
    );
  }
  if (withoutDrive.split(/[\\/]+/).some((segment) => segment === "..")) {
    throw new Error(
      "virtual fixture: sandbox files cannot traverse the sandbox",
    );
  }
}
