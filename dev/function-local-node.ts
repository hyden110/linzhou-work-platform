import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { Readable } from "node:stream";

import { handler } from "../functions/handler.ts";
import { createLocalRouter } from "./local-router.ts";

const HOST = "127.0.0.1";
const PORT = 8000;
const MAX_BODY_BYTES = 40 * 1024;

const localRouter = createLocalRouter({ port: PORT });

async function readBody(request: IncomingMessage): Promise<Uint8Array | undefined> {
  if (request.method === "GET" || request.method === "HEAD") return undefined;
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of request) {
    const bytes = typeof chunk === "string" ? new TextEncoder().encode(chunk) : new Uint8Array(chunk);
    size += bytes.byteLength;
    if (size > MAX_BODY_BYTES) throw new Error("request_too_large");
    chunks.push(bytes);
  }
  const body = new Uint8Array(size);
  chunks.reduce((offset, chunk) => {
    body.set(chunk, offset);
    return offset + chunk.byteLength;
  }, 0);
  return body;
}

function requestHeaders(request: IncomingMessage): Headers {
  const headers = new Headers();
  for (const [name, value] of Object.entries(request.headers)) {
    if (Array.isArray(value)) value.forEach((item) => headers.append(name, item));
    else if (value !== undefined) headers.set(name, value);
  }
  return headers;
}

async function toFetchRequest(request: IncomingMessage): Promise<Request> {
  const body = await readBody(request);
  return new Request(`http://${HOST}:${PORT}${request.url ?? "/"}`, {
    method: request.method,
    headers: requestHeaders(request),
    body,
  });
}

async function route(fetchRequest: Request): Promise<Response> {
  return new URL(fetchRequest.url).pathname.startsWith("/local/")
    ? localRouter(fetchRequest)
    : handler(fetchRequest);
}

async function sendResponse(response: Response, target: ServerResponse): Promise<void> {
  target.statusCode = response.status;
  response.headers.forEach((value, name) => target.setHeader(name, value));
  const contentType = response.headers.get("content-type") ?? "";
  // SSE（/local/events）是永不结束的流：整包 arrayBuffer 会挂死响应头，必须流式转发；
  // 客户端断开时销毁上游流，触发桥侧 cancel 清理订阅。
  if (contentType.includes("text/event-stream") && response.body) {
    const stream = Readable.fromWeb(response.body as import("node:stream/web").ReadableStream);
    const done = new Promise<void>((resolve) => {
      target.on("finish", () => resolve());
      target.on("close", () => { stream.destroy(); resolve(); });
      stream.on("error", () => { target.destroy(); resolve(); });
    });
    stream.pipe(target);
    await done;
    return;
  }
  target.end(Buffer.from(await response.arrayBuffer()));
}

const server = createServer(async (request, response) => {
  try {
    await sendResponse(await route(await toFetchRequest(request)), response);
  } catch (error) {
    const status = error instanceof Error && error.message === "request_too_large" ? 413 : 500;
    response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
    response.end(JSON.stringify({ ok: false, error: status === 413 ? "payload_too_large" : "local_server_error" }));
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Local Function listening on http://${HOST}:${PORT}`);
});
