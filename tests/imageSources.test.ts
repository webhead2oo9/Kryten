import { afterEach, describe, expect, it, vi } from "vitest";
import { MAX_IMAGE_BYTES, resolveImageSources } from "../src/features/imageFingerprint/imageSources";

function messageWithAttachment(attachment: Record<string, unknown>): any {
    return messageWithAttachments([attachment]);
}

function messageWithAttachments(attachments: Record<string, unknown>[]): any {
    return {
        attachments: new Map(attachments.map((attachment, index) => [String(index), attachment])),
    };
}

function imageAttachment(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
        contentType: "image/png",
        name: "image.png",
        url: "https://cdn.example/image.png",
        proxyURL: "https://cdn.example/image.png",
        size: 4,
        ...overrides,
    };
}

afterEach(() => {
    vi.unstubAllGlobals();
});

describe("resolveImageSources", () => {
    it("does not fetch attachments advertised over the byte limit", async () => {
        const fetchMock = vi.fn();
        vi.stubGlobal("fetch", fetchMock);

        const sources = await resolveImageSources(
            messageWithAttachment(imageAttachment({ size: MAX_IMAGE_BYTES + 1 })),
        );

        expect(sources).toEqual([]);
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it("rejects responses whose content-length exceeds the byte limit", async () => {
        vi.stubGlobal(
            "fetch",
            vi.fn(async () => new Response(new Uint8Array([1]), { headers: { "content-length": "5" } })),
        );

        const sources = await resolveImageSources(messageWithAttachment(imageAttachment({ size: 0 })), 4);

        expect(sources).toEqual([]);
    });

    it("stops streamed reads that exceed the byte limit", async () => {
        vi.stubGlobal(
            "fetch",
            vi.fn(async () => new Response(new Uint8Array([1, 2, 3, 4, 5]))),
        );

        const sources = await resolveImageSources(messageWithAttachment(imageAttachment({ size: 0 })), 4);

        expect(sources).toEqual([]);
    });

    it("downloads attachments sequentially", async () => {
        let resolveFirst: ((response: Response) => void) | undefined;
        const firstFetch = new Promise<Response>(resolve => {
            resolveFirst = resolve;
        });
        const fetchMock = vi.fn((url: string) => {
            if (url.endsWith("/first.png")) return firstFetch;
            return Promise.resolve(new Response(new Uint8Array([2])));
        });
        vi.stubGlobal("fetch", fetchMock);

        const result = resolveImageSources(
            messageWithAttachments([
                imageAttachment({ url: "https://cdn.example/first.png", size: 0 }),
                imageAttachment({ url: "https://cdn.example/second.png", size: 0 }),
            ]),
            4,
        );
        await Promise.resolve();

        expect(fetchMock).toHaveBeenCalledTimes(1);

        resolveFirst?.(new Response(new Uint8Array([1])));
        const sources = await result;

        expect(fetchMock).toHaveBeenCalledTimes(2);
        expect(sources.map(source => source.url)).toEqual([
            "https://cdn.example/first.png",
            "https://cdn.example/second.png",
        ]);
    });
});
