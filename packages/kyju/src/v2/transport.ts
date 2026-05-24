import type { DbSendEvent, ServerEvent } from "./shared";
import { VERSION } from "./shared";
import { createReplica } from "./replica/replica";
import { createClient, type ClientProxy } from "./client/client";
import type { SchemaShape } from "./db/schema";

const UINT8_TAG = "__$u8";
// Pre-built substrings we scan for to decide whether `dbParse` needs the
// slow reviver path. `dbStringify` uses default `JSON.stringify` (no
// whitespace), so Buffer-shaped objects always serialize to this exact
// byte sequence; the Uint8Array tag contains no JSON-escapable chars, so
// it also appears in the text literally whenever it's present.
const BUFFER_MARKER = '"type":"Buffer"';

export function dbStringify(value: unknown): string {
  return JSON.stringify(value, (_key, val) => {
    if (val instanceof Uint8Array) {
      let binary = "";
      for (let i = 0; i < val.length; i++) binary += String.fromCharCode(val[i]);
      return { [UINT8_TAG]: btoa(binary) };
    }
    return val;
  });
}

export function dbParse(text: string): any {
  // Fast path: if neither binary-encoding marker is present in the raw
  // JSON, the reviver below would walk every key but never transform
  // anything. `JSON.parse` with a reviver is 2–5× slower than without
  // because V8 has to call back into JS for every value — skipping it
  // for the common all-JSON message shaves significant time off every
  // inbound event on the renderer.
  if (!text.includes(UINT8_TAG) && !text.includes(BUFFER_MARKER)) {
    return JSON.parse(text);
  }
  return JSON.parse(text, (_key, val) => {
    if (val !== null && typeof val === "object") {
      if (UINT8_TAG in val) {
        const binary = atob(val[UINT8_TAG]);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
        return bytes;
      }
      // Handle Node.js Buffer.toJSON() format — JSON.stringify calls toJSON()
      // before the replacer in dbStringify, so Buffers arrive as this shape.
      if (val.type === "Buffer" && Array.isArray(val.data)) {
        return new Uint8Array(val.data);
      }
    }
    return val;
  });
}

function extractReplicaId(event: ServerEvent): string | undefined {
  if (event.kind === "connect") return event.message.replicaId;
  if ("replicaId" in event) return event.replicaId;
  return undefined;
}

export function createRouter() {
  const routes = new Map<string, (event: DbSendEvent) => void>();

  return {
    send(event: DbSendEvent) {
      routes.get(event.replicaId)?.(event);
    },

    connection(opts: {
      send: (event: DbSendEvent) => void;
      postMessage: (event: ServerEvent) => Promise<void>;
    }) {
      let replicaId: string | undefined;

      return {
        receive(event: ServerEvent) {
          const rid = extractReplicaId(event);
          if (rid && !replicaId) {
            replicaId = rid;
            routes.set(rid, opts.send);
          }
          return opts.postMessage(event);
        },
        close() {
          if (replicaId) routes.delete(replicaId);
        },
      };
    },
  };
}

export async function connectReplica<T extends SchemaShape>(opts: {
  send: (event: ServerEvent) => void;
  subscribe: (cb: (event: DbSendEvent) => void) => () => void;
  maxPageSizeBytes?: number;
}): Promise<{
  client: ClientProxy<T>;
  replica: ReturnType<typeof createReplica>;
  disconnect: () => Promise<void>;
}> {
  const replica = createReplica({
    send: opts.send,
    maxPageSizeBytes: opts.maxPageSizeBytes ?? 1024 * 1024,
  });

  const unsub = opts.subscribe((event) => {
    if (event.replicaId === replica.replicaId) {
      replica.postMessage(event);
    }
  });

  await replica.postMessage({ kind: "connect", version: VERSION });
  const client = createClient<T>(replica);

  return {
    client,
    replica,
    disconnect: async () => {
      await replica.postMessage({ kind: "disconnect" }).catch(() => {});
      unsub();
    },
  };
}
