import { ProviderError } from "./types.ts";

/** POST JSON and iterate the `data:` payloads of an SSE response. */
export async function* postSse(
  url: string,
  body: unknown,
  headers: Record<string, string>,
  signal?: AbortSignal,
  label = "provider",
): AsyncGenerator<string> {
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "text/event-stream", ...headers },
      body: JSON.stringify(body),
      signal,
    });
  } catch (e) {
    if (signal?.aborted) throw new ProviderError("aborted", null, false);
    throw new ProviderError(`${label}: network error: ${(e as Error).message}`, null, true);
  }
  if (!res.ok || !res.body) {
    const text = await res.text().catch(() => "");
    const retryable = res.status === 429 || res.status >= 500 || res.status === 408;
    throw new ProviderError(`${label} ${res.status}: ${text.slice(0, 500)}`, res.status, retryable);
  }
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  let buf = "";
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += value;
      let m: RegExpExecArray | null;
      while ((m = /\r?\n\r?\n/.exec(buf))) {
        const event = buf.slice(0, m.index);
        buf = buf.slice(m.index + m[0].length);
        const data = event
          .split(/\r?\n/)
          .filter((l) => l.startsWith("data:"))
          .map((l) => l.slice(5).trimStart())
          .join("\n");
        if (data) yield data;
      }
    }
    if (buf.trim().startsWith("data:")) yield buf.trim().slice(5).trimStart();
  } catch (e) {
    if (signal?.aborted) throw new ProviderError("aborted", null, false);
    throw new ProviderError(`${label}: stream error: ${(e as Error).message}`, null, true);
  }
}

export async function getJson(url: string, headers: Record<string, string>, label = "provider"): Promise<any> {
  const res = await fetch(url, { headers });
  if (!res.ok) throw new ProviderError(`${label} ${res.status}: ${(await res.text()).slice(0, 300)}`, res.status, false);
  return res.json();
}
