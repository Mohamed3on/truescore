import { REASONING_EFFORTS, type ReasoningEffort, type Provider as LLMProvider } from '@truescore/gmaps-shared';

// API keys are per-user: set in the TrueScore popup, stored in
// chrome.storage.sync. They are deliberately NOT bundled — a key compiled into
// the extension is readable by anyone who unpacks it.
const storedKey = async (name: string): Promise<string> => {
  try {
    const items = await chrome.storage.sync.get(name);
    return items[name] || '';
  } catch {
    // MAIN-world scripts can't reach chrome.storage; they use the web proxy, not this.
    return '';
  }
};

// gpt-5.4-nano reasoning effort, set in the popup. ReasoningEffort and its
// validation list are the canonical ones from gmaps-shared/wire.ts (shared with
// the server), re-exported here so the rest of the extension keeps importing
// them from config. Default 'low'; only the OpenAI path reads it (Gemini and
// DeepSeek run non-thinking).
export type { ReasoningEffort, LLMProvider };
export { REASONING_EFFORTS };
export const DEFAULT_REASONING_EFFORT: ReasoningEffort = 'low';

// Active provider for extension-direct summaries: the popup toggle wins;
// unset falls back to OpenAI-if-keyed, else Gemini. (Google Maps summaries
// are server-side and follow the server's LLM_PROVIDER instead.)
export async function getReasoningEffort(): Promise<ReasoningEffort> {
  const effort = await storedKey('openaiReasoningEffort');
  return (REASONING_EFFORTS as readonly string[]).includes(effort) ? (effort as ReasoningEffort) : DEFAULT_REASONING_EFFORT;
}

export async function getActiveLLM(): Promise<{ provider: LLMProvider; key: string; reasoningEffort: ReasoningEffort }> {
  const [pref, openaiKey, geminiKey, deepseekKey, reasoningEffort] = await Promise.all([
    storedKey('llmProvider'),
    storedKey('openaiApiKey'),
    storedKey('geminiApiKey'),
    storedKey('deepseekApiKey'),
    getReasoningEffort(),
  ]);
  const provider: LLMProvider = pref === 'gemini' || pref === 'openai' || pref === 'deepseek' ? pref : openaiKey ? 'openai' : 'gemini';
  const key = provider === 'openai' ? openaiKey : provider === 'deepseek' ? deepseekKey : geminiKey;
  return { provider, key, reasoningEffort };
}

// Google Maps summaries run server-side on the server's key, so the popup's
// provider toggle only overrides the server default when explicitly chosen — an
// unset toggle returns undefined and leaves the server on its own default.
export async function getProviderChoice(): Promise<LLMProvider | undefined> {
  const pref = await storedKey('llmProvider');
  return pref === 'gemini' || pref === 'openai' || pref === 'deepseek' ? pref : undefined;
}

export const GEMINI_MODEL = 'gemini-3-flash-preview';

export const geminiEndpoint = (apiKey: string) =>
  `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${apiKey}`;

export const OPENAI_MODEL = 'gpt-5.4-nano';

export const OPENAI_ENDPOINT = 'https://api.openai.com/v1/chat/completions';

// DeepSeek V4 Flash via its OpenAI-compatible Chat Completions endpoint. Always
// non-thinking (fastest, and its thinking ladder didn't improve summary quality
// — see web evals/latency.ts); no native json_schema, so review-summary.ts asks
// for json_object and pins the shape into the prompt.
export const DEEPSEEK_MODEL = 'deepseek-v4-flash';

export const DEEPSEEK_ENDPOINT = 'https://api.deepseek.com/v1/chat/completions';
