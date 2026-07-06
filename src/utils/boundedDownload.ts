/**
 * Shared bounded HTTP download: a single timeout covers the request and the
 * body read, and the body is size-capped while streaming so an oversized (or
 * lying content-length) response can never be buffered whole. Returns null on
 * any failure — never throws — matching the bot's degrade-don't-crash posture.
 */

export interface BoundedDownloadOptions {
    timeoutMs: number;
    maxBytes: number;
    redirect?: RequestRedirect;
    validateResponse?: (response: Response) => boolean;
}

export interface BoundedDownloadResult {
    buffer: Buffer;
    headers: Headers;
    url: string;
}

export async function downloadBounded(url: string, options: BoundedDownloadOptions): Promise<Buffer | null> {
    const result = await downloadBoundedResponse(url, options);
    return result?.buffer ?? null;
}

export async function downloadBoundedResponse(
    url: string,
    options: BoundedDownloadOptions,
): Promise<BoundedDownloadResult | null> {
    const { timeoutMs, maxBytes } = options;
    try {
        const res = await fetch(url, {
            signal: AbortSignal.timeout(timeoutMs),
            redirect: options.redirect ?? "follow",
        });
        if (!res.ok) {
            // Cancel unconsumed bodies so undici can return the connection to its
            // keep-alive pool instead of holding the socket until GC.
            void res.body?.cancel().catch(() => undefined);
            return null;
        }
        const contentLength = Number(res.headers.get("content-length") ?? 0);
        if (contentLength > maxBytes) {
            void res.body?.cancel().catch(() => undefined);
            return null;
        }
        if (options.validateResponse && !options.validateResponse(res)) {
            void res.body?.cancel().catch(() => undefined);
            return null;
        }
        return {
            buffer: await readBodyWithLimit(res, maxBytes),
            headers: res.headers,
            url: res.url,
        };
    } catch {
        return null;
    }
}

async function readBodyWithLimit(response: Response, maxBytes: number): Promise<Buffer> {
    if (!response.body) {
        const raw = Buffer.from(await response.arrayBuffer());
        if (raw.length > maxBytes) throw new Error("response too large");
        return raw;
    }

    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let received = 0;
    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        received += value.byteLength;
        if (received > maxBytes) {
            await reader.cancel().catch(() => undefined);
            throw new Error("response too large");
        }
        chunks.push(value);
    }
    return Buffer.concat(chunks, received);
}
