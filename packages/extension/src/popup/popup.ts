const status = document.getElementById('status')!;

// One field per provider key; review summaries prefer OpenAI when both are set.
const FIELDS = [
  { id: 'apikey', storageKey: 'geminiApiKey' },
  { id: 'openai-key', storageKey: 'openaiApiKey' },
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
      chrome.storage.sync.set({ [storageKey]: key }, () => {
        status.textContent = key ? 'Saved' : 'Cleared';
        status.className = 'saved';
        setTimeout(() => { status.textContent = ''; }, 1500);
      });
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
