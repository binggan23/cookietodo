/**
 * Slice 8 — In-memory stub WebDAV HTTP server for Playwright e2e tests.
 *
 * Handles LOCK / GET / PUT / UNLOCK / PROPFIND for a single remote
 * `snapshot.json` resource on an ephemeral port. Simulates:
 *   - First sync: GET returns empty (resource not yet created).
 *   - After PUT: GET returns the stored content.
 *   - LOCK contention: 423 on a held lock (test-only via `forceLocked` flag).
 *   - 401: when `failAuth` is set, returns 401 on all requests.
 *
 * Usage:
 *   const server = await createWebDAVServer({ failAuth: true });
 *   const url = server.url(); // "http://localhost:PORT"
 *   // ... run test ...
 *   await server.close();
 */
import { createServer, type Server } from "node:http";

interface WebDAVServerOptions {
  /** If true, all requests return 401. */
  failAuth?: boolean;
  /** If true, LOCK returns 423 (simulate contention). */
  forceLocked?: boolean;
}

export interface WebDAVTestServer {
  url(): string;
  close(): Promise<void>;
  /** The stored snapshot content (string), for assertion. */
  storedContent: string;
  /** Reset the stored content to empty. */
  reset(): void;
}

const XML_LOCK_DISCOVERY = `<?xml version="1.0" encoding="utf-8"?>
<D:prop xmlns:D="DAV:">
  <D:lockdiscovery>
    <D:activelock>
      <D:locktype><D:write/></D:locktype>
      <D:lockscope><D:exclusive/></D:lockscope>
      <D:locktoken><D:href>urn:e2e:locktoken:1</D:href></D:locktoken>
      <D:lockroot><D:href>/</D:href></D:lockroot>
    </D:activelock>
  </D:lockdiscovery>
</D:prop>`;

/**
 * Create a minimal WebDAV stub server on an ephemeral port.
 */
export function createWebDAVServer(opts: WebDAVServerOptions = {}): Promise<WebDAVTestServer> {
  return new Promise((resolve, reject) => {
    let storedContent = "";
    let locked = false;
    const { failAuth = false, forceLocked = false } = opts;

    const server: Server = createServer((req, res) => {
      // Simulate 401 auth failure.
      if (failAuth) {
        res.writeHead(401, { "Content-Type": "text/plain" });
        res.end("401 Unauthorized");
        return;
      }

      const method = req.method ?? "GET";

      // PROPFIND — required for the webdav lib's `exists` check.
      if (method === "PROPFIND") {
        if (storedContent) {
          res.writeHead(207, { "Content-Type": "application/xml; charset=utf-8" });
          res.end(
            `<?xml version="1.0"?><D:multistatus xmlns:D="DAV:"><D:response><D:href>/</D:href><D:propstat><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response></D:multistatus>`,
          );
        } else {
          res.writeHead(404);
          res.end();
        }
        return;
      }

      // LOCK
      if (method === "LOCK") {
        if (forceLocked || locked) {
          res.writeHead(423);
          res.end("423 Locked");
          return;
        }
        locked = true;
        res.writeHead(200, {
          "Content-Type": "application/xml; charset=utf-8",
          "Lock-Token": "<urn:e2e:locktoken:1>",
        });
        res.end(XML_LOCK_DISCOVERY);
        return;
      }

      // UNLOCK
      if (method === "UNLOCK") {
        locked = false;
        res.writeHead(204);
        res.end();
        return;
      }

      // GET
      if (method === "GET") {
        if (storedContent) {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(storedContent);
        } else {
          res.writeHead(404);
          res.end();
        }
        return;
      }

      // PUT
      if (method === "PUT") {
        let body = "";
        req.on("data", (chunk: Buffer) => {
          body += chunk.toString("utf8");
        });
        req.on("end", () => {
          storedContent = body;
          locked = false; // PUT also releases the lock (simplified).
          res.writeHead(201);
          res.end();
        });
        return;
      }

      // Fallback: 405
      res.writeHead(405);
      res.end();
    });

    server.listen(0, () => {
      const addr = server.address();
      if (addr === null || typeof addr === "string") {
        reject(new Error("Failed to bind WebDAV stub server"));
        return;
      }
      resolve({
        url: () => `http://localhost:${addr.port}`,
        close: () => new Promise<void>((res) => server.close(() => res())),
        reset: () => {
          storedContent = "";
          locked = false;
        },
        get storedContent() {
          return storedContent;
        },
        set storedContent(v: string) {
          storedContent = v;
        },
      });
    });
  });
}
