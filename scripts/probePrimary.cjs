const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { createLlmClassifier } = require("../dist/llm/classifier");
const { validateConfig } = require("../dist/config/validate");

async function main() {
    const live = process.argv[2] === "--live";
    assert(live || process.argv.length === 2, "Usage: node scripts/probePrimary.cjs [--live CONFIG]");
    const source = live
        ? validateConfig(JSON.parse(readFileSync(process.argv[3], "utf8"))).llm_classifier
        : { enabled: true, provider: "typesafe", model: "jev-1.13.0" };
    assert.equal(source?.enabled, true);
    assert.equal(source.provider, "typesafe");
    assert.equal(source.model, "jev-1.13.0");
    let calls = 0;
    let expected;
    const transport = async (url, init) => {
        assert.equal(url, "https://api.typesafe.ai/v1/systemone");
        calls++;
        if (live) return fetch(url, init);
        const body = JSON.parse(init.body);
        assert.deepEqual(Object.keys(body).sort(), ["model", "questions", "state"]);
        const labels = Object.keys(body.questions.decision.criteria);
        return Response.json({
            model: source.model,
            answers: {
                decision: {
                    type: "choice",
                    choice: expected,
                    probabilities: Object.fromEntries(labels.map(label => [label, label === expected ? 0.9 : 0.1])),
                    confidence: 0.8,
                },
            },
            usage: { input_tokens: 12, output_tokens: 4 },
        });
    };
    const classifier = createLlmClassifier(
        () => source,
        transport,
        live ? process.env : { TYPESAFE_API_KEY: "synthetic" },
    );
    try {
        for (const labels of [
            ["ROUTE", "IGNORE"],
            ["KEEP", "DELETE"],
        ]) {
            for (const label of labels) {
                expected = label;
                const result = await classifier.classifyLazy(labels[1], async () => ({
                    systemInstruction: `This is an isolated synthetic transport test. Select ${label} for TARGET.`,
                    input: "[TARGET]\nAUTHOR_1: synthetic provider smoke input",
                    allowedLabels: labels,
                    fallbackLabel: labels[1],
                }));
                assert.equal(result.status, "ok");
                assert.equal(result.label, label);
                assert.equal(result.provider, "typesafe");
                assert.equal(result.model, "jev-1.13.0");
                console.log(JSON.stringify({ mode: live ? "live" : "offline", expected: label, ...result }));
            }
        }
        assert.equal(calls, 4);
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
