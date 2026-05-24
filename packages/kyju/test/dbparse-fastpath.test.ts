/**
 * Behavioral spec for the `dbParse` fast path.
 *
 * `dbParse` historically ran `JSON.parse` with a reviver that scans
 * every value for two binary-encoding shapes (the `__$u8` Uint8Array
 * tag emitted by `dbStringify`, and Node `Buffer.toJSON()` output).
 * The reviver is called once per key in the parsed tree, which makes
 * parsing 2\u20135\u00d7 slower than a bare `JSON.parse`.
 *
 * The fast path skips the reviver when neither marker substring is
 * present in the raw text. These tests pin down:
 *
 *   1. The fast path returns identical results to a reviver-using
 *      parse for any payload that contains neither marker.
 *   2. Payloads with binary markers still go through the reviver and
 *      decode correctly (Uint8Array, Buffer shape).
 *   3. User strings that look like markers (escaped or contained
 *      inside other strings) don't trick the scanner into producing
 *      a wrong result \u2014 because the slow path is still safe, the
 *      worst case is "took the slow path unnecessarily", never "got
 *      a wrong value".
 *   4. The fast path is meaningfully faster than the slow path on
 *      realistic-sized payloads.
 */
import { describe, it, expect } from "vitest";
import { dbStringify, dbParse } from "../src/v2/transport";

// A reference parser that ALWAYS runs the reviver \u2014 i.e. exactly what
// `dbParse` did before the fast path was added. We compare against this
// to prove the fast path never disagrees.
const UINT8_TAG = "__$u8";
function dbParseReference(text: string): any {
  return JSON.parse(text, (_key, val) => {
    if (val !== null && typeof val === "object") {
      if (UINT8_TAG in val) {
        const binary = atob(val[UINT8_TAG]);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
        return bytes;
      }
      if (val.type === "Buffer" && Array.isArray(val.data)) {
        return new Uint8Array(val.data);
      }
    }
    return val;
  });
}

describe("dbParse fast path", () => {
  describe("equivalence to reference parser", () => {
    const cases: Array<[string, unknown]> = [
      ["null", null],
      ["primitive number", 42],
      ["primitive string", "hello"],
      ["empty object", {}],
      ["empty array", []],
      ["nested object", { a: { b: { c: 1 } }, d: [1, 2, 3] }],
      [
        "realistic write-batch shape",
        {
          kind: "write-batch",
          ops: [
            { type: "root.set", path: ["app", "count"], value: 7 },
            { type: "root.set", path: ["app", "name"], value: "alice" },
            {
              type: "root.set",
              path: ["app", "todos"],
              value: [
                { id: "a", title: "first", done: false },
                { id: "b", title: "second", done: true },
              ],
            },
          ],
        },
      ],
      [
        "string values containing JSON-meaningful chars",
        {
          message: 'he said "hi" \\ then left',
          path: "/a/b/c",
          unicode: "\u2603 \u00e9 \uD83D\uDC4B",
        },
      ],
      ["array of mixed primitives", [1, "two", 3.14, true, false, null]],
      [
        "deeply nested arrays",
        [[[[[1, 2], [3, 4]], [[5, 6], [7, 8]]]]],
      ],
    ];

    for (const [name, value] of cases) {
      it(`fast path matches reference for: ${name}`, () => {
        const text = dbStringify(value);
        expect(dbParse(text)).toEqual(dbParseReference(text));
      });
    }
  });

  describe("strings that look like markers but aren't", () => {
    /**
     * A user string that LITERALLY contains the marker chars
     * `__$u8` triggers the slow path (false positive), but the
     * slow path's reviver only transforms objects whose own key
     * actually equals `__$u8`. So the parsed result is still
     * correct \u2014 it's just plain user data with a funny substring.
     */
    it("user string containing __$u8 round-trips intact", () => {
      const value = { note: "my key is __$u8 and that's fine" };
      const text = dbStringify(value);
      const out = dbParse(text);
      expect(out).toEqual(value);
      expect(typeof out.note).toBe("string");
    });

    /**
     * Inside a JSON string, `"` is escaped to `\"`, so a user
     * string containing the literal characters `"type":"Buffer"`
     * encodes as `\"type\":\"Buffer\"` and won't match the raw
     * `"type":"Buffer"` substring \u2014 fast path is correct.
     */
    it("user string containing escaped quotes around type:Buffer is not misread", () => {
      const value = { note: 'someone wrote "type":"Buffer" in their bio' };
      const text = dbStringify(value);
      // Sanity-check that the encoded form does NOT contain the raw
      // marker (so we'll take the fast path), but still round-trips.
      expect(text.includes('"type":"Buffer"')).toBe(false);
      expect(dbParse(text)).toEqual(value);
    });

    it("user object literally shaped like a Buffer ({type:'Buffer', data:[...]}) is still parsed identically by both paths", () => {
      // This shape will be DECODED into a Uint8Array by both the fast
      // and slow paths \u2014 the fast path detects the marker substring
      // and takes the slow path. This matches existing pre-fast-path
      // behavior; we lock it in so the fast path can't silently
      // produce a different result.
      const text = JSON.stringify({ payload: { type: "Buffer", data: [1, 2, 3] } });
      const fast = dbParse(text);
      const slow = dbParseReference(text);
      expect(fast).toEqual(slow);
      expect(fast.payload).toBeInstanceOf(Uint8Array);
      expect(Array.from(fast.payload)).toEqual([1, 2, 3]);
    });
  });

  describe("payloads with binary markers still decode", () => {
    it("Uint8Array round-trips through dbStringify \u2192 dbParse", () => {
      const bytes = new Uint8Array([1, 2, 3, 4, 5]);
      const value = { kind: "blob.create", data: bytes };
      const text = dbStringify(value);
      // The marker MUST be in the serialized text (so we take the slow path).
      expect(text.includes(UINT8_TAG)).toBe(true);
      const out = dbParse(text);
      expect(out.kind).toBe("blob.create");
      expect(out.data).toBeInstanceOf(Uint8Array);
      expect(Array.from(out.data)).toEqual([1, 2, 3, 4, 5]);
    });

    it("nested Uint8Arrays decode correctly", () => {
      const value = {
        outer: {
          a: new Uint8Array([0, 1, 2]),
          b: new Uint8Array([255, 254]),
        },
      };
      const text = dbStringify(value);
      const out = dbParse(text);
      expect(out.outer.a).toBeInstanceOf(Uint8Array);
      expect(Array.from(out.outer.a)).toEqual([0, 1, 2]);
      expect(Array.from(out.outer.b)).toEqual([255, 254]);
    });

    it("empty Uint8Array round-trips", () => {
      const value = { data: new Uint8Array([]) };
      const text = dbStringify(value);
      const out = dbParse(text);
      expect(out.data).toBeInstanceOf(Uint8Array);
      expect(out.data.length).toBe(0);
    });
  });

  describe("fast path is faster than slow path", () => {
    it("on a realistic large payload, the fast path is meaningfully faster", () => {
      // Build a payload that resembles a fat write-batch event.
      const ops: unknown[] = [];
      for (let i = 0; i < 500; i++) {
        ops.push({
          type: "root.set",
          path: ["app", "todos", String(i)],
          value: {
            id: `t-${i}`,
            title: `Todo number ${i}`,
            description:
              "Some longer description text so the payload has real weight.",
            tags: ["alpha", "beta", "gamma"],
            done: i % 3 === 0,
            createdAt: 1_700_000_000_000 + i,
          },
        });
      }
      const value = { kind: "write-batch", ops };
      const text = dbStringify(value);
      // Sanity: must be a "fast path eligible" payload.
      expect(text.includes(UINT8_TAG)).toBe(false);
      expect(text.includes('"type":"Buffer"')).toBe(false);

      const time = (label: string, fn: () => void, iters: number) => {
        for (let i = 0; i < 3; i++) fn();
        const start = performance.now();
        for (let i = 0; i < iters; i++) fn();
        const total = performance.now() - start;
        const per = total / iters;
        // eslint-disable-next-line no-console
        console.log(`[perf] ${label}: ${per.toFixed(3)} ms/call`);
        return per;
      };

      const slow = time("reference dbParse (with reviver)", () => {
        dbParseReference(text);
      }, 50);
      const fast = time("dbParse fast path", () => {
        dbParse(text);
      }, 50);

      // Generous bound \u2014 in practice we expect ~2\u20135\u00d7. We only assert
      // a clear improvement to avoid flakiness on slow CI machines.
      expect(fast).toBeLessThan(slow);
    });
  });
});
