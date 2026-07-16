import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const CONTRACT_PATH = resolve(
  __dirname,
  "../../libs/iec-function-block-contracts.json",
);

function readContract() {
  return JSON.parse(readFileSync(CONTRACT_PATH, "utf8")) as {
    schema: string;
    contractVersion: string;
    library: { name: string; version: string; namespace: string };
    functionBlocks: Array<{
      name: string;
      inputs: Array<{ name: string; type: string; aliases?: string[] }>;
      outputs: Array<{ name: string; type: string; aliases?: string[] }>;
      inouts: Array<{ name: string; type: string; aliases?: string[] }>;
      dominance?: "set" | "reset";
    }>;
    identity: {
      algorithm: string;
      payloadSha256: string;
      payloadBytes: number;
    };
  };
}

describe("IEC function-block contract sidecar", () => {
  it("publishes versioned TwinCAT latch names and legacy aliases", () => {
    const contract = readContract();
    expect(contract.schema).toBe("tcgen-iec-function-block-contracts-v1");
    expect(contract.contractVersion).toBe("1.0.0");
    expect(contract.library).toEqual({
      name: "iec-standard-fb",
      version: "1.1.0",
      namespace: "strucpp",
    });

    const rs = contract.functionBlocks.find((fb) => fb.name === "RS");
    const sr = contract.functionBlocks.find((fb) => fb.name === "SR");
    expect(rs?.inputs).toEqual([
      { name: "SET", type: "BOOL", aliases: ["S"] },
      { name: "RESET1", type: "BOOL", aliases: ["R1"] },
    ]);
    expect(sr?.inputs).toEqual([
      { name: "SET1", type: "BOOL", aliases: ["S1"] },
      { name: "RESET", type: "BOOL", aliases: ["R"] },
    ]);
    expect(rs?.dominance).toBe("reset");
    expect(sr?.dominance).toBe("set");
  });

  it("binds the complete canonical payload to a reproducible SHA-256", () => {
    const contract = readContract();
    const { identity, ...payload } = contract;
    const canonicalPayload = JSON.stringify(payload);
    const sha256 = createHash("sha256")
      .update(canonicalPayload, "utf8")
      .digest("hex");

    expect(identity).toEqual({
      algorithm: "SHA-256",
      payloadSha256: sha256,
      payloadBytes: Buffer.byteLength(canonicalPayload, "utf8"),
    });

    const changedPayload = JSON.parse(JSON.stringify(payload)) as typeof payload;
    const rs = changedPayload.functionBlocks.find((fb) => fb.name === "RS");
    expect(rs).toBeDefined();
    rs!.dominance = "set";
    const changedSha256 = createHash("sha256")
      .update(JSON.stringify(changedPayload), "utf8")
      .digest("hex");
    expect(changedSha256).not.toBe(identity.payloadSha256);
  });
});
