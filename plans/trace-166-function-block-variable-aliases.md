# Trace 166 function-block variable aliases

1. Extend the generic library manifest and symbol model with validated,
   case-insensitive aliases that resolve to one canonical FB variable.
2. Canonicalize named FB arguments and direct member access before C++
   emission, and report invalid or duplicate formal assignments in ST.
3. Describe the TwinCAT RS/SR spellings only in the standard-library
   configuration while keeping the compiler mechanism vendor-neutral.
4. Generate and package a deterministic IEC function-block contract with a
   verifiable SHA-256 identity.
5. Cover manifest validation, code generation, diagnostics, behavior,
   contract generation, downstream version injection, and CI routing.
