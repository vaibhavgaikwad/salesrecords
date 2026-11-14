/**
 * SalesChat Pro v2.2
 * - Asks for Store Name on first launch and saves all subsequent entries under that store.
 * - Supports amount-only ("250"), product + amount ("Paracetamol 250"), and explicit store override ("Kirana Sugar 300").
 * - Silent sale recording (no bot reply bubbles on entry).
 */

const CONFIG = Object.freeze({
  APPS_SCRIPT_URL: 'https://script.google.com/macros/s/AKfycbyPovdOZCjYuGR8VNwFzmBjq4bkCsVWtN5dnYETCz7vwoMHVLaskB7CKF0EsY5s0sL5sw/exec',
  CACHE_TTL_MS: 60 * 1000,
  REQUEST_TIMEOUT_MS: 12000,
  DEFAULT_SHOPS: ['Medical', 'Kirana', 'Stationery', 'General']
});

/* ==================== 1. STORAGE & OFFLINE REPOSITORY ==================== */
class StorageRepository {
  constructor() {
    this.KEYS = {
      ROLE: 'saleschat_role',
      USER: 'saleschat_user',
      ACTIVE_STORE: 'saleschat_active_store',
      DARK: 'saleschat_dark',
      OUTBOX: 'saleschat_offline_outbox',
      QUERY_CACHE: 'saleschat_query_cache',
      SHOPS: 'saleschat_known_shops'
    };
  }

  getPrefs() {
    return {
      role: localStorage.getItem(this.KEYS.ROLE) || 'admin',
      userName: localStorage.getItem(this.KEYS.USER) || 'Vaibhav',
      activeStore: localStorage.getItem(this.KEYS.ACTIVE_STORE) || '',
      darkMode: localStorage.getItem(this.KEYS.DARK) === 'true'
    };
  }

  savePref(key, value) {
    localStorage.setItem(key, String(value));
  }

  getOutbox() {
    try {
      return JSON.parse(localStorage.getItem(this.KEYS.OUTBOX)) || [];
    } catch {
      return [];
    }
  }

  enqueueSale(salePayload) {
    const queue = this.getOutbox();
    queue.push({
      id: 'tx_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
      payload: salePayload,
      retries: 0
    });
    localStorage.setItem(this.KEYS.OUTBOX, JSON.stringify(queue));
    return queue.length;
  }

  saveOutbox(queue) {
    localStorage.setItem(this.KEYS.OUTBOX, JSON.stringify(queue));
  }

  getCachedQuery(cacheKey) {
    try {
      const store = JSON.parse(localStorage.getItem(this.KEYS.QUERY_CACHE)) || {};
      const entry = store[cacheKey];
      if (!entry) return null;
      if (Date.now() - entry.ts > CONFIG.CACHE_TTL_MS) return null;
      return entry.data;
    } catch {
      return null;
    }
  }

  setCachedQuery(cacheKey, data) {
    try {
      const store = JSON.parse(localStorage.getItem(this.KEYS.QUERY_CACHE)) || {};
      store[cacheKey] = { ts: Date.now(), data };
      localStorage.setItem(this.KEYS.QUERY_CACHE, JSON.stringify(store));
    } catch {}
  }

  clearQueryCache() {
    localStorage.removeItem(this.KEYS.QUERY_CACHE);
  }

  getKnownShops() {
    try {
      const saved = JSON.parse(localStorage.getItem(this.KEYS.SHOPS));
      return Array.isArray(saved) && saved.length ? saved : [...CONFIG.DEFAULT_SHOPS];
    } catch {
      return [...CONFIG.DEFAULT_SHOPS];
    }
  }

  addKnownShop(shopName) {
    if (!shopName || shopName === 'General') return;
    const shops = new Set(this.getKnownShops());
    shops.add(shopName);
    localStorage.setItem(this.KEYS.SHOPS, JSON.stringify(Array.from(shops).sort()));
  }

  setKnownShops(shopList) {
    const merged = Array.from(new Set([...CONFIG.DEFAULT_SHOPS, ...shopList])).sort();
    localStorage.setItem(this.KEYS.SHOPS, JSON.stringify(merged));
  }
}

/* ==================== 2. API GATEWAY ==================== */
class ApiGateway {
  constructor() {
    this.isConfigured = Boolean(
      CONFIG.APPS_SCRIPT_URL && !CONFIG.APPS_SCRIPT_URL.includes('PASTE_YOUR_GOOGLE_APPS_SCRIPT')
    );
  }

  async fetchWithTimeout(url, options = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), CONFIG.REQUEST_TIMEOUT_MS);
    try {
      const response = await fetch(url, { ...options, signal: controller.signal });
      clearTimeout(timer);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return await response.json();
    } catch (err) {
      clearTimeout(timer);
      throw err;
    }
  }

  async postSale(payload) {
    if (!this.isConfigured) throw new Error('APPS_SCRIPT_NOT_CONFIGURED');
    return this.fetchWithTimeout(CONFIG.APPS_SCRIPT_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(payload)
    });
  }

  async getQuery(paramsObj) {
    if (!this.isConfigured) throw new Error('APPS_SCRIPT_NOT_CONFIGURED');
    const qs = new URLSearchParams(paramsObj).toString();
    return this.fetchWithTimeout(`${CONFIG.APPS_SCRIPT_URL}?${qs}`);
  }
}

/* ==================== 3. STORE-AWARE COMMAND & SALE PARSER ==================== */
class DomainParser {
  static normalizeVoiceNumbers(text) {
    const wordMap = {
      zero: '0', one: '1', two: '2', three: '3', four: '4',
      five: '5', six: '6', seven: '7', eight: '8', nine: '9',
      ten: '10', twenty: '20', thirty: '30', forty: '40',
      fifty: '50', hundred: '100', thousand: '1000'
    };
    return text.replace(
      /\b(zero|one|two|three|four|five|six|seven|eight|nine|ten|twenty|thirty|forty|fifty|hundred|thousand)\b/gi,
      m => wordMap[m.toLowerCase()] || m
    );
  }

  static parse(rawText, currentUser, activeStore, knownShops = []) {
    const clean = rawText.replace(/\s+/g, ' ').trim();
    if (!clean) return { type: 'IGNORE' };

    const lower = clean.toLowerCase();

    // 1. Report Commands (Work anytime)
    if (/^(today'?s?\s+total|total\s+today)$/i.test(lower)) {
      return { type: 'COMMAND', command: "Today's Total", adminOnly: false };
    }
    if (/^(summary|shop\s+summary|all\s+summary)$/i.test(lower)) {
      return { type: 'COMMAND', command: 'Summary', adminOnly: true };
    }
    if (/^(monthly\s+summary|month\s+summary)$/i.test(lower)) {
      return { type: 'COMMAND', command: 'Monthly Summary', adminOnly: true };
    }

    const salesTodayMatch = clean.match(/^sales\s+today\s+(.+)$/i);
    if (salesTodayMatch) {
      return {
        type: 'COMMAND',
        command: `Sales Today ${this.capitalize(salesTodayMatch[1].trim())}`,
        adminOnly: false
      };
    }

    const shopTotalMatch = clean.match(/^total\s+(.+)$/i);
    if (shopTotalMatch) {
      return {
        type: 'COMMAND',
        command: `Total ${this.capitalize(shopTotalMatch[1].trim())}`,
        adminOnly: false
      };
    }

    // 2. Explicit Store Change Command: "Store Kirana" or "Shop Medical"
    const setStoreMatch = clean.match(/^(?:store|shop)\s+(.+)$/i);
    if (setStoreMatch) {
      return {
        type: 'SET_STORE',
        storeName: this.capitalize(setStoreMatch[1].trim())
      };
    }

    // 3. Sale Parsing (Supports: "250", "Paracetamol 250", or "Kirana Sugar 300")
    const tokens = clean.split(' ');
    const rawLastToken = tokens[tokens.length - 1].replace(/[₹,]/g, '');
    const amount = Number(rawLastToken);

    if (rawLastToken !== '' && !isNaN(amount) && isFinite(amount)) {
      // If activeStore is not yet set, ask user for store name first (unless they typed "StoreName Product Amount")
      if (!activeStore && tokens.length < 3) {
        return { type: 'NEED_STORE', pendingText: clean };
      }

      let shopName = activeStore || 'General';
      let productName = '-';

      if (tokens.length === 1) {
        // Amount only: "250" -> uses activeStore, product "-"
        productName = '-';
      } else if (tokens.length === 2) {
        // Two tokens: either "<KnownStore> 250" or "<Product> 250"
        const firstWordCap = this.capitalize(tokens[0]);
        const isKnownShop = knownShops.some(s => s.toLowerCase() === tokens[0].toLowerCase());
        if (isKnownShop && firstWordCap.toLowerCase() !== shopName.toLowerCase()) {
          shopName = firstWordCap;
          productName = '-';
        } else {
          productName = firstWordCap;
        }
      } else {
        // 3+ tokens: check if first token is an explicit different store or part of product name
        const firstWordCap = this.capitalize(tokens[0]);
        const isKnownShop = knownShops.some(s => s.toLowerCase() === tokens[0].toLowerCase());
        if (isKnownShop) {
          shopName = firstWordCap;
          productName = tokens.slice(1, -1).join(' ');
        } else {
          productName = tokens.slice(0, -1).join(' ');
        }
      }

      return {
        type: 'SALE',
        payload: {
          shopName,
          productName,
          amount,
          userName: currentUser,
          clientTimestamp: new Date().toISOString()
        }
      };
    }

    // 4. If awaiting initial store setup, treat plain text (e.g., "Medical") as the store name
    if (!activeStore) {
      return {
        type: 'SET_STORE',
        storeName: this.capitalize(clean)
      };
    }

    return {
      type: 'INVALID',
      error: `❓ Enter an amount (e.g. 250) or product & amount (e.g. Paracetamol 250) for ${activeStore}.`
    };
  }

  static capitalize(str) {
    return str.replace(/\b\w/g, c => c.toUpperCase());
  }
}

/* ==================== 4. VOICE RECOGNITION SERVICE ==================== */
class VoiceService {
  constructor(onResult, onStateChange) {
    const SpeechRec = window.SpeechRecognition || window.webkitSpeechRecognition;
    this.supported = Boolean(SpeechRec);
    this.isListening = false;
    this.onResult = onResult;
    this.onStateChange = onStateChange;

    if (this.supported) {
      this.recognition = new SpeechRec();
      this.recognition.lang = 'en-IN';
      this.recognition.interimResults = false;
      this.recognition.maxAlternatives = 1;

      this.recognition.onstart = () => {
        this.isListening = true;
        this.onStateChange(true, '🎙️ Listening...');
      };

      this.recognition.onresult = (event) => {
        let transcript = event.results[0][0].transcript;
        transcript = transcript.replace(/[.?!]+$/, '').trim();
        transcript = DomainParser.normalizeVoiceNumbers(transcript);
        if (transcript) this.onResult(transcript);
      };

      this.recognition.onerror = (event) => {
        this.isListening = false;
        this.onStateChange(false, `Mic error: ${event.error}`);
      };

      this.recognition.onend = () => {
        this.isListening = false;
        this.onStateChange(false, null);
      };
    }
  }

  toggle() {
    if (!this.supported) return;
    if (this.isListening) {
      this.recognition.stop();
    } else {
      try {
        this.recognition.start();
      } catch {}
    }
  }
}

/* ==================== 5. ADMIN ANALYTICS & CHARTS ==================== */
class AdminAnalyticsPresenter {
  constructor(api, storage) {
    this.api = api;
    this.storage = storage;
    this.shopChartInstance = null;
    this.monthlyChartInstance = null;
    this.latestRecords = [];

    this.modal = document.getElementById('dashboard-modal');
    this.bindEvents();
  }

  bindEvents() {
    document.getElementById('dashboard-btn').addEventListener('click', () => this.open());
    document.getElementById('close-dash-btn').addEventListener('click', () => this.close());
    document.getElementById('refresh-dash-btn').addEventListener('click', () => this.loadData(true));
    document.getElementById('export-csv-btn').addEventListener('click', () => this.exportCsv());
    this.modal.addEventListener('click', (e) => {
      if (e.target === this.modal) this.close();
    });
  }

  async open() {
    this.modal.classList.remove('hidden');
    await this.loadData(false);
  }

  close() {
    this.modal.classList.add('hidden');
  }

  async loadData(forceRefresh = false) {
    const cacheKey = 'admin_dashboard_v2';
    let data = !forceRefresh ? this.storage.getCachedQuery(cacheKey) : null;

    if (!data) {
      try {
        data = await this.api.getQuery({ action: 'dashboard', role: 'admin' });
        if (data && data.status === 'success') {
          this.storage.setCachedQuery(cacheKey, data);
        }
      } catch {
        alert('Unable to fetch dashboard analytics while offline.');
        return;
      }
    }

    if (!data || data.status !== 'success') return;

    this.latestRecords = data.records || [];
    this.renderKPIs(data.kpis);
    this.renderCharts(data.shopTotals, data.monthlyTrend);
  }

  renderKPIs(kpis) {
    const fmt = (n) => '₹' + Number(n || 0).toLocaleString('en-IN');
    document.getElementById('kpi-today').textContent = fmt(kpis.todayTotal);
    document.getElementById('kpi-month').textContent = fmt(kpis.monthTotal);
    document.getElementById('kpi-grand').textContent = fmt(kpis.grandTotal);
    document.getElementById('kpi-count').textContent = kpis.totalTransactions || 0;
  }

  renderCharts(shopTotals, monthlyTrend) {
    if (typeof Chart === 'undefined') return;

    const shopLabels = Object.keys(shopTotals);
    const shopValues = Object.values(shopTotals);

    if (this.shopChartInstance) this.shopChartInstance.destroy();
    const shopCtx = document.getElementById('shop-chart').getContext('2d');
    this.shopChartInstance = new Chart(shopCtx, {
      type: 'doughnut',
      data: {
        labels: shopLabels,
        datasets: [{
          data: shopValues,
          backgroundColor: ['#00a884', '#0284c7', '#f59e0b', '#8b5cf6', '#ec4899', '#10b981'],
          borderWidth: 1
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { position: 'bottom', labels: { boxWidth: 12 } } }
      }
    });

    const monthLabels = Object.keys(monthlyTrend).sort();
    const monthValues = monthLabels.map(m => monthlyTrend[m]);

    if (this.monthlyChartInstance) this.monthlyChartInstance.destroy();
    const monthCtx = document.getElementById('monthly-chart').getContext('2d');
    this.monthlyChartInstance = new Chart(monthCtx, {
      type: 'bar',
      data: {
        labels: monthLabels,
        datasets: [{
          label: 'Revenue (₹)',
          data: monthValues,
          backgroundColor: '#00a884',
          borderRadius: 6
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { display: false } },
        scales: { y: { beginAtZero: true } }
      }
    });
  }

  exportCsv() {
    if (!this.latestRecords.length) {
      alert('No records available to export.');
      return;
    }

    const headers = ['Timestamp', 'ShopName', 'ProductName', 'Amount', 'UserName'];
    const csvRows = [headers.join(',')];

    this.latestRecords.forEach(r => {
      const row = [
        `"${r.timestamp}"`,
        `"${String(r.shop).replace(/"/g, '""')}"`,
        `"${String(r.product).replace(/"/g, '""')}"`,
        r.amount,
        `"${String(r.user).replace(/"/g, '""')}"`
      ];
      csvRows.push(row.join(','));
    });

    const blob = new Blob([csvRows.join('\n')], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `Sales_Report_${new Date().toISOString().slice(0, 10)}.csv`;
    link.click();
    URL.revokeObjectURL(url);
  }
}

/* ==================== 6. MAIN UI & STORE CONTEXT CONTROLLER ==================== */
class ChatAppController {
  constructor() {
    this.storage = new StorageRepository();
    this.api = new ApiGateway();
    this.analytics = new AdminAnalyticsPresenter(this.api, this.storage);

    const prefs = this.storage.getPrefs();
    this.state = {
      role: prefs.role,
      userName: prefs.userName,
      activeStore: prefs.activeStore,
      darkMode: prefs.darkMode,
      isSyncing: false,
      awaitingStoreSwitch: !prefs.activeStore,
      pendingSaleText: ''
    };

    this.dom = {
      feed: document.getElementById('chat-feed'),
      form: document.getElementById('composer-form'),
      input: document.getElementById('message-input'),
      voiceBtn: document.getElementById('voice-btn'),
      storeBtn: document.getElementById('active-store-btn'),
      roleSelect: document.getElementById('role-select'),
      userSelect: document.getElementById('user-select'),
      themeToggle: document.getElementById('theme-toggle'),
      status: document.getElementById('connection-status'),
      syncBadge: document.getElementById('sync-badge'),
      suggestions: document.getElementById('shop-suggestions')
    };

    this.init();
  }

  init() {
    this.dom.roleSelect.value = this.state.role;
    this.dom.userSelect.value = this.state.userName;
    this.applyTheme(this.state.darkMode);
    this.applyRBAC();
    this.updateStoreUI();
    this.updateConnectivityUI();
    this.updateOutboxBadge();

    this.bindEvents();
    this.initVoice();
    this.syncShopCatalog();
    this.flushOfflineOutbox();

    // First-time Store Prompt
    if (!this.state.activeStore) {
      this.promptForStore(
        '🏪 Welcome! Which store are you recording sales for?\n(Type or tap a store name like Medical or Kirana)'
      );
    }
  }

  promptForStore(promptText) {
    this.state.awaitingStoreSwitch = true;
    this.appendMessage(promptText, 'bot', 'Setup');
    this.renderStoreChips(this.storage.getKnownShops());
    this.dom.input.placeholder = 'Enter store name (e.g. Medical)...';
    this.dom.input.focus();
  }

  setActiveStore(storeName) {
    const formatted = DomainParser.capitalize(storeName.trim());
    if (!formatted) return;

    this.state.activeStore = formatted;
    this.state.awaitingStoreSwitch = false;
    this.storage.savePref(this.storage.KEYS.ACTIVE_STORE, formatted);
    this.storage.addKnownShop(formatted);
    this.updateStoreUI();
    this.hideShopSuggestions();

    this.appendMessage(
      `✅ Active Store set to ${formatted}.\nNow send amounts (e.g. 250) or product & amount (e.g. Paracetamol 250).`,
      'bot',
      'Store'
    );

    // If user had typed an amount before setting the store, record it immediately
    if (this.state.pendingSaleText) {
      const queuedEntry = this.state.pendingSaleText;
      this.state.pendingSaleText = '';
      this.handleUserText(queuedEntry);
    }
  }

  updateStoreUI() {
    if (this.state.activeStore) {
      this.dom.storeBtn.textContent = `🏪 ${this.state.activeStore}`;
      this.dom.storeBtn.classList.remove('unset');
      this.dom.input.placeholder = `Amount or item for ${this.state.activeStore} (e.g. 250)...`;
    } else {
      this.dom.storeBtn.textContent = '🏪 Set Store';
      this.dom.storeBtn.classList.add('unset');
      this.dom.input.placeholder = 'Enter store name first (e.g. Medical)...';
    }
  }

  bindEvents() {
    this.dom.form.addEventListener('submit', (e) => {
      e.preventDefault();
      const val = this.dom.input.value.trim();
      if (!val) return;
      this.dom.input.value = '';
      this.hideShopSuggestions();
      this.handleUserText(val);
    });

    // Clicking the Store pill in the header lets the user switch stores anytime
    this.dom.storeBtn.addEventListener('click', () => {
      this.promptForStore('🏪 Switch store — enter or tap the store name:');
    });

    this.dom.input.addEventListener('input', () => {
      const val = this.dom.input.value.trim().toLowerCase();
      if (this.state.awaitingStoreSwitch) {
        const matches = this.storage.getKnownShops().filter(s => s.toLowerCase().includes(val));
        this.renderStoreChips(matches);
      } else {
        this.hideShopSuggestions();
      }
    });

    document.querySelectorAll('.cmd-chip').forEach(chip => {
      chip.addEventListener('click', () => this.handleUserText(chip.dataset.cmd));
    });

    this.dom.roleSelect.addEventListener('change', () => {
      this.state.role = this.dom.roleSelect.value;
      this.storage.savePref(this.storage.KEYS.ROLE, this.state.role);
      this.applyRBAC();
    });

    this.dom.userSelect.addEventListener('change', () => {
      this.state.userName = this.dom.userSelect.value;
      this.storage.savePref(this.storage.KEYS.USER, this.state.userName);
    });

    this.dom.themeToggle.addEventListener('click', () => {
      this.state.darkMode = !this.state.darkMode;
      this.storage.savePref(this.storage.KEYS.DARK, this.state.darkMode);
      this.applyTheme(this.state.darkMode);
    });

    window.addEventListener('online', () => {
      this.updateConnectivityUI();
      this.flushOfflineOutbox();
    });

    window.addEventListener('offline', () => this.updateConnectivityUI());
  }

  initVoice() {
    this.voice = new VoiceService(
      (transcript) => this.handleUserText(transcript),
      (listening, statusMsg) => {
        this.dom.voiceBtn.classList.toggle('listening', listening);
        if (statusMsg) {
          this.dom.status.textContent = statusMsg;
        } else {
          this.updateConnectivityUI();
        }
      }
    );

    if (!this.voice.supported) {
      this.dom.voiceBtn.classList.add('hidden');
    } else {
      this.dom.voiceBtn.addEventListener('click', () => this.voice.toggle());
    }
  }

  applyTheme(isDark) {
    document.body.classList.toggle('dark-mode', isDark);
    this.dom.themeToggle.textContent = isDark ? '☀️' : '🌙';
  }

  applyRBAC() {
    const isAdmin = this.state.role === 'admin';
    document.querySelectorAll('.admin-only').forEach(el => {
      el.classList.toggle('hidden', !isAdmin);
    });
  }

  updateConnectivityUI() {
    this.dom.status.textContent = navigator.onLine ? 'Online • Google Sheets' : 'Offline • Local Queue Mode';
  }

  updateOutboxBadge() {
    const count = this.storage.getOutbox().length;
    this.dom.syncBadge.textContent = `${count} queued`;
    this.dom.syncBadge.classList.toggle('hidden', count === 0);
  }

  renderStoreChips(shops) {
    if (!shops.length) {
      this.hideShopSuggestions();
      return;
    }
    this.dom.suggestions.innerHTML = '';
    shops.forEach(shop => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'shop-suggestion-item';
      btn.textContent = `🏪 ${shop}`;
      btn.addEventListener('click', () => {
        this.appendMessage(shop, 'user', this.state.userName);
        this.setActiveStore(shop);
      });
      this.dom.suggestions.appendChild(btn);
    });
    this.dom.suggestions.classList.remove('hidden');
  }

  hideShopSuggestions() {
    this.dom.suggestions.classList.add('hidden');
  }

  appendMessage(text, sender = 'user', metaLabel = '') {
    const row = document.createElement('div');
    row.className = `msg-row ${sender}`;

    const bubble = document.createElement('div');
    bubble.className = 'bubble';
    bubble.textContent = text;

    const meta = document.createElement('span');
    meta.className = 'msg-meta';
    const time = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    meta.textContent = metaLabel ? `${metaLabel} • ${time}` : time;

    row.appendChild(bubble);
    row.appendChild(meta);
    this.dom.feed.appendChild(row);
    this.dom.feed.scrollTop = this.dom.feed.scrollHeight;
    return bubble;
  }

  async handleUserText(rawText) {
    const clean = rawText.trim();
    if (!clean) return;

    this.appendMessage(clean, 'user', this.state.userName);

    // If user clicked the Store pill to switch stores and typed a store name (not a number/command)
    if (this.state.awaitingStoreSwitch && isNaN(Number(clean.replace(/[₹,]/g, '')))) {
      const quickCheck = DomainParser.parse(clean, this.state.userName, this.state.activeStore, this.storage.getKnownShops());
      if (quickCheck.type !== 'COMMAND') {
        const chosenStore = quickCheck.type === 'SET_STORE' ? quickCheck.storeName : clean;
        this.setActiveStore(chosenStore);
        return;
      }
    }

    const parsed = DomainParser.parse(
      clean,
      this.state.userName,
      this.state.activeStore,
      this.storage.getKnownShops()
    );

    if (parsed.type === 'IGNORE') return;

    if (parsed.type === 'NEED_STORE') {
      this.state.pendingSaleText = parsed.pendingText;
      this.promptForStore('🏪 Please enter the store name first (e.g. Medical or Kirana):');
      return;
    }

    if (parsed.type === 'SET_STORE') {
      this.setActiveStore(parsed.storeName);
      return;
    }

    if (parsed.type === 'INVALID') {
      this.appendMessage(parsed.error, 'bot', 'SalesBot');
      return;
    }

    if (parsed.type === 'COMMAND') {
      if (parsed.adminOnly && this.state.role !== 'admin') {
        this.appendMessage('🔒 Access Denied: Admin role required for this report.', 'bot', 'SalesBot');
        return;
      }
      await this.executeQueryCommand(parsed.command);
      return;
    }

    if (parsed.type === 'SALE') {
      this.storage.addKnownShop(parsed.payload.shopName);
      await this.recordSaleSilently(parsed.payload);
    }
  }

  /**
   * Saves sale under the active store silently without posting a bot reply bubble
   */
  async recordSaleSilently(payload) {
    if (!this.api.isConfigured) {
      this.dom.status.textContent = '⚠️ Configure APPS_SCRIPT_URL in app.js';
      return;
    }

    if (!navigator.onLine) {
      this.storage.enqueueSale(payload);
      this.updateOutboxBadge();
      this.dom.status.textContent = `Offline • Queued (${payload.shopName})`;
      return;
    }

    this.dom.status.textContent = `Saving to ${payload.shopName}...`;

    try {
      const res = await this.api.postSale(payload);
      if (res.status === 'success') {
        this.storage.clearQueryCache();
        this.dom.status.textContent = `✓ ${payload.shopName}: ₹${Number(payload.amount).toLocaleString('en-IN')}`;
        setTimeout(() => this.updateConnectivityUI(), 2000);
      } else {
        this.dom.status.textContent = `⚠️ ${res.message}`;
      }
    } catch {
      this.storage.enqueueSale(payload);
      this.updateOutboxBadge();
      this.dom.status.textContent = 'Queued • Will auto-sync';
    }
  }

  async executeQueryCommand(command) {
    if (!this.api.isConfigured) {
      this.appendMessage('⚙️ Please configure APPS_SCRIPT_URL in app.js first.', 'bot', 'System');
      return;
    }

    const cacheKey = `cmd_${command.toLowerCase()}_${this.state.role}_${this.state.userName}`;
    const cachedReply = this.storage.getCachedQuery(cacheKey);

    if (cachedReply) {
      this.appendMessage(cachedReply, 'bot', 'SalesBot');
      return;
    }

    if (!navigator.onLine) {
      this.appendMessage('📴 Offline and no cached report available.', 'bot', 'SalesBot');
      return;
    }

    const bubble = this.appendMessage('⏳ Fetching report...', 'bot', 'SalesBot');

    try {
      const res = await this.api.getQuery({
        action: 'command',
        command,
        role: this.state.role,
        userName: this.state.userName
      });

      const replyText = res.reply || res.message || 'No data returned.';
      if (res.status === 'success') {
        this.storage.setCachedQuery(cacheKey, replyText);
      }
      bubble.textContent = replyText;
    } catch {
      bubble.textContent = '❌ Unable to fetch report. Check connection.';
    }
  }

  async flushOfflineOutbox() {
    if (this.state.isSyncing || !navigator.onLine || !this.api.isConfigured) return;

    const queue = this.storage.getOutbox();
    if (!queue.length) return;

    this.state.isSyncing = true;
    this.dom.status.textContent = `Syncing ${queue.length} queued...`;

    const remaining = [];
    let syncedCount = 0;

    for (const item of queue) {
      try {
        const res = await this.api.postSale(item.payload);
        if (res.status === 'success') {
          syncedCount++;
        } else {
          remaining.push(item);
        }
      } catch {
        item.retries = (item.retries || 0) + 1;
        remaining.push(item);
      }
    }

    this.storage.saveOutbox(remaining);
    this.updateOutboxBadge();
    this.state.isSyncing = false;

    if (syncedCount > 0) {
      this.storage.clearQueryCache();
      this.dom.status.textContent = `✓ Synced ${syncedCount} record(s)`;
      setTimeout(() => this.updateConnectivityUI(), 2500);
    } else {
      this.updateConnectivityUI();
    }
  }

  async syncShopCatalog() {
    if (!navigator.onLine || !this.api.isConfigured) return;
    try {
      const res = await this.api.getQuery({ action: 'shops' });
      if (res.status === 'success' && Array.isArray(res.shops)) {
        this.storage.setKnownShops(res.shops);
        if (this.state.awaitingStoreSwitch) {
          this.renderStoreChips(this.storage.getKnownShops());
        }
      }
    } catch {}
  }
}

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  });
}

window.addEventListener('DOMContentLoaded', () => {
  new ChatAppController();
});
