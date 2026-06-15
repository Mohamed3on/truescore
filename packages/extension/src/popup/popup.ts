const status = document.getElementById('status')!;

const flashSaved = (msg: string) => {
  status.textContent = msg;
  status.className = 'saved';
  setTimeout(() => { status.textContent = ''; }, 1500);
};

// Provider toggle: explicit choice in llmProvider; unset falls back to
// OpenAI-if-keyed else Gemini (mirrors getActiveLLM in shared/config.ts).
const seg = document.getElementById('provider-seg')!;
const segBtns = [...seg.querySelectorAll<HTMLButtonElement>('button')];
const markActive = (provider: string) =>
  segBtns.forEach((b) => b.classList.toggle('active', b.dataset.provider === provider));

chrome.storage.sync.get(['llmProvider', 'openaiApiKey'], ({ llmProvider, openaiApiKey }) => {
  markActive(llmProvider || (openaiApiKey ? 'openai' : 'gemini'));
});

for (const btn of segBtns) {
  btn.addEventListener('click', () => {
    const provider = btn.dataset.provider!;
    chrome.storage.sync.set({ llmProvider: provider }, () => {
      markActive(provider);
      flashSaved('Saved');
    });
  });
}

// Reasoning effort for gpt-5.4-nano (OpenAI path only); defaults to medium.
const reasoningSeg = document.getElementById('reasoning-seg')!;
const reasoningBtns = [...reasoningSeg.querySelectorAll<HTMLButtonElement>('button')];
const markEffort = (effort: string) =>
  reasoningBtns.forEach((b) => b.classList.toggle('active', b.dataset.effort === effort));

chrome.storage.sync.get('openaiReasoningEffort', ({ openaiReasoningEffort }) => {
  markEffort(openaiReasoningEffort || 'low');
});

for (const btn of reasoningBtns) {
  btn.addEventListener('click', () => {
    const effort = btn.dataset.effort!;
    chrome.storage.sync.set({ openaiReasoningEffort: effort }, () => {
      markEffort(effort);
      flashSaved('Saved');
    });
  });
}

// One field per provider key; review summaries prefer OpenAI when both are set.
const FIELDS = [
  { id: 'apikey', storageKey: 'geminiApiKey' },
  { id: 'openai-key', storageKey: 'openaiApiKey' },
  { id: 'deepseek-key', storageKey: 'deepseekApiKey' },
];

for (const { id, storageKey } of FIELDS) {
  const input = document.getElementById(id) as HTMLInputElement;

  // Load saved key
  chrome.storage.sync.get(storageKey, (items) => {
    if (items[storageKey]) input.value = items[storageKey];
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
