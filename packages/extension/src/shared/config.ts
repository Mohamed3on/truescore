import { DEFAULT_PROVIDER, LLM_PROVIDERS, REASONING_EFFORTS, type ReasoningEffort, type Provider as LLMProvider } from '@truescore/gmaps-shared';

// API keys are per-user: set in the TrueScore popup, stored in
// chrome.storage.sync. They are deliberately NOT bundled — a key compiled into
// the extension is readable by anyone who unpacks it.
const storedKey = async (name: string): Promise<string> => {
  try {
    const items = await chrome.storage.sync.get(name) as Record<string, string>;

    return items[name] || '';
  } catch {
    // MAIN-world scripts can't reach chrome.storage; they use the web proxy, not this.
    return '';
  }
};

// The truescore server's shared password, set in the popup.
export const getTruescorePassword = (): Promise<string> => storedKey('truescorePassword');

// gpt-6-luna reasoning effort, set in the popup. ReasoningEffort and its
// validation list are the canonical ones from gmaps-shared/wire.ts (shared with
// the server), re-exported here so the rest of the extension keeps importing
// them from config. Default 'low'; only the OpenAI path reads it (Gemini and
// DeepSeek run non-thinking).
export type { ReasoningEffort, LLMProvider };

export { REASONING_EFFORTS };

export const DEFAULT_REASONING_EFFORT: ReasoningEffort = 'low';

// Active provider for extension-direct summaries: the popup toggle wins; unset,
// DEFAULT_PROVIDER (gmaps-shared/wire.ts) if its key is saved, else the first
// provider with one. (Google Maps summaries are server-side and follow the
// server's default instead.)
export async function getReasoningEffort(): Promise<ReasoningEffort> {
  const effort = await storedKey('openaiReasoningEffort');

  return (REASONING_EFFORTS as readonly string[]).includes(effort) ? (effort as ReasoningEffort) : DEFAULT_REASONING_EFFORT;
}

export async function getActiveLLM(): Promise<{ provider: LLMProvider; key: string; reasoningEffort: ReasoningEffort }> {
  const [pref, keys, reasoningEffort] = await Promise.all([
    getProviderChoice(),
    Promise.all([storedKey('anthropicApiKey'), storedKey('openaiApiKey'), storedKey('geminiApiKey'), storedKey('deepseekApiKey')])
      .then(([anthropic, openai, gemini, deepseek]): Record<LLMProvider, string> => ({ anthropic, openai, gemini, deepseek })),
    getReasoningEffort(),
  ]);

  const provider: LLMProvider = pref ?? [DEFAULT_PROVIDER, ...LLM_PROVIDERS].find((p) => keys[p]) ?? DEFAULT_PROVIDER;

  return { provider, key: keys[provider], reasoningEffort };
}

// Google Maps summaries run server-side on the server's key, so the popup's
// provider toggle only overrides the server default when explicitly chosen — an
// unset toggle returns undefined and leaves the server on its own default.
export async function getProviderChoice(): Promise<LLMProvider | undefined> {
  const pref = await storedKey('llmProvider');

  return (LLM_PROVIDERS as readonly string[]).includes(pref) ? (pref as LLMProvider) : undefined;
}
