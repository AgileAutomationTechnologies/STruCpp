import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { compile } from "../../src/index.js";
import { compileWithGpp, createPCH, hasGpp } from "./test-helpers.js";

const describeIfGpp = hasGpp ? describe : describe.skip;

describeIfGpp("TwinCAT property and CASE compatibility", () => {
  let tempDir: string;
  let pchPath: string;

  beforeAll(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "strucpp-twincat-compat-"));
    pchPath = createPCH(tempDir);
  });

  afterAll(() => {
    if (tempDir && fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("compiles accessor locals and grouped qualified CASE labels", () => {
    const source = `
      TYPE
        Pattern : (Single, Delayed, Retriggerable, Periodic, Burst);
      END_TYPE

      FUNCTION_BLOCK PatternValue
        VAR
          pattern : Pattern;
          stored : DINT;
        END_VAR
        PROPERTY Value : DINT
          GET
            VAR_TEMP selected : DINT; END_VAR
            CASE pattern OF
              Pattern.Single, Pattern.Delayed, Pattern.Retriggerable,
              Pattern.Periodic, Pattern.Burst:
                selected := stored;
            END_CASE;
            Value := selected;
          END_GET
          SET
            VAR requested : DINT; END_VAR
            requested := Value;
            stored := requested;
          END_SET
        END_PROPERTY
      END_FUNCTION_BLOCK

      PROGRAM Main
        VAR fb : PatternValue; result : DINT; END_VAR
        fb.Value := 7;
        result := fb.Value;
      END_PROGRAM
    `;
    const result = compile(source);
    expect(result.success).toBe(true);

    const nativeResult = compileWithGpp({
      tempDir,
      pchPath,
      headerCode: result.headerCode,
      cppCode: result.cppCode,
      testName: "twincat_property_case_compat",
    });
    expect(nativeResult.success, nativeResult.error).toBe(true);
  });
});
