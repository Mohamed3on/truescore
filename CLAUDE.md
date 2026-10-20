# TrueScore

## Model calls

Scripts, probes and evals here call paid APIs on the user's keys. Stick to the models the code already uses: production in `packages/gmaps-shared/src/wire.ts` (`DEFAULT_PROVIDER`, `MODELS`), eval candidates and judge in `packages/web/evals/`. Ask before calling any other model, even as a quick baseline or comparison. If a configured model looks outdated, say so and ask before running anything with it.

Put probe and A/B scripts in `packages/web/evals/out/` (gitignored): workspace imports (`@truescore/*`, the AI SDK) don't resolve from the scratchpad. The web typecheck covers that folder, so delete them when done.
