'use strict';
/**
 * SSE (Server-Sent Events) helper for streaming responses to clients.
 */
function sseInit(res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders();
  let closed = false;
  res.on('close', () => { closed = true; });
  return {
    get isClosed() { return closed; },
    send(event, data) {
      if (closed) return false;
      if (event) res.write(`event: ${event}\n`);
      res.write(`data: ${typeof data === 'string' ? data : JSON.stringify(data)}\n\n`);
      return true;
    },
    // OpenAI-style chunk
    chunk(obj) { return this.send(null, obj); },
    end() {
      if (!closed) { res.write('data: [DONE]\n\n'); res.end(); }
      closed = true;
    },
    raw(str) { if (!closed) res.write(str); },
  };
}

/**
 * Parse an upstream SSE byte stream, yielding {event, data} objects.
 * Handles multi-line data fields and [DONE] sentinel passthrough.
 */
async function* sseParse(bodyStream) {
  let buf = '';
  const decoder = new TextDecoder();
  for await (const chunk of bodyStream) {
    buf += decoder.decode(chunk, { stream: true });
    let idx;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const rawLine = buf.slice(0, idx).replace(/\r$/, '');
      buf = buf.slice(idx + 1);
      if (rawLine === '') continue;
      if (rawLine.startsWith(':')) continue; // comment/heartbeat
      if (rawLine.startsWith('event:')) {
        // attach to next data line; rare in our upstreams, keep simple
        yield { event: rawLine.slice(6).trim(), data: null };
        continue;
      }
      if (rawLine.startsWith('data:')) {
        const data = rawLine.slice(5).trim();
        yield { event: null, data };
      }
    }
  }
  if (buf.trim()) yield { event: null, data: buf.trim() };
}

module.exports = { sseInit, sseParse };
