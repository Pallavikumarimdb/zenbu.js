/**
 * Behavioral spec for the draft-model recording proxy.
 *
 * The previous global-overlay implementation hit
 * `RangeError: Maximum call stack size exceeded` in the wild on
 * startup, with a `lookup → has → lookup → has` trace. The cause:
 * a single global `lookup(path)` walked through `target` with
 * `path[i] in cur`, and if `cur` ever ended up being one of the
 * recorder's own proxies (easy to trigger if a proxy lands in the
 * writes overlay or the live root), `in` fired the `has` trap, which
 * re-entered `lookup`, and so on.
 *
 * The draft model fixes this by giving each proxy its own local
 * Draft { base, copy }, and having every trap read from
 * `copy ?? base` directly. No global path traversal, no cross-proxy
 * re-entry. These tests pin down the cases that broke the old
 * implementation, plus a few new contracts the draft model gives us
 * for free (stable child identity, structural sharing).
 */
import { describe, it, expect } from "vitest";
import { createRecordingProxy } from "../src/v2/client/proxy";

describe("recording proxy (draft model)", () => {
  describe("no infinite recursion through traps", () => {
    it("assigning a child node to one of its siblings doesn't loop", () => {
      // The old overlay stored proxy values in its writes map; a
      // subsequent `lookup` would walk into the stored proxy and
      // re-enter `has`. The draft model peels proxies on write, so
      // the stored value is always a plain snapshot.
      const target = { a: { x: 1, y: 2 }, b: { z: 3 } } as any;
      const { proxy, getOperations } = createRecordingProxy(target);
      proxy.a = proxy.b;
      expect(proxy.a).toEqual({ z: 3 });
      // And `has` on the resulting proxy doesn't recurse.
      expect("z" in proxy.a).toBe(true);
      expect("missing" in proxy.a).toBe(false);
      // Op emitted with a plain snapshot of `b`, not a proxy.
      const ops = getOperations();
      expect(ops).toEqual([{ kind: "set", path: ["a"], value: { z: 3 } }]);
    });

    it("self-assignment doesn't loop (root.a = root.a)", () => {
      const target = { a: { x: 1 } } as any;
      const { proxy } = createRecordingProxy(target);
      proxy.a = proxy.a;
      expect(proxy.a).toEqual({ x: 1 });
      expect("x" in proxy.a).toBe(true);
    });

    it("repeated has checks on the same proxy stay O(1)", () => {
      const target = { records: { a: 1, b: 2, c: 3 } } as any;
      const { proxy } = createRecordingProxy(target);
      for (let i = 0; i < 10000; i++) {
        expect("a" in proxy.records).toBe(true);
        expect("missing" in proxy.records).toBe(false);
      }
    });

    it("walking a deeply nested chain doesn't blow the stack", () => {
      // Build a chain 200 levels deep — way beyond what a recursive
      // `has → lookup → has` pattern would tolerate.
      let leaf: any = { val: "done" };
      for (let i = 0; i < 200; i++) leaf = { next: leaf };
      const { proxy } = createRecordingProxy({ chain: leaf } as any);
      let cur: any = proxy.chain;
      for (let i = 0; i < 200; i++) cur = cur.next;
      expect(cur.val).toBe("done");
    });
  });

  describe("stable child identity", () => {
    // The previous implementation returned a *fresh* Proxy on every
    // `get`, so `root.app === root.app` was false. That breaks
    // identity-based caching (React memo, Set/Map keys, ===).
    it("reading the same child twice returns the same proxy", () => {
      const { proxy } = createRecordingProxy({ app: { a: 1 } } as any);
      const ref1 = proxy.app;
      const ref2 = proxy.app;
      expect(ref1).toBe(ref2);
    });

    it("nested identity is stable", () => {
      const { proxy } = createRecordingProxy({
        a: { b: { c: { d: 1 } } },
      } as any);
      expect(proxy.a.b.c).toBe(proxy.a.b.c);
      expect(proxy.a.b).toBe(proxy.a.b);
    });

    it("identity is invalidated when the parent's value at that key is replaced", () => {
      const { proxy } = createRecordingProxy({ a: { x: 1 } } as any);
      const before = proxy.a;
      proxy.a = { x: 2, y: 3 };
      const after = proxy.a;
      expect(after).not.toBe(before);
      expect(after).toEqual({ x: 2, y: 3 });
    });
  });

  describe("nested writes propagate correctly", () => {
    it("writing 3 levels deep marks ancestors modified without copying them eagerly", () => {
      const target = {
        big: { keepMe: true, more: { stuff: 1 } },
        app: { user: { name: "alice" } },
      } as any;
      const { proxy, materialize } = createRecordingProxy(target);
      proxy.app.user.name = "bob";

      // Live target untouched.
      expect(target.app.user.name).toBe("alice");
      expect(target.big.keepMe).toBe(true);

      // The materialized root has the new value AND keeps the
      // untouched subtree === to the original (structural sharing).
      const m = materialize(proxy) as typeof target;
      expect(m.app.user.name).toBe("bob");
      expect(m.big).toBe(target.big);
    });

    it("structural sharing: unmodified subtrees keep === identity", () => {
      const target = {
        a: { x: 1 },
        b: { y: 2 },
        c: { z: 3 },
      } as any;
      const { proxy, materialize } = createRecordingProxy(target);
      proxy.a.x = 99;
      const m = materialize(proxy) as typeof target;
      // `a` changed, so it's a new object.
      expect(m.a).not.toBe(target.a);
      expect(m.a.x).toBe(99);
      // `b` and `c` weren't touched, so they're literally the same
      // references as the original. React selectors keyed on these
      // will skip re-rendering for free.
      expect(m.b).toBe(target.b);
      expect(m.c).toBe(target.c);
    });

    it("a deep modification produces fresh refs at every level along the path", () => {
      const target = { a: { b: { c: { d: 1 } } } } as any;
      const { proxy, materialize } = createRecordingProxy(target);
      proxy.a.b.c.d = 99;
      const m = materialize(proxy) as typeof target;
      expect(m).not.toBe(target);
      expect(m.a).not.toBe(target.a);
      expect(m.a.b).not.toBe(target.a.b);
      expect(m.a.b.c).not.toBe(target.a.b.c);
      expect(m.a.b.c.d).toBe(99);
    });
  });

  describe("peeling proxies on write", () => {
    it("assigning a child proxy stores its current materialized value, not the proxy itself", () => {
      const target = {
        src: { name: "alice", nested: { age: 30 } },
        dst: { placeholder: true },
      } as any;
      const { proxy, getOperations } = createRecordingProxy(target);

      proxy.dst = proxy.src;

      const ops = getOperations();
      expect(ops).toHaveLength(1);
      expect(ops[0]).toEqual({
        kind: "set",
        path: ["dst"],
        value: { name: "alice", nested: { age: 30 } },
      });
      // The recorded value is a plain object, not a proxy.
      const val = (ops[0] as any).value;
      expect(typeof val).toBe("object");
      expect(Array.isArray(val)).toBe(false);
      // Round-trips through JSON without surprises.
      expect(JSON.parse(JSON.stringify(val))).toEqual({
        name: "alice",
        nested: { age: 30 },
      });
    });

    it("peeling captures a snapshot, not a live link to the source", () => {
      const target = { src: { v: 1 }, dst: { v: 0 } } as any;
      const { proxy } = createRecordingProxy(target);
      proxy.dst = proxy.src;
      // Mutate src after the assignment.
      proxy.src.v = 999;
      // `dst` should still hold the value at the time of assignment.
      expect(proxy.dst.v).toBe(1);
    });
  });

  describe("repeated getOperations() is stable", () => {
    it("calling getOperations() twice returns equivalent results", () => {
      const { proxy, getOperations } = createRecordingProxy({
        a: 1,
        b: { x: 0 },
        arr: [1, 2, 3],
      } as any);
      proxy.a = 99;
      proxy.b.x = 7;
      (proxy.arr as number[]).push(4);

      const ops1 = getOperations();
      const ops2 = getOperations();
      expect(ops1).toEqual(ops2);
    });
  });

  describe("getOwnPropertyDescriptor + Object.assign", () => {
    it("Object.assign({}, proxy) reflects writes and deletes", () => {
      const target = {
        a: 1,
        b: 2,
        c: 3,
      } as any;
      const { proxy } = createRecordingProxy(target);
      proxy.a = 10;
      delete proxy.b;
      proxy.d = 4;
      expect(Object.assign({}, proxy)).toEqual({ a: 10, c: 3, d: 4 });
    });
  });

  describe("array iteration semantics", () => {
    it("Symbol.iterator routes through the proxy so iteration sees writes", () => {
      const target = { arr: [1, 2, 3] };
      const { proxy } = createRecordingProxy(target);
      (proxy.arr as number[])[0] = 99;
      (proxy.arr as number[]).push(4);
      expect([...(proxy.arr as number[])]).toEqual([99, 2, 3, 4]);
    });

    it("Array.isArray(proxy.arr) is true", () => {
      const { proxy } = createRecordingProxy({ arr: [1, 2, 3] } as any);
      expect(Array.isArray(proxy.arr)).toBe(true);
    });

    it("array methods that need write+read interleaving still work (splice)", () => {
      const { proxy, getOperations } = createRecordingProxy({
        arr: [1, 2, 3, 4, 5],
      } as any);
      const removed = (proxy.arr as number[]).splice(1, 2);
      // splice's return value must reflect the original elements.
      expect(removed).toEqual([2, 3]);
      expect(proxy.arr).toEqual([1, 4, 5]);
      const ops = getOperations();
      expect(ops).toHaveLength(1);
      expect(ops[0]).toEqual({
        kind: "set",
        path: ["arr"],
        value: [1, 4, 5],
      });
    });
  });

  describe("real-world startup scenario", () => {
    /**
     * The original bug reproduced under
     * "plugins evaluated"-time service code calling
     * `db.update(...)`. Replicate a plausible shape and confirm we
     * never recurse.
     */
    it("a service-style update against a multi-section root works", () => {
      const target = {
        app: {
          activeTabId: "t1",
          tabs: [
            { id: "t1", title: "first", state: { url: "x" } },
            { id: "t2", title: "second", state: { url: "y" } },
          ],
          settings: { theme: "dark" },
        },
        chrome: {
          windows: { main: { focused: true } },
        },
        unrelatedPlugin: {
          big: Array.from({ length: 500 }, (_, i) => ({
            id: `n${i}`,
            data: { idx: i },
          })),
        },
      } as any;
      const { proxy, getOperations } = createRecordingProxy(target);

      // The kind of thing a service does on boot:
      proxy.app.activeTabId = "t2";
      (proxy.app.tabs[1] as any).state.url = "z";
      proxy.app.settings.theme = "light";

      const ops = getOperations();
      // Two leaf scalar sets + one whole-array set for the tabs
      // mutation (because we touched a nested element of the array
      // through `tabs[1].state.url`, the array itself is *not* dirty
      // — but `tabs[1]` is an array element so it's tracked via the
      // outer array's dirty flag? No: we only mark dirty when the
      // array's *own* keys are written. `tabs[1].state.url` goes
      // through the inner object's draft, so the op is at
      // `["app", "tabs", "1", "state", "url"]`.).
      expect(ops).toContainEqual({
        kind: "set",
        path: ["app", "activeTabId"],
        value: "t2",
      });
      expect(ops).toContainEqual({
        kind: "set",
        path: ["app", "tabs", "1", "state", "url"],
        value: "z",
      });
      expect(ops).toContainEqual({
        kind: "set",
        path: ["app", "settings", "theme"],
        value: "light",
      });

      // Live target completely untouched.
      expect(target.app.activeTabId).toBe("t1");
      expect(target.app.tabs[1].state.url).toBe("y");
      expect(target.app.settings.theme).toBe("dark");
      // The big sibling we didn't touch is also untouched.
      expect(target.unrelatedPlugin.big[0]).toEqual({
        id: "n0",
        data: { idx: 0 },
      });
    });
  });

  describe("returning the root proxy from update", () => {
    it("materialize on the root proxy returns a plain JSON tree with writes applied", () => {
      const target = {
        app: { count: 1, name: "alice" },
        other: { keep: true },
      } as any;
      const { proxy, materialize } = createRecordingProxy(target);
      proxy.app.count = 99;
      const m = materialize(proxy) as typeof target;
      expect(m).toEqual({
        app: { count: 99, name: "alice" },
        other: { keep: true },
      });
      // Plain objects (no proxies, no exotic).
      expect(Object.getPrototypeOf(m)).toBe(Object.prototype);
      expect(Object.getPrototypeOf(m.app)).toBe(Object.prototype);
    });

    it("materialize on a child proxy returns the materialized view at that node", () => {
      const target = { app: { count: 1 } } as any;
      const { proxy, materialize } = createRecordingProxy(target);
      proxy.app.count = 7;
      const m = materialize(proxy.app) as any;
      expect(m).toEqual({ count: 7 });
    });
  });
});
