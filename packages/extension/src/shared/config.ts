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

// gpt-5.4-nano reasoning effort, set in the popup. The API accepts
// none|low|medium|high|xhigh; we expose none..high. Default is 'low' — about
// as fast as no reasoning while still thinking a little; medium/high roughly
// double nano's latency (see web evals/latency.ts). Only the OpenAI path reads
// this — Gemini Flash thinking is pinned to MINIMAL in review-summary.ts.
export type ReasoningEffort = 'none' | 'low' | 'medium' | 'high';
export const REASONING_EFFORTS: ReasoningEffort[] = ['none', 'low', 'medium', 'high'];
export const DEFAULT_REASONING_EFFORT: ReasoningEffort = 'low';

// Active provider for extension-direct summaries: the popup toggle wins;
// unset falls back to OpenAI-if-keyed, else Gemini. (Google Maps summaries
// are server-side and follow the server's LLM_PROVIDER instead.)
export async function getReasoningEffort(): Promise<ReasoningEffort> {
  const effort = await storedKey('openaiReasoningEffort');
  return (REASONING_EFFORTS as string[]).includes(effort) ? (effort as ReasoningEffort) : DEFAULT_REASONING_EFFORT;
}

export async function getActiveLLM(): Promise<{ provider: 'gemini' | 'openai'; key: string; reasoningEffort: ReasoningEffort }> {
  const [pref, openaiKey, geminiKey, reasoningEffort] = await Promise.all([
    storedKey('llmProvider'),
    storedKey('openaiApiKey'),
    storedKey('geminiApiKey'),
    getReasoningEffort(),
  ]);
  const provider = pref === 'gemini' || pref === 'openai' ? pref : openaiKey ? 'openai' : 'gemini';
  return { provider, key: provider === 'openai' ? openaiKey : geminiKey, reasoningEffort };
}

export const GEMINI_MODEL = 'gemini-3-flash-preview';

export const geminiEndpoint = (apiKey: string) =>
  `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${apiKey}`;

export const OPENAI_MODEL = 'gpt-5.4-nano';

export const OPENAI_ENDPOINT = 'https://api.openai.com/v1/chat/completions';
