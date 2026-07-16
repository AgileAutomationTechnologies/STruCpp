import { describe, expect, it } from "vitest";
import { parseBeckhoffVirtualFixture } from "../../src/testing/virtual-fixture.js";
import { generateBeckhoffVirtualFixtureHeader } from "../../src/node/virtual-fixture.js";

describe("Beckhoff virtual fixtures", () => {
  it("validates resources and emits deterministic reset code", () => {
    const fixture = parseBeckhoffVirtualFixture({
      schemaVersion: 1,
      profile: "beckhoff-virtual-v1",
      scanPeriodNanoseconds: 2_000_000,
      resources: [
        { kind: "adsSymbol", key: "1.2.3.4.5.6:851|MAIN.value", value: 7 },
        { kind: "motionAxis", key: "1001", ads: 1001, position: 12.5 },
      ],
      faults: [
        {
          target: "Tc2_MC2.MC_MoveAbsolute",
          callNumber: 2,
          delayScans: 3,
          errorId: 0xf0000005,
        },
      ],
    });
    const header = generateBeckhoffVirtualFixtureHeader(fixture);
    expect(header).toContain("environment.clear()");
    expect(header).toContain("environment.baselineResources");
    expect(header).toContain("Tc2_MC2.MC_MoveAbsolute");
    expect(header).toContain("environment.reset()");
    expect(header).toContain("strucpp::__CURRENT_TIME_NS");
  });

  it("rejects unknown resource kinds and malformed fault targets", () => {
    expect(() =>
      parseBeckhoffVirtualFixture({
        schemaVersion: 1,
        profile: "beckhoff-virtual-v1",
        resources: [{ kind: "hostProcess", key: "danger" }],
      }),
    ).toThrow(/unsupported/);
    expect(() =>
      parseBeckhoffVirtualFixture({
        schemaVersion: 1,
        profile: "beckhoff-virtual-v1",
        faults: [{ target: "invalid" }],
      }),
    ).toThrow(/target is invalid/);
    expect(() =>
      parseBeckhoffVirtualFixture({
        schemaVersion: 1,
        profile: "beckhoff-virtual-v1",
        resources: [{ kind: "sandboxFile", key: "..\\host.txt" }],
      }),
    ).toThrow(/traverse/);
  });
});
