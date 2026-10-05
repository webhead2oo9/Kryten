const assert = require("node:assert/strict");
const { createLlmClassifier } = require("../dist/llm/classifier");
const { clefRoutingAdmissionExcluded } = require("../dist/features/betaClassifier/clefAdmission");

const ADMITTED_CASES = [
    {
        taskType: "beta_routing",
        messages: ["Virtual Desktop is not working with my link cable."],
        expected: "ROUTE",
    },
    {
        taskType: "beta_routing",
        messages: ["How do I enable the direct USB connection in the Virtual Desktop Quest beta?"],
        expected: "ROUTE",
    },
    { taskType: "beta_routing", messages: ["Anyone playing Beat Saber tonight?"], expected: "IGNORE" },
    {
        taskType: "beta_greeting",
        messages: ["Where can I download the Beta Streamer for the current Quest beta?"],
        expected: "KEEP",
    },
    { taskType: "beta_greeting", messages: ["Hello!"], expected: "DELETE" },
];

const ADMISSION_CASES = [
    ["The Steam edition of Virtual Desktop fails over USB on my Quest.", true],
    ["The Steam-edition of Virtual Desktop fails over USB on my Quest.", true],
    ["This is not the Steam version, but VD USB keeps disconnecting.", true],
    ["I use both the Steam-version and Quest version; VD USB keeps disconnecting.", true],
    ["VD USB disconnects whenever SteamVR starts.", false],
    ["VD USB disconnects while I play Steam games.", false],
];

async function main() {
    const live = process.argv[2] === "--live-clef";
    assert(live || process.argv.length === 2, "Usage: node scripts/probePrimary.cjs [--live-clef]");
    const source = { enabled: true, provider: "clef", model: "Cloudflare/clef-flash" };
    let calls = 0;
    let expected;
    let requestBytes = 0;
    const transport = async (url, init) => {
        assert.equal(url, "http://127.0.0.1:58756/v1/systemone");
        assert.equal(init.redirect, "error");
        assert.equal(init.headers.Authorization, undefined);
        calls++;
        requestBytes = Buffer.byteLength(init.body);
        const body = JSON.parse(init.body);
        assert.deepEqual(Object.keys(body).sort(), ["model", "questions", "state"]);
        assert.match(body.state.policy_version, /^kryten-beta-(routing|greeting)-v1$/);
        assert(Array.isArray(body.state.messages));
        if (live) return fetch(url, init);
        const labels = Object.keys(body.questions.decision.criteria);
        return Response.json({
            model: "Cloudflare/clef-flash",
            answers: {
                decision: {
                    type: "choice",
                    choice: expected,
                    probabilities: Object.fromEntries(labels.map(label => [label, label === expected ? 0.9 : 0.1])),
                    confidence: 0.8,
                },
            },
            usage: { input_tokens: 12, output_tokens: 0 },
        });
    };
    const classifier = createLlmClassifier(() => source, transport, {});
    try {
        for (const [message, excluded] of ADMISSION_CASES) {
            assert.equal(clefRoutingAdmissionExcluded(message), excluded);
            console.log(JSON.stringify({ mode: "local-admission", excluded, message }));
        }
        assert.equal(calls, 0);

        for (const item of ADMITTED_CASES) {
            expected = item.expected;
            const routing = item.taskType === "beta_routing";
            if (routing) assert.equal(clefRoutingAdmissionExcluded(item.messages[0]), false);
            const labels = routing ? ["ROUTE", "IGNORE"] : ["KEEP", "DELETE"];
            const result = await classifier.classifyLazy(labels[1], async () => ({
                systemInstruction: "Clef synthetic probe",
                input: item.messages.join("\n\n"),
                allowedLabels: labels,
                fallbackLabel: labels[1],
                clef: { taskType: item.taskType, messages: item.messages },
            }));
            assert.equal(result.status, "ok");
            assert.equal(result.label, item.expected);
            assert.equal(result.provider, "clef");
            assert.equal(result.model, "Cloudflare/clef-flash");
            console.log(
                JSON.stringify({
                    mode: live ? "live" : "offline",
                    taskType: item.taskType,
                    expected: item.expected,
                    status: result.status,
                    provider: result.provider,
                    model: result.model,
                    latencyMs: result.latencyMs,
                    requestBytes,
                    usage: result.usage,
                }),
            );
        }
        assert.equal(calls, ADMITTED_CASES.length);
        console.log(JSON.stringify({ calls, metrics: classifier.getMetrics() }));
    } finally {
        classifier.close();
        await classifier.drain();
    }
}

main().catch(error => {
    console.error(error.message);
    process.exitCode = 1;
});
