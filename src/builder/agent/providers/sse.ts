/**
 * Server-sent event parsing for streaming model responses.
 *
 * Written as an incremental parser rather than a split on "\n\n" because network chunks
 * arrive at arbitrary boundaries: a single JSON payload routinely spans three reads, and a
 * naive parser drops or corrupts those. Providers also disagree on line endings and on
 * whether they send comment/heartbeat lines, so both are handled here rather than in each
 * adapter.
 */

export interface SseEvent {
  event: string;
  data: string;
}

export class SseParser {
  private buffer = '';
  private dataLines: string[] = [];
  private eventName = 'message';

  /** Feed a decoded chunk; returns whatever complete events it completed. */
  push(chunk: string): SseEvent[] {
    this.buffer += chunk;
    const events: SseEvent[] = [];

    // Normalize line endings first so a CRLF provider does not leave a stray \r on every
    // data payload, which would break JSON.parse on the last field.
    this.buffer = this.buffer.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

    let index: number;
    while ((index = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, index);
      this.buffer = this.buffer.slice(index + 1);

      if (line === '') {
        // Blank line dispatches the accumulated event.
        if (this.dataLines.length) {
          events.push({ event: this.eventName, data: this.dataLines.join('\n') });
        }
        this.dataLines = [];
        this.eventName = 'message';
        continue;
      }
      if (line.startsWith(':')) continue; // heartbeat comment

      const colon = line.indexOf(':');
      const field = colon === -1 ? line : line.slice(0, colon);
      // A single space after the colon is part of the framing, not the value.
      let value = colon === -1 ? '' : line.slice(colon + 1);
      if (value.startsWith(' ')) value = value.slice(1);

      if (field === 'data') this.dataLines.push(value);
      else if (field === 'event') this.eventName = value;
    }
    return events;
  }

  /** Flush a final event that arrived without a trailing blank line. */
  flush(): SseEvent[] {
    if (!this.dataLines.length) return [];
    const event = { event: this.eventName, data: this.dataLines.join('\n') };
    this.dataLines = [];
    this.eventName = 'message';
    return [event];
  }
}

/** Read an SSE response body as an async iterable of events. */
export async function* readSse(
  response: Response,
  signal?: AbortSignal,
): AsyncGenerator<SseEvent, void, unknown> {
  if (!response.body) throw new Error('The provider returned no response body.');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const parser = new SseParser();

  try {
    while (true) {
      if (signal?.aborted) return;
      const { done, value } = await reader.read();
      if (done) break;
      // stream: true keeps multi-byte characters intact across chunk boundaries.
      for (const event of parser.push(decoder.decode(value, { stream: true }))) {
        yield event;
      }
    }
    for (const event of parser.flush()) yield event;
  } finally {
    reader.cancel().catch(() => {});
  }
}

/**
 * Turn a non-2xx provider response into a message worth showing.
 *
 * Providers bury the useful sentence at different depths, and the raw body is often a wall
 * of JSON. The status code alone is not actionable: 401 could be a bad key or a bad
 * organization, and only the body says which.
 */
export async function describeProviderError(response: Response): Promise<string> {
  let detail = '';
  try {
    const text = await response.text();
    try {
      const json = JSON.parse(text);
      detail =
        json?.error?.message ||
        json?.error?.metadata?.raw ||
        json?.message ||
        json?.detail ||
        text.slice(0, 300);
    } catch {
      detail = text.slice(0, 300);
    }
  } catch {
    detail = '';
  }

  const prefix =
    response.status === 401
      ? 'The provider rejected the API key'
      : response.status === 403
        ? 'The provider refused this request'
        : response.status === 404
          ? 'The model or endpoint was not found'
          : response.status === 429
            ? 'Rate limited by the provider'
            : response.status >= 500
              ? 'The provider had a server error'
              : `The provider returned ${response.status}`;

  return detail ? `${prefix}: ${detail}` : prefix;
}
