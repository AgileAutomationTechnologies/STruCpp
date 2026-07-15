// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2025 Autonomy / OpenPLC Project

import { describe, expect, it } from "vitest";
import { compile } from "../../src/index.js";
import { buildAST } from "../../src/frontend/ast-builder.js";
import type {
  AssignmentStatement,
  BinaryExpression,
} from "../../src/frontend/ast.js";
import { tokenize } from "../../src/frontend/lexer.js";
import { parse } from "../../src/frontend/parser.js";
import { SemanticAnalyzer } from "../../src/semantic/analyzer.js";

const PRECEDENCE_SOURCE = `
PROGRAM Main
  VAR
    a, b, c, d, result : BOOL;
  END_VAR
  result := a AND_THEN b OR_ELSE c AND_THEN d;
END_PROGRAM
`;

describe("TwinCAT short-circuit operators", () => {
  it("lexes complete case-insensitive keywords without splitting identifiers", () => {
    const result = tokenize(
      "AND_THEN and_then OR_ELSE or_else AND_THEN_VALUE OR_ELSEWHERE",
    );

    expect(result.errors).toHaveLength(0);
    expect(result.tokens.map((token) => token.tokenType.name)).toEqual([
      "AND_THEN",
      "AND_THEN",
      "OR_ELSE",
      "OR_ELSE",
      "Identifier",
      "Identifier",
    ]);
  });

  it("retains distinct AST operators at the existing AND and OR precedence", () => {
    const parsed = parse(PRECEDENCE_SOURCE);
    expect(parsed.errors).toHaveLength(0);
    const ast = buildAST(parsed.cst!, "short-circuit.st");
    const assignment = ast.programs[0]!.body[0] as AssignmentStatement;
    const root = assignment.value as BinaryExpression;

    expect(root.operator).toBe("OR_ELSE");
    expect((root.left as BinaryExpression).operator).toBe("AND_THEN");
    expect((root.right as BinaryExpression).operator).toBe("AND_THEN");
  });

  it("generates lazy C++ operators while retaining ordinary eager operators", () => {
    const source = `
PROGRAM Main
  VAR
    a, b, lazyAnd, lazyOr : BOOL;
    wa, wb, eagerAnd, eagerOr : WORD;
  END_VAR
  lazyAnd := a AND_THEN b;
  lazyOr := a OR_ELSE b;
  eagerAnd := wa AND wb;
  eagerOr := wa OR wb;
END_PROGRAM
`;
    const result = compile(source, { noDefaultLibs: true });

    expect(result.success, result.errors.map((error) => error.message).join("\n"))
      .toBe(true);
    expect(result.cppCode).toContain("LAZYAND = (A) && (B);");
    expect(result.cppCode).toContain("LAZYOR = (A) || (B);");
    expect(result.cppCode).toContain("EAGERAND = (WA) & (WB);");
    expect(result.cppCode).toContain("EAGEROR = (WA) | (WB);");
  });

  it("rejects non-BOOL operands with side-specific diagnostics", () => {
    const source = `
PROGRAM Main
  VAR
    flag : BOOL;
    count : INT;
    bits : WORD;
  END_VAR
  flag := count AND_THEN TRUE;
  flag := FALSE OR_ELSE bits;
END_PROGRAM
`;
    const parsed = parse(source);
    expect(parsed.errors).toHaveLength(0);
    const ast = buildAST(parsed.cst!, "invalid-short-circuit.st");
    const result = new SemanticAnalyzer().analyze(ast);
    const messages = result.errors.map((error) => error.message);

    expect(messages).toContain(
      "AND_THEN requires BOOL operands; left operand is INT",
    );
    expect(messages).toContain(
      "OR_ELSE requires BOOL operands; right operand is WORD",
    );
  });

  it("emits a lazily evaluated method call on the right-hand side", () => {
    const source = `
FUNCTION_BLOCK Probe
  VAR calls : INT; END_VAR
  METHOD PUBLIC Touch : BOOL
    calls := calls + 1;
    Touch := TRUE;
  END_METHOD
END_FUNCTION_BLOCK

PROGRAM Main
  VAR
    probeInstance : Probe;
    skippedAnd, evaluatedAnd, skippedOr, evaluatedOr : BOOL;
  END_VAR
  skippedAnd := FALSE AND_THEN probeInstance.Touch();
  evaluatedAnd := TRUE AND_THEN probeInstance.Touch();
  skippedOr := TRUE OR_ELSE probeInstance.Touch();
  evaluatedOr := FALSE OR_ELSE probeInstance.Touch();
END_PROGRAM
`;
    const result = compile(source, { noDefaultLibs: true });

    expect(result.success, result.errors.map((error) => error.message).join("\n"))
      .toBe(true);
    expect(result.cppCode).toContain("(false) && (PROBEINSTANCE.TOUCH())");
    expect(result.cppCode).toContain("(true) && (PROBEINSTANCE.TOUCH())");
    expect(result.cppCode).toContain("(true) || (PROBEINSTANCE.TOUCH())");
    expect(result.cppCode).toContain("(false) || (PROBEINSTANCE.TOUCH())");
  });
});
