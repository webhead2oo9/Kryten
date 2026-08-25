import { describe, expect, it } from "vitest";
import { betaCandidateDecision } from "../src/features/betaClassifier/candidateGate";

describe("betaCandidateDecision", () => {
    const routes = [
        "How do I do the beta USB setup?",
        "USB NCM is missing from the adapter list, can anyone help?",
        "The VD stream freezes every 15 minutes on my Quest 3.",
        "The stream goes black about every fifteen minutes, is that expected?",
        "Why does the stream restart every quarter hour?",
        "Also getting disconnections on cabled.",
        "VD via USB has huge latency spikes, is that expected?",
        "Quest headset wired mode is not detected by my PC.",
        "Why does my link cable keep disconnecting in Virtual Desktop?",
        "Where do I download the Beta Streamer?",
        "How do I switch to the Beta release channel for USB mode?",
    ];

    const ignores = [
        "Why does 1.34.20 only show Wi-Fi?",
        "Where is the beta?",
        "The VD stream freezes every 12 minutes on my Quest 3.",
        "Can I use 100 fps in the Virtual Desktop beta?",
        "How do I install the beta from the phone app?",
        "I am still on 1.34.18 after switching to beta.",
        "The beta release channel spinner is stuck forever.",
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
