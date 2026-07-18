import { describe, expect, it } from "vitest";
import { compile } from "../../src/index.js";

function messages(errors: unknown[]): string {
  return errors
    .map((error) =>
      typeof error === "object" && error && "message" in error
        ? String(error.message)
        : String(error),
    )
    .join("\n");
}

describe("TwinCAT named-field STRUCT declaration initializers", () => {
  it("accepts reordered and nested fields in a VAR declaration", () => {
    const result = compile(`
      TYPE
        ST_Inner : STRUCT
          xEnabled : BOOL;
          uiLimit : UINT;
        END_STRUCT;
        ST_Config : STRUCT
          uiMode : UINT;
          inner : ST_Inner;
          tDelay : TIME;
        END_STRUCT;
      END_TYPE

      FUNCTION_BLOCK FB_Subject
        VAR
          config : ST_Config := (
            tDelay := T#1S,
            uiMode := 2,
            inner := (uiLimit := 10, xEnabled := TRUE)
          );
        END_VAR
      END_FUNCTION_BLOCK
    `);

    expect(result.success, messages(result.errors)).toBe(true);
    expect(result.cppCode).toContain("ST_CONFIG{");
    expect(result.cppCode).toContain("ST_INNER{");
  });

  it.each([
    ["unknown field", "missing := 1", /Unknown field 'missing'/i],
    [
      "duplicate field",
      "uiMode := 1, UIMODE := 2",
      /Duplicate field 'UIMODE'/i,
    ],
    ["field type mismatch", "uiMode := 'wrong'", /cannot assign/i],
  ])("rejects an %s", (_name, initializer, expected) => {
    const result = compile(`
      TYPE
        ST_Config : STRUCT
          uiMode : UINT;
        END_STRUCT;
      END_TYPE
      FUNCTION_BLOCK FB_Subject
        VAR
          config : ST_Config := (${initializer});
        END_VAR
      END_FUNCTION_BLOCK
    `);

    expect(result.success).toBe(false);
    expect(messages(result.errors)).toMatch(expected);
  });

  it("rejects the same aggregate syntax in executable implementation ST", () => {
    const result = compile(`
      TYPE
        ST_Config : STRUCT
          uiMode : UINT;
        END_STRUCT;
      END_TYPE
      FUNCTION_BLOCK FB_Subject
        VAR
          config : ST_Config;
        END_VAR
        config := (uiMode := 2);
      END_FUNCTION_BLOCK
    `);

    expect(result.success).toBe(false);
  });
});
