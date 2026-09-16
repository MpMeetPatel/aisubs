/** Remove local credentials, routing metadata, and hop-by-hop headers before authorization. */
export function proxyRequestHeaders(input: HeadersInit): Headers {
  const headers = new Headers(input);
  const connectionHeaders =
    headers
      .get("connection")
      ?.split(",")
      .map((name) => name.trim()) ?? [];
  for (const name of [
    ...connectionHeaders,
    "authorization",
    "connection",
    "content-length",
    "cookie",
    "forwarded",
    "host",
    "keep-alive",
    "origin",
    "proxy-authenticate",
    "proxy-authorization",
    "referer",
    "te",
    "trailer",
    "transfer-encoding",
    "upgrade",
    "x-api-key",
    "x-goog-api-key",
  ]) {
    if (name) headers.delete(name);
  }
  const routingHeaders = [...headers.keys()].filter(
    (name) => name.startsWith("x-forwarded-") || name.startsWith("sec-websocket-"),
  );
  for (const name of routingHeaders) headers.delete(name);
  return headers;
}
