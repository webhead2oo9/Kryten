import tseslint from "typescript-eslint";
import prettier from "eslint-config-prettier";

export default tseslint.config(
    { ignores: ["dist/**", "node_modules/**", "*.config.mjs"] },
    ...tseslint.configs.recommended,
    prettier,
    {
        rules: {
            // The codebase intentionally uses `any` (discord.js payload shims) and
            // non-null assertions; tsc's strict flags already cover unused locals.
            "@typescript-eslint/no-explicit-any": "off",
            "@typescript-eslint/no-non-null-assertion": "off",
            // Store.loadClasses dynamically require()s command files by design.
            "@typescript-eslint/no-require-imports": "off",
            "@typescript-eslint/no-unused-vars": [
                "warn",
                { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
            ],
            "no-empty": ["warn", { allowEmptyCatch: true }],
        },
    },
);
