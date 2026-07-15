# Trace 165 TwinCAT syntax compatibility

## Scope

- Remove the fixed lookahead limit that rejects realistic comma-separated,
  qualified `CASE` labels while retaining statement/label disambiguation.
- Parse `VAR` and `VAR_TEMP` declarations local to property `GET` and `SET`
  accessors.
- Carry accessor-local declarations through the AST, symbol scopes, type and
  undeclared-variable validation, traversal, and C++ generation.
- Add focused parser, AST, semantic, code-generation, and compile regressions.
- Ensure CLI test-mode temporary build directories are cleaned after passing,
  compiler-failing, and assertion-failing runs, with bounded Windows retries
  and a visible warning if cleanup remains impossible.
- Honor a host-provided `STRUCPP_TEST_TEMP_ROOT` for test-mode build files so a
  forcibly terminated compiler leaves recoverable artifacts inside the owning
  workspace; reject unusable roots with a visible, safe OS-temp fallback.

## Constraints

- Preserve eager `AND`/`OR` and all existing property behavior.
- Do not rewrite valid TwinCAT source to an avoidance syntax.
- Do not change package versions, tags, or release metadata.

## Release identity

After review and commit, TcGen packaging must publish this compiler delta as
`0.5.13-tcgen.2` and update the runtime lock/manifests to the resulting
immutable commit. The source `package.json` remains the upstream `0.5.13`.
