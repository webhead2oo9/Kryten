import { beforeEach, describe, expect, it, vi } from "vitest";
import { downloadBoundedResponse } from "../src/utils/boundedDownload";
import { buildImageGallery, isAllowedDiscordMediaUrl } from "../src/utils/imageGallery";

vi.mock("../src/utils/boundedDownload", () => ({
    downloadBoundedResponse: vi.fn(),
}));

beforeEach(() => {
    vi.mocked(downloadBoundedResponse).mockReset();
});

describe("isAllowedDiscordMediaUrl", () => {
    it("allows Discord CDN attachment URLs", () => {
        expect(isAllowedDiscordMediaUrl("https://cdn.discordapp.com/attachments/1/2/img.png")).toBe(true);
    });

    it("allows media proxy attachment and external URLs", () => {
        expect(isAllowedDiscordMediaUrl("https://media.discordapp.net/attachments/1/2/img.png")).toBe(true);
        expect(isAllowedDiscordMediaUrl("https://media.discordapp.net/external/abc/https/example.com/img.png")).toBe(
            true,
        );
    });

    it("allows numbered external-image hosts only under /external/", () => {
        expect(isAllowedDiscordMediaUrl("https://images-ext-1.discordapp.net/external/abc/img.png")).toBe(true);
        expect(isAllowedDiscordMediaUrl("https://images-ext-42.discordapp.net/external/abc/img.png")).toBe(true);
        expect(isAllowedDiscordMediaUrl("https://images-ext-1.discordapp.net/attachments/1/2/img.png")).toBe(false);
    });

    it("rejects non-https schemes", () => {
        expect(isAllowedDiscordMediaUrl("http://cdn.discordapp.com/attachments/1/2/img.png")).toBe(false);
        expect(isAllowedDiscordMediaUrl("ftp://cdn.discordapp.com/attachments/1/2/img.png")).toBe(false);
    });

    it("rejects foreign and look-alike hosts", () => {
        expect(isAllowedDiscordMediaUrl("https://example.com/attachments/1/2/img.png")).toBe(false);
        expect(isAllowedDiscordMediaUrl("https://cdn.discordapp.com.evil.com/attachments/1/2/img.png")).toBe(false);
        expect(isAllowedDiscordMediaUrl("https://images-ext-x.discordapp.net/external/abc/img.png")).toBe(false);
    });

    it("rejects allowed hosts outside their permitted path prefixes", () => {
        expect(isAllowedDiscordMediaUrl("https://cdn.discordapp.com/avatars/1/a.png")).toBe(false);
        expect(isAllowedDiscordMediaUrl("https://media.discordapp.net/banners/1/a.png")).toBe(false);
    });

    it("rejects malformed URLs", () => {
        expect(isAllowedDiscordMediaUrl("not a url")).toBe(false);
        expect(isAllowedDiscordMediaUrl("")).toBe(false);
    });
});

describe("buildImageGallery", () => {
    it("skips SVG attachments before download", async () => {
        const message = {
            attachments: new Map([
                [
                    "svg",
                    {
                        contentType: "image/svg+xml",
                        proxyURL: "https://cdn.discordapp.com/attachments/1/2/vector.svg",
                        url: "https://cdn.discordapp.com/attachments/1/2/vector.svg",
                    },
                ],
            ]),
            embeds: [],
        };

        const result = await buildImageGallery(message as any);

        expect(result.files).toHaveLength(0);
        expect(result.items).toHaveLength(0);
        expect(downloadBoundedResponse).not.toHaveBeenCalled();
    });

    it("rejects SVG responses from proxied embed images", async () => {
        vi.mocked(downloadBoundedResponse).mockImplementation(async (_url, options) => {
            const accepted =
                options.validateResponse?.(
                    new Response(null, { headers: new Headers({ "content-type": "image/svg+xml" }) }),
                ) ?? true;
            return accepted
                ? {
                      buffer: Buffer.from("<svg />"),
                      headers: new Headers({ "content-type": "image/svg+xml" }),
                      url: "https://media.discordapp.net/external/abc/https/example.com/vector.svg",
                  }
                : null;
        });
        const message = {
            attachments: new Map(),
            embeds: [
                {
                    image: {
                        proxyURL: "https://media.discordapp.net/external/abc/https/example.com/vector.svg",
                    },
                },
            ],
        };

        const result = await buildImageGallery(message as any);

        expect(result.files).toHaveLength(0);
        expect(result.items).toHaveLength(0);
        expect(downloadBoundedResponse).toHaveBeenCalledTimes(1);
    });

    it("stops downloading once the total byte budget is exhausted", async () => {
        const tenMiB = 10 * 1024 * 1024;
        vi.mocked(downloadBoundedResponse).mockImplementation(async () => ({
            buffer: Buffer.alloc(tenMiB),
            headers: new Headers({ "content-type": "image/png" }),
            url: "https://cdn.discordapp.com/attachments/1/2/image.png",
        }));
        const message = {
            attachments: new Map(
                Array.from({ length: 5 }, (_, i) => [
                    String(i),
                    {
                        contentType: "image/png",
                        proxyURL: `https://cdn.discordapp.com/attachments/1/2/${i}.png`,
                        url: `https://cdn.discordapp.com/attachments/1/2/${i}.png`,
                    },
                ]),
            ),
            embeds: [],
        };

        const result = await buildImageGallery(message as any);

        expect(result.files).toHaveLength(4);
        expect(result.items).toHaveLength(4);
        expect(downloadBoundedResponse).toHaveBeenCalledTimes(4);
    });
});
