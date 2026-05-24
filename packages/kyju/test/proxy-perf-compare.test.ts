/**
 * Direct A/B perf comparison: overlay-based recording proxy vs.
 * the old JSON.parse(JSON.stringify(...)) clone approach. This is
 * an informational test — it prints numbers and asserts a generous
 * speedup so the test only fails if the overlay path is somehow
 * worse than the clone path (which would be a real regression).
 */
import { describe, it, expect } from "vitest";
import { createRecordingProxy } from "../src/v2/client/proxy";

const buildBigRoot = () => {
  const big: Record<string, unknown> = {};
  for (let i = 0; i < 10_000; i++) {
    big[`k${i}`] = {
      a: { b: { c: { d: i } } },
      tag: `tag-${i}`,
      arr: [i, i + 1, i + 2, i + 3, i + 4],
    };
  }
  return big;
};

const time = (label: string, fn: () => void, iters: number) => {
  // warmup
  for (let i = 0; i < 5; i++) fn();
  const start = performance.now();
  for (let i = 0; i < iters; i++) fn();
  const total = performance.now() - start;
  const per = total / iters;
  // eslint-disable-next-line no-console
  console.log(`[perf] ${label}: ${per.toFixed(3)} ms/call (${iters} iters)`);
  return per;
};

describe("recording proxy perf — overlay vs deep clone", () => {
  it("overlay is dramatically faster than JSON.parse(JSON.stringify(root))", () => {
    const big = buildBigRoot();
    const ITERS = 50;

    const cloneCost = time(
      "JSON.parse(JSON.stringify(big))",
      () => {
        const snapshot = JSON.parse(JSON.stringify(big));
        void snapshot;
      },
      ITERS,
    );

    const overlayCost = time(
      "createRecordingProxy(big) + 1 set + getOperations",
      () => {
        const { proxy, getOperations } = createRecordingProxy(big);
        (proxy as any).k0 = (proxy as any).k0;
        getOperations();
      },
      ITERS,
    );

    // The whole point of the overlay rewrite. If the overlay path
    // is somehow as slow as a full deep clone, something regressed.
    expect(overlayCost).toBeLessThan(cloneCost / 5);
  });
});
