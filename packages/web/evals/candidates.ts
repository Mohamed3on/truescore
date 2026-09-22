// The shipped models against newer ones on the price-performance frontier
// (2026-09). Each is registered as an extra PROVIDERS entry under its label, so
// summarize() and ask() resolve it like a provider name and token usage is
// reported per contestant.
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createOpenAI } from '@ai-sdk/openai';
import { PROVIDERS, type Provider } from '../llm';

export const registerCandidates = () => {
  const google = createGoogleGenerativeAI({ apiKey: process.env.GEMINI_API_KEY });
  const openai = createOpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const candidates = {
    'luna:low': PROVIDERS.openai,
    'luna-6:low': { model: openai('gpt-6-luna'), providerOptions: PROVIDERS.openai.providerOptions },
    'flash-3:min': PROVIDERS.gemini,
    'flash-lite-3.5:min': { model: google('gemini-3.5-flash-lite'), providerOptions: PROVIDERS.gemini.providerOptions },
    // 3.8 has no minimal thinking level; low is its floor.
    'flash-3.8:low': { model: google('gemini-3.8-flash'), providerOptions: { google: { thinkingConfig: { thinkingLevel: 'low' as const } } } },
    'deepseek-flash:off': PROVIDERS.deepseek,
  };
  Object.assign(PROVIDERS, candidates);
  // --only=a,b keeps just those labels.
  const only = process.argv.find((a) => a.startsWith('--only='))?.slice('--only='.length).split(',');
  return Object.keys(candidates).filter((label) => !only || only.includes(label)).map((label) => ({ label, provider: label as Provider }));
};
