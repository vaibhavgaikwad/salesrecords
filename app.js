// ==========================================
// CONFIGURATION
// ==========================================
const SCRIPT_URL = 'https://script.google.com/macros/s/AKfycbxC_YMeGoCXkNbGOnFTJoGQE5XHYGJNos5dbHY5j_R5rmA5DIspK0kowQ3_RSjAqXRLfg/exec';

// DOM Elements
const chatForm = document.getElementById('chat-form');
const messageInput = document.getElementById('message-input');
const chatMessages = document.getElementById('chat-messages');
const micBtn = document.getElementById('mic-btn');
const userSelect = document.getElementById('user-select');
const statusText = document.getElementById('status-text');

// Persist selected user across reloads
const savedUser = localStorage.getItem('expense_chat_user');
if (savedUser) userSelect.value = savedUser;
userSelect.addEventListener('change', () => {
  localStorage.setItem('expense_chat_user', userSelect.value);
});

// ==========================================
// UI HELPERS
// ==========================================
function appendMessage(text, sender = 'user', metaText = '') {
  const wrapper = document.createElement('div');
  wrapper.className = `message ${sender}`;

  const bubble = document.createElement('div');
  bubble.className = 'bubble';
  bubble.textContent = text;

  const meta = document.createElement('span');
  meta.className = 'meta';
  const time = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  meta.textContent = metaText ? `${metaText} • ${time}` : time;

  wrapper.appendChild(bubble);
  wrapper.appendChild(meta);
  chatMessages.appendChild(wrapper);
  chatMessages.scrollTop = chatMessages.scrollHeight;
  return bubble;
}

// Quick command buttons
document.querySelectorAll('.quick-commands button').forEach(btn => {
  btn.addEventListener('click', () => {
    handleUserInput(btn.dataset.cmd);
  });
});

// ==========================================
// INPUT PARSING & COMMAND ROUTING
// ==========================================
chatForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const text = messageInput.value.trim();
  if (!text) return;
  messageInput.value = '';
  handleUserInput(text);
});

async function handleUserInput(rawText) {
  const currentUser = userSelect.value;
  appendMessage(rawText, 'user', currentUser);

  const lower = rawText.toLowerCase().trim();

  // Check if input is a Query Command
  const isCommand =
    lower === "today's total" ||
    lower === "todays total" ||
    lower === "today total" ||
    lower === "summary" ||
    lower.startsWith("total ");

  if (isCommand) {
    await executeCommand(rawText);
    return;
  }

  // Otherwise, parse as an Expense Entry: "<ShopName> <Product...> <Amount>"
  // Example: "Medical Paracetamol 250" or "Kirana Toor Dal 180.50"
  const parts = rawText.trim().split(/\s+/);
  const amount = parseFloat(parts[parts.length - 1]);

  if (parts.length < 3 || isNaN(amount)) {
    appendMessage(
      '⚠️ Invalid format.\nUse: ShopName Product Amount\nExample: Medical Paracetamol 250\n\nOr use a command: Summary, Today\'s Total, Total Medical',
      'bot',
      'Bot'
    );
    return;
  }

  const shopName = capitalize(parts[0]);
  const product = parts.slice(1, -1).join(' ');

  await saveExpense({
    shopName,
    product,
    amount,
    user: currentUser
  });
}

function capitalize(str) {
  return str.charAt(0).toUpperCase() + str.slice(1);
}

// ==========================================
// GOOGLE SHEETS API COMMUNICATION
// ==========================================
async function saveExpense(payload) {
  const loadingBubble = appendMessage('⏳ Saving to Google Sheets...', 'bot', 'Bot');

  try {
    // text/plain avoids CORS preflight OPTIONS requests on Google Apps Script
    const response = await fetch(SCRIPT_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(payload)
    });

    const result = await response.json();

    if (result.status === 'success') {
      loadingBubble.textContent =
        `✅ Saved!\n` +
        `🏪 Shop: ${payload.shopName}\n` +
        `📦 Item: ${payload.product}\n` +
        `💰 Amount: ₹${payload.amount}\n` +
        `👤 User: ${payload.user}`;
    } else {
      loadingBubble.textContent = `❌ Failed to save: ${result.message}`;
    }
  } catch (err) {
    loadingBubble.textContent = '❌ Network error. Check your internet or Apps Script URL.';
  }
}

async function executeCommand(commandText) {
  const loadingBubble = appendMessage('⏳ Fetching report...', 'bot', 'Bot');

  try {
    const url = `${SCRIPT_URL}?command=${encodeURIComponent(commandText)}`;
    const response = await fetch(url);
    const result = await response.json();
    loadingBubble.textContent = result.reply;
  } catch (err) {
    loadingBubble.textContent = '❌ Could not fetch data from Google Sheets.';
  }
}

// ==========================================
// VOICE INPUT (WEB SPEECH API)
// ==========================================
const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;

if (SpeechRecognition) {
  const recognition = new SpeechRecognition();
  recognition.lang = 'en-IN';
  recognition.interimResults = false;
  recognition.maxAlternatives = 1;

  micBtn.addEventListener('click', () => {
    if (micBtn.classList.contains('listening')) {
      recognition.stop();
    } else {
      recognition.start();
    }
  });

  recognition.onstart = () => {
    micBtn.classList.add('listening');
    statusText.textContent = 'Listening... Speak now';
  };

  recognition.onresult = (event) => {
    let transcript = event.results[0][0].transcript;
    // Strip trailing period that mobile speech keyboards often add
    transcript = transcript.replace(/\.$/, '').trim();
    messageInput.value = transcript;
    handleUserInput(transcript);
  };

  recognition.onerror = (event) => {
    statusText.textContent = 'Voice error: ' + event.error;
    setTimeout(() => { statusText.textContent = 'Online • Google Sheets'; }, 2500);
  };

  recognition.onend = () => {
    micBtn.classList.remove('listening');
    statusText.textContent = 'Online • Google Sheets';
  };
} else {
  micBtn.style.display = 'none';
}

// ==========================================
// PWA SERVICE WORKER REGISTRATION
// ==========================================
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch(err => console.warn('SW error:', err));
  });
}
