import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { compile } from "../../src/index.js";
import { compileStlib } from "../../src/library/library-compiler.js";
import { loadStlibArchive } from "../../src/library/library-loader.js";
import { loadLibraryProfile } from "../../src/node/library-profile.js";

describe("Beckhoff virtual compatibility profile", () => {
  it("classifies the complete pinned documentation snapshot", () => {
    const catalog = JSON.parse(
      readFileSync(
        resolve("libs/sources/beckhoff-virtual-core/beckhoff-api-catalog.json"),
        "utf8",
      ),
    );
    expect(catalog.coverage.indexedPages).toBe(688);
    expect(catalog.coverage.libraryIdentities).toBe(34);
    expect(catalog.pages).toHaveLength(688);
    expect(
      catalog.pages.every((page: { disposition?: string }) =>
        [
          "new-library-symbol",
          "existing-equivalent",
          "compiler-feature",
          "duplicate",
          "topic-only",
        ].includes(page.disposition ?? ""),
      ),
    ).toBe(true);
    expect(
      catalog.supportTypes.every((type: { disposition?: string }) =>
        Boolean(type.disposition),
      ),
    ).toBe(true);
  });

  it("loads the locked profile without dependency or symbol conflicts", () => {
    const profile = loadLibraryProfile("beckhoff-virtual");
    expect(profile.archives).toHaveLength(32);
    expect(profile.archives[0]!.manifest.name).toBe("iec-standard-fb");
    expect(profile.archives[1]!.manifest.runtimeCapabilities).toContain(
      "beckhoff-virtual-v1",
    );
    expect(
      profile.archives.some(
        (archive) => archive.manifest.name === "additional-function-blocks",
      ),
    ).toBe(false);
  });

  it("round-trips complete v2 OOP metadata", () => {
    const result = compileStlib(
      [
        {
          fileName: "oop.st",
          source: `
            INTERFACE IReadable
              METHOD Read : DINT
                VAR_INPUT index : UINT := 1; END_VAR
              END_METHOD
            END_INTERFACE
            FUNCTION Describe : STRING(64)
              VAR_INPUT value : POINTER TO DINT; END_VAR
              Describe := 'virtual';
            END_FUNCTION
            FUNCTION_BLOCK Base
              METHOD PUBLIC Reset END_METHOD
            END_FUNCTION_BLOCK
            FUNCTION_BLOCK Device EXTENDS Base IMPLEMENTS IReadable
              VAR_INPUT values : ARRAY[0..3] OF DINT; END_VAR
              METHOD PUBLIC Read : DINT
                VAR_INPUT index : UINT := 1; END_VAR
                Read := values[index];
              END_METHOD
              PROPERTY PUBLIC Amount : DINT
                GET Amount := values[0]; END_GET
                SET values[0] := Amount; END_SET
              END_PROPERTY
            END_FUNCTION_BLOCK
          `,
        },
      ],
      {
        name: "v2-oop",
        version: "1.0.0",
        namespace: "v2_oop",
        runtimeCapabilities: ["fixture-test"],
      },
    );
    expect(result.success).toBe(true);
    const loaded = loadStlibArchive(JSON.parse(JSON.stringify(result.archive)));
    const device = loaded.manifest.functionBlocks.find(
      (entry) => entry.name.toUpperCase() === "DEVICE",
    )!;
    expect(loaded.formatVersion).toBe(2);
    expect(
      loaded.manifest.interfaces[0]!.methods[0]!.parameters[0],
    ).toMatchObject({ name: "INDEX", direction: "input", initialValue: "1" });
    expect(device.extends).toBe("BASE");
    expect(device.implements).toEqual(["IREADABLE"]);
    expect(device.inputs[0]!.arrayDimensions).toEqual([{ start: 0, end: 3 }]);
    expect(device.methods[0]!.returnType).toBe("DINT");
    expect(device.properties[0]).toMatchObject({
      name: "AMOUNT",
      readable: true,
      writable: true,
    });
    expect(loaded.manifest.runtimeCapabilities).toEqual(["fixture-test"]);
    expect(loaded.manifest.functions[0]!.returnType).toBe("STRING");
    expect(loaded.manifest.functions[0]!.parameters[0]).toMatchObject({
      type: "DINT",
      referenceKind: "pointer_to",
    });

    const consumer = compile(
      `PROGRAM Consumer
         VAR device : Device; index : UINT; result : DINT; END_VAR
         device.Reset();
         result := device.Read(index := index);
         device.Amount := result;
         result := device.Amount;
       END_PROGRAM`,
      { libraries: [loaded] },
    );
    expect(
      consumer.success,
      consumer.errors.map((error) => error.message).join("; "),
    ).toBe(true);
  });

  it("rejects malformed nested v2 type metadata", () => {
    const invalid = {
      formatVersion: 2,
      manifest: {
        name: "invalid",
        version: "1.0.0",
        namespace: "invalid",
        functions: [],
        functionBlocks: [
          {
            name: "Broken",
            inputs: [
              {
                name: "value",
                type: "DINT",
                arrayDimensions: [{ start: "zero", end: 1 }],
              },
            ],
            outputs: [],
            inouts: [],
            methods: [],
            properties: [],
            isAbstract: false,
            isFinal: false,
          },
        ],
        interfaces: [],
        types: [],
        headers: [],
        isBuiltin: true,
      },
      chunks: [],
      dependencies: [],
    };
    expect(() => loadStlibArchive(invalid)).toThrow(/arrayDimensions/);
  });

  it("compiles every generated callable surface library-by-library", () => {
    const { archives } = loadLibraryProfile("beckhoff-virtual");
    for (const archive of archives.slice(2)) {
      const declarations: string[] = [];
      const statements: string[] = [];
      let index = 0;
      const variable = (type: string, prefix: string) => {
        const name = `${prefix}_${index++}`;
        declarations.push(`${name} : ${type};`);
        return name;
      };
      for (const fb of archive.manifest.functionBlocks) {
        const instance = variable(fb.name, "fb");
        for (const method of fb.methods) {
          const callArguments = method.parameters.map((parameter) => {
            const value = variable(parameter.type, "arg");
            return `${parameter.name} ${parameter.direction === "output" ? "=>" : ":="} ${value}`;
          });
          const call = `${instance}.${method.name}(${callArguments.join(", ")})`;
          if (method.returnType) {
            const output = variable(method.returnType, "ret");
            statements.push(`${output} := ${call};`);
          } else {
            statements.push(`${call};`);
          }
        }
        for (const property of fb.properties) {
          const value = variable(property.type, "property");
          if (property.readable)
            statements.push(`${value} := ${instance}.${property.name};`);
          if (property.writable)
            statements.push(`${instance}.${property.name} := ${value};`);
        }
      }
      for (const fn of archive.manifest.functions) {
        const callArguments = fn.parameters.map((parameter) => {
          const value = variable(parameter.type, "fnarg");
          return `${parameter.name} ${parameter.direction === "output" ? "=>" : ":="} ${value}`;
        });
        const output = variable(fn.returnType, "fnret");
        statements.push(
          `${output} := ${fn.name}(${callArguments.join(", ")});`,
        );
      }
      const source = `PROGRAM ProfileHarness VAR ${declarations.join("\n")} END_VAR ${statements.join("\n")} END_PROGRAM`;
      const result = compile(source, {
        fileName: `${archive.manifest.name}.st`,
        libraries: archives,
      });
      expect(
        result.success,
        `${archive.manifest.name}: ${result.errors.map((error) => error.message).join("; ")}`,
      ).toBe(true);
    }
  });
});
