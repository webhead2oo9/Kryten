import { describe, expect, it, vi } from "vitest";
import type { KrytenClient } from "../src/classes/client";
import type { CommandContext } from "../src/classes/commandContext";

const H = vi.hoisted(() => ({ deleteUser: vi.fn(async () => true) }));

vi.mock("../src/handlers/messageHandler", () => ({
    getUserInteractionStore: () => ({ deleteUser: H.deleteUser }),
}));

import DeleteDataCommand from "../src/commands/deleteData";

describe("/delete-data", () => {
    it("deletes only the invoking user's record and responds ephemerally", async () => {
        H.deleteUser.mockClear();
        const deferReply = vi.fn(async () => undefined);
        const editReply = vi.fn(async () => undefined);
        const context = {
            client: {} as KrytenClient,
            interaction: {
                user: { id: "invoking-user" },
                deferReply,
                editReply,
            },
        } as unknown as CommandContext;

        const command = new DeleteDataCommand();
        await command.run(context);

        expect(command.staff_only).toBe(false);
        expect(H.deleteUser).toHaveBeenCalledWith("invoking-user");
        expect(deferReply).toHaveBeenCalledWith({ ephemeral: true });
        expect(editReply).toHaveBeenCalledWith({
            content: expect.stringContaining("has been deleted"),
        });
    });
});
