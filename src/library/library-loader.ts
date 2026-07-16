// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2025 Autonomy / OpenPLC Project
/**
 * STruC++ Library Loader
 *
 * Loads library manifests and registers their symbols into the symbol tables
 * for cross-library function resolution.
 */

import type {
  LibraryManifest,
  LibraryMethodEntry,
  LibraryPropertyEntry,
  LibraryVarType,
  StlibArchive,
} from "./library-manifest.js";
import type { SymbolTables, VariableSymbol } from "../semantic/symbol-table.js";
import { DuplicateSymbolError } from "../semantic/symbol-table.js";
import type {
  ElementaryType,
  EnumType,
  IECType,
  MethodDeclaration,
  PropertyDeclaration,
  StructType,
  TypeReference,
  VarDeclaration,
  VarBlock,
} from "../frontend/ast.js";
import { createDefaultSourceSpan } from "../frontend/ast.js";
import { ELEMENTARY_TYPES } from "../semantic/type-utils.js";
import {
  isValidLibraryFBVariableName,
  validateLibraryFBVariableAliases,
} from "./variable-aliases.js";

/**
 * Error thrown when a library manifest fails validation.
 */
export class LibraryManifestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LibraryManifestError";
  }
}

function loadFunctionBlockVariables(
  value: unknown,
  path: string,
): LibraryVarType[] {
  if (!Array.isArray(value)) {
    throw new LibraryManifestError(
      `Invalid library manifest: ${path} must be an array`,
    );
  }
  return value.map((raw, index) => {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      throw new LibraryManifestError(
        `Invalid library manifest: ${path}[${index}] must be an object`,
      );
    }
    const obj = raw as Record<string, unknown>;
    if (typeof obj.name !== "string" || obj.name.length === 0) {
      throw new LibraryManifestError(
        `Invalid library manifest: ${path}[${index}].name must be a non-empty string`,
      );
    }
    if (typeof obj.type !== "string" || obj.type.length === 0) {
      throw new LibraryManifestError(
        `Invalid library manifest: ${path}[${index}].type must be a non-empty string`,
      );
    }
    const variable: LibraryVarType = { name: obj.name, type: obj.type };
    if (obj.aliases !== undefined) {
      if (
        !Array.isArray(obj.aliases) ||
        obj.aliases.some(
          (alias) =>
            typeof alias !== "string" || !isValidLibraryFBVariableName(alias),
        )
      ) {
        throw new LibraryManifestError(
          `Invalid library manifest: ${path}[${index}].aliases must be an array of valid Structured Text identifiers`,
        );
      }
      variable.aliases = [...(obj.aliases as string[])];
    }
    if (obj.arrayDimensions !== undefined) {
      if (
        !Array.isArray(obj.arrayDimensions) ||
        obj.arrayDimensions.some(
          (dimension) =>
            typeof dimension !== "object" ||
            dimension === null ||
            !Number.isInteger((dimension as Record<string, unknown>).start) ||
            !Number.isInteger((dimension as Record<string, unknown>).end),
        )
      ) {
        throw new LibraryManifestError(
          `Invalid library manifest: ${path}[${index}].arrayDimensions must contain integer start/end bounds`,
        );
      }
      variable.arrayDimensions = obj.arrayDimensions as Array<{
        start: number;
        end: number;
      }>;
    }
    if (typeof obj.elementTypeName === "string") {
      variable.elementTypeName = obj.elementTypeName;
    }
    if (
      typeof obj.maxLength === "number" ||
      (typeof obj.maxLength === "string" && obj.maxLength.length > 0)
    ) {
      variable.maxLength = obj.maxLength;
    } else if (obj.maxLength !== undefined) {
      throw new LibraryManifestError(
        `Invalid library manifest: ${path}[${index}].maxLength must be a number or non-empty string`,
      );
    }
    if (obj.referenceKind !== undefined) {
      if (
        !["pointer_to", "reference_to", "ref_to"].includes(
          String(obj.referenceKind),
        )
      ) {
        throw new LibraryManifestError(
          `Invalid library manifest: ${path}[${index}].referenceKind is invalid`,
        );
      }
      variable.referenceKind = String(obj.referenceKind);
    }
    if (typeof obj.initialValue === "string") {
      variable.initialValue = obj.initialValue;
    }
    return variable;
  });
}

function loadMethods(value: unknown, path: string): LibraryMethodEntry[] {
  if (!Array.isArray(value)) {
    throw new LibraryManifestError(
      `Invalid library manifest: ${path} must be an array`,
    );
  }
  return value.map((raw, index) => {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      throw new LibraryManifestError(
        `Invalid library manifest: ${path}[${index}] must be an object`,
      );
    }
    const obj = raw as Record<string, unknown>;
    if (typeof obj.name !== "string" || obj.name.length === 0) {
      throw new LibraryManifestError(
        `Invalid library manifest: ${path}[${index}].name must be a non-empty string`,
      );
    }
    const visibility = obj.visibility;
    if (!["PUBLIC", "PRIVATE", "PROTECTED"].includes(String(visibility))) {
      throw new LibraryManifestError(
        `Invalid library manifest: ${path}[${index}].visibility is invalid`,
      );
    }
    const parameters = loadFunctionBlockVariables(
      obj.parameters,
      `${path}[${index}].parameters`,
    ).map((parameter, parameterIndex) => {
      const rawParameter = (obj.parameters as unknown[])[
        parameterIndex
      ] as Record<string, unknown>;
      if (
        !["input", "output", "inout"].includes(String(rawParameter.direction))
      ) {
        throw new LibraryManifestError(
          `Invalid library manifest: ${path}[${index}].parameters[${parameterIndex}].direction is invalid`,
        );
      }
      return {
        ...parameter,
        direction: rawParameter.direction as "input" | "output" | "inout",
      };
    });
    return {
      name: obj.name,
      ...(typeof obj.returnType === "string"
        ? { returnType: obj.returnType }
        : {}),
      parameters,
      visibility: visibility as LibraryMethodEntry["visibility"],
      isAbstract: Boolean(obj.isAbstract),
      isFinal: Boolean(obj.isFinal),
      isOverride: Boolean(obj.isOverride),
    };
  });
}

function loadProperties(value: unknown, path: string): LibraryPropertyEntry[] {
  if (!Array.isArray(value)) {
    throw new LibraryManifestError(
      `Invalid library manifest: ${path} must be an array`,
    );
  }
  return value.map((raw, index) => {
    const obj = raw as Record<string, unknown>;
    if (
      typeof raw !== "object" ||
      raw === null ||
      Array.isArray(raw) ||
      typeof obj.name !== "string" ||
      typeof obj.type !== "string" ||
      !["PUBLIC", "PRIVATE", "PROTECTED"].includes(String(obj.visibility)) ||
      typeof obj.readable !== "boolean" ||
      typeof obj.writable !== "boolean"
    ) {
      throw new LibraryManifestError(
        `Invalid library manifest: ${path}[${index}] is not a valid property`,
      );
    }
    return {
      name: obj.name,
      type: obj.type,
      visibility: obj.visibility as LibraryPropertyEntry["visibility"],
      readable: obj.readable,
      writable: obj.writable,
    };
  });
}

/** Build a TypeReference AST node from a manifest variable entry. The
 *  reference preserves the metadata downstream consumers (codegen,
 *  debug-table-gen) need to recurse into nested types. */
function makeTypeRef(v: LibraryVarType): TypeReference {
  const ref: TypeReference = {
    kind: "TypeReference",
    sourceSpan: createDefaultSourceSpan(),
    name: v.type,
    isReference:
      v.referenceKind === "pointer_to" ||
      v.referenceKind === "reference_to" ||
      v.referenceKind === "ref_to",
    referenceKind:
      v.referenceKind === "pointer_to"
        ? "pointer_to"
        : v.referenceKind === "reference_to"
          ? "reference_to"
          : v.referenceKind === "ref_to"
            ? "ref_to"
            : "none",
  };
  if (v.arrayDimensions) ref.arrayDimensions = v.arrayDimensions;
  if (v.elementTypeName) ref.elementTypeName = v.elementTypeName;
  if (v.maxLength !== undefined) ref.maxLength = v.maxLength;
  return ref;
}

/** Create a VariableSymbol from a library variable entry. The synthesized
 *  VarDeclaration carries the real TypeReference so AST-walking consumers
 *  (debug-table-gen) can recurse uniformly across user-defined and
 *  library-defined function blocks. */
function makeVarSymbol(
  v: LibraryVarType,
  direction: "input" | "output" | "inout",
): VariableSymbol {
  const varType: ElementaryType = ELEMENTARY_TYPES[v.type.toUpperCase()] ?? {
    typeKind: "elementary",
    name: v.type,
    sizeBits: 0,
  };
  const declaration: VarDeclaration = {
    kind: "VarDeclaration",
    sourceSpan: createDefaultSourceSpan(),
    names: [v.name],
    type: makeTypeRef(v),
  };
  return {
    name: v.name,
    kind: "variable",
    type: varType,
    declaration,
    isInput: direction === "input",
    isOutput: direction === "output",
    isInOut: direction === "inout",
    isExternal: false,
    isGlobal: false,
    isRetain: false,
    ...(v.aliases ? { aliases: [...v.aliases] } : {}),
    ...(v.initialValue !== undefined ? { initialValue: v.initialValue } : {}),
  };
}

function makeVarBlock(
  blockType: "VAR_INPUT" | "VAR_OUTPUT" | "VAR_IN_OUT",
  variables: LibraryVarType[],
): VarBlock {
  return {
    kind: "VarBlock",
    sourceSpan: createDefaultSourceSpan(),
    blockType,
    isConstant: false,
    isRetain: false,
    declarations: variables.map((variable) => ({
      kind: "VarDeclaration",
      sourceSpan: createDefaultSourceSpan(),
      names: [variable.name],
      type: makeTypeRef(variable),
    })),
  };
}

function makeMethodDeclaration(method: LibraryMethodEntry): MethodDeclaration {
  const groups = [
    {
      blockType: "VAR_INPUT" as const,
      variables: method.parameters.filter((p) => p.direction === "input"),
    },
    {
      blockType: "VAR_OUTPUT" as const,
      variables: method.parameters.filter((p) => p.direction === "output"),
    },
    {
      blockType: "VAR_IN_OUT" as const,
      variables: method.parameters.filter((p) => p.direction === "inout"),
    },
  ];
  return {
    kind: "MethodDeclaration",
    sourceSpan: createDefaultSourceSpan(),
    name: method.name,
    visibility: method.visibility,
    isAbstract: method.isAbstract,
    isFinal: method.isFinal,
    isOverride: method.isOverride,
    ...(method.returnType
      ? {
          returnType: {
            kind: "TypeReference" as const,
            sourceSpan: createDefaultSourceSpan(),
            name: method.returnType,
            isReference: false,
            referenceKind: "none" as const,
          },
        }
      : {}),
    varBlocks: groups
      .filter((group) => group.variables.length > 0)
      .map((group) => makeVarBlock(group.blockType, group.variables)),
    body: [],
  };
}

function makePropertyDeclaration(
  property: LibraryPropertyEntry,
): PropertyDeclaration {
  return {
    kind: "PropertyDeclaration",
    sourceSpan: createDefaultSourceSpan(),
    name: property.name,
    type: {
      kind: "TypeReference",
      sourceSpan: createDefaultSourceSpan(),
      name: property.type,
      isReference: false,
      referenceKind: "none",
    },
    visibility: property.visibility,
    ...(property.readable ? { getter: [] } : {}),
    ...(property.writable ? { setter: [] } : {}),
  };
}

/**
 * Load a library manifest from a JSON object.
 * Validates required fields and structure.
 * (In production, this would read from a .stlib.json file on disk.)
 *
 * @throws {LibraryManifestError} if required fields are missing or invalid
 */
export function loadLibraryManifest(json: unknown): LibraryManifest {
  if (json === null || json === undefined || typeof json !== "object") {
    throw new LibraryManifestError(
      "Invalid library manifest: expected a JSON object",
    );
  }

  const obj = json as Record<string, unknown>;

  // Validate required top-level fields
  const name = obj.name;
  if (typeof name !== "string" || name.length === 0) {
    throw new LibraryManifestError(
      "Invalid library manifest: 'name' must be a non-empty string",
    );
  }
  const version = obj.version;
  if (typeof version !== "string" || version.length === 0) {
    throw new LibraryManifestError(
      "Invalid library manifest: 'version' must be a non-empty string",
    );
  }
  const namespace = obj.namespace;
  if (typeof namespace !== "string" || namespace.length === 0) {
    throw new LibraryManifestError(
      "Invalid library manifest: 'namespace' must be a non-empty string",
    );
  }

  // Validate functions array
  const functions: LibraryManifest["functions"] = [];
  if (Array.isArray(obj.functions)) {
    for (let i = 0; i < obj.functions.length; i++) {
      const fn = obj.functions[i] as Record<string, unknown>;
      if (typeof fn.name !== "string" || fn.name.length === 0) {
        throw new LibraryManifestError(
          `Invalid library manifest: functions[${i}].name must be a non-empty string`,
        );
      }
      if (typeof fn.returnType !== "string" || fn.returnType.length === 0) {
        throw new LibraryManifestError(
          `Invalid library manifest: functions[${i}].returnType must be a non-empty string`,
        );
      }
      if (!Array.isArray(fn.parameters)) {
        throw new LibraryManifestError(
          `Invalid library manifest: functions[${i}].parameters must be an array`,
        );
      }
      const rawParameters = fn.parameters as unknown[];
      functions.push({
        ...(fn as unknown as LibraryManifest["functions"][0]),
        parameters: loadFunctionBlockVariables(
          rawParameters,
          `functions[${i}].parameters`,
        ).map((parameter, parameterIndex) => {
          const rawParameter = rawParameters[parameterIndex] as Record<
            string,
            unknown
          >;
          if (
            !["input", "output", "inout"].includes(
              String(rawParameter.direction),
            )
          ) {
            throw new LibraryManifestError(
              `Invalid library manifest: functions[${i}].parameters[${parameterIndex}].direction is invalid`,
            );
          }
          return {
            ...parameter,
            direction: rawParameter.direction as "input" | "output" | "inout",
          };
        }),
      });
    }
  }

  // Validate function blocks array
  const functionBlocks: LibraryManifest["functionBlocks"] = [];
  if (Array.isArray(obj.functionBlocks)) {
    for (let i = 0; i < obj.functionBlocks.length; i++) {
      const fb = obj.functionBlocks[i] as Record<string, unknown>;
      if (typeof fb.name !== "string" || fb.name.length === 0) {
        throw new LibraryManifestError(
          `Invalid library manifest: functionBlocks[${i}].name must be a non-empty string`,
        );
      }
      const entry: LibraryManifest["functionBlocks"][0] = {
        name: fb.name,
        inputs: loadFunctionBlockVariables(
          fb.inputs,
          `functionBlocks[${i}].inputs`,
        ),
        outputs: loadFunctionBlockVariables(
          fb.outputs,
          `functionBlocks[${i}].outputs`,
        ),
        inouts: loadFunctionBlockVariables(
          fb.inouts,
          `functionBlocks[${i}].inouts`,
        ),
        methods:
          fb.methods === undefined
            ? []
            : loadMethods(fb.methods, `functionBlocks[${i}].methods`),
        properties:
          fb.properties === undefined
            ? []
            : loadProperties(fb.properties, `functionBlocks[${i}].properties`),
        isAbstract: Boolean(fb.isAbstract),
        isFinal: Boolean(fb.isFinal),
      };
      if (typeof fb.extends === "string") entry.extends = fb.extends;
      if (Array.isArray(fb.implements)) {
        entry.implements = fb.implements.map(String);
      }
      if (typeof fb.documentation === "string") {
        entry.documentation = fb.documentation;
      }
      if (fb.dominance !== undefined) {
        if (fb.dominance !== "set" && fb.dominance !== "reset") {
          throw new LibraryManifestError(
            `Invalid library manifest: functionBlocks[${i}].dominance must be "set" or "reset"`,
          );
        }
        entry.dominance = fb.dominance;
      }
      if (typeof fb.category === "string") entry.category = fb.category;
      const aliasIssues = validateLibraryFBVariableAliases(entry);
      if (aliasIssues.length > 0) {
        throw new LibraryManifestError(
          `Invalid library manifest: functionBlocks[${i}] '${entry.name}' has invalid variable aliases: ${aliasIssues.join("; ")}`,
        );
      }
      functionBlocks.push(entry);
    }
  }

  const interfaces: LibraryManifest["interfaces"] = [];
  if (Array.isArray(obj.interfaces)) {
    for (let i = 0; i < obj.interfaces.length; i++) {
      const iface = obj.interfaces[i] as Record<string, unknown>;
      if (typeof iface.name !== "string" || iface.name.length === 0) {
        throw new LibraryManifestError(
          `Invalid library manifest: interfaces[${i}].name must be a non-empty string`,
        );
      }
      interfaces.push({
        name: iface.name,
        ...(Array.isArray(iface.extends)
          ? { extends: iface.extends.map(String) }
          : {}),
        methods:
          iface.methods === undefined
            ? []
            : loadMethods(iface.methods, `interfaces[${i}].methods`),
        ...(typeof iface.documentation === "string"
          ? { documentation: iface.documentation }
          : {}),
        ...(typeof iface.category === "string"
          ? { category: iface.category }
          : {}),
      });
    }
  }

  // Validate types array
  const types: LibraryManifest["types"] = [];
  if (Array.isArray(obj.types)) {
    for (let i = 0; i < obj.types.length; i++) {
      const t = obj.types[i] as Record<string, unknown>;
      if (typeof t.name !== "string" || t.name.length === 0) {
        throw new LibraryManifestError(
          `Invalid library manifest: types[${i}].name must be a non-empty string`,
        );
      }
      if (
        typeof t.kind !== "string" ||
        !["struct", "enum", "alias"].includes(t.kind)
      ) {
        throw new LibraryManifestError(
          `Invalid library manifest: types[${i}].kind must be "struct", "enum", or "alias"`,
        );
      }
      const entry: LibraryManifest["types"][0] = {
        name: t.name,
        kind: t.kind as LibraryManifest["types"][0]["kind"],
      };
      if (t.fields !== undefined) {
        entry.fields = loadFunctionBlockVariables(
          t.fields,
          `types[${i}].fields`,
        );
      }
      if (Array.isArray(t.enumMembers)) {
        entry.enumMembers = t.enumMembers.map((rawMember, memberIndex) => {
          const member = rawMember as Record<string, unknown>;
          if (typeof member?.name !== "string") {
            throw new LibraryManifestError(
              `Invalid library manifest: types[${i}].enumMembers[${memberIndex}].name must be a string`,
            );
          }
          return {
            name: member.name,
            ...(typeof member.value === "string"
              ? { value: member.value }
              : {}),
          };
        });
      }
      if (typeof t.baseType === "string") entry.baseType = t.baseType;
      if (Array.isArray(t.arrayDimensions)) {
        entry.arrayDimensions = t.arrayDimensions as Array<{
          start: number;
          end: number;
        }>;
      }
      if (typeof t.elementTypeName === "string")
        entry.elementTypeName = t.elementTypeName;
      if (
        typeof t.maxLength === "number" ||
        (typeof t.maxLength === "string" && t.maxLength.length > 0)
      ) {
        entry.maxLength = t.maxLength;
      }
      if (typeof t.referenceKind === "string")
        entry.referenceKind = t.referenceKind;
      if (typeof t.documentation === "string")
        entry.documentation = t.documentation;
      if (typeof t.category === "string") entry.category = t.category;
      types.push(entry);
    }
  }

  // Exported global variables (optional — archives compiled before globals
  // were exported simply omit the field).
  const globals: NonNullable<LibraryManifest["globals"]> = [];
  if (Array.isArray(obj.globals)) {
    for (let i = 0; i < obj.globals.length; i++) {
      const g = obj.globals[i] as Record<string, unknown>;
      if (typeof g.name !== "string" || g.name.length === 0) {
        throw new LibraryManifestError(
          `Invalid library manifest: globals[${i}].name must be a non-empty string`,
        );
      }
      if (typeof g.type !== "string" || g.type.length === 0) {
        throw new LibraryManifestError(
          `Invalid library manifest: globals[${i}].type must be a non-empty string`,
        );
      }
      globals.push(g as unknown as NonNullable<LibraryManifest["globals"]>[0]);
    }
  }

  const result: LibraryManifest = {
    name,
    version,
    namespace,
    functions,
    functionBlocks,
    interfaces,
    types,
    headers: Array.isArray(obj.headers) ? (obj.headers as string[]) : [],
    isBuiltin: Boolean(obj.isBuiltin),
  };

  if (Array.isArray(obj.globals)) {
    result.globals = globals;
  }
  if (obj.description !== undefined) {
    result.description = String(obj.description);
  }
  if (typeof obj.displayName === "string") result.displayName = obj.displayName;
  if (Array.isArray(obj.runtimeCapabilities)) {
    if (obj.runtimeCapabilities.some((item) => typeof item !== "string")) {
      throw new LibraryManifestError(
        "Invalid library manifest: runtimeCapabilities must contain strings",
      );
    }
    result.runtimeCapabilities = [...(obj.runtimeCapabilities as string[])];
  }
  if (Array.isArray(obj.sourceFiles)) {
    result.sourceFiles = obj.sourceFiles as string[];
  }

  return result;
}

/**
 * Register a library's symbols into the compiler's symbol tables.
 * This makes library functions, FBs, and types available for semantic analysis.
 */
export function registerLibrarySymbols(
  manifest: LibraryManifest,
  symbolTables: SymbolTables,
): void {
  // Make archive-local types visible before callable return/parameter types are
  // reconstructed. This is significant for functions returning an enum,
  // struct, alias, or interface declared in the same archive.
  for (const t of manifest.types) {
    if (symbolTables.lookupType(t.name)) continue;
    const resolvedType: IECType =
      t.kind === "struct" && t.fields
        ? ({
            typeKind: "struct",
            name: t.name,
            fields: new Map<string, IECType>(
              t.fields.map((field) => [
                field.name,
                ELEMENTARY_TYPES[field.type.toUpperCase()] ??
                  ({
                    typeKind: "elementary",
                    name: field.type,
                    sizeBits: 0,
                  } as ElementaryType),
              ]),
            ),
          } as StructType)
        : t.kind === "enum"
          ? ({
              typeKind: "enum",
              name: t.name,
              values: (t.enumMembers ?? []).map((member) => member.name),
            } as EnumType)
          : (ELEMENTARY_TYPES[(t.baseType ?? t.name).toUpperCase()] ??
            ({
              typeKind: "elementary",
              name: t.name,
              sizeBits: 0,
            } as ElementaryType));
    symbolTables.globalScope.define({
      name: t.name,
      kind: "type",
      declaration: {
        kind: "TypeDeclaration",
        sourceSpan: createDefaultSourceSpan(),
        name: t.name,
        definition: {
          kind: "TypeReference",
          sourceSpan: createDefaultSourceSpan(),
          name: t.baseType ?? t.name,
          isReference: false,
          referenceKind: "none",
        },
      },
      resolvedType,
    });
  }
  for (const iface of manifest.interfaces ?? []) {
    if (symbolTables.lookupType(iface.name)) continue;
    symbolTables.globalScope.define({
      name: iface.name,
      kind: "type",
      declaration: {
        kind: "TypeDeclaration",
        sourceSpan: createDefaultSourceSpan(),
        name: iface.name,
        definition: {
          kind: "TypeReference",
          sourceSpan: createDefaultSourceSpan(),
          name: iface.name,
          isReference: false,
          referenceKind: "none",
        },
      },
      resolvedType: {
        typeKind: "elementary",
        name: iface.name,
        sizeBits: 0,
      } as ElementaryType,
    });
  }
  // Register functions
  for (const fn of manifest.functions) {
    const registeredReturnType = symbolTables.globalScope.lookup(fn.returnType);
    const returnType: IECType =
      registeredReturnType?.kind === "type"
        ? registeredReturnType.resolvedType
        : (ELEMENTARY_TYPES[fn.returnType.toUpperCase()] ??
          ({
            typeKind: "elementary",
            name: fn.returnType,
            sizeBits: 0,
          } as ElementaryType));

    try {
      symbolTables.globalScope.define({
        name: fn.name,
        kind: "function",
        declaration: {
          kind: "FunctionDeclaration",
          sourceSpan: createDefaultSourceSpan(),
          name: fn.name,
          returnType: {
            kind: "TypeReference",
            sourceSpan: createDefaultSourceSpan(),
            name: fn.returnType,
            isReference: false,
            referenceKind: "none",
          },
          varBlocks: [],
          body: [],
        },
        returnType,
        parameters: fn.parameters.map((p) => {
          const sym = makeVarSymbol(p, p.direction);
          // Carry the optional-input marker: a parameter with an initial value
          // is optional at the call site (see Option A in the analyzer).
          if (p.initialValue !== undefined) sym.initialValue = p.initialValue;
          return sym;
        }),
      });
    } catch (e) {
      // Skip duplicate symbol errors (first definition wins), re-throw others
      if (!(e instanceof DuplicateSymbolError)) throw e;
    }
  }

  // Register types
  for (const t of manifest.types) {
    // For a struct with exported fields, register a real StructType carrying its
    // member types, so member access on a dependency struct (e.g. `MATH.PI`)
    // resolves to the field's type rather than staying untyped.
    const resolvedType: IECType =
      t.kind === "struct" && t.fields
        ? ({
            typeKind: "struct",
            name: t.name,
            fields: new Map<string, IECType>(
              t.fields.map((f) => [
                f.name,
                ELEMENTARY_TYPES[f.type.toUpperCase()] ??
                  ({
                    typeKind: "elementary",
                    name: f.type,
                    sizeBits: 0,
                  } as ElementaryType),
              ]),
            ),
          } as StructType)
        : t.kind === "enum"
          ? ({
              typeKind: "enum",
              name: t.name,
              values: (t.enumMembers ?? []).map((member) => member.name),
            } as EnumType)
          : (ELEMENTARY_TYPES[t.name.toUpperCase()] ??
            ({
              typeKind: "elementary",
              name: t.name,
              sizeBits: 0,
            } as ElementaryType));

    try {
      symbolTables.globalScope.define({
        name: t.name,
        kind: "type",
        declaration: {
          kind: "TypeDeclaration",
          sourceSpan: createDefaultSourceSpan(),
          name: t.name,
          definition: {
            kind: "TypeReference",
            sourceSpan: createDefaultSourceSpan(),
            name: t.baseType ?? t.name,
            isReference: false,
            referenceKind: "none",
          },
        },
        resolvedType,
      });
    } catch (e) {
      if (!(e instanceof DuplicateSymbolError)) throw e;
    }
    if (t.kind === "enum") {
      for (let index = 0; index < (t.enumMembers ?? []).length; index++) {
        const member = t.enumMembers![index]!;
        const explicit =
          member.value === undefined ? NaN : Number(member.value);
        try {
          symbolTables.globalScope.define({
            name: member.name,
            kind: "enumValue",
            enumType: t.name,
            value: Number.isFinite(explicit) ? explicit : index,
          });
        } catch (e) {
          if (!(e instanceof DuplicateSymbolError)) throw e;
        }
      }
    }
  }

  // Interfaces are nominal dependency types. Their methods are also carried
  // by the manifest/codegen registry for calls and IMPLEMENTS validation.
  for (const iface of manifest.interfaces ?? []) {
    const inheritedMethods = new Map<
      string,
      { returnType?: string; parameters: VariableSymbol[] }
    >();
    for (const parentName of iface.extends ?? []) {
      for (const [
        methodName,
        signature,
      ] of symbolTables.interfaceMethodSignatures.get(
        parentName.toUpperCase(),
      ) ?? []) {
        inheritedMethods.set(methodName, signature);
      }
    }
    for (const method of iface.methods) {
      inheritedMethods.set(method.name.toUpperCase(), {
        ...(method.returnType ? { returnType: method.returnType } : {}),
        parameters: method.parameters.map((parameter) =>
          makeVarSymbol(parameter, parameter.direction),
        ),
      });
    }
    symbolTables.interfaceMethodSignatures.set(
      iface.name.toUpperCase(),
      inheritedMethods,
    );
    try {
      symbolTables.globalScope.define({
        name: iface.name,
        kind: "type",
        declaration: {
          kind: "TypeDeclaration",
          sourceSpan: createDefaultSourceSpan(),
          name: iface.name,
          definition: {
            kind: "TypeReference",
            sourceSpan: createDefaultSourceSpan(),
            name: iface.name,
            isReference: false,
            referenceKind: "none",
          },
        },
        resolvedType: {
          typeKind: "elementary",
          name: iface.name,
          sizeBits: 0,
        } as ElementaryType,
      });
    } catch (e) {
      if (!(e instanceof DuplicateSymbolError)) throw e;
    }
  }

  // Register function blocks. The library only ships its public interface
  // (inputs/outputs/inouts) — locals are implementation details and stay
  // inside the compiled archive. The debugger treats library FBs as
  // black boxes for the same reason: only the user-facing API is exposed.
  for (const fb of manifest.functionBlocks) {
    const parent = fb.extends
      ? symbolTables.lookupFunctionBlock(fb.extends)
      : undefined;
    const mergeVariables = (
      inherited: VariableSymbol[] | undefined,
      own: LibraryVarType[],
      direction: "input" | "output" | "inout",
    ): VariableSymbol[] => {
      const result = [...(inherited ?? [])];
      const names = new Set(
        result.map((variable) => variable.name.toUpperCase()),
      );
      for (const variable of own) {
        const symbol = makeVarSymbol(variable, direction);
        const key = symbol.name.toUpperCase();
        const existing = result.findIndex(
          (candidate) => candidate.name.toUpperCase() === key,
        );
        if (existing >= 0) result[existing] = symbol;
        else result.push(symbol);
        names.add(key);
      }
      return result;
    };
    const inputs = mergeVariables(parent?.inputs, fb.inputs, "input");
    const outputs = mergeVariables(parent?.outputs, fb.outputs, "output");
    const inouts = mergeVariables(parent?.inouts, fb.inouts, "inout");
    const propertyLocals = (fb.properties ?? []).map((property) =>
      makeVarSymbol({ name: property.name, type: property.type }, "output"),
    );
    const locals = mergeVariables(
      parent?.locals,
      propertyLocals.map((property) => ({
        name: property.name,
        type: property.declaration.type.name,
      })),
      "output",
    );
    const methodSignatures = new Map(parent?.methodSignatures ?? []);
    for (const interfaceName of fb.implements ?? []) {
      for (const [
        methodName,
        signature,
      ] of symbolTables.interfaceMethodSignatures.get(
        interfaceName.toUpperCase(),
      ) ?? []) {
        if (!methodSignatures.has(methodName)) {
          methodSignatures.set(methodName, signature);
        }
      }
    }
    for (const method of fb.methods ?? []) {
      methodSignatures.set(method.name.toUpperCase(), {
        ...(method.returnType ? { returnType: method.returnType } : {}),
        parameters: method.parameters.map((parameter) =>
          makeVarSymbol(parameter, parameter.direction),
        ),
      });
    }
    const inheritedMethodDeclarations = new Map(
      (parent?.declaration.methods ?? []).map((method) => [
        method.name.toUpperCase(),
        method,
      ]),
    );
    for (const interfaceName of fb.implements ?? []) {
      const iface = (manifest.interfaces ?? []).find(
        (candidate) =>
          candidate.name.toUpperCase() === interfaceName.toUpperCase(),
      );
      for (const method of iface?.methods ?? []) {
        if (!inheritedMethodDeclarations.has(method.name.toUpperCase())) {
          inheritedMethodDeclarations.set(
            method.name.toUpperCase(),
            makeMethodDeclaration(method),
          );
        }
      }
    }
    for (const method of fb.methods ?? []) {
      inheritedMethodDeclarations.set(
        method.name.toUpperCase(),
        makeMethodDeclaration(method),
      );
    }
    try {
      symbolTables.globalScope.define({
        name: fb.name,
        kind: "functionBlock",
        declaration: {
          kind: "FunctionBlockDeclaration",
          sourceSpan: createDefaultSourceSpan(),
          name: fb.name,
          isAbstract: fb.isAbstract,
          isFinal: fb.isFinal,
          ...(fb.extends ? { extends: fb.extends } : {}),
          ...(fb.implements ? { implements: [...fb.implements] } : {}),
          varBlocks: [
            makeVarBlock("VAR_INPUT", fb.inputs),
            makeVarBlock("VAR_OUTPUT", fb.outputs),
            makeVarBlock("VAR_IN_OUT", fb.inouts),
          ].filter((block) => block.declarations.length > 0),
          methods: [...inheritedMethodDeclarations.values()],
          properties: (fb.properties ?? []).map(makePropertyDeclaration),
          body: [],
        },
        inputs,
        outputs,
        inouts,
        // Properties participate in member type resolution but are excluded
        // from callable FB formals; the code generator lowers them to accessors.
        locals,
        methodSignatures,
      });
    } catch (e) {
      if (!(e instanceof DuplicateSymbolError)) throw e;
    }
  }

  // Register exported global variables into the shared global scope. Because
  // every imported library registers into the SAME globalScope (and duplicates
  // are skipped, first-wins), a program importing several libraries can see all
  // of their globals together at the same place — globals are additive.
  for (const g of manifest.globals ?? []) {
    const varType: ElementaryType = ELEMENTARY_TYPES[g.type.toUpperCase()] ?? {
      typeKind: "elementary",
      name: g.type,
      sizeBits: 0,
    };
    try {
      symbolTables.globalScope.define({
        name: g.name,
        kind: "variable",
        type: varType,
        declaration: {
          kind: "VarDeclaration",
          sourceSpan: createDefaultSourceSpan(),
          names: [g.name],
          type: {
            kind: "TypeReference",
            sourceSpan: createDefaultSourceSpan(),
            name: g.type,
            isReference: false,
            referenceKind: "none",
          },
        },
        isInput: false,
        isOutput: false,
        isInOut: false,
        isExternal: false,
        isGlobal: true,
        isRetain: false,
      });
    } catch (e) {
      if (!(e instanceof DuplicateSymbolError)) throw e;
    }
  }
}

/**
 * Load a `.stlib` archive from a parsed JSON object.
 * Validates the archive structure including formatVersion, manifest, headerCode,
 * cppCode, and dependencies.
 *
 * @throws {LibraryManifestError} if required fields are missing or invalid
 */
export function loadStlibArchive(json: unknown): StlibArchive {
  if (json === null || json === undefined || typeof json !== "object") {
    throw new LibraryManifestError(
      "Invalid stlib archive: expected a JSON object",
    );
  }

  const obj = json as Record<string, unknown>;

  // Validate formatVersion
  if (obj.formatVersion !== 2) {
    throw new LibraryManifestError(
      "Invalid stlib archive: 'formatVersion' must be 2",
    );
  }

  // Validate manifest
  if (
    obj.manifest === null ||
    obj.manifest === undefined ||
    typeof obj.manifest !== "object"
  ) {
    throw new LibraryManifestError(
      "Invalid stlib archive: 'manifest' must be an object",
    );
  }
  const manifest = loadLibraryManifest(obj.manifest);

  // Validate chunks — every per-symbol slice of the library's emitted
  // C++ output, plus its dep edges. Empty array is valid (synthetic
  // libraries like iec-std-functions ship only symbol-table entries).
  if (!Array.isArray(obj.chunks)) {
    throw new LibraryManifestError(
      "Invalid stlib archive: 'chunks' must be an array",
    );
  }

  // Validate dependencies
  if (!Array.isArray(obj.dependencies)) {
    throw new LibraryManifestError(
      "Invalid stlib archive: 'dependencies' must be an array",
    );
  }

  const archive: StlibArchive = {
    formatVersion: 2,
    manifest,
    chunks: obj.chunks as StlibArchive["chunks"],
    dependencies: obj.dependencies as Array<{ name: string; version: string }>,
  };

  // Optional sources
  if (Array.isArray(obj.sources)) {
    archive.sources = obj.sources as Array<{
      fileName: string;
      source: string;
    }>;
  }

  // Optional globalConstants
  if (
    obj.globalConstants !== null &&
    obj.globalConstants !== undefined &&
    typeof obj.globalConstants === "object" &&
    !Array.isArray(obj.globalConstants)
  ) {
    const gc: Record<string, number> = {};
    for (const [key, val] of Object.entries(
      obj.globalConstants as Record<string, unknown>,
    )) {
      if (typeof val !== "number") {
        throw new LibraryManifestError(
          `Invalid stlib archive: globalConstants["${key}"] must be a number, got ${typeof val}`,
        );
      }
      gc[key] = val;
    }
    archive.globalConstants = gc;
  }

  return archive;
}

/**
 * Parse and validate an stlib archive from its raw JSON text.
 *
 * Browser-safe sibling of `loadStlibFromFile` — takes a string the
 * caller already obtained (HTTP fetch, IPC, FileReader, etc.) instead
 * of touching the filesystem.  Use this in environments without `fs`.
 *
 * @param raw - JSON text of the `.stlib` archive
 * @param sourceLabel - Optional label used in error messages
 * @returns The validated archive
 * @throws {LibraryManifestError} if the JSON is malformed or invalid
 */
export function loadStlibFromString(
  raw: string,
  sourceLabel: string = "<string>",
): StlibArchive {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (e) {
    throw new LibraryManifestError(
      `Invalid JSON in stlib archive: ${sourceLabel}: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  return loadStlibArchive(json);
}

/**
 * Parse and validate an stlib archive from raw bytes.
 *
 * Browser-safe sibling of `loadStlibFromFile` — accepts the byte
 * payload of an `.stlib` (UTF-8 encoded JSON).  Suitable for
 * `fetch(...).then(r => r.arrayBuffer())` flows and for Electron
 * preload paths that hand the renderer a `Uint8Array` over IPC.
 *
 * @param bytes - Raw UTF-8 bytes of the `.stlib` archive
 * @param sourceLabel - Optional label used in error messages
 * @returns The validated archive
 * @throws {LibraryManifestError} if the JSON is malformed or invalid
 */
export function loadStlibFromBuffer(
  bytes: Uint8Array,
  sourceLabel: string = "<buffer>",
): StlibArchive {
  // TextDecoder is available in modern Node (≥11) and every browser /
  // worker context we care about.  Avoids pulling in `Buffer` so the
  // browser bundler doesn't have to polyfill it.
  const raw = new TextDecoder("utf-8").decode(bytes);
  return loadStlibFromString(raw, sourceLabel);
}

// File-shaped wrappers (`loadStlibFromFile`, `discoverStlibs`,
// `loadLibraryFromFile`, `discoverLibraries`) live in
// `src/node/library-loader.ts`.  Browser / worker consumers fetch
// bytes themselves and call the pure `loadStlibFromString` /
// `loadStlibFromBuffer` / `loadStlibArchive` / `loadLibraryManifest`
// helpers above.
