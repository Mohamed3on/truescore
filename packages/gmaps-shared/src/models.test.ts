import { expect, test } from 'bun:test';
import { modelCall } from './models';
import { LLM_PROVIDERS, MODELS } from './wire';

// Each Provider's settings, as the server and the extension both run them.
const SETTINGS = {
  gemini: { providerOptions: { google: { thinkingConfig: { thinkingLevel: 'minimal' } } }, maxOutputTokens: 32768 },
  deepseek: { providerOptions: { deepseek: { thinking: { type: 'disabled' } } }, maxOutputTokens: 8192 },
  anthropic: { providerOptions: { anthropic: { effort: 'low' } }, maxOutputTokens: 32768 },
  openai: { providerOptions: { openai: { reasoningEffort: 'low' } }, maxOutputTokens: 32768 },
};

test.each(LLM_PROVIDERS)('%s runs its model on its settings', (provider) => {
  const { model, ...settings } = modelCall(provider, { apiKey: 'k' });
  expect([(model as { modelId: string }).modelId, settings]).toEqual([MODELS[provider], SETTINGS[provider]]);
});

test("Luna takes the popup's effort, and the server's explicit caching", () => {
  expect(modelCall('openai', { apiKey: 'k', reasoningEffort: 'high', explicitCaching: true }).providerOptions)
    .toEqual({ openai: { reasoningEffort: 'high', promptCacheOptions: { mode: 'explicit' } } });
});
