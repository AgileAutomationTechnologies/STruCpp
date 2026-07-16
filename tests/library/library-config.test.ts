/**
 * Tests for the library.json loader and the merge step that bakes
 * per-block documentation into a compiled .stlib archive.
 *
 * Strategy: write small library.json fixtures into temp directories
 * (loadLibraryConfig is filesystem-bound) and run apply against
 * synthetic minimal archives so the validator and matcher can be
 * exercised without spinning up the full compile pipeline.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  applyLibraryConfigDocumentation,
  type LibraryConfig,
} from "../../src/library/library-config.js";
import { loadLibraryConfig } from "../../src/node/library-config.js";
import type { StlibArchive } from "../../src/library/library-manifest.js";

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "strucpp-libcfg-"));
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function writeJson(name: string, content: unknown) {
  writeFileSync(join(tmp, name), JSON.stringify(content, null, 2), "utf-8");
}

/** Minimal synthetic archive used by apply tests. */
function makeArchive(opts: {
  fbs?: string[];
  fns?: Array<{ name: string; returnType: string }>;
}): StlibArchive {
  return {
    formatVersion: 2,
    manifest: {
      name: "test",
      version: "0.0.0",
      namespace: "ns",
      functions: (opts.fns ?? []).map((f) => ({
        name: f.name,
        returnType: f.returnType,
        parameters: [],
      })),
      functionBlocks: (opts.fbs ?? []).map((name) => ({
        name,
        inputs: [],
        outputs: [],
        inouts: [],
        methods: [],
        properties: [],
        isAbstract: false,
        isFinal: false,
      })),
      interfaces: [],
      types: [],
      headers: [],
      isBuiltin: false,
    },
    headerCode: "",
    cppCode: "",
    dependencies: [],
  };
}

describe("loadLibraryConfig", () => {
  it("returns null when library.json is absent", () => {
    expect(loadLibraryConfig(tmp)).toBeNull();
  });

  it("loads a valid minimal config", () => {
    writeJson("library.json", {
      name: "my-lib",
      version: "1.0.0",
      namespace: "strucpp",
    });
    const cfg = loadLibraryConfig(tmp);
    expect(cfg).toEqual({
      name: "my-lib",
      version: "1.0.0",
      namespace: "strucpp",
    });
  });

  it("loads optional fields (description, isBuiltin, blocks, functions)", () => {
    writeJson("library.json", {
      name: "x",
      version: "1",
      namespace: "ns",
      description: "Test",
      isBuiltin: true,
      blocks: { FB: { documentation: "doc" } },
      functions: { FN: { documentation: "fn-doc" } },
    });
    const cfg = loadLibraryConfig(tmp);
    expect(cfg?.description).toBe("Test");
    expect(cfg?.isBuiltin).toBe(true);
    expect(cfg?.blocks?.FB.documentation).toBe("doc");
    expect(cfg?.functions?.FN.documentation).toBe("fn-doc");
  });

  it("loads canonical block-variable aliases", () => {
    writeJson("library.json", {
      name: "x",
      version: "1",
      namespace: "ns",
      blocks: {
        RS: {
          documentation: "reset dominant",
          variableAliases: { SET: ["S"], RESET1: ["R1"] },
        },
      },
    });
    expect(loadLibraryConfig(tmp)?.blocks?.RS.variableAliases).toEqual({
      SET: ["S"],
      RESET1: ["R1"],
    });
  });

  it("loads validated bistable dominance metadata", () => {
    writeJson("library.json", {
      name: "x",
      version: "1",
      namespace: "ns",
      blocks: {
        RS: {
          documentation: "reset dominant",
          dominance: "reset",
        },
        SR: {
          documentation: "set dominant",
          dominance: "set",
        },
      },
    });
    const blocks = loadLibraryConfig(tmp)?.blocks;
    expect(blocks?.RS.dominance).toBe("reset");
    expect(blocks?.SR.dominance).toBe("set");
  });

  it("rejects unknown bistable dominance values", () => {
    writeJson("library.json", {
      name: "x",
      version: "1",
      namespace: "ns",
      blocks: {
        RS: { documentation: "invalid", dominance: "last-input-wins" },
      },
    });
    expect(() => loadLibraryConfig(tmp)).toThrow(
      /dominance must be "set" or "reset"/,
    );
  });

  it("rejects malformed or non-identifier block-variable aliases", () => {
    for (const aliases of [["NOT VALID"], "S", [""]]) {
      writeJson("library.json", {
        name: "x",
        version: "1",
        namespace: "ns",
        blocks: {
          RS: {
            documentation: "reset dominant",
            variableAliases: { SET: aliases },
          },
        },
      });
      expect(() => loadLibraryConfig(tmp)).toThrow(
        /Structured Text identifiers/,
      );
    }
  });

  it("rejects duplicate canonical alias keys case-insensitively", () => {
    writeJson("library.json", {
      name: "x",
      version: "1",
      namespace: "ns",
      blocks: {
        RS: {
          documentation: "reset dominant",
          variableAliases: { SET: ["S"], set: ["OLD_SET"] },
        },
      },
    });
    expect(() => loadLibraryConfig(tmp)).toThrow(/collide case-insensitively/);
  });

  it("loads globalConstants when supplied (e.g. OSCAT's STRING_LENGTH)", () => {
    writeJson("library.json", {
      name: "x",
      version: "1",
      namespace: "ns",
      globalConstants: { STRING_LENGTH: 254, LIST_LENGTH: 254 },
    });
    const cfg = loadLibraryConfig(tmp);
    expect(cfg?.globalConstants).toEqual({
      STRING_LENGTH: 254,
      LIST_LENGTH: 254,
    });
  });

  it("throws when globalConstants is an array instead of an object map", () => {
    writeJson("library.json", {
      name: "x",
      version: "1",
      namespace: "ns",
      globalConstants: [254, 254],
    });
    expect(() => loadLibraryConfig(tmp)).toThrow(/globalConstants/);
  });

  it("throws when a globalConstants value is non-numeric", () => {
    writeJson("library.json", {
      name: "x",
      version: "1",
      namespace: "ns",
      globalConstants: { STRING_LENGTH: "254" },
    });
    expect(() => loadLibraryConfig(tmp)).toThrow(/STRING_LENGTH/);
  });

  it("throws when a globalConstants value is non-finite (NaN / Infinity)", () => {
    writeJson("library.json", {
      name: "x",
      version: "1",
      namespace: "ns",
      // JSON can't carry NaN, but it can carry null. The validator
      // rejects anything that's not a finite number, including null.
      globalConstants: { BAD: null },
    });
    expect(() => loadLibraryConfig(tmp)).toThrow(/BAD/);
  });

  it("throws on malformed JSON", () => {
    writeFileSync(join(tmp, "library.json"), "{ not json", "utf-8");
    expect(() => loadLibraryConfig(tmp)).toThrow(/invalid JSON/i);
  });

  it("throws when name is missing", () => {
    writeJson("library.json", { version: "1", namespace: "ns" });
    expect(() => loadLibraryConfig(tmp)).toThrow(/"name"/);
  });

  it("throws when name is empty string", () => {
    writeJson("library.json", { name: "", version: "1", namespace: "ns" });
    expect(() => loadLibraryConfig(tmp)).toThrow(/"name"/);
  });

  it("throws when version is non-string", () => {
    writeJson("library.json", { name: "x", version: 1, namespace: "ns" });
    expect(() => loadLibraryConfig(tmp)).toThrow(/"version"/);
  });

  it("throws when namespace is missing", () => {
    writeJson("library.json", { name: "x", version: "1" });
    expect(() => loadLibraryConfig(tmp)).toThrow(/"namespace"/);
  });

  it("throws when blocks is an array instead of object", () => {
    writeJson("library.json", {
      name: "x",
      version: "1",
      namespace: "ns",
      blocks: [],
    });
    expect(() => loadLibraryConfig(tmp)).toThrow(/blocks/);
  });

  it("throws when a block entry is missing documentation", () => {
    writeJson("library.json", {
      name: "x",
      version: "1",
      namespace: "ns",
      blocks: { FB: {} },
    });
    expect(() => loadLibraryConfig(tmp)).toThrow(/documentation/);
  });

  it("throws when a block entry's documentation is non-string", () => {
    writeJson("library.json", {
      name: "x",
      version: "1",
      namespace: "ns",
      blocks: { FB: { documentation: 123 } },
    });
    expect(() => loadLibraryConfig(tmp)).toThrow(/documentation/);
  });
});

describe("applyLibraryConfigDocumentation", () => {
  it("merges block docs into matching FBs in place", () => {
    const archive = makeArchive({ fbs: ["TON", "TOF"] });
    const config: LibraryConfig = {
      name: "x",
      version: "1",
      namespace: "ns",
      blocks: {
        TON: { documentation: "on-delay" },
        TOF: { documentation: "off-delay" },
      },
    };
    const report = applyLibraryConfigDocumentation(archive, config);
    expect(report.blocksDocumented).toBe(2);
    expect(report.unknownBlockDocs).toEqual([]);
    expect(archive.manifest.functionBlocks[0]?.documentation).toBe("on-delay");
    expect(archive.manifest.functionBlocks[1]?.documentation).toBe("off-delay");
  });

  it("merges bistable dominance into the compiled manifest", () => {
    const archive = makeArchive({ fbs: ["RS", "SR"] });
    applyLibraryConfigDocumentation(archive, {
      name: "x",
      version: "1",
      namespace: "ns",
      blocks: {
        RS: { documentation: "reset dominant", dominance: "reset" },
        SR: { documentation: "set dominant", dominance: "set" },
      },
    });

    expect(archive.manifest.functionBlocks[0]?.dominance).toBe("reset");
    expect(archive.manifest.functionBlocks[1]?.dominance).toBe("set");
  });

  it("merges function docs into matching functions in place", () => {
    const archive = makeArchive({ fns: [{ name: "ABS", returnType: "REAL" }] });
    const config: LibraryConfig = {
      name: "x",
      version: "1",
      namespace: "ns",
      functions: { ABS: { documentation: "absolute value" } },
    };
    const report = applyLibraryConfigDocumentation(archive, config);
    expect(report.functionsDocumented).toBe(1);
    expect(archive.manifest.functions[0]?.documentation).toBe("absolute value");
  });

  it("applies aliases to the canonical variable and reports unknown pins", () => {
    const archive = makeArchive({ fbs: ["RS"] });
    archive.manifest.functionBlocks[0]!.inputs = [
      { name: "SET", type: "BOOL" },
      { name: "RESET1", type: "BOOL" },
    ];
    const report = applyLibraryConfigDocumentation(archive, {
      name: "x",
      version: "1",
      namespace: "ns",
      blocks: {
        RS: {
          documentation: "reset dominant",
          variableAliases: { set: ["S"], TYPO: ["OLD"] },
        },
      },
    });

    expect(archive.manifest.functionBlocks[0]!.inputs[0]!.aliases).toEqual([
      "S",
    ]);
    expect(report.variableAliasesApplied).toBe(1);
    expect(report.unknownBlockVariables).toEqual(["RS.TYPO"]);
  });

  it("rejects canonical and alias namespace collisions in config", () => {
    const archive = makeArchive({ fbs: ["FB"] });
    archive.manifest.functionBlocks[0]!.inputs = [
      { name: "FIRST", type: "BOOL" },
      { name: "SECOND", type: "BOOL" },
    ];
    expect(() =>
      applyLibraryConfigDocumentation(archive, {
        name: "x",
        version: "1",
        namespace: "ns",
        blocks: {
          FB: {
            documentation: "bad aliases",
            variableAliases: { FIRST: ["SECOND"] },
          },
        },
      }),
    ).toThrow(/collides with canonical variable/);
  });

  it("reports unknown block names instead of silently dropping them", () => {
    const archive = makeArchive({ fbs: ["TON"] });
    const config: LibraryConfig = {
      name: "x",
      version: "1",
      namespace: "ns",
      blocks: {
        TON: { documentation: "ok" },
        TYPO_NAME: { documentation: "should fail" },
      },
    };
    const report = applyLibraryConfigDocumentation(archive, config);
    expect(report.blocksDocumented).toBe(1);
    expect(report.unknownBlockDocs).toEqual(["TYPO_NAME"]);
  });

  it("reports unknown function names", () => {
    const archive = makeArchive({ fns: [] });
    const config: LibraryConfig = {
      name: "x",
      version: "1",
      namespace: "ns",
      functions: { GHOST: { documentation: "not in manifest" } },
    };
    const report = applyLibraryConfigDocumentation(archive, config);
    expect(report.unknownFunctionDocs).toEqual(["GHOST"]);
  });

  it("matches names case-sensitively (FB names are uppercase by convention)", () => {
    const archive = makeArchive({ fbs: ["TON"] });
    const config: LibraryConfig = {
      name: "x",
      version: "1",
      namespace: "ns",
      blocks: { ton: { documentation: "lowercase typo" } },
    };
    const report = applyLibraryConfigDocumentation(archive, config);
    expect(report.unknownBlockDocs).toEqual(["ton"]);
    expect(archive.manifest.functionBlocks[0]?.documentation).toBeUndefined();
  });

  it("is a no-op when blocks/functions are absent from config", () => {
    const archive = makeArchive({ fbs: ["TON"] });
    const config: LibraryConfig = {
      name: "x",
      version: "1",
      namespace: "ns",
    };
    const report = applyLibraryConfigDocumentation(archive, config);
    expect(report.blocksDocumented).toBe(0);
    expect(report.functionsDocumented).toBe(0);
    expect(archive.manifest.functionBlocks[0]?.documentation).toBeUndefined();
  });
});
