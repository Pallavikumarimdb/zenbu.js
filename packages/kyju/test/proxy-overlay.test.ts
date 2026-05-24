/**
 * Behavioral spec for the overlay-based recording proxy.
 *
 * The previous proxy `JSON.parse(JSON.stringify(target))`-cloned the
 * whole root, then proxied + mutated the clone. The new proxy keeps
 * the live target untouched and stores writes/deletes in a flat
 * overlay. These tests pin down the contracts that change (or that
 * we need to keep stable) under that switch:
 *
 *   1. The live `target` argument is never mutated by anything the
 *      caller does through the proxy.
 *   2. Reads through the proxy honor pending writes/deletes done in
 *      the same `update()` callback (read-after-write).
 *   3. Iteration (`Object.keys`, `for..of`, `JSON.stringify`,
 *      spread) reflects the overlay, including deletes.
 *   4. Recorded ops match what the previous implementation produced
 *      so the wire format / replica behavior is unchanged.
 *   5. Array mutations (push/splice/sort/length) collapse to a
 *      single `root.set` of the materialized array, same as before.
 *   6. Cost does not scale with root size — verified by passing a
 *      pathologically large root and checking that construction is
 *      fast.
 */
import { describe, it, expect } from "vitest";
import { createRecordingProxy } from "../src/v2/client/proxy";

describe("recording proxy (overlay)", () => {
  describe("does not mutate the live target", () => {
    it("set on an object does not mutate the original object", () => {
      const target = { a: { x: 1 } };
      const original = target.a;
      const { proxy } = createRecordingProxy(target);

      proxy.a.x = 99;

      expect(target.a).toBe(original);
      expect(target.a.x).toBe(1);
    });

    it("delete on an object does not mutate the original object", () => {
      const target = { a: { x: 1, y: 2 } as Record<string, number> };
      const { proxy } = createRecordingProxy(target);

      delete (proxy.a as Record<string, number>).x;

      expect(target.a).toEqual({ x: 1, y: 2 });
    });

    it("push on an array does not mutate the original array", () => {
      const target = { arr: [1, 2, 3] };
      const originalArr = target.arr;
      const { proxy } = createRecordingProxy(target);

      (proxy.arr as number[]).push(4);

      expect(target.arr).toBe(originalArr);
      expect(target.arr).toEqual([1, 2, 3]);
    });

    it("assigning a fresh object to a key does not mutate the original", () => {
      const target = { a: { x: 1 } as Record<string, unknown> };
      const { proxy } = createRecordingProxy(target);

      (proxy as any).a = { x: 999, y: 0 };

      expect(target.a).toEqual({ x: 1 });
    });
  });

  describe("read-after-write inside a single update callback", () => {
    it("reading a written primitive returns the new value", () => {
      const { proxy } = createRecordingProxy({ count: 1 });
      proxy.count = 5;
      expect(proxy.count).toBe(5);
    });

    it("count++ semantics work (read, then write, then read)", () => {
      const { proxy } = createRecordingProxy({ count: 0 });
      (proxy as any).count++;
      (proxy as any).count++;
      (proxy as any).count++;
      expect(proxy.count).toBe(3);
    });

    it("writing a nested object then reading it reflects the new value", () => {
      const target = { app: { greeting: "hi" } } as any;
      const { proxy } = createRecordingProxy(target);
      proxy.app = { greeting: "hello", extra: 1 };
      expect(proxy.app.greeting).toBe("hello");
      expect(proxy.app.extra).toBe(1);
    });

    it("write at a prefix shadows reads at deeper paths", () => {
      const target = { app: { a: 1, b: 2 } } as any;
      const { proxy } = createRecordingProxy(target);
      proxy.app = { a: 10 };
      expect(proxy.app.a).toBe(10);
      // `b` was clobbered by replacing the whole `app`.
      expect(proxy.app.b).toBeUndefined();
    });

    it("delete then read returns undefined", () => {
      const target = { records: { a: 1, b: 2 } as Record<string, number> };
      const { proxy } = createRecordingProxy(target);
      delete (proxy.records as Record<string, number>).a;
      expect((proxy.records as Record<string, number>).a).toBeUndefined();
      expect("a" in (proxy.records as Record<string, number>)).toBe(false);
    });

    it("delete then re-set reads as the new value", () => {
      const target = { records: { a: 1 } as Record<string, number> };
      const { proxy } = createRecordingProxy(target);
      delete (proxy.records as Record<string, number>).a;
      (proxy.records as Record<string, number>).a = 99;
      expect((proxy.records as Record<string, number>).a).toBe(99);
      expect("a" in (proxy.records as Record<string, number>)).toBe(true);
    });
  });

  describe("iteration honors the overlay", () => {
    it("Object.keys reflects deletes", () => {
      const target = { records: { a: 1, b: 2, c: 3 } as Record<string, number> };
      const { proxy } = createRecordingProxy(target);
      delete (proxy.records as Record<string, number>).b;
      expect(Object.keys(proxy.records).sort()).toEqual(["a", "c"]);
    });

    it("Object.keys reflects added keys", () => {
      const target = { records: { a: 1 } as Record<string, number> };
      const { proxy } = createRecordingProxy(target);
      (proxy.records as Record<string, number>).b = 2;
      expect(Object.keys(proxy.records).sort()).toEqual(["a", "b"]);
    });

    it("JSON.stringify reflects writes and deletes", () => {
      const target = {
        app: { a: 1, b: 2 } as Record<string, number>,
      };
      const { proxy } = createRecordingProxy(target);
      (proxy.app as Record<string, number>).a = 10;
      delete (proxy.app as Record<string, number>).b;
      (proxy.app as Record<string, number>).c = 3;
      expect(JSON.parse(JSON.stringify(proxy))).toEqual({
        app: { a: 10, c: 3 },
      });
    });

    it("for..of on a mutated array iterates the overlay state", () => {
      const target = { arr: [1, 2, 3] };
      const { proxy } = createRecordingProxy(target);
      (proxy.arr as number[]).push(4);
      const out: number[] = [];
      for (const v of proxy.arr as number[]) out.push(v);
      expect(out).toEqual([1, 2, 3, 4]);
    });

    it("array spread reflects the overlay", () => {
      const target = { arr: [1, 2, 3] };
      const { proxy } = createRecordingProxy(target);
      (proxy.arr as number[]).push(4);
      (proxy.arr as number[])[0] = 99;
      expect([...(proxy.arr as number[])]).toEqual([99, 2, 3, 4]);
    });

    it("array length reflects writes", () => {
      const target = { arr: [1, 2, 3] };
      const { proxy } = createRecordingProxy(target);
      (proxy.arr as number[]).push(4);
      expect((proxy.arr as number[]).length).toBe(4);
    });

    it("for..in honors deletes", () => {
      const target = { o: { a: 1, b: 2 } as Record<string, number> };
      const { proxy } = createRecordingProxy(target);
      delete (proxy.o as Record<string, number>).a;
      const keys: string[] = [];
      for (const k in proxy.o) keys.push(k);
      expect(keys).toEqual(["b"]);
    });
  });

  describe("recorded ops match expected shape", () => {
    it("a single primitive set records one set op", () => {
      const { proxy, getOperations } = createRecordingProxy({ a: { b: 1 } });
      proxy.a.b = 2;
      expect(getOperations()).toEqual([
        { kind: "set", path: ["a", "b"], value: 2 },
      ]);
    });

    it("a delete records one delete op", () => {
      const { proxy, getOperations } = createRecordingProxy({
        records: { a: 1, b: 2 } as Record<string, number>,
      });
      delete (proxy.records as Record<string, number>).a;
      expect(getOperations()).toEqual([
        { kind: "delete", path: ["records", "a"] },
      ]);
    });

    it("multiple writes record in order", () => {
      const { proxy, getOperations } = createRecordingProxy({
        x: 0,
        y: 0,
        z: 0,
      });
      proxy.x = 1;
      proxy.y = 2;
      proxy.z = 3;
      expect(getOperations()).toEqual([
        { kind: "set", path: ["x"], value: 1 },
        { kind: "set", path: ["y"], value: 2 },
        { kind: "set", path: ["z"], value: 3 },
      ]);
    });

    it("array push records exactly one root.set of the new array", () => {
      const { proxy, getOperations } = createRecordingProxy({
        arr: [1, 2, 3],
      });
      (proxy.arr as number[]).push(4);
      const ops = getOperations();
      expect(ops).toHaveLength(1);
      expect(ops[0]).toEqual({
        kind: "set",
        path: ["arr"],
        value: [1, 2, 3, 4],
      });
    });

    it("array splice records one root.set of the spliced array", () => {
      const { proxy, getOperations } = createRecordingProxy({
        arr: [1, 2, 3, 4, 5],
      });
      (proxy.arr as number[]).splice(1, 2);
      const ops = getOperations();
      expect(ops).toHaveLength(1);
      expect(ops[0]).toEqual({
        kind: "set",
        path: ["arr"],
        value: [1, 4, 5],
      });
    });

    it("array sort records one root.set of the sorted array", () => {
      const { proxy, getOperations } = createRecordingProxy({
        arr: [3, 1, 4, 1, 5, 9, 2, 6],
      });
      (proxy.arr as number[]).sort((a, b) => a - b);
      const ops = getOperations();
      expect(ops).toHaveLength(1);
      expect(ops[0]).toEqual({
        kind: "set",
        path: ["arr"],
        value: [1, 1, 2, 3, 4, 5, 6, 9],
      });
    });

    it("array reverse records one root.set of the reversed array", () => {
      const { proxy, getOperations } = createRecordingProxy({
        arr: ["a", "b", "c"],
      });
      (proxy.arr as string[]).reverse();
      const ops = getOperations();
      expect(ops).toHaveLength(1);
      expect(ops[0]).toEqual({
        kind: "set",
        path: ["arr"],
        value: ["c", "b", "a"],
      });
    });

    it("writing then deleting a key emits both ops in order", () => {
      const { proxy, getOperations } = createRecordingProxy({
        o: { a: 1 } as Record<string, number>,
      });
      (proxy.o as Record<string, number>).b = 2;
      delete (proxy.o as Record<string, number>).a;
      expect(getOperations()).toEqual([
        { kind: "set", path: ["o", "b"], value: 2 },
        { kind: "delete", path: ["o", "a"] },
      ]);
    });

    it("no writes ⇒ no ops", () => {
      const { proxy, getOperations } = createRecordingProxy({ a: 1 });
      void proxy.a; // read only
      expect(getOperations()).toEqual([]);
    });

    it("deleting a missing key emits no op", () => {
      const { proxy, getOperations } = createRecordingProxy({
        o: { a: 1 } as Record<string, unknown>,
      });
      delete (proxy.o as Record<string, unknown>).missing;
      expect(getOperations()).toEqual([]);
    });

    it("deeply nested set records the full path", () => {
      const { proxy, getOperations } = createRecordingProxy({
        a: { b: { c: { d: 1 } } },
      });
      proxy.a.b.c.d = 99;
      expect(getOperations()).toEqual([
        { kind: "set", path: ["a", "b", "c", "d"], value: 99 },
      ]);
    });
  });

  describe("array index writes", () => {
    it("writing arr[i] records a single root.set with the new array", () => {
      const { proxy, getOperations } = createRecordingProxy({
        arr: [10, 20, 30],
      });
      (proxy.arr as number[])[1] = 99;
      const ops = getOperations();
      expect(ops).toHaveLength(1);
      expect(ops[0]).toEqual({
        kind: "set",
        path: ["arr"],
        value: [10, 99, 30],
      });
    });

    it("setting length truncates the materialized array", () => {
      const { proxy, getOperations } = createRecordingProxy({
        arr: [1, 2, 3, 4, 5],
      });
      (proxy.arr as number[]).length = 2;
      const ops = getOperations();
      expect(ops).toHaveLength(1);
      expect((ops[0] as any).value).toEqual([1, 2]);
    });

    it("nested arrays materialize correctly", () => {
      const { proxy, getOperations } = createRecordingProxy({
        outer: [
          [1, 2],
          [3, 4],
        ],
      });
      (proxy.outer as number[][])[0]!.push(99);
      const ops = getOperations();
      // The inner array is "dirty" — we ship the inner array verbatim.
      // (Containing array's identity didn't change at this path so we
      // don't need to ship `outer` itself.)
      expect(ops).toHaveLength(1);
      expect(ops[0]).toEqual({
        kind: "set",
        path: ["outer", "0"],
        value: [1, 2, 99],
      });
    });
  });

  describe("snapshot field", () => {
    it("snapshot reflects writes and deletes (overlay view)", () => {
      const target = {
        records: {
          a: { id: "a" },
          b: { id: "b" },
        } as Record<string, { id: string }>,
      };
      const { proxy, snapshot } = createRecordingProxy(target);
      delete (proxy.records as Record<string, unknown>).b;
      expect(snapshot.records).toEqual({ a: { id: "a" } });
    });

    it("snapshot doesn't expose the live target's deleted keys", () => {
      const target = { a: 1, b: 2 };
      const { proxy, snapshot } = createRecordingProxy(target);
      delete (proxy as any).b;
      expect(JSON.parse(JSON.stringify(snapshot))).toEqual({ a: 1 });
    });
  });

  describe("isOwnedProxy / materialize helpers", () => {
    it("isOwnedProxy is true for proxy and its descendants", () => {
      const { proxy, isOwnedProxy } = createRecordingProxy({
        a: { b: { c: 1 } },
      });
      expect(isOwnedProxy(proxy)).toBe(true);
      expect(isOwnedProxy(proxy.a)).toBe(true);
      expect(isOwnedProxy(proxy.a.b)).toBe(true);
      expect(isOwnedProxy({})).toBe(false);
      expect(isOwnedProxy(null)).toBe(false);
      expect(isOwnedProxy(42)).toBe(false);
    });

    it("materialize on the root proxy returns a plain JSON view of the overlay", () => {
      const { proxy, materialize } = createRecordingProxy({
        a: 1,
        b: { x: 1 } as Record<string, number>,
      });
      (proxy.b as Record<string, number>).x = 99;
      (proxy.b as Record<string, number>).y = 2;
      const m = materialize(proxy) as any;
      expect(m).toEqual({ a: 1, b: { x: 99, y: 2 } });
      // and the result is plain, not a proxy
      expect(Object.getPrototypeOf(m)).toBe(Object.prototype);
      expect(Object.getPrototypeOf(m.b)).toBe(Object.prototype);
    });

    it("materialize passes plain values through unchanged", () => {
      const { materialize } = createRecordingProxy({ a: 1 });
      expect(materialize({ foo: 1 })).toEqual({ foo: 1 });
      expect(materialize(42)).toBe(42);
      expect(materialize("hi")).toBe("hi");
      expect(materialize(null)).toBe(null);
    });
  });

  describe("does not scale with root size", () => {
    /**
     * Build a deliberately-large root: 10k top-level keys, each a
     * nested object 4 levels deep with some primitive leaves. The
     * previous implementation deep-cloned this on every
     * `createRecordingProxy` call; the new implementation should be
     * effectively free.
     *
     * We assert a generous upper bound on a "no-op" recording proxy
     * to catch regressions to a full clone strategy.
     */
    it("creating a proxy over a huge root is fast and does not allocate a deep clone", () => {
      const big: Record<string, unknown> = {};
      for (let i = 0; i < 10_000; i++) {
        big[`k${i}`] = {
          a: { b: { c: { d: i } } },
          tag: `tag-${i}`,
          arr: [i, i + 1, i + 2, i + 3, i + 4],
        };
      }
      // Warmup so jit doesn't dominate the measurement.
      for (let i = 0; i < 5; i++) {
        const { proxy } = createRecordingProxy(big);
        void proxy;
      }

      const start = performance.now();
      const ITERS = 100;
      for (let i = 0; i < ITERS; i++) {
        const { proxy, getOperations } = createRecordingProxy(big);
        // touch one key to make sure we're not optimized away
        proxy.k0 = (proxy.k0 as any);
        getOperations();
      }
      const elapsed = performance.now() - start;
      const perCall = elapsed / ITERS;
      // For reference, a JSON.parse(JSON.stringify) of this root
      // takes ~60ms on the dev machine that triggered this work.
      // Overlay construction should be sub-millisecond. Give it
      // generous headroom for CI variance.
      expect(perCall).toBeLessThan(5);
    });
  });

  describe("realistic update scenarios", () => {
    it("counter increment", () => {
      const { proxy, getOperations } = createRecordingProxy({
        app: { count: 7 },
      });
      proxy.app.count = proxy.app.count + 1;
      expect(getOperations()).toEqual([
        { kind: "set", path: ["app", "count"], value: 8 },
      ]);
    });

    it("push to a todo list", () => {
      const target = {
        app: { todos: [{ id: "a", title: "first" }] },
      };
      const { proxy, getOperations } = createRecordingProxy(target);
      (proxy.app.todos as any[]).push({ id: "b", title: "second" });
      const ops = getOperations();
      expect(ops).toHaveLength(1);
      expect(ops[0]).toEqual({
        kind: "set",
        path: ["app", "todos"],
        value: [
          { id: "a", title: "first" },
          { id: "b", title: "second" },
        ],
      });
      // Live target untouched.
      expect(target.app.todos).toEqual([{ id: "a", title: "first" }]);
    });

    it("remove an entry from a record then add a different one", () => {
      const target = {
        records: {
          a: { id: "a", token: "tok-a" },
          b: { id: "b", token: "tok-b" },
        } as Record<string, { id: string; token: string }>,
      };
      const { proxy, getOperations } = createRecordingProxy(target);
      delete (proxy.records as Record<string, unknown>).a;
      (proxy.records as Record<string, { id: string; token: string }>).c = {
        id: "c",
        token: "tok-c",
      };
      expect(getOperations()).toEqual([
        { kind: "delete", path: ["records", "a"] },
        {
          kind: "set",
          path: ["records", "c"],
          value: { id: "c", token: "tok-c" },
        },
      ]);
      // Reads through the proxy reflect the overlay state.
      expect(Object.keys(proxy.records).sort()).toEqual(["b", "c"]);
    });

    it("replace a subtree then keep reading inside it", () => {
      const target = { app: { user: { name: "alice", age: 30 } } } as any;
      const { proxy } = createRecordingProxy(target);
      proxy.app.user = { name: "bob", age: 31, extra: true };
      expect(proxy.app.user.name).toBe("bob");
      expect(proxy.app.user.extra).toBe(true);
      // Original is untouched.
      expect(target.app.user).toEqual({ name: "alice", age: 30 });
    });
  });
});
