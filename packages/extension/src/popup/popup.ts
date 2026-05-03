const input = document.getElementById('apikey') as HTMLInputElement;
const status = document.getElementById('status')!;
const toggleBtn = document.getElementById('toggle-vis')!;

// Load saved key
chrome.storage.sync.get('geminiApiKey', ({ geminiApiKey }) => {
  if (geminiApiKey) input.value = geminiApiKey;
});

// Save on change (debounced)
let timer: ReturnType<typeof setTimeout>;
input.addEventListener('input', () => {
  clearTimeout(timer);
  timer = setTimeout(() => {
    const key = input.value.trim();
    chrome.storage.sync.set({ geminiApiKey: key }, () => {
      status.textContent = key ? 'Saved' : 'Cleared';
      status.className = 'saved';
      setTimeout(() => { status.textContent = ''; }, 1500);
    });
  }, 400);
});

// Toggle visibility
let visible = false;
toggleBtn.addEventListener('click', () => {
  visible = !visible;
  input.type = visible ? 'text' : 'password';
});
