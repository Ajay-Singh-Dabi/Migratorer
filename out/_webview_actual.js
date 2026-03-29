
const vscode = acquireVsCodeApi();

// ─── State ────────────────────────────────────────────────────────────────────
let planMarkdown = '';
let analysisData = null;
let isGenerating = false;
let lastRepoUrl   = '';

// ─── Element Refs ──────────────────────────────────────────────────────────────
const btnAnalyze       = document.getElementById('btn-analyze');
const btnGenerate      = document.getElementById('btn-generate');
const btnStop          = document.getElementById('btn-stop');
const btnSuggest       = document.getElementById('btn-suggest');
const recsSection      = document.getElementById('recs-section');
const recsLoading      = document.getElementById('recs-loading');
const recsCards        = document.getElementById('recs-cards');
const btnHealth        = document.getElementById('btn-health');
const healthSection    = document.getElementById('health-section');
const healthLoading    = document.getElementById('health-loading');
const healthSummary    = document.getElementById('health-summary');
const healthCards      = document.getElementById('health-cards');
const btnSettings      = document.getElementById('btn-settings');
const btnCopy          = document.getElementById('btn-copy');
const btnSaveMd        = document.getElementById('btn-save-md');
const btnValidateToken = document.getElementById('btn-validate-token');
const btnRunQueue      = document.getElementById('btn-run-queue');
const btnClearHistory  = document.getElementById('btn-clear-history');
const modelPicker      = document.getElementById('model-picker');
const inputRepo        = document.getElementById('input-repo');
const inputToken       = document.getElementById('input-token');
const inputTarget      = document.getElementById('input-target');
const queueInput       = document.getElementById('queue-input');
const presetSelect     = document.getElementById('preset-select');
const detailLevel      = document.getElementById('detail-level');
const optTests         = document.getElementById('opt-tests');
const optCi            = document.getElementById('opt-ci');
const optDocker        = document.getElementById('opt-docker');
const progressSect     = document.getElementById('progress-section');
const progressBar      = document.getElementById('progress-bar');
const progressText     = document.getElementById('progress-text');
const errorBox         = document.getElementById('error-box');
const cacheNotice      = document.getElementById('cache-notice');
const tokenStatus      = document.getElementById('token-status');
const stackSection     = document.getElementById('stack-section');
const stackCard        = document.getElementById('stack-card');
const stackAiLoading   = document.getElementById('stack-ai-loading');
const planEmpty        = document.getElementById('plan-empty');
const planContainer    = document.getElementById('plan-container');
const planRendered     = document.getElementById('plan-rendered');
const planOutput       = document.getElementById('plan-output');
const filesEmpty       = document.getElementById('files-empty');
const filesContainer   = document.getElementById('files-container');
const filesHeader      = document.getElementById('files-header');
const fileTreeCont     = document.getElementById('file-tree-content');
const rawEmpty         = document.getElementById('raw-empty');
const genIndicator     = document.getElementById('generating-indicator');
const securityEmpty    = document.getElementById('security-empty');
const securityReport   = document.getElementById('security-report');
const securityContent  = document.getElementById('security-content');
const historyList      = document.getElementById('history-list');
const queueStatus      = document.getElementById('queue-status');
// New tabs
const btnPreviews      = document.getElementById('btn-previews');
const previewsEmpty    = document.getElementById('previews-empty');
const previewsContainer= document.getElementById('previews-container');
const previewsRendered = document.getElementById('previews-rendered');
const previewsIndicator= document.getElementById('previews-indicator');
const btnCopyPreviews  = document.getElementById('btn-copy-previews');
const btnDebug         = document.getElementById('btn-debug');
const btnStopDebug     = document.getElementById('btn-stop-debug');
const debugInput       = document.getElementById('debug-input');
const debugEmpty       = document.getElementById('debug-empty');
const debugRendered    = document.getElementById('debug-rendered');
const exportFormat     = document.getElementById('export-format');
const reportFormatSel  = document.getElementById('report-format');
const exportOutputWrap = document.getElementById('export-output-wrap');
const exportContent    = document.getElementById('export-content');
const exportTitle      = document.getElementById('export-title');
const btnCopyExport    = document.getElementById('btn-copy-export');
const btnCloseExport   = document.getElementById('btn-close-export');
const orgInput         = document.getElementById('org-input');
const btnScanOrg       = document.getElementById('btn-scan-org');
const orgEmpty         = document.getElementById('org-empty');
const orgTableWrap     = document.getElementById('org-table-wrap');
const orgSummary       = document.getElementById('org-summary');
const orgTbody         = document.getElementById('org-tbody');
const orgProgress      = document.getElementById('org-progress');
const progressBranch   = document.getElementById('progress-branch');
const btnCheckProgress = document.getElementById('btn-check-progress');
const progressEmpty    = document.getElementById('progress-empty');
const progressContainer= document.getElementById('progress-container');
const progressRendered = document.getElementById('progress-rendered');
const progressIndicator= document.getElementById('progress-indicator');
const scopeSelect      = document.getElementById('scope-select');
const optPhased        = document.getElementById('opt-phased');
let previewsMarkdown   = '';
let exportMarkdown     = '';
let stackRecsMarkdown  = '';
let stackHealthMarkdown = '';

// ─── Chat State ────────────────────────────────────────────────────────────────
let chatReady     = false; // true once a plan has been generated
let chatReplying  = false; // true while streaming an assistant reply
let chatReplyBuf  = '';    // accumulates current assistant turn

const chatThread    = document.getElementById('chat-thread');
const chatInput     = document.getElementById('chat-input');
const btnChatSend   = document.getElementById('btn-chat-send');
const btnChatStop   = document.getElementById('btn-chat-stop');
const btnChatClear  = document.getElementById('btn-chat-clear');
const chatHint      = document.getElementById('chat-hint');
const chatEmptyState = document.getElementById('chat-empty-state');

// ─── Checklist refs ────────────────────────────────────────────────────────────
const checklistEmpty     = document.getElementById('checklist-empty');
const checklistContainer = document.getElementById('checklist-container');
const checklistBar       = document.getElementById('checklist-bar');
const checklistLabel     = document.getElementById('checklist-label');
const checklistList      = document.getElementById('checklist-list');
const btnResetChecklist  = document.getElementById('btn-reset-checklist');

// ─── Compat Matrix refs ────────────────────────────────────────────────────────
const compatEmpty    = document.getElementById('compat-empty');
const compatContainer= document.getElementById('compat-container');
const compatLoading  = document.getElementById('compat-loading');
const compatTbody    = document.getElementById('compat-tbody');
const compatFilters  = document.getElementById('compat-filters');
const btnCompat      = document.getElementById('btn-compat');
let compatMarkdown   = '';
let activeFilter     = 'all';

// ─── Tab switching ─────────────────────────────────────────────────────────────
document.querySelectorAll('.tab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.tab-content').forEach(t => t.classList.remove('active'));
    tab.classList.add('active');
    document.getElementById('tab-' + tab.dataset.tab).classList.add('active');
  });
});

// ─── Chat ──────────────────────────────────────────────────────────────────────

function chatSend() {
  const text = chatInput.value.trim();
  if (!text || chatReplying || !chatReady) { return; }
  chatInput.value = '';
  chatInput.style.height = 'auto';
  appendChatBubble('user', text);
  startChatReply();
  vscode.postMessage({ type: 'chat', chatMessage: text });
}

function startChatReply() {
  chatReplying = true;
  chatReplyBuf = '';
  btnChatSend.style.display = 'none';
  btnChatStop.style.display = 'inline-flex';
  chatInput.disabled = true;
  btnChatClear.disabled = true;
  // Placeholder bubble that we'll fill in as chunks arrive
  const wrap = document.createElement('div');
  wrap.className = 'chat-msg-wrap assistant';
  wrap.id = 'chat-pending-wrap';
  const label = document.createElement('div');
  label.className = 'chat-role-label';
  label.textContent = 'Assistant';
  const bubble = document.createElement('div');
  bubble.className = 'chat-bubble assistant';
  bubble.id = 'chat-pending-bubble';
  bubble.innerHTML = `<div class="chat-typing"><div class="dot-pulse"><span></span><span></span><span></span></div> Thinking…</div>`;
  wrap.appendChild(label);
  wrap.appendChild(bubble);
  chatThread.appendChild(wrap);
  chatThread.scrollTop = chatThread.scrollHeight;
}

function stopChatReply() {
  chatReplying = false;
  btnChatSend.style.display = 'inline-flex';
  btnChatStop.style.display = 'none';
  chatInput.disabled = false;
  btnChatClear.disabled = false;
  chatInput.focus();
  // Remove pending bubble if it was never filled
  const pending = document.getElementById('chat-pending-wrap');
  if (pending && !chatReplyBuf) { pending.remove(); }
}

function appendChatBubble(role, text) {
  const wrap = document.createElement('div');
  wrap.className = `chat-msg-wrap ${role}`;
  const label = document.createElement('div');
  label.className = 'chat-role-label';
  label.textContent = role === 'user' ? 'You' : 'Assistant';
  const bubble = document.createElement('div');
  bubble.className = `chat-bubble ${role}`;
  bubble.innerHTML = role === 'user' ? escapeHtml(text) : parseMarkdown(text);
  wrap.appendChild(label);
  wrap.appendChild(bubble);
  chatThread.appendChild(wrap);
  chatThread.scrollTop = chatThread.scrollHeight;
}

function enableChat() {
  chatReady = true;
  chatInput.disabled = false;
  btnChatSend.disabled = false;
  btnChatClear.disabled = false;
  chatHint.textContent = 'Ask anything about the migration plan. Shift+Enter for new line.';
}

btnChatSend.addEventListener('click', chatSend);

btnChatStop.addEventListener('click', () => {
  vscode.postMessage({ type: 'stopGeneration' });
  stopChatReply();
});

btnChatClear.addEventListener('click', () => {
  chatThread.innerHTML = '';
  chatReplyBuf = '';
  vscode.postMessage({ type: 'clearChat' });
});

chatInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    chatSend();
  }
});

// Auto-resize textarea
chatInput.addEventListener('input', () => {
  chatInput.style.height = 'auto';
  chatInput.style.height = Math.min(chatInput.scrollHeight, 120) + 'px';
});

// ─── Model Picker (enhancement #10) ───────────────────────────────────────────
modelPicker.addEventListener('change', () => {
  vscode.postMessage({ type: 'changeModel', model: modelPicker.value });
});

// ─── Preset select ─────────────────────────────────────────────────────────────
presetSelect.addEventListener('change', () => {
  if (presetSelect.value) { inputTarget.value = presetSelect.value; presetSelect.value = ''; }
});

// ─── Settings ─────────────────────────────────────────────────────────────────
btnSettings.addEventListener('click', () => vscode.postMessage({ type: 'openSettings' }));

// ─── Token Validation (enhancement #12) ──────────────────────────────────────
btnValidateToken.addEventListener('click', () => {
  const tok = inputToken.value.trim();
  if (!tok) {
    tokenStatus.style.display = 'block';
    tokenStatus.style.color = 'var(--vscode-errorForeground)';
    tokenStatus.textContent = '❌ Enter a token first.';
    return;
  }
  btnValidateToken.disabled = true;
  btnValidateToken.textContent = '⏳';
  tokenStatus.style.display = 'block';
  tokenStatus.style.color = 'var(--vscode-descriptionForeground)';
  tokenStatus.textContent = 'Verifying…';
  vscode.postMessage({ type: 'validateToken', githubToken: tok, repoUrl: inputRepo.value.trim() || undefined });
});

// ─── Save as .md (enhancement #2) ─────────────────────────────────────────────
btnSaveMd.addEventListener('click', () => {
  vscode.postMessage({ type: 'savePlan', plan: planMarkdown });
});

// ─── Bypass cache ─────────────────────────────────────────────────────────────
function bypassCache() {
  cacheNotice.style.display = 'none';
  lastRepoUrl = '';
  btnAnalyze.click();
}

// ─── Queue (enhancement #6) ───────────────────────────────────────────────────
inputTarget.addEventListener('input', () => {
  btnRunQueue.disabled = !inputTarget.value.trim() || !queueInput.value.trim();
});
queueInput.addEventListener('input', () => {
  btnRunQueue.disabled = !inputTarget.value.trim() || !queueInput.value.trim();
});
btnRunQueue.addEventListener('click', () => {
  const urls = queueInput.value.split('\n').map(u => u.trim()).filter(Boolean);
  if (!urls.length) { return; }
  const target = inputTarget.value.trim();
  if (!target) { showError('Set a target stack before running the queue.'); return; }
  hideError();
  vscode.postMessage({
    type: 'addToQueue',
    queueUrls: urls,
    githubToken: inputToken.value.trim() || undefined,
    targetStack: target,
    options: getOptions(),
  });
});

// ─── History actions (enhancement #9) ─────────────────────────────────────────
btnClearHistory.addEventListener('click', () => vscode.postMessage({ type: 'clearHistory' }));

// ─── Analyze ──────────────────────────────────────────────────────────────────
btnAnalyze.addEventListener('click', () => {
  const repoUrl = inputRepo.value.trim();
  if (!repoUrl) { showError('Please enter a GitHub repository URL.'); return; }
  hideError();
  cacheNotice.style.display = 'none';
  progressSect.style.display = 'block';
  btnAnalyze.disabled = true;
  stackSection.style.display = 'none';
  btnGenerate.disabled = true;
  lastRepoUrl = repoUrl;
  vscode.postMessage({ type: 'analyze', repoUrl, githubToken: inputToken.value.trim() || undefined });
});

// ─── Stack Health ─────────────────────────────────────────────────────────────
btnHealth.addEventListener('click', () => {
  hideError();
  healthSection.style.display = 'block';
  healthLoading.style.display = 'block';
  healthSummary.style.display = 'none';
  healthCards.innerHTML = '';
  stackHealthMarkdown = '';
  btnHealth.disabled = true;
  vscode.postMessage({ type: 'analyzeStackHealth' });
});

// ─── Suggest Targets ──────────────────────────────────────────────────────────
btnSuggest.addEventListener('click', () => {
  hideError();
  recsSection.style.display = 'block';
  recsLoading.style.display = 'block';
  recsCards.innerHTML = '';
  stackRecsMarkdown = '';
  btnSuggest.disabled = true;
  vscode.postMessage({ type: 'recommendStacks' });
});

// ─── Generate ─────────────────────────────────────────────────────────────────
btnGenerate.addEventListener('click', () => {
  const target = inputTarget.value.trim();
  if (!target) { showError('Please enter a target stack or pick a preset.'); return; }
  hideError();
  startGeneration();
  vscode.postMessage({ type: 'generatePlan', targetStack: target, options: getOptions() });
});

btnStop.addEventListener('click', () => vscode.postMessage({ type: 'stopGeneration' }));

btnCopy.addEventListener('click', () => {
  navigator.clipboard.writeText(planMarkdown).then(() => {
    btnCopy.textContent = 'Copied!';
    setTimeout(() => { btnCopy.textContent = 'Copy'; }, 2000);
  });
});

// ─── Compat Matrix ─────────────────────────────────────────────────────────────
btnCompat.addEventListener('click', () => {
  const target = inputTarget.value.trim() || 'target stack';
  compatMarkdown = '';
  compatLoading.style.display = 'block';
  compatTbody.innerHTML = '';
  compatEmpty.style.display = 'none';
  compatContainer.style.display = 'flex';
  // Switch to compat tab
  document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
  document.querySelectorAll('.tab-content').forEach(t => t.classList.remove('active'));
  document.querySelector('[data-tab="compat"]').classList.add('active');
  document.getElementById('tab-compat').classList.add('active');
  vscode.postMessage({ type: 'generateCompatMatrix', targetStack: target });
});

compatFilters.addEventListener('click', (e) => {
  const btn = e.target.closest('.filter-btn');
  if (!btn) { return; }
  activeFilter = btn.dataset.filter;
  compatFilters.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  applyCompatFilter();
});

function applyCompatFilter() {
  compatTbody.querySelectorAll('tr').forEach(row => {
    if (activeFilter === 'all') {
      row.dataset.hidden = 'false';
    } else {
      const statusCell = row.querySelector('.status-badge');
      const matches = statusCell && statusCell.textContent.startsWith(activeFilter);
      row.dataset.hidden = matches ? 'false' : 'true';
    }
  });
}

function parseCompatTable(markdown) {
  // Extract table rows from the markdown output
  const rows = markdown.split('\n').filter(l => l.trim().startsWith('|') && !l.includes('---'));
  if (rows.length < 2) { return; } // need header + at least one data row

  const dataRows = rows.slice(1); // skip header row
  compatTbody.innerHTML = '';

  for (const row of dataRows) {
    const cells = row.split('|').map(c => c.trim()).filter((_, i, a) => i > 0 && i < a.length - 1);
    if (cells.length < 3) { continue; }
    const [pkg, version, status, equivalent, notes] = cells;
    if (!pkg || !status) { continue; }

    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td><span class="pkg-name">${escapeHtml(pkg)}</span></td>
      <td style="font-size:11px;font-family:var(--vscode-editor-font-family,monospace)">${escapeHtml(version || '')}</td>
      <td><span class="status-badge">${escapeHtml(status)}</span></td>
      <td><span class="pkg-name">${escapeHtml(equivalent || '—')}</span></td>
      <td class="compat-notes">${escapeHtml(notes || '')}</td>
    `;
    compatTbody.appendChild(tr);
  }
  applyCompatFilter();
}

// ─── Checklist ─────────────────────────────────────────────────────────────────
btnResetChecklist.addEventListener('click', () => {
  vscode.postMessage({ type: 'resetChecklist' });
});

function renderChecklist(items) {
  if (!items || items.length === 0) {
    checklistEmpty.style.display = 'flex';
    checklistContainer.style.display = 'none';
    return;
  }
  checklistEmpty.style.display = 'none';
  checklistContainer.style.display = 'flex';

  const done = items.filter(i => i.done).length;
  const pct = items.length > 0 ? Math.round((done / items.length) * 100) : 0;
  checklistBar.style.width = pct + '%';
  checklistLabel.textContent = `${done} / ${items.length} done (${pct}%)`;

  // Group by phase
  const phases = [...new Set(items.map(i => i.phase))];
  checklistList.innerHTML = phases.map(phase => {
    const phaseItems = items.filter(i => i.phase === phase);
    return `<div class="checklist-phase">${escapeHtml(phase)}</div>` +
      phaseItems.map(item => `
        <div class="checklist-item${item.done ? ' done' : ''}" data-id="${escapeHtml(item.id)}" onclick="toggleChecklistItem('${escapeHtml(item.id)}')">
          <input type="checkbox" class="checklist-cb" ${item.done ? 'checked' : ''} tabindex="-1" readonly>
          <span class="checklist-text">${escapeHtml(item.text)}</span>
        </div>
      `).join('');
  }).join('');
}

function toggleChecklistItem(id) {
  vscode.postMessage({ type: 'toggleChecklistItem', checklistItemId: id });
}

function getOptions() {
  return {
    includeTestMigration: optTests.checked,
    includeCiMigration: optCi.checked,
    includeDockerMigration: optDocker.checked,
    detailLevel: detailLevel.value,
    phasedMode: optPhased.checked,
    scope: scopeSelect.value || 'full',
  };
}

// ─── File Previews ─────────────────────────────────────────────────────────────
btnPreviews.addEventListener('click', () => {
  const target = inputTarget.value.trim();
  if (!target) { showError('Set a target stack first.'); return; }
  previewsEmpty.style.display = 'none';
  previewsContainer.style.display = 'flex';
  previewsIndicator.style.display = 'flex';
  previewsMarkdown = '';
  previewsRendered.innerHTML = '';
  vscode.postMessage({ type: 'generateFilePreviews', targetStack: target });
  // Switch to previews tab
  document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
  document.querySelectorAll('.tab-content').forEach(t => t.classList.remove('active'));
  document.querySelector('[data-tab="previews"]').classList.add('active');
  document.getElementById('tab-previews').classList.add('active');
});

btnCopyPreviews.addEventListener('click', () => {
  navigator.clipboard.writeText(previewsMarkdown).then(() => {
    btnCopyPreviews.textContent = 'Copied!';
    setTimeout(() => { btnCopyPreviews.textContent = 'Copy'; }, 2000);
  });
});

// ─── Export ────────────────────────────────────────────────────────────────────
exportFormat.addEventListener('change', () => {
  const fmt = exportFormat.value;
  if (!fmt) { return; }
  exportFormat.value = '';
  if (fmt === 'exec-summary') {
    // streams to exec summary overlay
    exportMarkdown = '';
    exportOutputWrap.style.display = 'flex';
    exportTitle.textContent = '📊 Executive Summary';
    exportContent.textContent = 'Generating…';
    vscode.postMessage({ type: 'exportPlan', exportFormat: fmt });
    return;
  }
  exportMarkdown = '';
  exportOutputWrap.style.display = 'flex';
  const labels = { checklist: '✅ Checklist', 'github-issue': '🐙 GitHub Issue', confluence: '📝 Confluence' };
  exportTitle.textContent = labels[fmt] || 'Export';
  exportContent.textContent = 'Generating…';
  vscode.postMessage({ type: 'exportPlan', exportFormat: fmt });
});

btnCopyExport.addEventListener('click', () => {
  navigator.clipboard.writeText(exportMarkdown).then(() => {
    btnCopyExport.textContent = 'Copied!';
    setTimeout(() => { btnCopyExport.textContent = 'Copy'; }, 2000);
  });
});

btnCloseExport.addEventListener('click', () => { exportOutputWrap.style.display = 'none'; });

// ─── Download Report ──────────────────────────────────────────────────────────
reportFormatSel.addEventListener('change', () => {
  const fmt = reportFormatSel.value;
  if (!fmt) { return; }
  const targetStack = inputTarget.value.trim() || 'modern stack';
  vscode.postMessage({ type: 'generateReport', targetStack, reportFormat: fmt });
});

// ─── Debug ─────────────────────────────────────────────────────────────────────
btnDebug.addEventListener('click', () => {
  const err = debugInput.value.trim();
  if (!err) { return; }
  btnDebug.disabled = true;
  btnStopDebug.style.display = 'inline-flex';
  debugEmpty.style.display = 'none';
  debugRendered.style.display = 'block';
  debugRendered.innerHTML = '';
  vscode.postMessage({ type: 'debugError', errorMessage: err });
});
btnStopDebug.addEventListener('click', () => vscode.postMessage({ type: 'stopGeneration' }));

// ─── Org Dashboard ─────────────────────────────────────────────────────────────
btnScanOrg.addEventListener('click', () => {
  const url = orgInput.value.trim();
  if (!url) { return; }
  orgProgress.style.display = 'block';
  orgProgress.textContent = 'Starting scan…';
  orgEmpty.style.display = 'none';
  vscode.postMessage({ type: 'analyzeOrg', orgUrl: url, githubToken: inputToken.value.trim() || undefined });
});

// ─── Progress Check ────────────────────────────────────────────────────────────
btnCheckProgress.addEventListener('click', () => {
  const branch = progressBranch.value.trim();
  progressEmpty.style.display = 'none';
  progressContainer.style.display = 'flex';
  progressIndicator.style.display = 'flex';
  progressRendered.innerHTML = '';
  vscode.postMessage({ type: 'checkProgress', branch });
});

// ─── Message from extension ───────────────────────────────────────────────────
window.addEventListener('message', (event) => {
  const msg = event.data;
  switch (msg.type) {
    case 'settingsLoaded':
      if (msg.settings.githubToken) { inputToken.value = msg.settings.githubToken; }
      if (msg.settings.copilotModel) { modelPicker.value = msg.settings.copilotModel; }
      break;

    case 'progress':
      progressBar.style.width = ((msg.step / msg.totalSteps) * 100) + '%';
      progressText.textContent = msg.message;
      break;

    case 'analysisComplete':
      progressSect.style.display = 'none';
      btnAnalyze.disabled = false;
      analysisData = msg.analysis;
      renderStack(msg.analysis);
      renderFileTree(msg.analysis);
      renderSecurityReport(msg.analysis);
      btnGenerate.disabled = false;
      btnSuggest.disabled = false;
      btnRunQueue.disabled = !inputTarget.value.trim() || !queueInput.value.trim();
      // Kick off AI stack enrichment automatically
      showStackLoading(true);
      vscode.postMessage({ type: 'aiDetectStack' });
      break;

    case 'cacheHit': {
      const ago = Math.round((Date.now() - msg.cachedAt) / 60000);
      cacheNotice.style.display = 'block';
      cacheNotice.querySelector('span') && (cacheNotice.querySelector('span').textContent = `${ago}m ago`);
      break;
    }

    case 'planChunk':
      if (msg.chunk === '') {
        planMarkdown = '';
        planRendered.innerHTML = '';
        planOutput.textContent = '';
        showPlanContainer();
      } else {
        planMarkdown += msg.chunk;
        planRendered.innerHTML = parseMarkdown(planMarkdown);
        planOutput.textContent = planMarkdown;
        rawEmpty.style.display = 'none';
        planOutput.style.display = 'block';
        planRendered.scrollTop = planRendered.scrollHeight;
      }
      break;

    case 'planComplete':
      stopGeneration(false);
      btnSaveMd.disabled = false;
      btnPreviews.disabled = false;
      btnCompat.disabled = false;
      enableChat();
      break;

    case 'planSaved':
      btnSaveMd.title = 'Saved!';
      setTimeout(() => { btnSaveMd.title = 'Save plan as .md'; }, 2000);
      break;

    case 'stopped':
      stopGeneration(true);
      break;

    case 'error':
      progressSect.style.display = 'none';
      btnAnalyze.disabled = false;
      stopGeneration(true);
      showError(msg.message);
      break;

    // Token validation (enhancement #12)
    case 'tokenValidation':
      tokenStatus.style.display = 'block';
      if (msg.isValid) {
        tokenStatus.style.color = 'var(--vscode-testing-iconPassed, #4caf50)';
        tokenStatus.textContent = `✅ Valid — logged in as @${msg.username}`;
      } else {
        tokenStatus.style.color = 'var(--vscode-errorForeground)';
        tokenStatus.textContent = `❌ ${msg.message || 'Invalid token'}`;
      }
      break;

    // History (enhancement #9)
    case 'historyLoaded':
      renderHistory(msg.entries || []);
      break;

    // Queue progress (enhancement #6)
    case 'queueProgress':
      queueStatus.style.display = 'block';
      queueStatus.textContent = `Processing ${msg.queueIndex}/${msg.queueTotal}: ${msg.queueRepo}`;
      break;

    // File previews (enhancement #1 — enhanced with diff cards)
    case 'previewChunk':
      if (msg.chunk === '') {
        previewsMarkdown = '';
        previewsRendered.innerHTML = '';
      } else {
        previewsMarkdown += msg.chunk;
        renderPreviewCards(previewsMarkdown);
      }
      break;
    case 'previewComplete':
      previewsIndicator.style.display = 'none';
      renderPreviewCards(previewsMarkdown); // final render
      break;

    // Debug (enhancement #3)
    case 'debugChunk':
      if (msg.chunk === '') { debugRendered.innerHTML = ''; }
      else { debugRendered.innerHTML = parseMarkdown(debugRendered.dataset.md = (debugRendered.dataset.md || '') + msg.chunk); }
      break;
    case 'debugComplete':
      btnDebug.disabled = false;
      btnStopDebug.style.display = 'none';
      break;

    // Export (enhancement #4)
    case 'exportReady':
      exportMarkdown = msg.exportContent || '';
      exportContent.textContent = exportMarkdown || 'Generating…';
      break;

    // Exec Summary (enhancement #5)
    case 'execSummaryChunk':
      if (msg.chunk === '') { exportMarkdown = ''; exportContent.textContent = ''; }
      else { exportMarkdown += msg.chunk; exportContent.textContent = exportMarkdown; }
      break;
    case 'execSummaryComplete':
      break;

    // Org dashboard (enhancement #7)
    case 'orgDashboard':
      orgProgress.style.display = 'none';
      renderOrgDashboard(msg.dashboard);
      break;

    // Progress check (enhancement #8)
    case 'progressChunk':
      if (msg.chunk === '') { progressRendered.innerHTML = ''; progressRendered.dataset.md = ''; }
      else {
        progressRendered.dataset.md = (progressRendered.dataset.md || '') + msg.chunk;
        progressRendered.innerHTML = parseMarkdown(progressRendered.dataset.md);
      }
      break;
    case 'progressComplete':
      progressIndicator.style.display = 'none';
      break;

    // AI stack detection
    case 'aiStackDetected':
      showStackLoading(false);
      if (msg.aiStack) { renderAIStack(msg.aiStack, analysisData); }
      break;

    // Stack health analysis
    case 'stackHealthChunk':
      if (msg.chunk === '') { stackHealthMarkdown = ''; }
      else { stackHealthMarkdown += msg.chunk; }
      break;
    case 'stackHealthComplete':
      healthLoading.style.display = 'none';
      btnHealth.disabled = false;
      renderHealthCards(stackHealthMarkdown);
      break;

    // Stack recommendations
    case 'stackRecsChunk':
      if (msg.chunk === '') { stackRecsMarkdown = ''; }
      else { stackRecsMarkdown += msg.chunk; }
      break;
    case 'stackRecsComplete':
      recsLoading.style.display = 'none';
      btnSuggest.disabled = false;
      renderRecCards(stackRecsMarkdown);
      break;

    // Report generation
    case 'reportReady':
      reportFormatSel.value = '';
      showInfoMsg('Report saved: ' + msg.message);
      break;
    case 'reportError':
      reportFormatSel.value = '';
      showError('Report error: ' + msg.message);
      break;

    // Chat
    case 'chatChunk':
      if (msg.chunk === '') {
        // New assistant turn starting — pending bubble already added by startChatReply()
        chatReplyBuf = '';
      } else {
        chatReplyBuf += msg.chunk;
        const bubble = document.getElementById('chat-pending-bubble');
        if (bubble) {
          bubble.innerHTML = parseMarkdown(chatReplyBuf) + `<span class="cursor"></span>`;
          chatThread.scrollTop = chatThread.scrollHeight;
        }
      }
      break;

    case 'chatComplete': {
      const bubble = document.getElementById('chat-pending-bubble');
      if (bubble) {
        bubble.removeAttribute('id');
        bubble.innerHTML = parseMarkdown(chatReplyBuf);
      }
      const wrap = document.getElementById('chat-pending-wrap');
      if (wrap) { wrap.removeAttribute('id'); }
      stopChatReply();
      chatThread.scrollTop = chatThread.scrollHeight;
      break;
    }

    case 'chatCleared':
      // Already cleared by button handler
      break;

    // Compat matrix
    case 'compatMatrixChunk':
      if (msg.chunk === '') {
        compatMarkdown = '';
        compatTbody.innerHTML = '';
      } else {
        compatMarkdown += msg.chunk;
        parseCompatTable(compatMarkdown);
      }
      break;
    case 'compatMatrixComplete':
      compatLoading.style.display = 'none';
      if (compatTbody.children.length === 0) {
        compatTbody.innerHTML = `<tr><td colspan="5" style="padding:12px;color:var(--vscode-descriptionForeground)">No dependency data found. Make sure the repository has a package.json, requirements.txt, or similar.</td></tr>`;
      }
      break;

    // Checklist
    case 'checklistLoaded':
    case 'checklistUpdated':
      renderChecklist(msg.checklist || []);
      break;
  }
});

// ─── UI Helpers ───────────────────────────────────────────────────────────────

// ─── Health Cards ─────────────────────────────────────────────────────────────

function renderHealthCards(markdown) {
  healthCards.innerHTML = '';

  // Extract and show the summary line
  const summaryMatch = markdown.match(/**Health Score:.*?**[^
]*/);
  if (summaryMatch) {
    healthSummary.style.display = 'block';
    healthSummary.innerHTML = parseMarkdown(summaryMatch[0]);
  }

  // Split into issue sections by "## " headings
  const sections = markdown.split(/(?=## )/g).filter(s => s.startsWith('## '));

  sections.forEach(section => {
    const titleMatch = section.match(/## (.+)/);
    if (!titleMatch) { return; }
    const title = titleMatch[1].trim();

    const impactMatch = section.match(/**Impact:**s*(High|Medium|Low)/i);
    const impact = impactMatch ? impactMatch[1].toLowerCase() : 'medium';

    const problemMatch = section.match(/**Problem:**s*([^
]+)/i);
    const problem = problemMatch ? problemMatch[1].trim() : '';

    const fixMatch = section.match(/**Fix:**s*([^
]+)/i);
    const fix = fixMatch ? fixMatch[1].trim() : '';

    const card = document.createElement('div');
    card.className = `health-card impact-${impact}`;
    card.innerHTML = `
      <div class="health-card-title">
        ${escapeHtml(title)}<span class="health-impact">${escapeHtml(impact.toUpperCase())}</span>
      </div>
      ${problem ? `<div class="health-problem">${escapeHtml(problem)}</div>` : ''}
      ${fix ? `<div class="health-fix">${escapeHtml(fix)}</div>` : ''}
    `;
    healthCards.appendChild(card);
  });

  if (healthCards.children.length === 0) {
    healthCards.innerHTML = `<div class="rec-body">${parseMarkdown(markdown)}</div>`;
  }
}

// ─── Recommendation Cards ──────────────────────────────────────────────────────

function renderRecCards(markdown) {
  recsCards.innerHTML = '';
  // Split by "## Option" headings
  const sections = markdown.split(/(?=## Option d+:)/g).filter(s => s.trim());

  sections.forEach(section => {
    // Extract title
    const titleMatch = section.match(/## Option d+:s*(.+)/);
    if (!titleMatch) { return; }
    const title = titleMatch[1].trim();

    // Extract effort
    const effortMatch = section.match(/**Effort:**s*(.+)/i);
    const effort = effortMatch ? effortMatch[1].trim() : '';

    // Extract best for
    const bestForMatch = section.match(/**Best for:**s*(.+)/i);
    const bestFor = bestForMatch ? bestForMatch[1].trim() : '';

    // Extract [TARGET]: line
    const targetMatch = section.match(/[TARGET]:s*(.+)/i);
    const target = targetMatch ? targetMatch[1].trim() : '';

    // Extract pros/cons block (between Best for and [TARGET])
    let body = section
      .replace(/## Option d+:.+/g, '')
      .replace(/**Effort:**.*
?/g, '')
      .replace(/**Best for:**.*
?/g, '')
      .replace(/[TARGET]:.*/g, '')
      .trim();

    // Build effort badge class
    const effortLower = effort.toLowerCase().replace(/s+/g, '-');
    const effortClass = ['low','medium','high','very-high'].includes(effortLower)
      ? `effort-${effortLower}`
      : 'effort-medium';

    const card = document.createElement('div');
    card.className = 'rec-card';
    card.innerHTML = `
      <div class="rec-card-header">
        <span class="rec-title">${escapeHtml(title)}</span>
        ${effort ? `<span class="effort-badge ${effortClass}">${escapeHtml(effort)} effort</span>` : ''}
      </div>
      ${bestFor ? `<p class="rec-bestfor">${escapeHtml(bestFor)}</p>` : ''}
      <div class="rec-body">${parseMarkdown(body)}</div>
      ${target ? `<button class="btn btn-primary rec-use-btn" data-target="${escapeHtml(target)}">→ Use This Target</button>` : ''}
    `;

    if (target) {
      card.querySelector('.rec-use-btn').addEventListener('click', () => {
        inputTarget.value = target;
        inputTarget.scrollIntoView({ behavior: 'smooth', block: 'center' });
        inputTarget.focus();
      });
    }

    recsCards.appendChild(card);
  });

  if (recsCards.children.length === 0) {
    // Fallback: render raw markdown if parsing failed
    recsCards.innerHTML = `<div class="rec-body">${parseMarkdown(markdown)}</div>`;
  }
}

// ─── File Preview Cards (diff view) ───────────────────────────────────────────

function renderPreviewCards(markdown) {
  // Split into file sections by "## 📄" heading
  const sections = markdown.split(/(?=## 📄 )/g).filter(s => s.trim().startsWith('## 📄'));
  if (sections.length === 0) {
    // fallback: render raw markdown while streaming
    previewsRendered.innerHTML = parseMarkdown(markdown);
    return;
  }

  previewsRendered.innerHTML = sections.map((section, idx) => {
    // Extract filename (strip surrounding backticks/quotes if present)
    const nameMatch = section.match(/## 📄 (.+)/);
    const filename = nameMatch ? nameMatch[1].replace(/[`'"]/g, '').trim() : `File ${idx + 1}`;

    // Extract changes line
    const changesMatch = section.match(/**Changes:**s*([^
]+)/);
    const changes = changesMatch ? changesMatch[1].trim() : '';

    // Extract ORIGINAL code block
    const origMatch = section.match(/### ORIGINALs*
```[^
]*
([sS]*?)
```/);
    const origCode = origMatch ? origMatch[1] : '';

    // Extract MIGRATED code block
    const migMatch = section.match(/### MIGRATEDs*
```[^
]*
([sS]*?)
```/);
    const migCode = migMatch ? migMatch[1] : '';

    // If MIGRATED not parsed yet (still streaming), show partial with raw
    if (!migCode && !origCode) {
      return `<div class="preview-file-card">
        <div class="preview-file-header">
          <span class="preview-file-name">${escapeHtml(filename)}</span>
          ${changes ? `<span class="preview-file-changes">${escapeHtml(changes)}</span>` : ''}
        </div>
        <pre class="preview-code">${escapeHtml(section.replace(/## 📄[^
]*
/, '').replace(/**Changes:**[^
]*
/, ''))}</pre>
      </div>`;
    }

    const cardId = `preview-${idx}`;
    const diffHtml = origCode && migCode ? buildDiff(origCode, migCode) : '';

    return `<div class="preview-file-card">
      <div class="preview-file-header" onclick="togglePreviewCard('${cardId}')">
        <div>
          <span class="preview-file-name">📄 ${escapeHtml(filename)}</span>
          ${changes ? `<div class="preview-file-changes">${escapeHtml(changes)}</div>` : ''}
        </div>
        <div class="preview-file-actions">
          <button class="copy-btn" onclick="copyMigrated(event,${idx})">Copy migrated</button>
          <span style="font-size:11px;opacity:0.5">▼</span>
        </div>
      </div>
      <div id="${cardId}">
        <div class="preview-tabs">
          <button class="preview-tab active" onclick="switchPreviewTab(event,'${cardId}','orig')">Original</button>
          <button class="preview-tab" onclick="switchPreviewTab(event,'${cardId}','mig')">Migrated</button>
          ${diffHtml ? `<button class="preview-tab" onclick="switchPreviewTab(event,'${cardId}','diff')">Diff</button>` : ''}
        </div>
        <div class="preview-pane active" id="${cardId}-orig"><pre class="preview-code">${escapeHtml(origCode || '(not available)')}</pre></div>
        <div class="preview-pane" id="${cardId}-mig"><pre class="preview-code">${escapeHtml(migCode || '(still generating…)')}</pre></div>
        ${diffHtml ? `<div class="preview-pane" id="${cardId}-diff"><pre class="preview-code">${diffHtml}</pre></div>` : ''}
      </div>
    </div>`;
  }).join('');

  // Store migrated code blocks for copy buttons
  window._previewMigratedCode = sections.map(section => {
    const m = section.match(/### MIGRATEDs*
```[^
]*
([sS]*?)
```/);
    return m ? m[1] : '';
  });
}

function buildDiff(original, migrated) {
  const origLines = original.split('\n');
  const migLines  = migrated.split('\n');
  const maxLen = Math.max(origLines.length, migLines.length);
  let html = '';
  for (let i = 0; i < maxLen; i++) {
    const o = origLines[i];
    const m = migLines[i];
    if (o === undefined) {
      html += `<span class="diff-add">+${escapeHtml(m)}\n</span>`;
    } else if (m === undefined) {
      html += `<span class="diff-remove">-${escapeHtml(o)}\n</span>`;
    } else if (o !== m) {
      html += `<span class="diff-remove">-${escapeHtml(o)}\n</span><span class="diff-add">+${escapeHtml(m)}\n</span>`;
    } else {
      html += escapeHtml(o) + '\n';
    }
  }
  return html;
}

function switchPreviewTab(event, cardId, pane) {
  event.stopPropagation();
  const card = document.getElementById(cardId);
  if (!card) { return; }
  card.querySelectorAll('.preview-tab').forEach(t => t.classList.remove('active'));
  card.querySelectorAll('.preview-pane').forEach(p => p.classList.remove('active'));
  event.target.classList.add('active');
  const paneEl = document.getElementById(`${cardId}-${pane}`);
  if (paneEl) { paneEl.classList.add('active'); }
}

function togglePreviewCard(cardId) {
  const card = document.getElementById(cardId);
  if (card) { card.style.display = card.style.display === 'none' ? '' : 'none'; }
}

function copyMigrated(event, idx) {
  event.stopPropagation();
  const code = window._previewMigratedCode?.[idx] || '';
  if (!code) { return; }
  navigator.clipboard.writeText(code).then(() => {
    const btn = event.target;
    btn.textContent = 'Copied!';
    setTimeout(() => { btn.textContent = 'Copy migrated'; }, 2000);
  });
}

function escapeHtml(str) {
  return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function showInfoMsg(text) {
  errorBox.className = 'msg-info';
  errorBox.textContent = text;
  errorBox.style.display = 'block';
  setTimeout(() => { errorBox.style.display = 'none'; }, 6000);
}

function showError(msg) {
  errorBox.className = 'msg-error';
  errorBox.textContent = msg;
  errorBox.style.display = 'block';
}
function hideError() {
  errorBox.style.display = 'none';
}

function startGeneration() {
  isGenerating = true;
  btnGenerate.disabled = true;
  btnStop.style.display = 'flex';
  genIndicator.style.display = 'flex';
  planMarkdown = '';
  showPlanContainer();
}

function stopGeneration(cancelled) {
  isGenerating = false;
  btnGenerate.disabled = false;
  btnStop.style.display = 'none';
  genIndicator.style.display = 'none';
  if (cancelled && planMarkdown) {
    planMarkdown += '\n\n---\n*Generation stopped.*';
    planRendered.innerHTML = parseMarkdown(planMarkdown);
  }
}

function showPlanContainer() {
  planEmpty.style.display = 'none';
  planContainer.style.display = 'flex';
}

// ─── Security Report (enhancement #11) ────────────────────────────────────────
function renderSecurityReport(analysis) {
  const r = analysis.redactionSummary;
  const lines = [];

  if (r.skippedFiles.length > 0) {
    lines.push('<h4 style="margin:8px 0 4px">🚫 Blocked Files (never fetched)</h4>');
    lines.push('<ul>' + r.skippedFiles.map(f => `<li style="color:var(--vscode-errorForeground)">${escapeHtml(f)}</li>`).join('') + '</ul>');
  } else {
    lines.push('<p style="color:var(--vscode-testing-iconPassed,#4caf50)">✅ No blocked files matched.</p>');
  }

  if (r.filesWithSecrets.length > 0) {
    lines.push('<h4 style="margin:12px 0 4px">🔐 Secrets Redacted</h4>');
    lines.push(`<p>Total redactions: <strong>${r.totalRedactions}</strong></p>`);
    lines.push('<ul>' + r.filesWithSecrets.map(f => `<li>${escapeHtml(f)}</li>`).join('') + '</ul>');
  } else {
    lines.push('<p style="color:var(--vscode-testing-iconPassed,#4caf50);margin-top:12px">✅ No secrets detected in fetched files.</p>');
  }

  lines.push('<h4 style="margin:12px 0 4px">📁 Files Analyzed</h4>');
  const fileRows = analysis.keyFiles.map(f =>
    `<tr><td>${escapeHtml(f.path)}</td><td>${escapeHtml(f.type)}</td><td>${f.redactedCount > 0 ? `<span style="color:var(--vscode-errorForeground)">${f.redactedCount} redacted</span>` : '✅ clean'}</td></tr>`
  ).join('');
  lines.push(`<table style="width:100%;border-collapse:collapse;font-size:11px">
    <thead><tr><th style="text-align:left;padding:4px;border-bottom:1px solid var(--vscode-panel-border)">File</th><th style="padding:4px;border-bottom:1px solid var(--vscode-panel-border)">Type</th><th style="padding:4px;border-bottom:1px solid var(--vscode-panel-border)">Status</th></tr></thead>
    <tbody>${fileRows}</tbody></table>`);

  securityContent.innerHTML = lines.join('');
  securityEmpty.style.display = 'none';
  securityReport.style.display = 'block';
}

// ─── History Render (enhancement #9) ──────────────────────────────────────────
function renderHistory(entries) {
  if (!entries || entries.length === 0) {
    historyList.innerHTML = '<div style="font-size:11px;color:var(--vscode-descriptionForeground)">No history yet.</div>';
    return;
  }
  historyList.innerHTML = entries.map(e => {
    const ago = formatAgo(e.timestamp);
    return `<div style="display:flex;flex-direction:column;gap:2px;padding:6px 8px;background:var(--vscode-editor-inactiveSelectionBackground);border-radius:4px;font-size:11px">
      <div style="display:flex;justify-content:space-between;align-items:center">
        <strong style="word-break:break-all">${escapeHtml(e.repo)}</strong>
        <button onclick="removeHistory('${e.id}')" style="background:none;border:none;color:var(--vscode-descriptionForeground);cursor:pointer;font-size:11px;padding:0 2px" title="Remove">✕</button>
      </div>
      <div style="color:var(--vscode-descriptionForeground)">${escapeHtml(e.targetStack)}</div>
      <div style="display:flex;justify-content:space-between;align-items:center;margin-top:2px">
        <span style="opacity:0.6">${ago}</span>
        <button onclick="loadHistory('${e.id}')" class="copy-btn" style="font-size:10px">Load</button>
      </div>
    </div>`;
  }).join('');
}

function loadHistory(id) {
  vscode.postMessage({ type: 'loadFromHistory', historyId: id });
}
function removeHistory(id) {
  vscode.postMessage({ type: 'removeFromHistory', historyId: id });
}
function formatAgo(ts) {
  const diff = Date.now() - ts;
  const m = Math.floor(diff / 60000);
  if (m < 1) { return 'just now'; }
  if (m < 60) { return `${m}m ago`; }
  const h = Math.floor(m / 60);
  if (h < 24) { return `${h}h ago`; }
  return `${Math.floor(h / 24)}d ago`;
}

// ─── Org Dashboard Render (enhancement #7) ────────────────────────────────────
function renderOrgDashboard(dashboard) {
  orgSummary.textContent = `${dashboard.org} — ${dashboard.repos.length} of ${dashboard.totalRepos} repos shown`;
  const complexityColor = { Low: '#4caf50', Medium: '#ff9800', High: '#f44336', Unknown: '#9e9e9e' };
  orgTbody.innerHTML = dashboard.repos.map(r => `
    <tr style="border-bottom:1px solid var(--vscode-panel-border)">
      <td style="padding:6px 8px">
        <strong>${escapeHtml(r.name)}</strong>
        ${r.description ? `<br><span style="font-size:10px;opacity:0.7">${escapeHtml(r.description.slice(0,60))}</span>` : ''}
      </td>
      <td style="padding:6px 8px;text-align:center">${escapeHtml(r.language)}</td>
      <td style="padding:6px 8px;text-align:center">${escapeHtml(r.detectedStack || '?')}</td>
      <td style="padding:6px 8px;text-align:center">⭐ ${r.stars}</td>
      <td style="padding:6px 8px;text-align:center">
        <span style="color:${complexityColor[r.complexity] || '#9e9e9e'};font-weight:600">${r.complexity}</span>
      </td>
      <td style="padding:6px 8px;text-align:center">
        <button class="copy-btn" onclick="analyzeOrgRepo('${escapeHtml(r.fullName)}','${escapeHtml(dashboard.hostname)}')">Analyze</button>
      </td>
    </tr>`).join('');
  orgEmpty.style.display = 'none';
  orgTableWrap.style.display = 'block';
}

function analyzeOrgRepo(fullName, hostname) {
  const url = `https://${hostname}/${fullName}`;
  inputRepo.value = url;
  // Switch to main sidebar and trigger analysis
  document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
  document.querySelectorAll('.tab-content').forEach(t => t.classList.remove('active'));
  document.querySelector('[data-tab="plan"]').classList.add('active');
  document.getElementById('tab-plan').classList.add('active');
  btnAnalyze.click();
}

function renderStack(analysis) {
  const s = analysis.detectedStack;
  const info = analysis.repoInfo;
  stackCard.innerHTML = [
    row('Repo', `${info.owner}/${info.repo}`),
    row('Language', s.primaryLanguage),
    row('Runtime', s.currentVersion || s.runtime),
    row('Framework', s.framework),
    row('Build Tool', s.buildTool),
    row('Pkg Manager', s.packageManager),
    row('CI/CD', s.ciSystem),
    row('Docker', s.containerized ? '✅ Yes' : '❌ No'),
    s.databases.length ? row('Databases', s.databases.join(', ')) : '',
    s.testingFrameworks.length ? row('Tests', s.testingFrameworks.join(', ')) : '',
    row('Files', analysis.totalFiles.toLocaleString()),
    row('Stars', '⭐ ' + info.stars.toLocaleString()),
  ].filter(Boolean).join('');
  stackSection.style.display = 'block';
}

function row(key, val) {
  return `<div class="stack-row"><span class="stack-key">${key}</span><span class="stack-val">${escapeHtml(String(val))}</span></div>`;
}

function showStackLoading(show) {
  stackAiLoading.style.display = show ? 'block' : 'none';
}

function renderAIStack(ai, analysis) {
  const info = analysis?.repoInfo || {};
  stackCard.innerHTML = [
    info.owner ? row('Repo', `${info.owner}/${info.repo}`) : '',
    row('Language',    ai.primaryLanguage),
    row('Runtime',     ai.currentVersion || ai.runtime),
    row('Framework',   ai.framework),
    row('Build Tool',  ai.buildTool),
    row('Pkg Manager', ai.packageManager),
    row('CI/CD',       ai.ciSystem || 'None'),
    row('Docker',      ai.containerized ? '✅ Yes' : '❌ No'),
    ai.databases?.length        ? row('Databases', ai.databases.join(', '))         : '',
    ai.testingFrameworks?.length ? row('Tests',    ai.testingFrameworks.join(', '))  : '',
    info.totalFiles ? row('Files', info.totalFiles.toLocaleString()) : '',
    info.stars !== undefined ? row('Stars', '⭐ ' + info.stars.toLocaleString()) : '',
    ai.insights ? `<div class="stack-row" style="flex-direction:column;gap:2px">
      <span class="stack-key" style="margin-bottom:2px">AI Insights</span>
      <span class="stack-val" style="text-align:left;font-weight:400;opacity:0.85;font-size:10.5px">${escapeHtml(ai.insights)}</span>
    </div>` : '',
  ].filter(Boolean).join('');
  // Mark card as AI-enriched with a subtle badge
  stackCard.style.position = 'relative';
  const badge = document.createElement('div');
  badge.style.cssText = 'position:absolute;top:6px;right:8px;font-size:9px;font-weight:700;padding:1px 5px;border-radius:6px;background:var(--vscode-badge-background);color:var(--vscode-badge-foreground);opacity:0.8';
  badge.textContent = '✨ AI';
  stackCard.appendChild(badge);
}

function renderFileTree(analysis) {
  filesHeader.textContent = `${analysis.totalFiles} files in ${analysis.repoInfo.owner}/${analysis.repoInfo.repo} (${analysis.repoInfo.defaultBranch})`;
  fileTreeCont.innerHTML = analysis.fileTree
    .slice(0, 200)
    .map(f => `<div>${escapeHtml(f)}</div>`)
    .join('');
  if (analysis.totalFiles > 200) {
    fileTreeCont.innerHTML += `<div style="opacity:0.5;margin-top:8px">… and ${analysis.totalFiles - 200} more files</div>`;
  }
  filesEmpty.style.display = 'none';
  filesContainer.style.display = 'block';
}

// escapeHtml defined earlier — no duplicate needed

// ─── Line-by-line Markdown Parser ────────────────────────────────────────────
function parseMarkdown(md) {
  var lines = md.split('\n');
  var out = [];
  var i = 0;
  var inUl = false, inOl = false, isChecklist = false;

  function flushList() {
    if (inUl) { out.push(isChecklist ? '</ul>' : '</ul>'); inUl = false; isChecklist = false; }
    if (inOl) { out.push('</ol>'); inOl = false; }
  }

  function esc(s) {
    return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  function inline(s) {
    s = s.replace(/`([^`\n]+)`/g, '<code>$1</code>');
    s = s.replace(/\*\*\*([^*]+)\*\*\*/g, '<strong><em>$1</em></strong>');
    s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    s = s.replace(/__([^_\n]+)__/g, '<strong>$1</strong>');
    s = s.replace(/\*([^*\n]+)\*/g, '<em>$1</em>');
    s = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');
    return s;
  }

  function isBlockLine(ln) {
    return /^\s*$/.test(ln) || /^#+\s/.test(ln) || /^> /.test(ln) ||
           /^```/.test(ln) || /^\|/.test(ln) ||
           /^[\-*+] /.test(ln) || /^\d+[.)]\s/.test(ln) || /^[\-*_]{3,}\s*$/.test(ln);
  }

  while (i < lines.length) {
    var line = lines[i];

    // ── Fenced code block ────────────────────────────────────────────────────
    if (/^```/.test(line)) {
      flushList();
      var lang = line.replace(/^```/, '').trim() || 'code';
      var codeAcc = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i])) { codeAcc.push(lines[i]); i++; }
      i++; // closing fence
      out.push(
        '<div class="code-wrap">' +
        '<div class="code-label">' + esc(lang) + '</div>' +
        '<pre><code>' + esc(codeAcc.join('\n')) + '</code></pre>' +
        '</div>'
      );
      continue;
    }

    // ── Table (lines starting with |) ────────────────────────────────────────
    if (/^\|/.test(line)) {
      flushList();
      var tRows = [];
      while (i < lines.length && /^\|/.test(lines[i])) { tRows.push(lines[i]); i++; }
      var sepIdx = -1;
      for (var ti = 0; ti < tRows.length; ti++) {
        if (/^\|[\s\-:|]+\|/.test(tRows[ti])) { sepIdx = ti; break; }
      }
      var hRows = sepIdx > 0 ? tRows.slice(0, sepIdx) : [tRows[0]];
      var bRows = tRows.slice(sepIdx >= 0 ? sepIdx + 1 : 1);
      var thead = '<thead>' + hRows.map(function(r) {
        return '<tr>' + r.split('|').slice(1,-1).map(function(c) {
          return '<th>' + inline(esc(c.trim())) + '</th>';
        }).join('') + '</tr>';
      }).join('') + '</thead>';
      var tbody = '<tbody>' + bRows.map(function(r) {
        return '<tr>' + r.split('|').slice(1,-1).map(function(c) {
          return '<td>' + inline(esc(c.trim())) + '</td>';
        }).join('') + '</tr>';
      }).join('') + '</tbody>';
      out.push('<div class="table-wrap"><table>' + thead + tbody + '</table></div>');
      continue;
    }

    // ── Headings ─────────────────────────────────────────────────────────────
    var hm = line.match(/^(#{1,6})\s+(.*)/);
    if (hm) {
      flushList();
      var hl = Math.min(hm[1].length, 6);
      out.push('<h' + hl + '>' + inline(esc(hm[2])) + '</h' + hl + '>');
      i++; continue;
    }

    // ── Horizontal rule ──────────────────────────────────────────────────────
    if (/^[\-*_]{3,}\s*$/.test(line)) {
      flushList(); out.push('<hr>'); i++; continue;
    }

    // ── Blockquote ───────────────────────────────────────────────────────────
    if (/^> /.test(line)) {
      flushList();
      var bqAcc = [];
      while (i < lines.length && /^> /.test(lines[i])) {
        bqAcc.push(inline(esc(lines[i].slice(2)))); i++;
      }
      out.push('<blockquote>' + bqAcc.join('<br>') + '</blockquote>');
      continue;
    }

    // ── Checklist ────────────────────────────────────────────────────────────
    if (/^- \[[ xX]\] /.test(line)) {
      if (!inUl || !isChecklist) { flushList(); out.push('<ul class="checklist">'); inUl = true; isChecklist = true; }
      var chk = (line[3] === 'x' || line[3] === 'X');
      out.push('<li><input type="checkbox"' + (chk ? ' checked' : '') + ' disabled> ' + inline(esc(line.slice(6))) + '</li>');
      i++; continue;
    }

    // ── Unordered list ───────────────────────────────────────────────────────
    if (/^(\s*)[\-*+] /.test(line)) {
      var ulm = line.match(/^(\s*)[\-*+] (.*)/);
      if (inOl || isChecklist) { flushList(); }
      if (!inUl) { out.push('<ul>'); inUl = true; }
      var ulIndent = ulm[1].length;
      out.push('<li style="margin-left:' + (ulIndent * 8) + 'px">' + inline(esc(ulm[2])) + '</li>');
      i++; continue;
    }

    // ── Ordered list ─────────────────────────────────────────────────────────
    if (/^\d+[.)]\s/.test(line)) {
      var olm = line.match(/^\d+[.)]\s+(.*)/);
      if (inUl) { flushList(); }
      if (!inOl) { out.push('<ol>'); inOl = true; }
      out.push('<li>' + inline(esc(olm ? olm[1] : line)) + '</li>');
      i++; continue;
    }

    // ── Empty line ───────────────────────────────────────────────────────────
    if (/^\s*$/.test(line)) { flushList(); i++; continue; }

    // ── Paragraph (accumulate consecutive non-block lines) ───────────────────
    flushList();
    var pLines = [];
    while (i < lines.length && !isBlockLine(lines[i])) {
      pLines.push(inline(esc(lines[i]))); i++;
    }
    if (pLines.length) { out.push('<p>' + pLines.join('<br>') + '</p>'); }
  }

  flushList();
  return out.join('\n');
}

// ─── Init ─────────────────────────────────────────────────────────────────────
vscode.postMessage({ type: 'ready' });

// Enter key on repo URL
inputRepo.addEventListener('keydown', e => {
  if (e.key === 'Enter') { btnAnalyze.click(); }
});
