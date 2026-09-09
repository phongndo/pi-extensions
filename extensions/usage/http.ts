/** Bounded status responses. Never expose provider bodies or secrets in errors. */
export async function jsonResponse(response: Response, signal: AbortSignal): Promise<unknown> {
  const maxBytes = 1024 * 1024;
  if (!response.ok || Number(response.headers.get("content-length")) > maxBytes) {
    await response.body?.cancel();
    throw new Error("Status unavailable");
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Empty response");
  let size = 0;
  const chunks: Uint8Array[] = [];
  try {
    while (true) {
      signal.throwIfAborted();
      const { value, done } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > maxBytes) throw new Error("Oversized response");
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
  }
}

export async function getStatus(
  url: string,
  token: string,
  signal: AbortSignal,
  fetcher: typeof fetch,
  headers: Record<string, string> = {},
): Promise<unknown> {
  const requestSignal = AbortSignal.any([signal, AbortSignal.timeout(8000)]);
  requestSignal.throwIfAborted();
  return jsonResponse(
    await fetcher(url, {
      method: "GET",
      redirect: "error",
      signal: requestSignal,
      headers: { ...headers, Authorization: `Bearer ${token}`, Accept: "application/json" },
    }),
    requestSignal,
  );
}
