# TrueScore

## Model calls

Scripts, probes and evals here call paid APIs on the user's keys. Stick to the models the code already uses: production in `packages/web/llm.ts` and `packages/extension/src/shared/config.ts`, eval candidates and judge in `packages/web/evals/`. Ask before calling any other model, even as a quick baseline or comparison. If a configured model looks outdated, say so and ask before running anything with it.
