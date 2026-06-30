# basic_fb Default Library TOGGLE Collision

## Summary

`tests/st-validation/function_blocks/basic_fb.st` declares a `FUNCTION_BLOCK
Toggle`. With default bundled libraries enabled, OSCAT also contributes a
`TOGGLE` function block. Generated C++ is case-insensitive at the IEC symbol
level and emits both as `TOGGLE`, causing a redefinition.

## Current Workaround

Run the sample with default libraries disabled:

```powershell
node dist\node\cli.js tests\st-validation\function_blocks\basic_fb.st --no-default-libs --gpp C:\msys64\ucrt64\bin\g++.exe --test tests\st-validation\function_blocks\test_basic_fb.st
```

Use `fb_accumulator` as the default-library native test smoke:

```powershell
node dist\node\cli.js tests\st-validation\function_blocks\fb_accumulator.st --gpp C:\msys64\ucrt64\bin\g++.exe --test tests\st-validation\function_blocks\test_fb_accumulator.st
```

## Out Of Scope For The Windows Compiler Fix

The Windows `--gpp` environment fix only ensures MinGW helper processes and
test binaries can load their DLLs. It does not change library symbol shadowing
or default library reachability semantics.
