// D.A.V.E. TV — CORS proxy (AWS Lambda, response streaming via Function URL)
//
// The Internet Archive serves direct MP4s but no CORS headers, so the in-scene
// TV's canvas/DynamicTexture can't read their pixels (tainted canvas →
// SecurityError → black screen). This streams the file through with an
// Access-Control-Allow-Origin header and forwards Range requests so seeking and
// progressive playback still work.
//
// Runs on a Lambda Function URL in RESPONSE_STREAM mode — API Gateway can't
// stream and caps payloads at ~10 MB, so video must bypass it. Locked to
// archive.org so it can't be abused as an open proxy. Zero npm deps: uses the
// Node global `fetch` and stream pipeline.

const { Readable } = require("node:stream");
const { pipeline } = require("node:stream/promises");

const ALLOWED_HOST = /(^|\.)archive\.org$/;

// Stream errors that just mean "the client hung up".
const CLIENT_ABORT = new Set([
  "ERR_STREAM_PREMATURE_CLOSE",
  "ERR_STREAM_DESTROYED",
  "EPIPE",
  "ECONNRESET",
]);

// Lambda response streaming caps a single response at ~20 MB, but IA's MP4
// derivatives run 35-75 MB (feature films far more). An open-ended
// `Range: bytes=0-` would blow that cap mid-stream, so every GET is clamped to
// a window. The browser just re-requests the next one as playback advances —
// 206 + Content-Range keeps both seeking and progressive playback intact.
const MAX_WINDOW = 16 * 1024 * 1024;

function clampRange(range) {
  const m = /^bytes=(\d*)-(\d*)$/.exec((range || "").trim());
  // No Range (or a multi-range we don't parse): ask for the first window.
  if (!m) return range || `bytes=0-${MAX_WINDOW - 1}`;
  // Suffix form `bytes=-N` — the LAST n bytes, used to grab a trailing moov atom.
  if (!m[1]) {
    const n = parseInt(m[2], 10);
    return `bytes=-${Math.min(n || MAX_WINDOW, MAX_WINDOW)}`;
  }
  const start = parseInt(m[1], 10);
  const end = m[2] ? parseInt(m[2], 10) : Infinity;
  return `bytes=${start}-${Math.min(end, start + MAX_WINDOW - 1)}`;
}

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET,HEAD,OPTIONS",
  "access-control-allow-headers": "Range",
  "access-control-expose-headers":
    "Content-Length,Content-Range,Accept-Ranges,Content-Type",
};

exports.handler = awslambda.streamifyResponse(async (event, responseStream) => {
  const method = event.requestContext?.http?.method || "GET";

  // Short-circuit reply (no upstream body): preflight, errors, HEAD.
  const reply = (statusCode, text = "", extra = {}) => {
    const s = awslambda.HttpResponseStream.from(responseStream, {
      statusCode,
      headers: { ...CORS, ...extra },
    });
    s.end(text);
  };

  if (method === "OPTIONS") return reply(204);
  if (method !== "GET" && method !== "HEAD") return reply(405, "method not allowed");

  const target = event.queryStringParameters?.u;
  if (!target) return reply(400, "missing ?u");

  let t;
  try {
    t = new URL(target);
  } catch {
    return reply(400, "bad url");
  }
  if (t.protocol !== "https:" || !ALLOWED_HOST.test(t.hostname)) {
    return reply(403, "host not allowed");
  }

  // Forward only Range; follow IA's redirect to its serving node. HEAD goes
  // upstream unclamped so it still reports the file's real total size.
  const fwd = {};
  if (method === "GET") fwd.range = clampRange(event.headers?.range);

  let upstream;
  try {
    upstream = await fetch(t.toString(), { method, headers: fwd, redirect: "follow" });
  } catch {
    return reply(502, "upstream fetch failed");
  }

  const passthrough = {};
  for (const h of [
    "content-type",
    "content-length",
    "content-range",
    "accept-ranges",
    "cache-control",
    "last-modified",
    "etag",
  ]) {
    const v = upstream.headers.get(h);
    if (v) passthrough[h] = v;
  }

  const out = awslambda.HttpResponseStream.from(responseStream, {
    statusCode: upstream.status,
    headers: { ...CORS, ...passthrough },
  });

  if (method === "HEAD" || !upstream.body) {
    out.end();
    return;
  }
  try {
    await pipeline(Readable.fromWeb(upstream.body), out);
  } catch (err) {
    // A video element aborts mid-stream on every seek and whenever its forward
    // buffer fills. That's routine, not a failure — let it end the invocation
    // cleanly instead of surfacing as a Lambda error on each one.
    if (!CLIENT_ABORT.has(err?.code)) throw err;
  }
});
