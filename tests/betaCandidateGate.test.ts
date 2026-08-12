import { describe, expect, it } from "vitest";
import { betaCandidateDecision } from "../src/features/betaClassifier/candidateGate";

describe("betaCandidateDecision", () => {
    const routes = [
        "Why does 1.34.20 only show Wi-Fi and no USB tag?",
        "How do I do the beta USB setup?",
        "Does the USB cable work?",
        "Where is the beta?",
        "Where do I download the Beta Streamer?",
        "USB NCM is missing from the adapter list, can anyone help?",
        "The VD stream freezes every 12 minutes on my Quest 3.",
        "Also getting disconnections on cabled.",
        "VD via USB has huge latency spikes, is that expected?",
        "Quest headset wired mode is not detected by my PC.",
        "Can I use 100 fps in the Virtual Desktop beta?",
        "How do I install the beta from the phone app?",
        "I am still on 1.34.18 after switching to beta.",
        "The beta release channel spinner is stuck forever.",
    ];

    const ignores = [
        "Why does 1.34.19 only show Wi-Fi and no USB tag?",
        "I use a cable; how do I start a flight simulator in VR?",
        "The beta USB connection and my new cable work perfectly.",
        "My USB flight stick is not detected by my game, can someone help?",
        "Why is my PC-to-router Ethernet connection dropping?",
        "Meta Link via USB keeps disconnecting, any ideas?",
        "The SteamVR beta crashes whenever I open a game.",
        "Which cable should I buy to charge my Quest?",
        "Why does VD disconnect on Wi-Fi?",
        "Why is the Quest OS beta option missing?",
    ];

    it.each(routes)("admits a likely beta support candidate: %s", text => {
        expect(betaCandidateDecision(text)).toMatchObject({ candidate: true });
    });

    it.each(ignores)("rejects a known false-positive shape: %s", text => {
        expect(betaCandidateDecision(text)).toMatchObject({ candidate: false });
    });
});
