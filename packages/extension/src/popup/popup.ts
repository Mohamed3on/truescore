import { getActiveLLM, getReasoningEffort } from '../shared/config';

const status = document.getElementById('status')!;

const flashSaved = (msg: string) => {
  status.textContent = msg;
  status.className = 'saved';
  setTimeout(() => { status.textContent = ''; }, 1500);
};

// Provider toggle: explicit choice in llmProvider; unset shows what getActiveLLM
// falls back to.
const seg = document.getElementById('provider-seg')!;
const segBtns = [...seg.querySelectorAll<HTMLButtonElement>('button')];

const markActive = (provider: string) =>
  segBtns.forEach((b) => b.classList.toggle('active', b.dataset.provider === provider));

// Reasoning effort only applies to GPT-6 Luna; hide the field for Gemini /
// DeepSeek. style.display (not [hidden]) so it beats `.field { display: flex }`.
const reasoningField = document.getElementById('reasoning-field')!;
const showReasoning = (provider: string) => { reasoningField.style.display = provider === 'openai' ? '' : 'none'; };

getActiveLLM().then(({ provider }) => {
  markActive(provider);
  showReasoning(provider);
});

for (const btn of segBtns) {
  btn.addEventListener('click', () => {
    const provider = btn.dataset.provider!;
    chrome.storage.sync.set({ llmProvider: provider }, () => {
      markActive(provider);
      showReasoning(provider);
      flashSaved('Saved');
    });
  });
}

// Reasoning effort for gpt-6-luna (OpenAI path only); defaults to low.
const reasoningSeg = document.getElementById('reasoning-seg')!;
const reasoningBtns = [...reasoningSeg.querySelectorAll<HTMLButtonElement>('button')];

const markEffort = (effort: string) =>
  reasoningBtns.forEach((b) => b.classList.toggle('active', b.dataset.effort === effort));

// A saved level that's no longer offered (None) shows as the default it now runs at.
getReasoningEffort().then(markEffort);

for (const btn of reasoningBtns) {
  btn.addEventListener('click', () => {
    const effort = btn.dataset.effort!;
    chrome.storage.sync.set({ openaiReasoningEffort: effort }, () => {
      markEffort(effort);
      flashSaved('Saved');
    });
  });
}

// One field per provider key; with no model picked, summaries prefer the default's key (getActiveLLM).
const FIELDS = [
  { id: 'apikey', storageKey: 'geminiApiKey' },
  { id: 'openai-key', storageKey: 'openaiApiKey' },
  { id: 'deepseek-key', storageKey: 'deepseekApiKey' },
  { id: 'anthropic-key', storageKey: 'anthropicApiKey' },
  { id: 'truescore-key', storageKey: 'truescorePassword' },
];

for (const { id, storageKey } of FIELDS) {
  // SAFETY: popup.html renders each of FIELDS' ids as an <input>.
  const input = document.getElementById(id) as HTMLInputElement;

  // Load saved key
  chrome.storage.sync.get(storageKey, (items) => {
    // SAFETY: the popup is sync storage's only writer, and it saves every value as a string.
    const v = (items as Record<string, string>)[storageKey];

    if (v) input.value = v;
  });

  // Save on change (debounced)
  let timer: ReturnType<typeof setTimeout>;
  input.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      const key = input.value.trim();
      chrome.storage.sync.set({ [storageKey]: key }, () => flashSaved(key ? 'Saved' : 'Cleared'));
    }, 400);
  });

  // Toggle visibility
  const toggleBtn = input.closest('.input-row')!.querySelector('button')!;
  let visible = false;
  toggleBtn.addEventListener('click', () => {
    visible = !visible;
    input.type = visible ? 'text' : 'password';
  });
}
