/**
 * Newline-delimited JSON (JSONL) framing for the JSON-RPC transport.
 *
 * One frame per line: a complete JSON document followed by `\n`. The framer
 * tolerates arbitrarily chunked input (half lines, several frames per chunk)
 * and surfaces malformed lines through `onError` instead of throwing, so one
 * bad frame cannot kill the connection.
 */
export class JsonlFraming {
  private buffer = '';
  private ended = false;

  constructor(
    private readonly onFrame: (message: unknown) => void,
    private readonly onError?: (error: Error, rawLine: string) => void,
  ) {}

  /** Feed a chunk of incoming text. Emits one callback per completed line. */
  feed(chunk: string): void {
    if (this.ended) return;
    this.buffer += chunk;
    for (;;) {
      const newline = this.buffer.indexOf('\n');
      if (newline === -1) return;
      const line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      this.dispatchLine(line);
    }
  }

  /**
   * Signal end of input. A non-empty tail is a truncated final frame and is
   * reported as an error (the peer went away mid-frame).
   */
  end(): void {
    if (this.ended) return;
    this.ended = true;
    const tail = this.buffer;
    this.buffer = '';
    if (tail.trim().length > 0) {
      this.onError?.(new Error('Truncated JSONL frame at end of input'), tail);
    }
  }

  private dispatchLine(rawLine: string): void {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
    if (line.trim().length === 0) return;
    try {
      this.onFrame(JSON.parse(line));
    } catch (error) {
      this.onError?.(
        error instanceof Error ? error : new Error(String(error)),
        line.length > 200 ? `${line.slice(0, 200)}…` : line,
      );
    }
  }
}

/** Encode one outgoing message as a JSONL frame. */
export function encodeJsonlFrame(message: unknown): string {
  return `${JSON.stringify(message)}\n`;
}
