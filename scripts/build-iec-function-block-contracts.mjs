#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2025 Autonomy / OpenPLC Project

/**
 * Emit the versioned public IEC function-block interface contract.
 *
 * The .stlib archive remains the executable source of truth. This compact,
 * deterministic sidecar lets packagers and semantic runtimes bind to the
 * exact canonical pin names, positional order, compatibility aliases, and
 * library version without parsing generated C++ or duplicating TwinCAT data.
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const projectRoot = resolve(__dirname, "..");

export const IEC_FUNCTION_BLOCK_CONTRACT_SCHEMA =
  "tcgen-iec-function-block-contracts-v1";
export const IEC_FUNCTION_BLOCK_CONTRACT_VERSION = "1.0.0";

function contractVariable(variable) {
  const result = { name: variable.name, type: variable.type };
  if (Array.isArray(variable.aliases) && variable.aliases.length > 0) {
    result.aliases = [...variable.aliases];
  }
  return result;
}

export function createIecFunctionBlockContracts(archive) {
  const manifest = archive?.manifest;
  if (!manifest || !Array.isArray(manifest.functionBlocks)) {
    throw new Error(
      "IEC function-block contract input is not a valid .stlib archive",
    );
  }

  const payload = {
    schema: IEC_FUNCTION_BLOCK_CONTRACT_SCHEMA,
    contractVersion: IEC_FUNCTION_BLOCK_CONTRACT_VERSION,
    library: {
      name: manifest.name,
      version: manifest.version,
      namespace: manifest.namespace,
    },
    functionBlocks: manifest.functionBlocks.map((fb) => {
      const contract = {
        name: fb.name,
        inputs: fb.inputs.map(contractVariable),
        outputs: fb.outputs.map(contractVariable),
        inouts: fb.inouts.map(contractVariable),
      };
      if (fb.dominance === "set" || fb.dominance === "reset") {
        contract.dominance = fb.dominance;
      }
      return contract;
    }),
  };
  const canonicalPayload = JSON.stringify(payload);
  const payloadSha256 = createHash("sha256")
    .update(canonicalPayload, "utf8")
    .digest("hex");

  return {
    ...payload,
    identity: {
      algorithm: "SHA-256",
      payloadSha256,
      payloadBytes: Buffer.byteLength(canonicalPayload, "utf8"),
    },
  };
}

export function buildIecFunctionBlockContracts(options = {}) {
  const archivePath =
    options.archivePath ??
    resolve(projectRoot, "libs", "iec-standard-fb.stlib");
  const outputPath =
    options.outputPath ??
    resolve(projectRoot, "libs", "iec-function-block-contracts.json");
  if (!existsSync(archivePath)) {
    throw new Error(`IEC standard FB archive not found: ${archivePath}`);
  }
  const archive = JSON.parse(readFileSync(archivePath, "utf8"));
  const contract = createIecFunctionBlockContracts(archive);
  writeFileSync(outputPath, `${JSON.stringify(contract, null, 2)}\n`, "utf8");
  console.log(
    `[build-iec-function-block-contracts] Wrote ${contract.functionBlocks.length} ` +
      `FB contracts to ${outputPath} (${contract.identity.payloadSha256})`,
  );
  return contract;
}

const isDirectRun =
  process.argv[1] && resolve(process.argv[1]) === resolve(__filename);
if (isDirectRun) {
  try {
    buildIecFunctionBlockContracts();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
