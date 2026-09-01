interface StoppableBetaClassifier {
    stop(): void;
    drain(): Promise<void>;
}

interface StoppableBetaResponder {
    stop(): Promise<void>;
}

export async function stopBetaFeatures(
    betaClassifier: StoppableBetaClassifier,
    betaResponder: StoppableBetaResponder,
    destroyClient: () => Promise<void>,
    timeoutMs: number,
): Promise<void> {
    betaClassifier.stop();
    try {
        await Promise.race([
            Promise.all([betaClassifier.drain(), betaResponder.stop()]),
            new Promise<void>(resolve => {
                const timer = setTimeout(resolve, timeoutMs);
                timer.unref();
            }),
        ]);
    } finally {
        await destroyClient();
    }
}
