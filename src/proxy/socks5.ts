/**
 * Minimal SOCKS5 client with optional user/password auth. The hostname is
 * resolved by the proxy (socks5h semantics), so the upstream never sees our
 * local DNS lookups.
 */
import { connect as tcpConnect } from "node:net";
import type { Socket } from "node:net";

export interface Socks5Target {
  host: string;
  port: number;
}

export function parseSocks5URL(url: string): { host: string; port: number; username?: string; password?: string } {
  const u = new URL(url);
  const port = u.port ? Number(u.port) : 1080;
  return {
    host: u.hostname,
    port,
    username: u.username ? decodeURIComponent(u.username) : undefined,
    password: u.password ? decodeURIComponent(u.password) : undefined,
  };
}

export function socks5Connect(
  proxy: { host: string; port: number; username?: string; password?: string },
  target: Socks5Target,
  timeoutMs: number,
): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const sock = tcpConnect({ host: proxy.host, port: proxy.port });
    let settled = false;
    const fail = (err: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      sock.destroy();
      reject(err);
    };
    const timer = setTimeout(() => fail(new Error("socks5 dial timeout")), timeoutMs);
    sock.on("error", fail);

    let buf = Buffer.alloc(0);
    let stage: "greet" | "auth" | "connect" = "greet";
    let sentConnect = false;

    sock.on("connect", () => {
      if (proxy.username !== undefined) {
        sock.write(Buffer.from([0x05, 0x01, 0x02])); // username/password auth
      } else {
        sock.write(Buffer.from([0x05, 0x01, 0x00])); // no auth
      }
    });

    sock.on("data", (data: Buffer) => {
      buf = Buffer.concat([buf, data]);
      if (stage === "greet" && buf.length >= 2) {
        const method = buf[1] ?? 0x00;
        buf = buf.subarray(2);
        if (method === 0x02) {
          stage = "auth";
          const user = proxy.username ?? "";
          const pass = proxy.password ?? "";
          const head = Buffer.from([0x01, user.length]);
          const tail = Buffer.from([pass.length]);
          sock.write(Buffer.concat([head, Buffer.from(user, "utf8"), tail, Buffer.from(pass, "utf8")]));
        } else if (method === 0x00) {
          stage = "connect";
          sendConnect();
        } else {
          fail(new Error("socks5: no acceptable auth method"));
        }
        return;
      }
      if (stage === "auth" && buf.length >= 2) {
        if ((buf[1] ?? 0xff) !== 0x00) {
          fail(new Error("socks5: auth failed"));
          return;
        }
        buf = buf.subarray(2);
        stage = "connect";
        sendConnect();
        return;
      }
      if (stage === "connect" && buf.length >= 4) {
        const rep = buf[1] ?? 0xff;
        const atyp = buf[3] ?? 0x00;
        let addrLen = 0;
        if (atyp === 0x01) addrLen = 4;
        else if (atyp === 0x03) addrLen = buf.length >= 5 ? (buf[4] ?? 0) + 1 : 0;
        else if (atyp === 0x04) addrLen = 16;
        const total = 4 + addrLen + 2;
        if (buf.length < total) return;
        if (rep !== 0x00) {
          fail(new Error(`socks5: connect failed (rep=${rep})`));
          return;
        }
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        sock.removeAllListeners("data");
        resolve(sock);
      }
    });

    function sendConnect() {
      if (sentConnect) return;
      sentConnect = true;
      const hostBuf = Buffer.from(target.host, "utf8");
      const portBuf = Buffer.alloc(2);
      portBuf.writeUInt16BE(target.port);
      const req = Buffer.concat([
        Buffer.from([0x05, 0x01, 0x00, 0x03, hostBuf.length]),
        hostBuf,
        portBuf,
      ]);
      sock.write(req);
    }
  });
}
