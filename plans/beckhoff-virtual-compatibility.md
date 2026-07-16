# Beckhoff Virtual Compatibility Implementation

1. Migrate `.stlib` metadata and consumers to format v2, covering methods,
   properties, interfaces, inheritance, defaults, and complete public types.
2. Add a reproducible Beckhoff documentation catalog and exact coverage gate.
3. Add the `beckhoff-virtual` profile, shared simulator runtime, and generated
   Beckhoff-compatible libraries in priority-tier order until coverage is full.
4. Add fixture support to STruCPP test mode and integrate the profile and
   fixture provenance into `tcgen-st-test-mcp` packaging and reports.
5. Validate archive round trips, full-corpus compilation, simulator behavior,
   and packaged native execution while preserving pre-existing user changes.

The local `beckhoff_docs/index.json` snapshot is the API authority. General
topic and supplemental pragma pages receive explicit non-library dispositions;
all callable and type dependencies must resolve. External operations remain
deterministic and offline, with host file access restricted to the test sandbox.
