/** Generic library FB variable-alias contract tests. */

import { describe, expect, it } from "vitest";
import { compile } from "../../src/index.js";
import { compileStlib } from "../../src/library/library-compiler.js";
import {
  LibraryManifestError,
  loadLibraryManifest,
  registerLibrarySymbols,
} from "../../src/library/library-loader.js";
import { loadStlibFromFile } from "../../src/node/library-loader.js";
import { applyLibraryConfigDocumentation } from "../../src/library/library-config.js";
import { resolveLibraryFBVariable } from "../../src/library/variable-aliases.js";
import {
  SymbolTables,
  resolveFunctionBlockFormalVariable,
} from "../../src/semantic/symbol-table.js";

function buildAliasLibrary() {
  const result = compileStlib(
    [
      {
        fileName: "pin_fb.st",
        source: `
          FUNCTION_BLOCK PIN_FB
            VAR_INPUT CANON_IN : BOOL; SECOND : BOOL; END_VAR
            VAR_OUTPUT CANON_OUT : BOOL; END_VAR
            CANON_OUT := CANON_IN;
          END_FUNCTION_BLOCK
        `,
      },
    ],
    { name: "alias-lib", version: "1.0.0", namespace: "strucpp" },
  );
  expect(result.success).toBe(true);
  applyLibraryConfigDocumentation(result.archive, {
    name: "alias-lib",
    version: "1.0.0",
    namespace: "strucpp",
    blocks: {
      PIN_FB: {
        documentation: "Alias fixture",
        variableAliases: {
          CANON_IN: ["OLD_IN"],
          CANON_OUT: ["OLD_OUT"],
        },
      },
    },
  });
  return result.archive;
}

describe("library function-block variable aliases", () => {
  it("keeps one ordered canonical interface and resolves aliases in tooling", () => {
    const archive = buildAliasLibrary();
    const fb = archive.manifest.functionBlocks[0]!;

    expect(fb.inputs.map((variable) => variable.name)).toEqual([
      "CANON_IN",
      "SECOND",
    ]);
    expect(fb.inputs[0]!.aliases).toEqual(["OLD_IN"]);
    expect(resolveLibraryFBVariable(fb, "old_in")).toMatchObject({
      canonicalName: "CANON_IN",
      direction: "input",
      isAlias: true,
    });

    const symbols = new SymbolTables();
    registerLibrarySymbols(archive.manifest, symbols);
    const fbSymbol = symbols.lookupFunctionBlock("PIN_FB")!;
    expect(
      resolveFunctionBlockFormalVariable(fbSymbol, "OLD_OUT"),
    ).toMatchObject({
      canonicalName: "CANON_OUT",
      direction: "output",
      isAlias: true,
    });
  });

  it("canonicalizes named calls, output captures, and direct member access", () => {
    const archive = buildAliasLibrary();
    const result = compile(
      `
        PROGRAM Main
          VAR fb : PIN_FB; q : BOOL; END_VAR
          fb(OLD_IN := TRUE, SECOND := FALSE, OLD_OUT => q);
          fb.OLD_IN := FALSE;
          q := fb.OLD_OUT;
        END_PROGRAM
      `,
      { libraries: [archive] },
    );

    expect(result.success).toBe(true);
    expect(result.cppCode).toContain("FB.CANON_IN = true;");
    expect(result.cppCode).toContain("FB.CANON_IN = false;");
    expect(result.cppCode).toContain("Q = FB.CANON_OUT;");
    expect(result.cppCode).not.toMatch(/FB\.(OLD_IN|OLD_OUT)/);
  });

  it("leaves positional order bound only to canonical inputs", () => {
    const result = compile(
      `
        PROGRAM Main
          VAR fb : PIN_FB; END_VAR
          fb(TRUE, FALSE);
        END_PROGRAM
      `,
      { libraries: [buildAliasLibrary()] },
    );

    expect(result.success).toBe(true);
    expect(result.cppCode).toContain("FB.CANON_IN = true;");
    expect(result.cppCode).toContain("FB.SECOND = false;");
  });

  it("accepts TwinCAT counter aliases on the bundled IEC standard FB library", () => {
    const archive = loadStlibFromFile("libs/iec-standard-fb.stlib");
    const result = compile(
      `
        PROGRAM Main
          VAR
            up : CTU;
            down : CTD;
            both : CTUD;
          END_VAR
          up(CU := TRUE, RESET := TRUE, PV := 5);
          down(CD := TRUE, LOAD := TRUE, PV := 5);
          both(CU := TRUE, CD := FALSE, RESET := FALSE, LOAD := TRUE, PV := 5);
        END_PROGRAM
      `,
      { libraries: [archive] },
    );

    expect(result.success).toBe(true);
    expect(result.cppCode).toContain("UP.R = true;");
    expect(result.cppCode).toContain("DOWN.LD = true;");
    expect(result.cppCode).toContain("BOTH.R = false;");
    expect(result.cppCode).toContain("BOTH.LD = true;");
    expect(result.cppCode).not.toMatch(/\.(RESET|LOAD)\b/);
  });

  it("reports unknown and duplicate canonical/alias formals before C++", () => {
    const archive = buildAliasLibrary();
    const duplicate = compile(
      `PROGRAM Main VAR fb : PIN_FB; END_VAR
       fb(CANON_IN := TRUE, OLD_IN := FALSE); END_PROGRAM`,
      { libraries: [archive] },
    );
    expect(duplicate.success).toBe(false);
    expect(duplicate.errors.map((error) => error.message).join("\n")).toContain(
      "parameter 'CANON_IN' is assigned more than once",
    );
    expect(duplicate.errors[0]).toMatchObject({ line: 2 });

    const unknown = compile(
      `PROGRAM Main VAR fb : PIN_FB; END_VAR
       fb(NOT_A_PIN := TRUE); END_PROGRAM`,
      { libraries: [archive] },
    );
    expect(unknown.success).toBe(false);
    expect(unknown.errors.map((error) => error.message).join("\n")).toContain(
      "Unknown parameter 'NOT_A_PIN' for function block 'PIN_FB'",
    );
    const unknownMessage = unknown.errors
      .map((error) => error.message)
      .join("\n");
    expect(unknownMessage).toContain("ST instance 'FB'");
    expect(unknownMessage).toContain("type 'PIN_FB', line 2");
    expect(unknownMessage).toContain(
      "Accepted inputs: CANON_IN (aliases: OLD_IN), SECOND",
    );
    expect(unknownMessage).toContain(
      "Accepted outputs: CANON_OUT (aliases: OLD_OUT)",
    );
    expect(unknown.errors[0]).toMatchObject({ line: 2 });
  });

  it("provides exact RS/SR formal corrections without accepting invalid TwinCAT ST", () => {
    const archive = loadStlibFromFile("libs/iec-standard-fb.stlib");
    const rs = compile(
      `PROGRAM Main VAR latch : RS; END_VAR
       latch(SET1 := TRUE, RESET := FALSE); END_PROGRAM`,
      { libraries: [archive] },
    );
    const sr = compile(
      `PROGRAM Main VAR latch : SR; END_VAR
       latch(SET := TRUE, RESET1 := FALSE); END_PROGRAM`,
      { libraries: [archive] },
    );

    expect(rs.success).toBe(false);
    expect(rs.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "IEC_FB_RS_SR_FORMAL_MISMATCH",
          suggestion: expect.stringContaining("'SET1' with 'SET'"),
        }),
        expect.objectContaining({
          code: "IEC_FB_RS_SR_FORMAL_MISMATCH",
          suggestion: expect.stringContaining("'RESET' with 'RESET1'"),
        }),
      ]),
    );
    expect(sr.success).toBe(false);
    expect(sr.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "IEC_FB_RS_SR_FORMAL_MISMATCH",
          suggestion: expect.stringContaining("'SET' with 'SET1'"),
        }),
        expect.objectContaining({
          code: "IEC_FB_RS_SR_FORMAL_MISMATCH",
          suggestion: expect.stringContaining("'RESET1' with 'RESET'"),
        }),
      ]),
    );
  });

  it("rejects manifest aliases that collide with canonical names or aliases", () => {
    const base = {
      name: "bad-alias-lib",
      version: "1.0.0",
      namespace: "strucpp",
      functions: [],
      types: [],
      headers: [],
      isBuiltin: false,
    };
    expect(() =>
      loadLibraryManifest({
        ...base,
        functionBlocks: [
          {
            name: "FB",
            inputs: [
              { name: "FIRST", type: "BOOL", aliases: ["SECOND"] },
              { name: "SECOND", type: "BOOL" },
            ],
            outputs: [],
            inouts: [],
          },
        ],
      }),
    ).toThrow(LibraryManifestError);

    expect(() =>
      loadLibraryManifest({
        ...base,
        functionBlocks: [
          {
            name: "FB",
            inputs: [
              { name: "FIRST", type: "BOOL", aliases: ["LEGACY"] },
              { name: "SECOND", type: "BOOL", aliases: ["legacy"] },
            ],
            outputs: [],
            inouts: [],
          },
        ],
      }),
    ).toThrow(/already assigned/);
  });

  it("validates and preserves bistable dominance in loaded manifests", () => {
    const manifest = {
      name: "bistable-contract-lib",
      version: "1.0.0",
      namespace: "strucpp",
      functions: [],
      types: [],
      headers: [],
      isBuiltin: false,
      functionBlocks: [
        {
          name: "RS",
          inputs: [],
          outputs: [],
          inouts: [],
          dominance: "reset",
        },
      ],
    };
    expect(loadLibraryManifest(manifest).functionBlocks[0]?.dominance).toBe(
      "reset",
    );
    expect(() =>
      loadLibraryManifest({
        ...manifest,
        functionBlocks: [
          {
            ...manifest.functionBlocks[0],
            dominance: "last-input-wins",
          },
        ],
      }),
    ).toThrow(/dominance must be "set" or "reset"/);
  });
});
