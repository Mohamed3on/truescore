// The shipped models against newer ones on the price-performance frontier
// (2026-09). Each is registered as an extra PROVIDERS entry under its label, so
// summarize() and ask() resolve it like a provider name and token usage is
// reported per contestant.
import { createDeepSeek } from '@ai-sdk/deepseek';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { PROVIDERS, type Provider } from '../llm';

export const registerCandidates = () => {
  const google = createGoogleGenerativeAI({ apiKey: process.env.GEMINI_API_KEY });
  const deepseek = createDeepSeek({ apiKey: process.env.DEEPSEEK_API_KEY });
  const candidates = {
    'luna:low': PROVIDERS.openai,
    'flash-3:min': PROVIDERS.gemini,
    'flash-lite-3.5:min': { model: google('gemini-3.5-flash-lite'), providerOptions: PROVIDERS.gemini.providerOptions },
    // 3.8 has no minimal thinking level; low is its floor.
    'flash-3.8:low': { model: google('gemini-3.8-flash'), providerOptions: { google: { thinkingConfig: { thinkingLevel: 'low' as const } } } },
    // The shipped deepseek-v4-flash ID is a temporary alias for this model.
    'deepseek-flash:off': { model: deepseek('deepseek-flash'), providerOptions: PROVIDERS.deepseek.providerOptions },
  };
  Object.assign(PROVIDERS, candidates);
  return Object.keys(candidates).map((label) => ({ label, provider: label as Provider }));
};
