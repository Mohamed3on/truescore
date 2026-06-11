// The Gemini key is per-user: set in the TrueScore popup, stored in
// chrome.storage.sync. It is deliberately NOT bundled — a key compiled into the
// extension is readable by anyone who unpacks it.
export async function getGeminiApiKey(): Promise<string> {
  try {
    const { geminiApiKey } = await chrome.storage.sync.get('geminiApiKey');
    return geminiApiKey || '';
  } catch {
    // MAIN-world scripts can't reach chrome.storage; they use the web proxy, not this.
    return '';
  }
}

export const GEMINI_MODEL = 'gemini-3-flash-preview';

export const geminiEndpoint = (apiKey: string) =>
  `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${apiKey}`;
