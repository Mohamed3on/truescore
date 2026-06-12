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

export const getGeminiApiKey = () => storedKey('geminiApiKey');
export const getOpenAIApiKey = () => storedKey('openaiApiKey');

export const GEMINI_MODEL = 'gemini-3-flash-preview';

export const geminiEndpoint = (apiKey: string) =>
  `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${apiKey}`;

export const OPENAI_MODEL = 'gpt-5.4-nano';

export const OPENAI_ENDPOINT = 'https://api.openai.com/v1/chat/completions';
