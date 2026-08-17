/**
 * Minimal HTTP/1.1 client over an already-established TCP socket.
 *
 * Bun's node:http/node:https ignore custom agents, `createConnection` and
 * `socket` options and silently dial the host directly, which bypasses the
 * SOCKS5 tunnel (requests then egress from the box's own IP, not from the
 * rotating proxy pool). Dialing the socket ourselves and speaking HTTP/1.1
 * over it keeps every upstream connection inside the configured path.
 *
 * Supports Content-Length, chunked and close-delimited bodies, incremental
 * parsing regardless of TCP segment boundaries, streaming, idle/total
 * timeouts and abort signals.
 */
import tls from "node:tls";
import { Readable } from "node:stream";
import type { Socket } from "node:net";

export interface Http1RequestOptions {
  /** Established TCP socket (already routed via socks5 / ipv6-prefer). */
  tcp: Socket;
  tls: boolean;
  servername?: string;
  /** Full raw HTTP/1.1 request (status line, headers, blank line, body). */
  request: string;
  /** Kill the whole request after this long. */
  totalTimeoutMs?: number;
  signal?: AbortSignal;
}

export interface Http1Result {
  status: number;
  headers: Headers;
  /** Node Readable that yields the decoded body bytes. */
  body: Readable;
  /** Abandon the underlying connection. */
  destroy: () => void;
}

const CRLFCRLF = "\r\n\r\n";

export function http1Request(opts: Http1RequestOptions): Promise<Http1Result> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let tcp = opts.tcp;
    let sock: import("node:stream").Duplex = tcp as unknown as import("node:stream").Duplex;
    let bodyReadable: Readable | null = null;
    const totalTimer = opts.totalTimeoutMs
      ? setTimeout(() => fail(new Error("upstream total timeout")), opts.totalTimeoutMs)
      : null;

    function fail(err: Error) {
      if (settled) {
        // Head already delivered: surface body-phase errors on the readable
        // and abandon the connection instead of swallowing them.
        bodyReadable?.destroy(err);
        try {
          tcp.destroy();
        } catch {
          /* already closed */
        }
        return;
      }
      settled = true;
      clearTimers();
      try {
        tcp.destroy();
      } catch {
        /* already closed */
      }
      bodyReadable?.destroy(err);
      reject(err);
    }
    function clearTimers() {
      if (totalTimer) clearTimeout(totalTimer);
    }
    const onAbort = () => fail(new Error("request aborted"));
    if (opts.signal) {
      if (opts.signal.aborted) {
        onAbort();
        return;
      }
      opts.signal.addEventListener("abort", onAbort, { once: true });
    }

    let buf = Buffer.alloc(0);
    let bodyMode: "length" | "chunked" | "until-end" | "none" = "until-end";
    let remaining = 0;
    let chunkRemaining = 0;
    let chunkPhase: "size" | "data" | "crlf" | "done" = "size";
    let bodyEnded = false;

    function pushBody(chunk: Buffer) {
      if (!bodyReadable) return;
      bodyReadable.push(chunk);
      if (bodyReadable.readableLength > 65536) {
        sock.pause();
        bodyReadable.once("drain", () => sock.resume());
      }
    }
    function finishBody() {
      bodyEnded = true;
      clearTimers();
      bodyReadable?.push(null);
    }

    function drainBody(): void {
      while (buf.length > 0 && bodyReadable) {
        if (bodyMode === "chunked") {
          if (chunkPhase === "size") {
            const nl = buf.indexOf("\r\n", 0, "latin1");
            if (nl < 0) return;
            const sizeLine = buf.subarray(0, nl).toString("latin1");
            buf = buf.subarray(nl + 2);
            const sizeHex = sizeLine.split(";")[0]?.trim() ?? "";
            const size = parseInt(sizeHex, 16);
            if (!Number.isInteger(size) || size < 0) {
              throw new Error(`upstream sent invalid chunk size: ${sizeLine.slice(0, 20)}`);
            }
            if (size === 0) {
              chunkPhase = "done";
              continue;
            }
            chunkRemaining = size;
            chunkPhase = "data";
          }
          if (chunkPhase === "data") {
            if (buf.length <= chunkRemaining) {
              pushBody(buf);
              chunkRemaining -= buf.length;
              buf = Buffer.alloc(0);
              if (chunkRemaining === 0) chunkPhase = "crlf";
              return;
            }
            pushBody(buf.subarray(0, chunkRemaining));
            buf = buf.subarray(chunkRemaining);
            chunkRemaining = 0;
            chunkPhase = "crlf";
          }
          if (chunkPhase === "crlf") {
            if (buf.length < 2) return; // CRLF split across segments
            if (buf[0] !== 0x0d || buf[1] !== 0x0a) {
              throw new Error("upstream sent malformed chunk terminator");
            }
            buf = buf.subarray(2);
            chunkPhase = "size";
            continue;
          }
          // After the 0-size line its CRLF is already consumed; the trailer
          // section is terminated by a final CRLF (empty trailers "0\r\n\r\n")
          // or CRLFCRLF when trailers exist.
          if (buf.length >= 2 && buf.subarray(0, 2).toString("latin1") === "\r\n") {
            buf = Buffer.alloc(0);
            finishBody();
            return;
          }
          if (buf.includes(CRLFCRLF, 0, "latin1")) {
            buf = Buffer.alloc(0);
            finishBody();
            return;
          }
          return;
        }
        if (bodyMode === "length") {
          const take = Math.min(buf.length, remaining);
          pushBody(buf.subarray(0, take));
          buf = buf.subarray(take);
          remaining -= take;
          if (remaining === 0) {
            finishBody();
            return;
          }
          return;
        }
        pushBody(buf);
        buf = Buffer.alloc(0);
        return;
      }
    }

    function onData(d: Uint8Array) {
      buf = Buffer.concat([buf, Buffer.from(d)]);
      if (!settled) {
        try {
          parseHead();
        } catch (e) {
          fail(e instanceof Error ? e : new Error(String(e)));
          return;
        }
        return;
      }
      try {
        drainBody();
      } catch (e) {
        fail(e instanceof Error ? e : new Error(String(e)));
      }
    }

    function parseHead() {
      const idx = buf.indexOf(CRLFCRLF, 0, "latin1");
      if (idx < 0) {
        if (buf.length > 65536) throw new Error("upstream response head too large");
        return;
      }
      const head = buf.subarray(0, idx).toString("latin1");
      buf = buf.subarray(idx + 4);
      const lines = head.split("\r\n");
      const statusLine = lines[0] ?? "";
      const m = /^HTTP\/\d(?:\.\d)?\s+(\d{3})/.exec(statusLine);
      if (!m) throw new Error(`upstream sent invalid status line: ${statusLine.slice(0, 40)}`);
      const headers = new Headers();
      for (const line of lines.slice(1)) {
        const i = line.indexOf(":");
        if (i <= 0) continue;
        try {
          headers.append(line.slice(0, i).trim(), line.slice(i + 1).trim());
        } catch {
          /* ignore invalid header lines */
        }
      }
      const te = headers.get("transfer-encoding")?.toLowerCase() ?? "";
      const cl = headers.get("content-length");
      if (te.includes("chunked")) {
        bodyMode = "chunked";
      } else if (cl !== null) {
        const n = Number(cl);
        if (!Number.isInteger(n) || n < 0) throw new Error(`upstream sent invalid Content-Length: ${cl}`);
        bodyMode = n === 0 ? "none" : "length";
        remaining = n;
      } else {
        bodyMode = "until-end";
      }
      bodyReadable = new Readable({ read() { /* pushed from socket data */ } });
      const result: Http1Result = {
        status: Number(m[1]),
        headers,
        body: bodyReadable,
        destroy: () => {
          try {
            tcp.destroy();
          } catch {
            /* already closed */
          }
        },
      };
      settled = true;
      clearTimers();
      if (opts.signal) opts.signal.removeEventListener("abort", onAbort);
      resolve(result);
      if (bodyMode === "none") {
        finishBody();
        return;
      }
      drainBody();
    }

    function setup() {
      sock.on("data", onData);
      sock.on("error", (e) => {
        const err = e instanceof Error ? e : new Error(String(e));
        if (!settled) {
          fail(err);
          return;
        }
        bodyReadable?.destroy(err);
      });
      sock.on("close", () => {
        if (!settled) {
          fail(new Error("upstream connection closed before response"));
          return;
        }
        if (bodyMode === "until-end") {
          finishBody();
          return;
        }
        if (bodyMode === "length" && remaining > 0) {
          bodyReadable?.destroy(new Error("upstream connection closed before body complete"));
          return;
        }
        if (bodyMode === "chunked") {
          if (bodyEnded) return;
          if (chunkPhase === "done") {
            finishBody();
            return;
          }
          bodyReadable?.destroy(new Error("upstream connection closed before body complete"));
        }
      });
      sock.write(opts.request);
    }

    const tlsSock = opts.tls ? tls.connect({ socket: opts.tcp, servername: opts.servername }) : null;
    if (tlsSock) {
      tlsSock.once("secureConnect", () => {
        sock = tlsSock as typeof sock;
        setup();
      });
      tlsSock.once("error", (e) => fail(e instanceof Error ? e : new Error(String(e))));
    } else {
      setup();
    }
    tcp.on("error", (e) => fail(e instanceof Error ? e : new Error(String(e))));
  });
}

/** Build a raw HTTP/1.1 request string. */
export function buildRequest(
  method: string,
  path: string,
  hostHeader: string,
  headers: Record<string, string>,
  body?: string,
): string {
  const lines = [`${method} ${path} HTTP/1.1`, `Host: ${hostHeader}`];
  for (const [k, v] of Object.entries(headers)) lines.push(`${k}: ${v}`);
  if (body) lines.push(`Content-Length: ${Buffer.byteLength(body)}`);
  const head = lines.join("\r\n") + "\r\n\r\n";
  return body ? head + body : head;
}
