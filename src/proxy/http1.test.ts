/**
 * Unit tests for the minimal HTTP/1.1 client over a raw socket.
 *
 * The upstream mock writes the response byte-by-byte so every chunk-size,
 * CRLF and trailer boundary is split across TCP segments — the exact
 * segmentation that previously stalled or killed the body parser.
 */
import { test, expect } from "bun:test";
import net from "node:net";
import { Readable } from "node:stream";
import { http1Request } from "./http1";

function collect(stream: Readable): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    stream.on("data", (c: Buffer) => chunks.push(c));
    stream.on("end", () => resolve(Buffer.concat(chunks)));
    stream.on("error", reject);
  });
}

async function request(raw: string, byteByByte = true): Promise<{ status: number; body: Buffer }> {
  const server = net.createServer((sock) => {
    sock.on("data", () => {});
    const payload = Buffer.from(raw, "latin1");
    if (byteByByte) {
      let i = 0;
      const timer = setInterval(() => {
        if (i >= payload.length) {
          clearInterval(timer);
          sock.end();
          return;
        }
        sock.write(payload.subarray(i, i + 1));
        i++;
      }, 2);
      sock.on("close", () => clearInterval(timer));
    } else {
      sock.write(raw);
      sock.end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as net.AddressInfo).port;
  try {
    const tcp = net.connect({ port, host: "127.0.0.1" });
    const result = await http1Request({
      tcp,
      tls: false,
      request: "GET / HTTP/1.1\r\nHost: mock\r\nConnection: close\r\n\r\n",
      totalTimeoutMs: 5000,
    });
    const body = await collect(result.body);
    return { status: result.status, body };
  } finally {
    server.close();
  }
}

test("parses chunked body with CRLF and size lines split across TCP segments", async () => {
  const { status, body } = await request(
    "HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n" +
      "5\r\nhello\r\n6\r\n world\r\n0\r\n\r\n",
  );
  expect(status).toBe(200);
  expect(body.toString()).toBe("hello world");
});

test("parses chunked body with a trailer section ending in CRLFCRLF", async () => {
  const { status, body } = await request(
    "HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n" +
      "2\r\nhi\r\n0\r\nX-Test: yes\r\n\r\n",
  );
  expect(status).toBe(200);
  expect(body.toString()).toBe("hi");
});

test("parses a fragmented multi-chunk stream ending right at the final CRLF", async () => {
  const { status, body } = await request(
    "HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n" +
      "3\r\nabc\r\n3\r\ndef\r\n0\r\n\r\n",
  );
  expect(status).toBe(200);
  expect(body.toString()).toBe("abcdef");
});

test("parses content-length bodies split at any boundary", async () => {
  const { status, body } = await request(
    "HTTP/1.1 200 OK\r\nContent-Length: 11\r\n\r\nhello world",
  );
  expect(status).toBe(200);
  expect(body.toString()).toBe("hello world");
});

test("parses close-delimited bodies", async () => {
  const { status, body } = await request(
    "HTTP/1.1 200 OK\r\n\r\nstreamed till end",
  );
  expect(status).toBe(200);
  expect(body.toString()).toBe("streamed till end");
});
