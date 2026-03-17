// Build-time fallback (from GEMINI_API_KEY env var)
const BUILD_TIME_KEY = process.env.GEMINI_API_KEY as string;

// Runtime key from chrome.storage, falling back to build-time key
export async function getGeminiApiKey(): Promise<string> {
  try {
    const { geminiApiKey } = await chrome.storage.sync.get('geminiApiKey');
    return geminiApiKey || BUILD_TIME_KEY || '';
  } catch {
    // MAIN world scripts can't access chrome.storage
    return BUILD_TIME_KEY || '';
  }
}

// Sync export for MAIN world scripts (gmaps) that can't use chrome.storage
export const GEMINI_API_KEY = BUILD_TIME_KEY || '';
