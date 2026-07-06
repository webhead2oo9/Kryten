import { describe, expect, it, vi } from "vitest";
import {
    deleteMessageById,
    kickMember,
    sendModAlert,
    timeoutMember,
} from "../src/features/moderation/actions";

function clientWithChannel(channel: unknown): any {
    return { channels: { fetch: vi.fn(async () => channel) } };
}

describe("timeoutMember", () => {
    it("calls member.timeout with exactly minutes*60*1000 ms and reports the duration", async () => {
        const timeout = vi.fn(async () => undefined);
        const member: any = { timeout };

        const result = await timeoutMember(member, 10, "spam burst");

        expect(timeout).toHaveBeenCalledTimes(1);
        expect(timeout).toHaveBeenCalledWith(10 * 60 * 1000, "spam burst");
        expect(result).toEqual({ ok: true, detail: "10min timeout" });
    });

    it("returns {ok:false} with the failure detail and never throws when timeout rejects", async () => {
        const member: any = {
            timeout: vi.fn(async () => {
                throw new Error("Missing Permissions");
            }),
        };

        const result = await timeoutMember(member, 5, "reason");

        expect(result.ok).toBe(false);
        expect(result.detail).toBe("Timeout failed - Missing Permissions");
    });
});

describe("kickMember", () => {
    it("returns {ok:true, detail:'User kicked'} on success", async () => {
        const kick = vi.fn(async () => undefined);
        const member: any = { kick };

        const result = await kickMember(member, "ban evasion");

        expect(kick).toHaveBeenCalledWith("ban evasion");
        expect(result).toEqual({ ok: true, detail: "User kicked" });
    });

    it("returns {ok:false} with the failure detail and never throws when kick rejects", async () => {
        const member: any = {
            kick: vi.fn(async () => {
                throw new Error("Unknown Member");
            }),
        };

        const result = await kickMember(member, "reason");

        expect(result.ok).toBe(false);
        expect(result.detail).toBe("Kick failed - Unknown Member");
    });
});

describe("deleteMessageById", () => {
    it("returns false when the channel fetch rejects, without throwing", async () => {
        const client: any = {
            channels: {
                fetch: vi.fn(async () => {
                    throw new Error("Unknown Channel");
                }),
            },
        };

        await expect(deleteMessageById(client, "chan", "msg")).resolves.toBe(false);
    });

    it("returns false when the channel is not text-based", async () => {
        const client = clientWithChannel({ isTextBased: () => false });

        await expect(deleteMessageById(client, "chan", "msg")).resolves.toBe(false);
    });

    it("returns false when the message fetch rejects", async () => {
        const channel = {
            isTextBased: () => true,
            messages: {
                fetch: vi.fn(async () => {
                    throw new Error("Unknown Message");
                }),
            },
        };
        const client = clientWithChannel(channel);

        await expect(deleteMessageById(client, "chan", "msg")).resolves.toBe(false);
    });

    it("returns false when the delete rejects, without throwing", async () => {
        const channel = {
            isTextBased: () => true,
            messages: {
                fetch: vi.fn(async () => ({
                    delete: vi.fn(async () => {
                        throw new Error("Missing Permissions");
                    }),
                })),
            },
        };
        const client = clientWithChannel(channel);

        await expect(deleteMessageById(client, "chan", "msg")).resolves.toBe(false);
    });

    it("fetches the (uncached) message and returns true on a full success", async () => {
        const del = vi.fn(async () => undefined);
        const messageFetch = vi.fn(async () => ({ delete: del }));
        const channel = {
            isTextBased: () => true,
            messages: { fetch: messageFetch },
        };
        const client = clientWithChannel(channel);

        const result = await deleteMessageById(client, "chan", "msg-123");

        expect(messageFetch).toHaveBeenCalledWith("msg-123");
        expect(del).toHaveBeenCalledTimes(1);
        expect(result).toBe(true);
    });
});

describe("sendModAlert", () => {
    it("sends with allowedMentions parse:[] so nothing in the container can ping", async () => {
        const send = vi.fn(async () => undefined);
        const channel = { isTextBased: () => true, send };
        const client = clientWithChannel(channel);
        const container: any = { marker: "container" };

        const result = await sendModAlert(client, "alerts", container);

        expect(result).toBe(true);
        expect(send).toHaveBeenCalledTimes(1);
        const payload = send.mock.calls[0][0] as any;
        expect(payload.allowedMentions).toEqual({ parse: [] });
        expect(payload.components).toEqual([container]);
    });

    it("returns false when the channel is missing, without throwing", async () => {
        const client = clientWithChannel(null);

        await expect(sendModAlert(client, "alerts", {} as any)).resolves.toBe(false);
    });

    it("returns false when the channel is not text-based", async () => {
        const client = clientWithChannel({ isTextBased: () => false });

        await expect(sendModAlert(client, "alerts", {} as any)).resolves.toBe(false);
    });

    it("returns false when send rejects, without throwing", async () => {
        const channel = {
            isTextBased: () => true,
            send: vi.fn(async () => {
                throw new Error("Missing Access");
            }),
        };
        const client = clientWithChannel(channel);

        await expect(sendModAlert(client, "alerts", {} as any)).resolves.toBe(false);
    });
});
