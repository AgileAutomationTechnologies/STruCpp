// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2025 Autonomy / OpenPLC Project
/**
 * Library configuration file (`library.json`).
 *
 * Each library on disk lives in `libs/sources/<lib-name>/` and ships a
 * `library.json` next to its `.st` source files. The JSON carries every
 * field of the .stlib manifest that ISN'T derivable from the ST sources:
 *
 *   - identity (name, version, namespace)
 *   - human-readable description
 *   - the `isBuiltin` flag
 *   - block-level documentation prose (one entry per FUNCTION_BLOCK)
 *   - function-level documentation prose (one entry per FUNCTION)
 *
 * The build flow is:
 *
 *   1. Read library.json from the library's source directory
 *      (loadLibraryConfig).
 *   2. Read all .st files alongside it.
 *   3. Call compileStlib(sources, options-from-config).
 *   4. Merge per-block / per-function documentation into the resulting
 *      manifest entries (applyLibraryConfigDocumentation), validating
 *      that every doc'd name actually appears in the compiled output.
 *
 * library.json is the single source of truth for library metadata.
 * Build scripts may still hardcode defaults for libraries that haven't
 * been migrated yet — loadLibraryConfig returns null when the file is
 * absent, and the caller falls back to its own constants.
 */

import type { StlibArchive } from "./library-manifest.js";
import {
  isValidLibraryFBVariableName,
  listLibraryFBVariables,
  validateLibraryFBVariableAliases,
} from "./variable-aliases.js";

export interface LibraryBlockConfig {
  documentation: string;
  /** Canonical public variable name -> accepted source-level aliases. */
  variableAliases?: Record<string, string[]>;
  /**
   * Optional bistable behavior published to semantic-runtime consumers.
   * This is descriptive contract metadata only; the block's ST source remains
   * the executable definition of its behavior.
   */
  dominance?: "set" | "reset";
}

/**
 * Parsed shape of a `library.json` file.
 *
 * Required fields mirror the corresponding `.stlib` manifest fields so a
 * library with no .st sources at all (purely-imported lib, e.g. OSCAT)
 * could in theory ship just a `library.json` + `.stlib` archive.
 *
 * `blocks` and `functions` are name-keyed maps so the JSON file reads
 * naturally — one block per top-level entry — and the build script can
 * cross-check each name against the compiled manifest's `functionBlocks[]`
 * / `functions[]`.
 */
export interface LibraryConfig {
  /** Library identity. Must match what the consumer references. */
  name: string;
  /** Optional human-readable name for tooling display (editor library
   *  trees, package manager UIs). Falls back to `name` when unset. */
  displayName?: string;
  /** SemVer-like version string. */
  version: string;
  /** C++ namespace the compiled archive lives in. */
  namespace: string;
  /** Human-readable summary surfaced in tooling. */
  description?: string;
  /** Marks the library as a built-in runtime library (vs. user-installed). */
  isBuiltin?: boolean;
  /** Runtime services that consumers must provide for executable behavior. */
  runtimeCapabilities?: string[];
  /** Compile-time integer constants the library's ST sources reference
   *  (e.g. OSCAT's STRING_LENGTH and LIST_LENGTH). Forwarded to
   *  compileStlib's `globalConstants` option. */
  globalConstants?: Record<string, number>;
  /** Path (relative to the library's source directory) to a CODESYS
   *  binary library file (.lib for V2.3, .library for V3) that the build
   *  script should run through the codesys-importer instead of compiling
   *  hand-authored .st files. When set, the lib's source directory should
   *  not contain .st files — the importer produces them at build time. */
  codesysSource?: string;
  /** Block-level documentation, keyed by FB name. */
  blocks?: Record<string, LibraryBlockConfig>;
  /** Function-level documentation, keyed by function name. */
  functions?: Record<string, { documentation: string }>;
}

/**
 * Parse a `library.json` payload that the caller has already
 * obtained from somewhere (disk, HTTP fetch, IPC, …).  `sourceLabel`
 * rides on diagnostics so a malformed config still points at a
 * meaningful location.
 *
 * Throws on parse errors and on schema violations so build failures
 * are loud and pinpoint the misconfigured input.
 */
export function loadLibraryConfigFromString(
  json: string,
  sourceLabel: string,
): LibraryConfig {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`${sourceLabel}: invalid JSON — ${msg}`);
  }
  return validateLibraryConfig(raw, sourceLabel);
}

function validateLibraryConfig(raw: unknown, path: string): LibraryConfig {
  if (typeof raw !== "object" || raw === null) {
    throw new Error(`${path}: top-level value must be an object`);
  }
  const obj = raw as Record<string, unknown>;
  for (const required of ["name", "version", "namespace"]) {
    if (typeof obj[required] !== "string" || obj[required] === "") {
      throw new Error(`${path}: missing or non-string field "${required}"`);
    }
  }

  const config: LibraryConfig = {
    name: obj.name as string,
    version: obj.version as string,
    namespace: obj.namespace as string,
  };
  if (typeof obj.displayName === "string") config.displayName = obj.displayName;
  if (typeof obj.description === "string") config.description = obj.description;
  if (typeof obj.isBuiltin === "boolean") config.isBuiltin = obj.isBuiltin;
  if (obj.runtimeCapabilities !== undefined) {
    if (
      !Array.isArray(obj.runtimeCapabilities) ||
      obj.runtimeCapabilities.some((value) => typeof value !== "string")
    ) {
      throw new Error(
        `${path}: "runtimeCapabilities" must be an array of strings`,
      );
    }
    config.runtimeCapabilities = [...(obj.runtimeCapabilities as string[])];
  }
  if (typeof obj.codesysSource === "string")
    config.codesysSource = obj.codesysSource;

  if (obj.globalConstants !== undefined) {
    config.globalConstants = validateGlobalConstants(obj.globalConstants, path);
  }
  if (obj.blocks !== undefined) {
    config.blocks = validateBlockMap(obj.blocks, path);
  }
  if (obj.functions !== undefined) {
    config.functions = validateDocMap(obj.functions, "functions", path);
  }
  return config;
}

function validateBlockMap(
  value: unknown,
  path: string,
): Record<string, LibraryBlockConfig> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${path}: "blocks" must be an object map`);
  }
  const out: Record<string, LibraryBlockConfig> = {};
  for (const [name, entry] of Object.entries(
    value as Record<string, unknown>,
  )) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      throw new Error(
        `${path}: blocks["${name}"] must be an object with a "documentation" field`,
      );
    }
    const entryObj = entry as Record<string, unknown>;
    if (typeof entryObj.documentation !== "string") {
      throw new Error(
        `${path}: blocks["${name}"].documentation must be a string`,
      );
    }
    const block: LibraryBlockConfig = {
      documentation: entryObj.documentation,
    };
    if (entryObj.dominance !== undefined) {
      if (entryObj.dominance !== "set" && entryObj.dominance !== "reset") {
        throw new Error(
          `${path}: blocks["${name}"].dominance must be "set" or "reset"`,
        );
      }
      block.dominance = entryObj.dominance;
    }
    if (entryObj.variableAliases !== undefined) {
      if (
        typeof entryObj.variableAliases !== "object" ||
        entryObj.variableAliases === null ||
        Array.isArray(entryObj.variableAliases)
      ) {
        throw new Error(
          `${path}: blocks["${name}"].variableAliases must be an object map`,
        );
      }
      const aliases: Record<string, string[]> = {};
      const canonicalKeys = new Map<string, string>();
      for (const [canonical, rawAliases] of Object.entries(
        entryObj.variableAliases as Record<string, unknown>,
      )) {
        const previousCanonical = canonicalKeys.get(canonical.toUpperCase());
        if (previousCanonical !== undefined) {
          throw new Error(
            `${path}: blocks["${name}"].variableAliases keys "${previousCanonical}" and "${canonical}" collide case-insensitively`,
          );
        }
        canonicalKeys.set(canonical.toUpperCase(), canonical);
        if (
          !Array.isArray(rawAliases) ||
          rawAliases.some(
            (alias) =>
              typeof alias !== "string" || !isValidLibraryFBVariableName(alias),
          )
        ) {
          throw new Error(
            `${path}: blocks["${name}"].variableAliases["${canonical}"] must be an array of valid Structured Text identifiers`,
          );
        }
        aliases[canonical] = [...(rawAliases as string[])];
      }
      block.variableAliases = aliases;
    }
    out[name] = block;
  }
  return out;
}

function validateGlobalConstants(
  value: unknown,
  path: string,
): Record<string, number> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${path}: "globalConstants" must be an object map`);
  }
  const out: Record<string, number> = {};
  for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
    if (typeof v !== "number" || !Number.isFinite(v)) {
      throw new Error(
        `${path}: globalConstants["${key}"] must be a finite number`,
      );
    }
    out[key] = v;
  }
  return out;
}

function validateDocMap(
  value: unknown,
  field: string,
  path: string,
): Record<string, { documentation: string }> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${path}: "${field}" must be an object map`);
  }
  const map = value as Record<string, unknown>;
  const out: Record<string, { documentation: string }> = {};
  for (const [name, entry] of Object.entries(map)) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      throw new Error(
        `${path}: ${field}["${name}"] must be an object with a "documentation" field`,
      );
    }
    const entryObj = entry as Record<string, unknown>;
    if (typeof entryObj.documentation !== "string") {
      throw new Error(
        `${path}: ${field}["${name}"].documentation must be a string`,
      );
    }
    out[name] = { documentation: entryObj.documentation };
  }
  return out;
}

/**
 * Result of merging documentation into a compiled archive.
 * `unknownBlockDocs` / `unknownFunctionDocs` carry names that appeared
 * in `library.json` but don't exist in the compiled manifest — usually
 * a typo or a stale entry left behind when an FB was renamed. Build
 * scripts should treat this as a hard error.
 */
export interface ApplyDocumentationResult {
  /** Number of FBs that received documentation. */
  blocksDocumented: number;
  /** Number of functions that received documentation. */
  functionsDocumented: number;
  /** Block names doc'd in library.json but absent from the manifest. */
  unknownBlockDocs: string[];
  /** Function names doc'd in library.json but absent from the manifest. */
  unknownFunctionDocs: string[];
  /** Number of alternate variable spellings attached to canonical pins. */
  variableAliasesApplied: number;
  /** Configured `BLOCK.VARIABLE` identities absent from the manifest. */
  unknownBlockVariables: string[];
}

/**
 * Merge `LibraryConfig.blocks` and `.functions` documentation into the
 * compiled archive's manifest, in place. Returns a report of what was
 * applied and what was unmatched so the caller can fail the build on
 * mismatch.
 *
 * Names are matched case-sensitively — STruC++ FB / function names are
 * uppercased by the parser before they reach the manifest, so the
 * library.json keys must use the same casing the source declares.
 */
export function applyLibraryConfigDocumentation(
  archive: StlibArchive,
  config: LibraryConfig,
): ApplyDocumentationResult {
  const result: ApplyDocumentationResult = {
    blocksDocumented: 0,
    functionsDocumented: 0,
    unknownBlockDocs: [],
    unknownFunctionDocs: [],
    variableAliasesApplied: 0,
    unknownBlockVariables: [],
  };

  if (config.blocks) {
    const fbByName = new Map(
      archive.manifest.functionBlocks.map((fb) => [fb.name, fb]),
    );
    for (const [name, entry] of Object.entries(config.blocks)) {
      const fb = fbByName.get(name);
      if (!fb) {
        result.unknownBlockDocs.push(name);
        continue;
      }
      fb.documentation = entry.documentation;
      if (entry.dominance !== undefined) {
        fb.dominance = entry.dominance;
      }
      result.blocksDocumented++;
      if (entry.variableAliases) {
        const variables = listLibraryFBVariables(fb);
        for (const [canonicalName, aliases] of Object.entries(
          entry.variableAliases,
        )) {
          const variable = variables.find(
            ({ variable: candidate }) =>
              candidate.name.toUpperCase() === canonicalName.toUpperCase(),
          )?.variable;
          if (!variable) {
            result.unknownBlockVariables.push(`${name}.${canonicalName}`);
            continue;
          }
          variable.aliases = [...aliases];
          result.variableAliasesApplied += aliases.length;
        }
        const issues = validateLibraryFBVariableAliases(fb);
        if (issues.length > 0) {
          throw new Error(
            `library.json block '${name}' has invalid variable aliases: ${issues.join("; ")}`,
          );
        }
      }
    }
  }

  if (config.functions) {
    const fnByName = new Map(
      archive.manifest.functions.map((fn) => [fn.name, fn]),
    );
    for (const [name, entry] of Object.entries(config.functions)) {
      const fn = fnByName.get(name);
      if (!fn) {
        result.unknownFunctionDocs.push(name);
        continue;
      }
      fn.documentation = entry.documentation;
      result.functionsDocumented++;
    }
  }

  return result;
}
