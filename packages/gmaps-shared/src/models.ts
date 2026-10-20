import { createAnthropic } from '@ai-sdk/anthropic';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createOpenAI } from '@ai-sdk/openai';
import type { LanguageModel } from 'ai';
import { deepseekModel } from './deepseek';
import { MODELS, type Provider, type ReasoningEffort } from './wire';

// Each Provider's settings, written once for the server and the extension:
// a key in, the configured model call out. DEFAULT_PROVIDER and MODELS
// (wire.ts) pick the active one and each one's model.
export type ModelCall = { model: LanguageModel; providerOptions: Record<string, Record<string, any>>; maxOutputTokens: number };

export type ModelSetup = {
  apiKey: string | undefined;
  // gpt-6-luna's only; the other providers' thinking is fixed below.
  reasoningEffort?: ReasoningEffort;
  // For a call that needs no reasoning (web/llm.ts aliasesFor): each provider's
  // lowest setting. Gemini and DeepSeek already run at theirs.
  noReasoning?: boolean;
  // The server's: OpenAI then writes a prompt cache only at a breakpoint a call
  // places. Its default (implicit) mode bills a cache write at 1.25x input on
  // every request, at the end of the prompt, which a call with a different
  // ending never reads — so summaries and varied questions paid 25% more for
  // nothing.
  explicitCaching?: boolean;
  // The extension's: Anthropic only answers a browser's cross-origin call with
  // its direct-browser-access header.
  browser?: boolean;
};

export const modelCall = (provider: Provider, { apiKey, reasoningEffort = 'low', noReasoning, explicitCaching, browser }: ModelSetup): ModelCall => {
  switch (provider) {
    case 'gemini':
      return { model: createGoogleGenerativeAI({ apiKey })(MODELS.gemini), providerOptions: { google: { thinkingConfig: { thinkingLevel: 'minimal' } } }, maxOutputTokens: 32768 };
    // V4.1 Flash, non-thinking. V4 Flash tied nano/flash on latency+quality at a
    // fraction of the cost (web evals/latency.ts) and its thinking ladder ran
    // 2.5-7x slower for no quality gain, so it stays disabled. Structured output
    // goes through a strict tool call (deepseek.ts).
    case 'deepseek':
      return { model: deepseekModel(apiKey, MODELS.deepseek), providerOptions: { deepseek: { thinking: { type: 'disabled' } } }, maxOutputTokens: 8192 };
    // Claude Sonnet 5.5 at low effort, the default since 2026-10-20 (Ask,
    // summaries and the Tally; web evals/candidates.ts has the results). Medium
    // scored no better.
    case 'anthropic':
      return {
        model: createAnthropic({ apiKey, ...(browser ? { headers: { 'anthropic-dangerous-direct-browser-access': 'true' } } : {}) })(MODELS.anthropic),
        // Sonnet 5.5 refuses thinking disabled; between_tools is its lowest setting.
        providerOptions: { anthropic: { effort: 'low', ...(noReasoning ? { thinking: { type: 'between_tools' } } : {}) } },
        maxOutputTokens: 32768,
      };
    // GPT-6 Luna (the fast/cheap GPT-6 tier), low reasoning effort unless the
    // popup picks another. 2026-09-22 evals against GPT-5.6 Luna at low
    // (gpt-6-sol judge): its summaries are terser but beat 5.6's 26-6 once
    // grounding counts the weight of evidence (5.6's extra detail overstated
    // consensus), 1.5-3x faster at about half the cost; Ask quality matches.
    // Medium effort brought back 5.6's latency for no gain, and 5.6's ladder
    // showed high/xhigh burning 20-60x the reasoning tokens for no quality
    // gain — so keep the cheapest level.
    case 'openai':
      return {
        model: createOpenAI({ apiKey })(MODELS.openai),
        providerOptions: { openai: { reasoningEffort: noReasoning ? 'none' : reasoningEffort, ...(explicitCaching ? { promptCacheOptions: { mode: 'explicit' } } : {}) } },
        maxOutputTokens: 32768,
      };
  }
};
