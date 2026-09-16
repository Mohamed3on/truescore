// The extension's own LLM calls (src/llm.ts), loaded on first use: the AI SDK
// behind them is megabytes a page script shouldn't carry.
export const loadLlm = (): Promise<typeof import('../llm')> => import(chrome.runtime.getURL('llm.js'));
