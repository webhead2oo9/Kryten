import { describe, expect, it, vi } from "vitest";
import { stopBetaFeatures } from "../src/shutdown/betaFeatures";

describe("stopBetaFeatures", () => {
    it("keeps Discord available until beta greeting cleanup completes", async () => {
        let finishResponder!: () => void;
        const responderStopped = new Promise<void>(resolve => {
            finishResponder = resolve;
        });
        const betaClassifier = {
            stop: vi.fn(),
            drain: vi.fn(async () => undefined),
        };
        const betaResponder = {
            stop: vi.fn(async () => responderStopped),
        };
        const destroyClient = vi.fn(async () => undefined);

        const stopping = stopBetaFeatures(betaClassifier, betaResponder, destroyClient, 5_000);
        await vi.waitFor(() => expect(betaResponder.stop).toHaveBeenCalledOnce());
        expect(destroyClient).not.toHaveBeenCalled();

        finishResponder();
        await stopping;

        expect(destroyClient).toHaveBeenCalledOnce();
        expect(betaClassifier.stop).toHaveBeenCalledOnce();
        expect(betaClassifier.drain).toHaveBeenCalledOnce();
    });
});
