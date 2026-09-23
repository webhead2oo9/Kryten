interface StoppableBetaClassifier {
    stop(): void;
    drain(): Promise<void>;
}

interface StoppableBetaResponder {
    stop(): Promise<void>;
}

interface StoppableTypeSafeShadow {
    close(): void;
    drain(): Promise<void>;
}

export async function stopBetaFeatures(
    betaClassifier: StoppableBetaClassifier,
    betaResponder: StoppableBetaResponder,
    typeSafeShadow: StoppableTypeSafeShadow,
    destroyClient: () => Promise<void>,
    timeoutMs: number,
): Promise<void> {
    betaClassifier.stop();
    typeSafeShadow.close();
    try {
        await Promise.race([
            Promise.all([betaClassifier.drain(), betaResponder.stop(), typeSafeShadow.drain()]),
            new Promise<void>(resolve => {
                const timer = setTimeout(resolve, timeoutMs);
                timer.unref();
            }),
        ]);
    } finally {
        await destroyClient();
    }
}
