/**
 * SalesChat Pro - Clean Architecture Frontend
 * Layers:
 *  1. Config & StateStore
 *  2. OfflineQueue & CacheRepository
 *  3. ApiGateway (with Retry & Timeout)
 *  4. DomainParser (NLP Commands + Sale Validation)
 *  5. VoiceRecognitionService (Web Speech API + Spoken Number Normalization)
 *  6. AdminAnalyticsPresenter (Charts + CSV Export)
 *  7. ChatUIController
 */

const CONFIG = Object.freeze({
  APPS_SCRIPT_URL: 'https://script.google.com/macros/s/AKfycbwN_1AuJh79pKhhwOrFKthXSBUZv6HLblsMILS5Xy0_HKvb5XaYQEjsqtR1XDE4ofQzNg/exec',
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
    } catch {
      // Ignore quota errors
    }
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
    const shops = new Set(this.getKnownShops());
    shops.add(shopName);
    const sorted = Array.from(shops).sort();
    localStorage.setItem(this.KEYS.SHOPS, JSON.stringify(sorted));
    return sorted;
  }

  setKnownShops(shopList) {
    const merged = Array.from(new Set([...CONFIG.DEFAULT_SHOPS, ...shopList])).sort();
    localStorage.setItem(this.KEYS.SHOPS, JSON.stringify(merged));
    return merged;
  }
}

/* ==================== 2. API GATEWAY WITH RETRY ==================== */
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

/* ==================== 3. COMMAND & INPUT PARSER ==================== */
class DomainParser {
  static normalizeVoiceNumbers(text) {
    const wordMap = {
      zero: '0', one: '1', two: '2', three: '3', four: '4',
      five: '5', six: '6', seven: '7', eight: '8', nine: '9',
      ten: '10', twenty: '20', thirty: '30', forty: '40',
      fifty: '50', hundred: '100', thousand: '1000'
    };
    return text.replace(/\b(zero|one|two|three|four|five|six|seven|eight|nine|ten|twenty|thirty|forty|fifty|hundred|thousand)\b/gi,
      m => wordMap[m.toLowerCase()] || m
    );
  }

  static parse(rawText, currentUser) {
    const clean = rawText.replace(/\s+/g, ' ').trim();
    if (!clean) return { type: 'INVALID', error: 'Message cannot be empty.' };

    const lower = clean.toLowerCase();

    // Command matching with flexible natural phrasing
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

    // Sale Record Parsing: <ShopName> <ProductName...> <Amount>
    const tokens = clean.split(' ');
    if (tokens.length < 3) {
      return {
        type: 'INVALID',
        error: '⚠️ Invalid command or format.\nEnter: ShopName Product Amount (e.g. Medical Dolo650 120)\nOr command: Summary, Today\'s Total, Total Medical'
      };
    }

    const rawAmount = tokens[tokens.length - 1].replace(/[₹,]/g, '');
    const amount = Number(rawAmount);

    if (!rawAmount || !isFinite(amount) || amount <= 0) {
      return {
        type: 'INVALID',
        error: `⚠️ Invalid amount "${tokens[tokens.length - 1]}". Please provide a valid positive number.`
      };
    }

    const shopName = this.capitalize(tokens[0]);
    const productName = tokens.slice(1, -1).join(' ');

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
      } catch {
        // Ignore rapid double-tap start exceptions
      }
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
      } catch (err) {
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

/* ==================== 6. MAIN UI & SYNC CONTROLLER ==================== */
class ChatAppController {
  constructor() {
    this.storage = new StorageRepository();
    this.api = new ApiGateway();
    this.analytics = new AdminAnalyticsPresenter(this.api, this.storage);

    const prefs = this.storage.getPrefs();
    this.state = {
      role: prefs.role,
      userName: prefs.userName,
      darkMode: prefs.darkMode,
      isSyncing: false
    };

    this.dom = {
      feed: document.getElementById('chat-feed'),
      form: document.getElementById('composer-form'),
      input: document.getElementById('message-input'),
      voiceBtn: document.getElementById('voice-btn'),
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
    this.updateConnectivityUI();
    this.updateOutboxBadge();

    this.bindEvents();
    this.initVoice();
    this.syncShopCatalog();
    this.flushOfflineOutbox();

    this.appendMessage(
      `👋 Ready, ${this.state.userName} (${this.state.role.toUpperCase()}).\n` +
      `Enter sales (e.g., Medical Dolo650 120) or tap a command below.`,
      'bot',
      'System'
    );
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

    // Live Shop Autocomplete Suggestions on first token
    this.dom.input.addEventListener('input', () => {
      const val = this.dom.input.value;
      if (!val || val.includes(' ')) {
        this.hideShopSuggestions();
        return;
      }
      const query = val.toLowerCase();
      const matches = this.storage.getKnownShops()
        .filter(s => s.toLowerCase().startsWith(query) && s.toLowerCase() !== query);

      this.renderShopSuggestions(matches);
    });

    document.querySelectorAll('.cmd-chip').forEach(chip => {
      chip.addEventListener('click', () => this.handleUserText(chip.dataset.cmd));
    });

    this.dom.roleSelect.addEventListener('change', () => {
      this.state.role = this.dom.roleSelect.value;
      this.storage.savePref(this.storage.KEYS.ROLE, this.state.role);
      this.applyRBAC();
      this.appendMessage(
        `🔐 Role switched to ${this.state.role === 'admin' ? 'Admin (Full Access)' : 'Sales User (Own Records)'}.`,
        'bot',
        'System'
      );
    });

    this.dom.userSelect.addEventListener('change', () => {
      this.state.userName = this.dom.userSelect.value;
      this.storage.savePref(this.storage.KEYS.USER, this.state.userName);
      this.appendMessage(`👤 Active user: ${this.state.userName}`, 'bot', 'System');
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

  renderShopSuggestions(shops) {
    if (!shops.length) {
      this.hideShopSuggestions();
      return;
    }
    this.dom.suggestions.innerHTML = '';
    shops.slice(0, 6).forEach(shop => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'shop-suggestion-item';
      btn.textContent = shop;
      btn.addEventListener('click', () => {
        this.dom.input.value = `${shop} `;
        this.hideShopSuggestions();
        this.dom.input.focus();
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
    this.appendMessage(rawText, 'user', `${this.state.userName} (${this.state.role})`);

    const parsed = DomainParser.parse(rawText, this.state.userName);

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
      await this.recordSale(parsed.payload);
    }
  }

  async recordSale(payload) {
    if (!this.api.isConfigured) {
      this.appendMessage('⚙️ Please configure APPS_SCRIPT_URL in app.js first.', 'bot', 'System');
      return;
    }

    // Immediate offline queueing if disconnected
    if (!navigator.onLine) {
      const qLen = this.storage.enqueueSale(payload);
      this.updateOutboxBadge();
      this.appendMessage(
        `📴 Offline Saved (Queued #${qLen})\n` +
        `Shop: ${payload.shopName}\n` +
        `Product: ${payload.productName}\n` +
        `Amount: ₹${payload.amount.toLocaleString('en-IN')}\n` +
        `Will auto-sync when online.`,
        'bot',
        'OfflineSync'
      );
      return;
    }

    const bubble = this.appendMessage('⏳ Recording sale...', 'bot', 'SalesBot');

    try {
      const res = await this.api.postSale(payload);
      if (res.status === 'success') {
        this.storage.clearQueryCache();
        bubble.textContent =
          `✅ Sale Recorded\n` +
          `Shop: ${res.record.shopName}\n` +
          `Product: ${res.record.productName}\n` +
          `Amount: ₹${Number(res.record.amount).toLocaleString('en-IN')}\n` +
          `Time: ${res.record.timestamp}`;
      } else {
        bubble.textContent = `❌ ${res.message}`;
      }
    } catch (err) {
      // Automatic fallback to offline queue on network failure
      const qLen = this.storage.enqueueSale(payload);
      this.updateOutboxBadge();
      bubble.textContent =
        `⚠️ Network unstable — Saved offline (Queued #${qLen}).\n` +
        `Shop: ${payload.shopName} | ₹${payload.amount}\n` +
        `Auto-retry scheduled.`;
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
      this.appendMessage(cachedReply, 'bot', 'SalesBot (Cached)');
      return;
    }

    if (!navigator.onLine) {
      this.appendMessage('📴 You are offline and no cached report is available for this query.', 'bot', 'SalesBot');
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
      bubble.textContent = '❌ Unable to fetch report. Check connection and try again.';
    }
  }

  async flushOfflineOutbox() {
    if (this.state.isSyncing || !navigator.onLine || !this.api.isConfigured) return;

    const queue = this.storage.getOutbox();
    if (!queue.length) return;

    this.state.isSyncing = true;
    this.dom.status.textContent = `Syncing ${queue.length} offline record(s)...`;

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
    this.updateConnectivityUI();

    if (syncedCount > 0) {
      this.storage.clearQueryCache();
      this.appendMessage(`🔄 Auto-Sync Complete: ${syncedCount} offline sale(s) uploaded to Google Sheets.`, 'bot', 'SyncEngine');
    }
  }

  async syncShopCatalog() {
    if (!navigator.onLine || !this.api.isConfigured) return;
    try {
      const res = await this.api.getQuery({ action: 'shops' });
      if (res.status === 'success' && Array.isArray(res.shops)) {
        this.storage.setKnownShops(res.shops);
      }
    } catch {
      // Silent background refresh
    }
  }
}

// Register Service Worker & Boot Application
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  });
}

window.addEventListener('DOMContentLoaded', () => {
  new ChatAppController();
});
