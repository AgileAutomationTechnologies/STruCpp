// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2025 Autonomy / OpenPLC Project

import type { LibraryFBEntry, LibraryVarType } from "./library-manifest.js";

export type LibraryFBVariableDirection = "input" | "output" | "inout";

export interface LibraryFBVariableResolution {
  canonicalName: string;
  direction: LibraryFBVariableDirection;
  isAlias: boolean;
  variable: LibraryVarType;
}

/** Match the Structured Text identifier token accepted by the lexer. */
export function isValidLibraryFBVariableName(name: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(name);
}

/** Keep declaration order intact while presenting all public FB variables. */
export function listLibraryFBVariables(fb: LibraryFBEntry): Array<{
  direction: LibraryFBVariableDirection;
  variable: LibraryVarType;
}> {
  return [
    ...fb.inputs.map((variable) => ({ direction: "input" as const, variable })),
    ...fb.outputs.map((variable) => ({
      direction: "output" as const,
      variable,
    })),
    ...fb.inouts.map((variable) => ({ direction: "inout" as const, variable })),
  ];
}

/**
 * Resolve a canonical or alternate spelling without changing positional
 * order. Identifier matching follows IEC's case-insensitive rules.
 */
export function resolveLibraryFBVariable(
  fb: LibraryFBEntry,
  sourceName: string,
): LibraryFBVariableResolution | undefined {
  const requested = sourceName.toUpperCase();
  for (const { direction, variable } of listLibraryFBVariables(fb)) {
    if (variable.name.toUpperCase() === requested) {
      return {
        canonicalName: variable.name,
        direction,
        isAlias: false,
        variable,
      };
    }
    if (
      variable.aliases?.some((alias) => alias.toUpperCase() === requested) ===
      true
    ) {
      return {
        canonicalName: variable.name,
        direction,
        isAlias: true,
        variable,
      };
    }
  }
  return undefined;
}

/**
 * Validate one FB's canonical namespace and alias namespace together.
 * Returns every issue so loaders can report deterministic, useful failures.
 */
export function validateLibraryFBVariableAliases(fb: LibraryFBEntry): string[] {
  const issues: string[] = [];
  const canonicalOwners = new Map<string, string>();
  const aliasOwners = new Map<string, string>();
  const variables = listLibraryFBVariables(fb);

  for (const { variable } of variables) {
    const canonical = variable.name.toUpperCase();
    if (!isValidLibraryFBVariableName(variable.name)) {
      issues.push(
        `canonical variable '${variable.name}' is not a valid identifier`,
      );
    }
    const previous = canonicalOwners.get(canonical);
    if (previous !== undefined) {
      issues.push(
        `canonical variable '${variable.name}' collides with '${previous}'`,
      );
    } else {
      canonicalOwners.set(canonical, variable.name);
    }
  }

  for (const { variable } of variables) {
    const canonical = variable.name.toUpperCase();
    for (const alias of variable.aliases ?? []) {
      const aliasUpper = alias.toUpperCase();
      if (!isValidLibraryFBVariableName(alias)) {
        issues.push(
          `alias '${alias}' for '${variable.name}' is not a valid identifier`,
        );
        continue;
      }
      if (aliasUpper === canonical) {
        issues.push(
          `alias '${alias}' repeats its canonical variable '${variable.name}'`,
        );
        continue;
      }

      const canonicalCollision = canonicalOwners.get(aliasUpper);
      if (canonicalCollision !== undefined) {
        issues.push(
          `alias '${alias}' for '${variable.name}' collides with canonical variable '${canonicalCollision}'`,
        );
        continue;
      }

      const aliasCollision = aliasOwners.get(aliasUpper);
      if (aliasCollision !== undefined) {
        issues.push(
          `alias '${alias}' for '${variable.name}' is already assigned to '${aliasCollision}'`,
        );
        continue;
      }
      aliasOwners.set(aliasUpper, variable.name);
    }
  }

  return issues;
}
