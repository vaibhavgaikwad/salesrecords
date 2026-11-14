/**
 * SalesChat PWA - Client Application Logic
 * Handles NLP-lite command/sale parsing, RBAC enforcement,
 * Web Speech API voice automation, Dark Mode, and Google Apps Script sync.
 */

const APPS_SCRIPT_URL = 'https://script.google.com/macros/s/AKfycbxWl8n26-1LuGebk4Pd5Bna1TeV1KX9xMicmQw7zsxdBtOYA6WElir1D6gzgsXK1PI4AQ/exec';

// DOM References
const chatFeed = document.getElementById('chat-feed');
const composerForm = document.getElementById('composer-form');
const messageInput = document.getElementById('message-input');
const voiceBtn = document.getElementById('voice-btn');
const roleSelect = document.getElementById('role-select');
const userSelect = document.getElementById('user-select');
const themeToggle = document.getElementById('theme-toggle');
const connectionStatus = document.getElementById('connection-status');

// Application State
const state = {
  role: localStorage.getItem('saleschat_role') || 'admin',
  userName: localStorage.getItem('saleschat_user') || 'Vaibhav',
  darkMode: localStorage.getItem('saleschat_dark') === 'true'
};

// Initialize UI State
function initApp() {
  roleSelect.value = state.role;
  userSelect.value = state.userName;
  applyTheme(state.darkMode);
  applyRolePermissions();

  appendMessage(
    `👋 Welcome, ${state.userName} (${state.role.toUpperCase()}).\n\n` +
    `Record a sale by typing or speaking:\n` +
    `• Medical Dolo650 120\n` +
    `• Kirana Rice 500\n\n` +
    `Or run a report command:\n` +
    `• Total Medical\n` +
    `• Today's Total\n` +
    `• Sales Today Medical\n` +
    (state.role === 'admin' ? `• Summary\n• Monthly Summary` : ''),
    'bot',
    'System'
  );
}

/* ==================== THEME & ROLE MANAGEMENT ==================== */

function applyTheme(isDark) {
  document.body.classList.toggle('dark-mode', isDark);
  themeToggle.textContent = isDark ? '☀️' : '🌙';
  localStorage.setItem('saleschat_dark', isDark);
}

themeToggle.addEventListener('click', () => {
  state.darkMode = !state.darkMode;
  applyTheme(state.darkMode);
});

function applyRolePermissions() {
  const adminChips = document.querySelectorAll('.cmd-chip.admin-only');
  adminChips.forEach(chip => {
    chip.classList.toggle('hidden', state.role !== 'admin');
  });
}

roleSelect.addEventListener('change', () => {
  state.role = roleSelect.value;
  localStorage.setItem('saleschat_role', state.role);
  applyRolePermissions();
  appendMessage(
    `🔄 Switched role to ${state.role === 'admin' ? 'Admin (All records & summaries)' : 'Sales User (Own totals only)'}.`,
    'bot',
    'System'
  );
});

userSelect.addEventListener('change', () => {
  state.userName = userSelect.value;
  localStorage.setItem('saleschat_user', state.userName);
  appendMessage(`👤 Active user set to ${state.userName}.`, 'bot', 'System');
});

/* ==================== CHAT RENDERING ==================== */

function appendMessage(text, sender = 'user', label = '') {
  const row = document.createElement('div');
  row.className = `msg-row ${sender}`;

  const bubble = document.createElement('div');
  bubble.className = 'bubble';
  bubble.textContent = text;

  const meta = document.createElement('span');
  meta.className = 'msg-meta';
  const timeStr = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  meta.textContent = label ? `${label} • ${timeStr}` : timeStr;

  row.appendChild(bubble);
  row.appendChild(meta);
  chatFeed.appendChild(row);
  chatFeed.scrollTop = chatFeed.scrollHeight;

  return bubble;
}

/* ==================== MESSAGE & COMMAND PARSER ==================== */

composerForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const raw = messageInput.value.trim();
  if (!raw) return; // Security: Prevent empty messages
  messageInput.value = '';
  processUserMessage(raw);
});

document.querySelectorAll('.cmd-chip').forEach(btn => {
  btn.addEventListener('click', () => {
    processUserMessage(btn.dataset.cmd);
  });
});

async function processUserMessage(rawText) {
  const cleanText = rawText.trim();
  if (!cleanText) return;

  appendMessage(cleanText, 'user', `${state.userName} (${state.role})`);

  const lower = cleanText.toLowerCase();

  // Check if message matches a supported reporting command
  if (isCommandQuery(lower)) {
    // Client-side RBAC guard before hitting network
    if ((lower === 'summary' || lower === 'monthly summary') && state.role !== 'admin') {
      appendMessage('🔒 Access Denied: Only Admin users can view Summary and Monthly Summary reports.', 'bot', 'SalesBot');
      return;
    }
    await sendCommandRequest(cleanText);
    return;
  }

  // Otherwise parse as Sale Record: <ShopName> <ProductName...> <Amount>
  const parsedSale = parseSaleEntry(cleanText);

  if (!parsedSale.valid) {
    appendMessage(parsedSale.error, 'bot', 'SalesBot');
    return;
  }

  await sendSaleRecord(parsedSale.data);
}

function isCommandQuery(lowerText) {
  return (
    lowerText === "today's total" ||
    lowerText === "todays total" ||
    lowerText === "today total" ||
    lowerText === "summary" ||
    lowerText === "monthly summary" ||
    lowerText.startsWith("total ") ||
    lowerText.startsWith("sales today ")
  );
}

/**
 * Extracts ShopName, ProductName, and validates numeric Amount.
 * Example: "Medical Dolo650 120" -> { shopName: "Medical", productName: "Dolo650", amount: 120 }
 */
function parseSaleEntry(text) {
  const tokens = text.split(/\s+/);

  if (tokens.length < 3) {
    return {
      valid: false,
      error: '⚠️ Invalid format or command.\nTo record a sale, enter:\nShopName ProductName Amount\nExample: Medical Dolo650 120'
    };
  }

  // Support currency symbols like ₹120 or commas like 1,250
  const rawAmountToken = tokens[tokens.length - 1].replace(/[₹,]/g, '');
  const amount = Number(rawAmountToken);

  // Security: Validate amount is strictly numeric and > 0
  if (!rawAmountToken || isNaN(amount) || !isFinite(amount) || amount <= 0) {
    return {
      valid: false,
      error: `⚠️ Invalid amount "${tokens[tokens.length - 1]}". The last value must be a positive number.\nExample: Medical Paracetamol 250`
    };
  }

  const shopName = capitalizeWords(tokens[0]);
  const productName = tokens.slice(1, -1).join(' ');

  return {
    valid: true,
    data: {
      shopName,
      productName,
      amount,
      userName: state.userName
    }
  };
}

function capitalizeWords(str) {
  return str.replace(/\b\w/g, char => char.toUpperCase());
}

/* ==================== GOOGLE APPS SCRIPT API CALLS ==================== */

async function sendSaleRecord(saleData) {
  if (!isConfigured()) return;

  const botBubble = appendMessage('⏳ Saving sale to Google Sheets...', 'bot', 'SalesBot');

  try {
    // text/plain avoids CORS preflight OPTIONS requests on Google Apps Script
    const response = await fetch(APPS_SCRIPT_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(saleData)
    });

    const result = await response.json();

    if (result.status === 'success') {
      const formattedAmt = Number(result.record.amount).toLocaleString('en-IN');
      botBubble.textContent =
        `✅ Sale Recorded\n` +
        `Shop: ${result.record.shopName}\n` +
        `Product: ${result.record.productName}\n` +
        `Amount: ₹${formattedAmt}\n` +
        `Time: ${result.record.timestamp}`;
    } else {
      botBubble.textContent = `❌ Error: ${result.message}`;
    }
  } catch (err) {
    botBubble.textContent = '❌ Network error: Unable to reach Google Sheets backend.';
  }
}

async function sendCommandRequest(commandText) {
  if (!isConfigured()) return;

  const botBubble = appendMessage('⏳ Fetching report...', 'bot', 'SalesBot');

  try {
    const queryParams = new URLSearchParams({
      command: commandText,
      role: state.role,
      userName: state.userName
    });

    const response = await fetch(`${APPS_SCRIPT_URL}?${queryParams.toString()}`);
    const result = await response.json();
    botBubble.textContent = result.reply || result.message || 'No response received.';
  } catch (err) {
    botBubble.textContent = '❌ Network error: Could not retrieve report from Google Sheets.';
  }
}

function isConfigured() {
  if (!APPS_SCRIPT_URL || APPS_SCRIPT_URL.includes('PASTE_YOUR_GOOGLE_APPS_SCRIPT')) {
    appendMessage('⚙️ Setup Required: Please paste your Google Apps Script Web App URL into app.js.', 'bot', 'System');
    return false;
  }
  return true;
}

/* ==================== WEB SPEECH API (VOICE INPUT) ==================== */

const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;

if (SpeechRecognition) {
  const recognition = new SpeechRecognition();
  recognition.lang = 'en-IN';
  recognition.interimResults = false;
  recognition.maxAlternatives = 1;

  let isListening = false;

  voiceBtn.addEventListener('click', () => {
    if (isListening) {
      recognition.stop();
    } else {
      try {
        recognition.start();
      } catch (e) {
        console.warn('Speech recognition already active:', e);
      }
    }
  });

  recognition.onstart = () => {
    isListening = true;
    voiceBtn.classList.add('listening');
    connectionStatus.textContent = '🎙️ Listening... Speak now';
  };

  recognition.onresult = (event) => {
    let transcript = event.results[0][0].transcript;
    // Clean trailing punctuation added by speech engines (e.g., "Medical Dolo 650 120.")
    transcript = transcript.replace(/[.?!]+$/, '').trim();
    if (transcript) {
      processUserMessage(transcript); // Automatically submit recognized text
    }
  };

  recognition.onerror = (event) => {
    connectionStatus.textContent = `Voice error: ${event.error}`;
    setTimeout(() => {
      connectionStatus.textContent = 'Ready • Google Sheets';
    }, 2500);
  };

  recognition.onend = () => {
    isListening = false;
    voiceBtn.classList.remove('listening');
    connectionStatus.textContent = 'Ready • Google Sheets';
  };
} else {
  voiceBtn.style.display = 'none';
}

/* ==================== SERVICE WORKER REGISTRATION ==================== */

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch(err => {
      console.warn('Service Worker registration failed:', err);
    });
  });
}

// Start App
initApp();
