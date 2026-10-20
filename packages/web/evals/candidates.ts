// The shipped models against newer ones on the price-performance frontier
// (2026-09). Each is registered as an extra PROVIDERS entry under its label, so
// summarize() and ask() resolve it like a provider name and token usage is
// reported per contestant.
import { createAnthropic } from '@ai-sdk/anthropic';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { PROVIDERS, type Provider } from '../llm';

export const registerCandidates = () => {
  const google = createGoogleGenerativeAI({ apiKey: process.env.GEMINI_API_KEY });
  const anthropic = createAnthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const candidates = {
    'luna:low': PROVIDERS.openai,
    'flash-3:min': PROVIDERS.gemini,
    'flash-lite-3.5:min': { model: google('gemini-3.5-flash-lite'), providerOptions: PROVIDERS.gemini.providerOptions },
    // 3.8 has no minimal thinking level; low is its floor.
    'flash-3.8:low': { model: google('gemini-3.8-flash'), providerOptions: { google: { thinkingConfig: { thinkingLevel: 'low' as const } } } },
    'deepseek-flash:off': PROVIDERS.deepseek,
    // 2026-10-20 vs luna:low, the verdict depends on the judge: gpt-6-sol
    // picked luna in all 8 summary pairs, blind Claude judges picked Sonnet in
    // all 8. Both agree Sonnet covers more and luna is better grounded; Sonnet
    // also under-searches in Ask (45% recall). Medium effort changed nothing,
    // so only low stays.
    'sonnet-5.5:low': { model: anthropic('claude-sonnet-5-5'), providerOptions: { anthropic: { effort: 'low' as const } } },
  };
  Object.assign(PROVIDERS, candidates);
  // --only=a,b keeps just those labels.
  const only = process.argv.find((a) => a.startsWith('--only='))?.slice('--only='.length).split(',');
  return Object.keys(candidates).filter((label) => !only || only.includes(label)).map((label) => ({ label, provider: label as Provider }));
};
