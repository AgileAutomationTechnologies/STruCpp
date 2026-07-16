// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2025 Autonomy / OpenPLC Project
/**
 * STruC++ Library Manifest Types
 *
 * Defines the JSON manifest format for external libraries.
 * Libraries can be either built-in C++ libraries or compiled ST libraries.
 */

/**
 * Library function entry in a manifest.
 *
 * Parameter and return types are stored as bare type names (`"INT"`,
 * `"ANY_NUM"`, etc.). Generic types like `ANY_NUM` / `ANY_INT` /
 * `ANY_REAL` / `ANY_BIT` / `ANY_STRING` / `ANY_ELEMENTARY` / `ANY` are
 * IEC 61131-3 type categories — when they appear in this entry the
 * tooling must unify identically-named generics across params and
 * return type to find a concrete type at instantiation. The strucpp
 * synthetic `iec-std-functions.stlib` (built from `StdFunctionRegistry`)
 * uses these directly; library compilers for ordinary .st sources only
 * emit concrete IEC type names.
 */
export interface LibraryFunctionEntry {
  /** Function name */
  name: string;
  /** Return type name (concrete IEC type or generic — see above) */
  returnType: string;
  /** Parameter list */
  parameters: Array<
    LibraryVarType & {
      direction: "input" | "output" | "inout";
      /** Initial (default) value of the parameter, as an ST expression string
       *  (e.g. "255", "10.0", "T#100ms"). Present only for inputs declared with
       *  an initial value. Semantics: an input WITH an `initialValue` is
       *  OPTIONAL at the call site (the compiler supplies the default when the
       *  argument is omitted); an input WITHOUT one is MANDATORY (omitting it is
       *  a compile error). Captured by the library compiler from VAR_INPUT
       *  initial values in the source ST — including ST produced by the CODESYS
       *  v2/v3 importers, which preserve declarations verbatim. */
      initialValue?: string;
    }
  >;
  /** Variadic call shape. When set, `parameters` describes the leading
   *  required parameters and the function accepts any number of
   *  additional arguments matching the LAST parameter's type. `minArgs`
   *  is the minimum total argument count (typically `parameters.length`
   *  for variadic-after-required, e.g. `ADD(IN1, IN2, …)` has 2 declared
   *  params and minArgs=2). Only used by tooling to validate call sites
   *  / render extensible blocks; codegen reads it from compiler-internal
   *  metadata directly. */
  variadic?: { minArgs: number };
  /** Function-level help text shown in editor hover dialogs. Authored
   *  in the library's `library.json` and merged into the manifest at
   *  build time (see scripts/generate-*.mjs). */
  documentation?: string;
  /** Folder path within the library, slash-separated (e.g. "POUs/Time&Date").
   *  Empty/undefined means the entry lives at the root. Hierarchy is
   *  metadata-only — codegen is unaffected. The disk source layout,
   *  imported library folder structure, or any future tooling-driven
   *  organization populates this; consumers (editor library trees,
   *  decompile-to-folder extraction) read it back. */
  category?: string;
}

/**
 * Variable type reference in a library manifest.
 * Stores enough metadata for the codegen to reconstruct the full C++ type,
 * including inline array dimensions and pointer/reference qualifiers.
 */
export interface LibraryVarType {
  /** Type name */
  name: string;
  /** Type kind for the variable itself */
  type: string;
  /**
   * Alternative source-level names for this variable. Aliases never create
   * additional storage and never participate in positional argument order;
   * consumers resolve them back to `name` before semantic checks or codegen.
   */
  aliases?: string[];
  /** Array dimensions for inline array types (e.g., ARRAY[0..255] OF BYTE) */
  arrayDimensions?: Array<{ start: number; end: number }>;
  /** Element type name for inline array types */
  elementTypeName?: string;
  /** Declared STRING/WSTRING capacity, including named global constants. */
  maxLength?: number | string;
  /** Reference/pointer qualifier ("pointer_to" | "reference_to") */
  referenceKind?: string;
  /** Parameter/default initial value serialized as ST source. */
  initialValue?: string;
}

/** Public method parameter exported by a compiled library. */
export interface LibraryMethodParameter extends LibraryVarType {
  direction: "input" | "output" | "inout";
}

/** Public method metadata required by dependency semantic analysis/codegen. */
export interface LibraryMethodEntry {
  name: string;
  returnType?: string;
  parameters: LibraryMethodParameter[];
  visibility: "PUBLIC" | "PRIVATE" | "PROTECTED";
  isAbstract: boolean;
  isFinal: boolean;
  isOverride: boolean;
}

/** Public property metadata required to lower dependency property access. */
export interface LibraryPropertyEntry {
  name: string;
  type: string;
  visibility: "PUBLIC" | "PRIVATE" | "PROTECTED";
  readable: boolean;
  writable: boolean;
}

/** Interface declaration exported by a compiled library. */
export interface LibraryInterfaceEntry {
  name: string;
  extends?: string[];
  methods: LibraryMethodEntry[];
  documentation?: string;
  category?: string;
}

/**
 * Library function block entry in a manifest.
 */
export interface LibraryFBEntry {
  /** Function block name */
  name: string;
  /** Input variables */
  inputs: LibraryVarType[];
  /** Output variables */
  outputs: LibraryVarType[];
  /** In-out variables */
  inouts: LibraryVarType[];
  methods: LibraryMethodEntry[];
  properties: LibraryPropertyEntry[];
  extends?: string;
  implements?: string[];
  isAbstract: boolean;
  isFinal: boolean;
  /** Block-level help text shown in editor hover dialogs. Authored in
   *  the library's `library.json` and merged into the manifest at build
   *  time (see scripts/generate-*.mjs). Optional so existing archives
   *  without docs still load. */
  documentation?: string;
  /**
   * Bistable dominance exposed as machine-readable contract metadata.
   * Optional so ordinary FBs and existing library archives remain unchanged.
   */
  dominance?: "set" | "reset";
  /** Folder path within the library — see `LibraryFunctionEntry.category`. */
  category?: string;
}

/**
 * Library type entry in a manifest.
 */
export interface LibraryTypeEntry {
  /** Type name */
  name: string;
  /** Type kind (struct, enum, alias) */
  kind: "struct" | "enum" | "alias";
  /** Base type (for alias/enum) */
  baseType?: string;
  /** Struct member fields (name + declared type), so a consuming compilation
   *  can type member access on a dependency struct (e.g. `MATH.PI`). Only set
   *  for `kind: "struct"`; optional for backward compatibility. */
  fields?: LibraryVarType[];
  /** Enum members in declaration order, with optional explicit ST values. */
  enumMembers?: Array<{ name: string; value?: string }>;
  /** Array alias dimensions. */
  arrayDimensions?: Array<{ start: number; end: number }>;
  elementTypeName?: string;
  maxLength?: number | string;
  referenceKind?: string;
  /** Type-level help text — same lifecycle as `LibraryFBEntry.documentation`,
   *  populated automatically from the structured doc-block slot in CODESYS
   *  imports (typically the type's revision-history comment for OSCAT) and
   *  overridable via `library.json`. */
  documentation?: string;
  /** Folder path within the library — see `LibraryFunctionEntry.category`. */
  category?: string;
}

/**
 * Library global-variable entry in a manifest.
 *
 * One per name declared in a library's `VAR_GLOBAL` blocks (e.g. OSCAT's
 * `MATH : CONSTANTS_MATH`). The variable's storage is emitted by the library
 * as an `inlineGlobal` chunk; this entry is what lets a *consuming* compilation
 * see the symbol so `MATH.PI` resolves. Globals from every imported library are
 * registered into the same shared global scope, so a program importing two
 * libraries sees both libraries' globals together (additively).
 */
export interface LibraryGlobalEntry {
  /** Global variable name (as declared). */
  name: string;
  /** Declared type name (elementary or a library type, e.g. CONSTANTS_MATH). */
  type: string;
  /** True for `VAR_GLOBAL CONSTANT` entries. */
  constant?: boolean;
  /** Folder path within the library — see `LibraryFunctionEntry.category`. */
  category?: string;
}

/**
 * Internal behavior contract for a callable supplied by a virtual library.
 * These records are compiler/runtime metadata; they are deliberately not part
 * of the Structured Text call surface exposed to test authors.
 */
export interface LibrarySimulationDescriptor {
  target: string;
  callableKind: "functionBlock" | "function" | "method" | "property";
  behavior: "pure" | "stateful" | "resource";
  family: string;
  trigger?: {
    input: string;
    mode: "rising" | "level" | "cyclic";
    busy?: string;
    done?: string;
    error?: string;
    errorId?: string;
    latencyScans: number;
  };
  resource?: {
    operation: "None" | "Read" | "Write" | "Connect" | "Remove";
    key:
      | { kind: "axisAds"; input: string }
      | { kind: "handle"; input: string }
      | { kind: "inputs"; inputs: string[] }
      | { kind: "instance"; value: string };
    payloadInput?: string;
    payloadOutput?: string;
    handleOutput?: string;
    countInput?: string;
    countOutput?: string;
    eofOutput?: string;
  };
  motion?: {
    axis: string;
    action:
      | "power"
      | "moveAbsolute"
      | "moveRelative"
      | "velocity"
      | "stop"
      | "reset"
      | "observe";
    positionInput?: string;
    distanceInput?: string;
    velocityInput?: string;
  };
  propertyAccess?: { readable: boolean; writable: boolean };
}

/**
 * Library manifest describing a compiled library's public interface.
 */
export interface LibraryManifest {
  /** Library name (kebab-case identifier; matches the .stlib filename
   *  and is what dependency declarations reference). */
  name: string;
  /** Optional human-readable label for tooling that surfaces libraries
   *  to end users (editor library trees, package managers). When unset,
   *  consumers fall back to `name`. Authored in `library.json` and
   *  carried unchanged through compile. */
  displayName?: string;
  /** Library version */
  version: string;
  /** Human-readable description */
  description?: string;
  /** C++ namespace for the library */
  namespace: string;
  /** Exported functions */
  functions: LibraryFunctionEntry[];
  /** Exported function blocks */
  functionBlocks: LibraryFBEntry[];
  /** Exported top-level interfaces. */
  interfaces: LibraryInterfaceEntry[];
  /** Exported types */
  types: LibraryTypeEntry[];
  /** Exported global variables (from the library's VAR_GLOBAL blocks).
   *  Optional for backward compatibility with archives compiled before
   *  globals were exported — consumers treat a missing field as empty. */
  globals?: LibraryGlobalEntry[];
  /** C++ headers to include */
  headers: string[];
  /** Whether this is a built-in C++ runtime library */
  isBuiltin: boolean;
  /** Allowlisted compiler/runtime features required by this archive. */
  runtimeCapabilities?: string[];
  /** Validated internal virtual-runtime behavior contracts. */
  simulationDescriptors?: LibrarySimulationDescriptor[];
  /** Original ST source files (for ST libraries) */
  sourceFiles?: string[];
}

/**
 * Reference to another symbol from a library chunk's dep graph.
 *
 * Recorded by the library compiler when it scans a chunk's body for
 * cross-symbol references. Codegen walks these edges to compute the
 * reachable-from-the-user's-AST closure and only emit those chunks.
 */
export interface LibraryChunkDep {
  /** Owning archive name (matches `LibraryManifest.name`). The library
   *  compiler resolves edges at compile time, so this is always the
   *  actual archive name — including for same-archive deps (no `"this"`
   *  sentinel). Consumers can index every dep through the
   *  symbol→archive map without a separate normalisation step. */
  library: string;
  /** Referenced symbol's uppercase name (matches `LibraryChunk.name`
   *  in the target archive). */
  name: string;
}

/**
 * Per-symbol chunk in a compiled library.
 *
 * One chunk per top-level declaration: function, function block, type
 * (struct/enum/alias group), or inline global. `header` + `cpp`
 * concatenated in chunk-array order reproduce the legacy library-wide
 * header/cpp blobs — the chunked form is a refinement, not a rewrite,
 * of what the codegen used to emit as one chunk per library.
 *
 * The chunks-and-deps representation is what enables function-level
 * tree-shaking: codegen walks the user's AST, seeds the closure with
 * referenced names, BFS-traverses `deps`, then emits only the chunks
 * in the closure. Symbols that no reachable chunk depends on never
 * appear in the user's `generated.hpp`/`generated.cpp`.
 */
export interface LibraryChunk {
  /** Symbol name (uppercase). Matches an entry in
   *  `manifest.functions`, `manifest.functionBlocks`, `manifest.types`,
   *  or names an inline global owned by this library. */
  name: string;
  /** Top-level kind. Drives forward-decl ordering during emission
   *  (function blocks need forward decls so circular FB-to-FB
   *  references resolve; types and functions don't). */
  kind: "function" | "functionBlock" | "type" | "inlineGlobal";
  /** Slice of this library's emitted header code that declares this
   *  symbol — class declaration, struct body, function prototype, or
   *  inline-global definition — plus any same-line `using IEC_X = X;`
   *  alias that conventionally accompanies it. Concatenating every
   *  chunk's `header` in array order reproduces the legacy
   *  library-wide `headerCode` blob byte-for-byte. */
  header: string;
  /** Slice of this library's emitted cpp code that implements this
   *  symbol — constructor + `operator()` bodies for FBs, function
   *  bodies for free functions. Empty string for types and inline
   *  globals whose entire materialisation lives in `header`. */
  cpp: string;
  /** Symbols this chunk references in its body. Same-archive entries
   *  use `library: "this"`; cross-archive entries name the owning
   *  archive's `manifest.name`. The codegen treats these as edges
   *  in the chunk-reachability graph. */
  deps: LibraryChunkDep[];
}

/**
 * Result of compiling a library.
 */
export interface LibraryCompileResult {
  /** Whether compilation succeeded */
  success: boolean;
  /** The library manifest */
  manifest: LibraryManifest;
  /** Generated C++ header */
  headerCode: string;
  /** Generated C++ implementation */
  cppCode: string;
  /** Per-symbol chunks. Populated from Phase 2 onward; Phase 1 ships
   *  the type definition only so consumers can be migrated
   *  incrementally. When non-empty, concatenating chunks in array
   *  order reproduces `headerCode` / `cppCode`. */
  chunks?: LibraryChunk[];
  /** Compilation errors */
  errors: Array<{ message: string; file?: string; line?: number }>;
}

/**
 * Single-file `.stlib` archive format containing metadata + compiled C++ code.
 *
 * Emission to a consumer is per-symbol via `chunks` — the codegen
 * tree-shake walks the user's AST and emits only reachable chunks
 * into the final `generated.hpp` / `generated.cpp`. There is no
 * library-wide blob field: the legacy `headerCode` / `cppCode` were
 * retired in Phase 4 of the function-level tree-shaking work.
 */
export interface StlibArchive {
  /** Format version for forward compatibility */
  formatVersion: 2;
  /** Library metadata (function/FB/type signatures for symbol registration) */
  manifest: LibraryManifest;
  /** Per-symbol chunks. One entry per top-level declaration emitted
   *  by the library compiler: function, function block, type, or
   *  inline global. Each chunk owns its header/cpp slices plus the
   *  dep edges to other chunks (in this archive or any declared dep).
   *  Empty for synthetic libraries that bypass `compileLibrary`
   *  (e.g. `iec-std-functions` is built from the std-function registry
   *  and contributes only symbol-table entries, no C++ output). */
  chunks: LibraryChunk[];
  /** Original ST source files (omitted for closed-source distribution).
   *  `category` mirrors the manifest entry category for the POUs declared
   *  in this file so `--decompile-lib` can recreate the folder hierarchy
   *  on disk without re-parsing the source. Sources that span multiple
   *  POUs (e.g. iec-standard-fb's counter.st) all share one category by
   *  construction — every POU declared in the same file came from the
   *  same input folder. */
  sources?: Array<{ fileName: string; source: string; category?: string }>;
  /** Global constants required by this library (e.g., STRING_LENGTH, LIST_LENGTH) */
  globalConstants?: Record<string, number>;
  /** Reserved for future library-to-library dependency resolution */
  dependencies: Array<{ name: string; version: string }>;
}

/**
 * Result of compiling an ST library into a `.stlib` archive.
 */
export interface StlibCompileResult {
  /** Whether compilation succeeded */
  success: boolean;
  /** The compiled archive */
  archive: StlibArchive;
  /** Compilation errors */
  errors: Array<{ message: string; file?: string; line?: number }>;
}
