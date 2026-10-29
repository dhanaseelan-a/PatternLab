/* PatternLab — Vanilla JavaScript, browser-only PDF password recovery.
   PDF.js is loaded only when Start is clicked. No PDF bytes are uploaded. */
(() => {
  "use strict";
  const PDF_JS_URL = "https://cdn.jsdelivr.net/npm/pdfjs-dist@6.4.299/build/pdf.min.mjs";
  const PDF_WORKER_URL = "https://cdn.jsdelivr.net/npm/pdfjs-dist@6.4.299/build/pdf.worker.min.mjs";
  // Keep the v3 key so verified v3 checkpoints remain resumable in v4.
  const CHECKPOINT_KEY = "patternlab-v3-checkpoint";
  const PURGE_MARKER_KEY = "patternlab-v4-cleanup-pending";
  const DB_NAME = "patternlab-v4-private";
  const DB_STORE = "documents";
  const STORED_FILE_ID = "remembered-pdf";
  const MAX_SAVED_LOGS = 4000; // Rolling, bounded in-memory log; never store passwords persistently.
  const FAST_SAMPLE_INTERVAL = 1000;
  const CHECKPOINT_EVERY_ATTEMPTS = 250n;
  const CHECKPOINT_INTERVAL_MS = 2000;
  const MAX_VISIBLE_LOGS = 90;
  const $ = (id) => document.getElementById(id);
  const ui = Object.fromEntries([
    "file-input", "dropzone", "file-name", "file-meta", "min-length", "max-length",
    "prefix", "suffix", "middle-value", "middle-position", "set-digits", "set-lower", "set-upper", "log-mode", "warning-threshold", "save-progress", "large-warning", "checkpoint-hint", "clear-checkpoint",
    "remember-pdf", "remember-hint", "forget-pdf", "clear-all",
    "mask-list", "validation-message", "candidate-total",
    "start-btn", "pause-btn", "resume-btn", "stop-btn", "state-pill", "state-label",
    "percent-label", "progress-fill", "checked-label", "total-label", "elapsed-label",
    "rate-label", "length-label", "current-password", "attempt-result", "active-hint",
    "success-panel", "found-password", "copy-password", "download-log", "terminal", "log-caption", "toast"
  ].map((id) => [id.replaceAll("-", "_"), $(id)]));

  let selectedFile = null;
  let masks = new Map();
  let maskErrors = new Map();
  let pdfjsLib = null;
  let currentRun = null;
  let sequenceNumber = 0;
  let toastTimer = null;
  let rememberedRecord = null; // Opt-in local record includes a PDF Blob and pattern settings.
  let storageReady = false;
  let storageDbPromise = null;

  function openPrivateDB() {
    if (!('indexedDB' in window)) return Promise.reject(new Error('IndexedDB unavailable'));
    if (!storageDbPromise) {
      storageDbPromise = new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, 1);
        request.onupgradeneeded = () => {
          const db = request.result;
          if (!db.objectStoreNames.contains(DB_STORE)) db.createObjectStore(DB_STORE);
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error ?? new Error('IndexedDB open failed'));
        request.onblocked = () => reject(new Error('IndexedDB blocked by another tab'));
      }).catch(error => {storageDbPromise = null; throw error;});
    }
    return storageDbPromise;
  }
  async function dbOperation(mode, perform) {
    const db = await openPrivateDB();
    return new Promise((resolve, reject) => {
      let outcome;
      const tx = db.transaction(DB_STORE, mode);
      const store = tx.objectStore(DB_STORE);
      try { outcome = perform(store); }
      catch (error) { reject(error); return; }
      tx.oncomplete = () => resolve(outcome?.result);
      tx.onerror = () => reject(tx.error ?? new Error('Browser storage operation failed'));
      tx.onabort = () => reject(tx.error ?? new Error('Browser storage aborted'));
    });
  }
  const readRemembered = () => dbOperation('readonly', store => store.get(STORED_FILE_ID));
  const saveRemembered = (record) => dbOperation('readwrite', store => store.put(record, STORED_FILE_ID));
  const deleteRemembered = () => dbOperation('readwrite', store => store.delete(STORED_FILE_ID));

  function updateRememberUI(message = '') {
    ui.remember_hint.textContent = message || (rememberedRecord
      ? `Stored locally: ${rememberedRecord.name} (${(rememberedRecord.size / 1024 / 1024).toFixed(2)} MB). Only one PDF is retained.`
      : 'No PDF is stored in the browser. Remember PDF is OFF by default.');
    ui.forget_pdf.disabled = isBusy() || !rememberedRecord;
    ui.clear_all.disabled = isBusy();
  }
  async function forgetSavedPdf(showMessage = true) {
    try {
      await deleteRemembered();
      rememberedRecord = null;
      ui.remember_pdf.checked = false;
      updateRememberUI('Stored PDF removed from this browser.');
      if (showMessage) showToast('Remembered PDF removed.');
      return true;
    } catch (error) {
      updateRememberUI('Could not remove saved PDF. Check browser storage permissions.');
      if (showMessage) showToast(`Storage cleanup failed: ${error.message}`);
      return false;
    }
  }
  function captureSearchSettings() {
    return {
      min: ui.min_length.value, max: ui.max_length.value,
      prefix: ui.prefix.value, suffix: ui.suffix.value,
      middle: ui.middle_value.value, middlePosition: ui.middle_position.value,
      digits: ui.set_digits.checked, lower: ui.set_lower.checked, upper: ui.set_upper.checked,
      logMode: ui.log_mode.value, warn: ui.warning_threshold.value,
      masks: [...masks.entries()].map(([length,mask]) => [length,mask])
    };
  }
  function restoreSearchSettings(settings) {
    if (!settings || typeof settings !== 'object') return;
    const value = (v) => typeof v === 'string' ? v : '';
    ui.min_length.value = value(settings.min) || '8';
    ui.max_length.value = value(settings.max) || '10';
    ui.prefix.value = value(settings.prefix).slice(0,128);
    ui.suffix.value = value(settings.suffix).slice(0,128);
    ui.middle_value.value = value(settings.middle).slice(0,128);
    ui.middle_position.value = value(settings.middlePosition) || '1';
    ui.set_digits.checked = !!settings.digits;
    ui.set_lower.checked = !!settings.lower;
    ui.set_upper.checked = !!settings.upper;
    ui.log_mode.value = settings.logMode === 'detailed' ? 'detailed' : 'fast';
    if ([...ui.warning_threshold.options].some(x => x.value === settings.warn)) ui.warning_threshold.value = settings.warn;
    buildMasks();
    const savedMasks = new Map(Array.isArray(settings.masks) ? settings.masks : []);
    for (const input of ui.mask_list.querySelectorAll('.mask-input')) {
      const length = Number(input.parentElement.querySelector('.mask-count').dataset.length);
      const mask = savedMasks.get(length);
      if (typeof mask === 'string' && mask.length <= 128) {
        input.value = mask;
        masks.set(length, mask);
        maskErrors.delete(length);
      }
    }
    validate();
  }
  async function restoreRememberedOnOpen() {
    try {
      // A page can be closed before async deletion completes after success.
      // Finish the scheduled cleanup before considering any auto-restore.
      let pendingPurge = false;
      try { pendingPurge = localStorage.getItem(PURGE_MARKER_KEY) === '1'; } catch {}
      if (pendingPurge) {
        await deleteRemembered();
        try { localStorage.removeItem(PURGE_MARKER_KEY); } catch {}
      }
      const record = await readRemembered();
      storageReady = true;
      if (record && record.blob instanceof Blob && typeof record.name === 'string') {
        rememberedRecord = record;
        ui.remember_pdf.checked = true;
        ui.save_progress.checked = true;
        const file = new File([record.blob], record.name, {
          type: 'application/pdf', lastModified: record.lastModified || Date.now()
        });
        if (!selectedFile && !isBusy()) {
          await setFile(file, true);
          restoreSearchSettings(record.searchSettings);
          showToast('PDF and search pattern restored locally. Ready to resume.');
        }
      }
      updateRememberUI();
    } catch (error) {
      storageReady = true;
      ui.remember_pdf.checked = false;
      updateRememberUI('Browser PDF storage unavailable; you can still recover using a selected file.');
    }
  }
  async function rememberSelectedFile(file, fileHash) {
    if (!ui.remember_pdf.checked) return;
    const searchSettings = captureSearchSettings();
    const record = {blob: file, name: file.name, size: file.size,
      lastModified: file.lastModified, fileHash, searchSettings, savedAt: Date.now()};
    if (rememberedRecord?.fileHash === fileHash &&
      JSON.stringify(rememberedRecord.searchSettings) === JSON.stringify(searchSettings)) return;
    if (rememberedRecord && rememberedRecord.fileHash !== fileHash) {
      if (!window.confirm(`Another PDF (${rememberedRecord.name}) is stored locally. Replace that saved copy with ${file.name}?`)) {
        throw new Error('Canceled: previous stored PDF was preserved.');
      }
    }
    try {
      await saveRemembered(record);
      rememberedRecord = record;
      updateRememberUI();
    } catch (error) {
      ui.remember_pdf.checked = false;
      showToast(`Could not remember PDF (storage unavailable or full): ${error.message}`);
      updateRememberUI('PDF was not saved. Select it again after reopening the browser.');
    }
  }
  async function clearAllData() {
    if (isBusy()) return;
    if (!window.confirm('Delete the saved PDF, checkpoint, and current recovery session from this browser?')) return;
    const cleared = await forgetSavedPdf(false);
    if (!cleared) return; // Never claim cleanup if IndexedDB removal failed.
    safeStorage.clear();
    try { localStorage.removeItem(PURGE_MARKER_KEY); } catch {}
    currentRun = null;
    selectedFile = null;
    ui.file_input.value = '';
    ui.file_name.textContent = 'Choose or drop a PDF';
    ui.file_meta.textContent = 'Only your browser reads the file';
    ui.prefix.value = '';
    ui.suffix.value = '';
    ui.middle_value.value = '';
    ui.middle_position.value = '1';
    ui.min_length.value = '8';
    ui.max_length.value = '10';
    ui.set_digits.checked = true;
    ui.set_lower.checked = false;
    ui.set_upper.checked = false;
    ui.log_mode.value = 'fast';
    buildMasks();
    ui.success_panel.hidden = true;
    ui.found_password.textContent = '—';
    ui.terminal.replaceChildren();
    ui.current_password.textContent = '— — — — — —';
    ui.attempt_result.textContent = '—';
    ui.checked_label.textContent = '0';
    ui.percent_label.textContent = '0.00%';
    ui.progress_fill.style.width = '0%';
    ui.elapsed_label.textContent = '00:00';
    ui.rate_label.textContent = '—';
    ui.length_label.textContent = '—';
    ui.active_hint.textContent = 'Waiting for a PDF and a search pattern.';
    ui.download_log.disabled = true;
    ui.log_caption.textContent = 'Attempt log cleared.';
    setStatus('idle','READY');
    refreshCheckpointHint();
    validate();
    controls(null);
    showToast('Local recovery data cleared.');
  }

  const fmt = (value) => (typeof value === "bigint" ? value : BigInt(value)).toLocaleString("en-US");
  const safeStorage = {
    read() { try { return JSON.parse(localStorage.getItem(CHECKPOINT_KEY)); } catch { return null; } },
    write(data) { try { localStorage.setItem(CHECKPOINT_KEY, JSON.stringify(data)); return true; } catch { return false; } },
    clear() { try { localStorage.removeItem(CHECKPOINT_KEY); return true; } catch { return false; } }
  };
  async function sha256(value) {
    if (!globalThis.crypto?.subtle) throw new Error("Checkpoint requires HTTPS or localhost (Web Crypto unavailable).");
    const input = value instanceof ArrayBuffer ? value : new TextEncoder().encode(value);
    const hash = await crypto.subtle.digest("SHA-256", input);
    return [...new Uint8Array(hash)].map(x => x.toString(16).padStart(2,"0")).join("");
  }
  function refreshCheckpointHint(message) {
    const checkpoint = safeStorage.read();
    ui.checkpoint_hint.textContent = message || (checkpoint
      ? `Saved checkpoint available: ${fmt(BigInt(checkpoint.checked || "0"))} verified attempts. Remembered PDFs and patterns restore automatically; otherwise reselect your PDF and enter the same pattern.`
      : "No saved recovery checkpoint. Enable checkpoint saving to resume after a page reload.");
    ui.clear_checkpoint.disabled = isBusy() || !checkpoint;
  }
  function clearCheckpoint() {
    if (isBusy()) return;
    safeStorage.clear();
    refreshCheckpointHint("Saved progress cleared. New searches will start at the first candidate.");
    showToast("Saved checkpoint cleared.");
  }
  function restoreProgress(run, checked) {
    run.tested = checked;
    run.startedAtCount = checked;
    let remaining = checked;
    for (const p of run.patterns) {
      p.next = remaining < p.count ? remaining : p.count;
      remaining -= p.next;
    }
    run.patternIndex = run.patterns.findIndex(p => p.next < p.count);
    if (run.patternIndex < 0) run.patternIndex = run.patterns.length;
  }
  function checkpoint(run, force = false) {
    if (!run || !run.saveProgress || !run.fileHash || !run.configHash) return;
    if (!force && run.tested - run.lastCheckpointCount < CHECKPOINT_EVERY_ATTEMPTS &&
        now() - run.lastCheckpointTime < CHECKPOINT_INTERVAL_MS) return;
    const ok = safeStorage.write({version: 4, fileHash: run.fileHash, configHash: run.configHash,
      checked: run.tested.toString(), savedAt: Date.now()});
    if (ok) { run.lastCheckpointCount = run.tested; run.lastCheckpointTime = now(); }
    else if (!run.warnedStorage) {
      run.warnedStorage = true;
      showToast("Browser storage unavailable; progress cannot persist after closing the tab.");
    }
  }
  function warnLargeSearch(config) {
    const choice = ui.warning_threshold.value;
    const threshold = choice === "off" ? null : BigInt(choice);
    const huge = !!config && threshold !== null && config.total > threshold;
    ui.large_warning.hidden = !huge;
    if (huge) ui.large_warning.textContent = `Large search: ${fmt(config.total)} candidates. No hard limit applies, but this may take a very long time or drain your device battery. You will be asked to confirm before starting.`;
    return huge;
  }
  const cleanKnown = (value) => value.replace(/[^0-9a-zA-Z]/g, "");
  const maskValid = (mask, length) => mask.length === length && /^[0-9a-zA-Z?]+$/.test(mask);
  const alphabet = () => (ui.set_digits.checked ? "0123456789" : "") +
    (ui.set_lower.checked ? "abcdefghijklmnopqrstuvwxyz" : "") +
    (ui.set_upper.checked ? "ABCDEFGHIJKLMNOPQRSTUVWXYZ" : "");
  const now = () => performance.now();
  const mmss = (ms) => {
    const seconds = Math.floor(ms / 1000);
    return `${Math.floor(seconds / 60).toString().padStart(2, "0")}:${(seconds % 60).toString().padStart(2, "0")}`;
  };
  function showToast(message) {
    ui.toast.textContent = message;
    ui.toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { ui.toast.hidden = true; }, 3300);
  }
  function setStatus(state, label) {
    ui.state_pill.className = `state-pill ${state}`;
    ui.state_label.textContent = label;
  }
  async function setFile(file, restored = false) {
    if (!file) return;
    if (!(/\.pdf$/i.test(file.name) || file.type === "application/pdf")) {
      showToast("Please choose a PDF file.");
      return;
    }
    if (isBusy()) { showToast("Stop the current search before changing files."); return; }
    if (!restored && rememberedRecord &&
      (file.name !== rememberedRecord.name || file.size !== rememberedRecord.size ||
       file.lastModified !== rememberedRecord.lastModified)) {
      if (!window.confirm('A different PDF is stored in this browser. Delete its saved copy and checkpoint before selecting this new PDF?')) return;
      const wantRemember = ui.remember_pdf.checked;
      if (!await forgetSavedPdf(false)) return;
      ui.remember_pdf.checked = wantRemember;
      safeStorage.clear();
      refreshCheckpointHint();
    }
    selectedFile = file;
    ui.file_name.textContent = file.name;
    ui.file_meta.textContent = `${(file.size / 1024 / 1024).toFixed(2)} MB · ${restored ? 'Restored from this browser' : 'Local file'} · No upload`;
    if (currentRun?.terminal) {
      ui.success_panel.hidden = true;
      ui.found_password.textContent = '—';
    }
    ui.dropzone.classList.remove("dragover");
    validate();
    refreshCheckpointHint();
  }
  function buildMasks() {
    const min = Number(ui.min_length.value);
    const max = Number(ui.max_length.value);
    const prefix = ui.prefix.value;
    const suffix = ui.suffix.value;
    const middle = ui.middle_value.value;
    const middlePosition = Number(ui.middle_position.value);
    masks = new Map();
    maskErrors = new Map();
    ui.mask_list.replaceChildren();
    if (!Number.isInteger(min) || !Number.isInteger(max) || min < 1 || max > 128 || min > max) {
      return validate();
    }
    for (let length = min; length <= max; length++) {
      const chars = Array(length).fill("?");
      function place(value, start, label) {
        if (!value) return;
        if (!Number.isInteger(start) || start < 0 || start + value.length > length) {
          throw new Error(`${length}-character pattern: ${label} cannot fit. Change the position or length range.`);
        }
        for (let i = 0; i < value.length; i++) {
          const pos = start + i;
          if (chars[pos] !== "?") {
            throw new Error(`${length}-character pattern: ${label} conflicts at position ${pos + 1}.`);
          }
          chars[pos] = value[i];
        }
      }
      try {
        place(prefix, 0, "Prefix");
        place(suffix, length - suffix.length, "Suffix");
        if (middle) place(middle, middlePosition - 1, "Middle sequence");
      } catch (error) {
        maskErrors.set(length, error.message);
      }
      const value = chars.join("");
      masks.set(length, value);
      const row = document.createElement("label");
      row.className = "mask-row";
      const lenText = document.createElement("span");
      lenText.className = "mask-len";
      lenText.textContent = `${length} CHARS`;
      const input = document.createElement("input");
      input.className = "mask-input";
      input.type = "text";
      input.autocomplete = "off";
      input.spellcheck = false;
      input.maxLength = 128;
      input.value = value;
      input.setAttribute("aria-label", `${length}-character password pattern`);
      input.addEventListener("input", () => {
        masks.set(length, input.value);
        maskErrors.delete(length); // Manual edits can resolve automatic placement conflicts.
        validate();
      });
      const count = document.createElement("span");
      count.className = "mask-count";
      count.dataset.length = String(length);
      row.append(lenText, input, count);
      ui.mask_list.append(row);
    }
    validate();
  }
  function compile() {
    const min = Number(ui.min_length.value);
    const max = Number(ui.max_length.value);
    if (!Number.isInteger(min) || !Number.isInteger(max) || min < 1 || max > 128 || min > max) {
      throw new Error("Choose a valid password length range (1–128 characters).");
    }
    for (const [length, message] of maskErrors) {
      if (length >= min && length <= max) throw new Error(message);
    }
    const chars = alphabet();
    const compiled = [];
    let total = 0n;
    for (let length = min; length <= max; length++) {
      const mask = masks.get(length) ?? "";
      if (!maskValid(mask, length)) {
        throw new Error(`${length}-character pattern must have exactly ${length} letters, digits or ? characters.`);
      }
      const unknown = [...mask].filter((x) => x === "?").length;
      if (unknown && !chars.length) throw new Error("Enable at least one character set for unknown (?) positions.");
      const count = BigInt(chars.length) ** BigInt(unknown);
      compiled.push({length, mask, unknown, count, next: 0n});
      total += count;
    }
    return {compiled, total, chars};
  }
  function validate() {
    let validationError = null;
    let config = null;
    try { config = compile(); } catch (error) { validationError = error.message; }
    const chars = alphabet();
    const fields = [...ui.mask_list.querySelectorAll(".mask-input")];
    for (const field of fields) {
      const len = Number(field.parentElement.querySelector(".mask-count").dataset.length);
      const unknown = (field.value.match(/\?/g) || []).length;
      const count = BigInt(chars.length) ** BigInt(unknown);
      const valid = maskValid(field.value, len) && !maskErrors.has(len) && (unknown === 0 || chars.length > 0);
      field.classList.toggle("invalid", !valid);
      field.parentElement.querySelector(".mask-count").textContent = valid ? fmt(count) : "INVALID";
    }
    ui.validation_message.hidden = !validationError;
    ui.validation_message.textContent = validationError ?? "";
    ui.candidate_total.replaceChildren(document.createTextNode(config ? `${fmt(config.total)} ` : "— "));
    const small = document.createElement("small");
    small.textContent = "candidates";
    ui.candidate_total.append(small);
    warnLargeSearch(config);
    if (!isBusy()) {
      ui.total_label.textContent = `/ ${config ? fmt(config.total) : "—"} attempts`;
      ui.start_btn.disabled = !selectedFile || !!validationError;
    }
    return config;
  }
  function candidateFromPattern(pattern, idx, chars) {
    if (pattern.unknown === 0) return pattern.mask;
    // Base-N encoding: selected alphabet controls each unknown slot.
    const base = BigInt(chars.length);
    const slots = Array(pattern.unknown);
    for (let i = slots.length - 1; i >= 0; i--) {
      slots[i] = chars[Number(idx % base)];
      idx = idx / base;
    }
    let pos = 0;
    return pattern.mask.replace(/\?/g, () => slots[pos++]);
  }
  function nextCandidate(run) {
    while (run.patternIndex < run.patterns.length) {
      const p = run.patterns[run.patternIndex];
      if (p.next < p.count) {
        const password = candidateFromPattern(p, p.next, run.chars);
        p.next++;
        return {password, length: p.length};
      }
      run.patternIndex++;
    }
    return null;
  }
  function isBusy() { return !!currentRun && (currentRun.state === "loading" || currentRun.state === "running" || currentRun.state === "paused"); }
  function controls(run) {
    const state = run?.state;
    ui.pause_btn.disabled = state !== "running";
    ui.resume_btn.disabled = state !== "paused";
    ui.stop_btn.disabled = !["loading", "running", "paused"].includes(state);
    ui.start_btn.disabled = isBusy() || !selectedFile || !validateConfigOnly();
    ui.clear_checkpoint.disabled = isBusy() || !safeStorage.read();
    updateRememberUI();
    const locked = isBusy();
    for (const input of [ui.file_input, ui.min_length, ui.max_length, ui.prefix, ui.suffix, ui.middle_value, ui.middle_position, ui.set_digits, ui.set_lower, ui.set_upper, ui.log_mode, ui.warning_threshold, ui.save_progress, ui.remember_pdf, ...ui.mask_list.querySelectorAll("input")]) input.disabled = locked;
    ui.dropzone.style.pointerEvents = locked ? "none" : "";
    ui.download_log.disabled = !run || run.logsWritten === 0;
  }
  function validateConfigOnly() { try { compile(); return true; } catch { return false; } }
  function appendLog(run, password, outcome) {
    // Logged only AFTER PDF.js rejected or accepted a candidate.
    const shouldLog = run.logMode === "detailed" || run.tested <= 3n || run.tested % BigInt(FAST_SAMPLE_INTERVAL) === 0n || outcome === "FOUND";
    run.lastPassword = password;
    run.lastOutcome = outcome;
    if (outcome === "FOUND") run.foundPassword = password;
    if (!shouldLog) return;
    const line = `Checked ${fmt(run.tested)}/${fmt(run.total)} | Password: ${password} | ${outcome}`;
    run.recent.push({password, outcome, count: fmt(run.tested)});
    if (run.recent.length > MAX_VISIBLE_LOGS) run.recent.shift();
    // Circular buffer: bounded memory and O(1) insertion regardless of search size.
    run.logs[run.logsWritten % MAX_SAVED_LOGS] = line;
    run.logsWritten++;
    run.logRevision++;
  }
  function recentExportLines(run) {
    const length = Math.min(run.logsWritten, MAX_SAVED_LOGS);
    const start = Math.max(0, run.logsWritten - length);
    return Array.from({length}, (_, i) => run.logs[(start + i) % MAX_SAVED_LOGS]);
  }
  function drawRecent(run) {
    if (run.logRevision === run.paintLogRevision) return;
    run.paintLogRevision = run.logRevision;
    const fragment = document.createDocumentFragment();
    for (const entry of run.recent) {
      const line = document.createElement("div");
      line.className = `terminal-line ${entry.outcome.toLowerCase()}`;
      const count = document.createElement("span");
      count.className = "line-count";
      count.textContent = `#${entry.count} `;
      const password = document.createElement("span");
      password.className = "line-pass";
      password.textContent = entry.password;
      const status = document.createElement("span");
      status.className = "line-status";
      status.textContent = `   ${entry.outcome}`;
      line.append(count, password, status);
      fragment.append(line);
    }
    ui.terminal.replaceChildren(fragment);
    ui.terminal.scrollTop = ui.terminal.scrollHeight;
    const sampling = run.logMode === "fast" ? `Fast mode: first 3, every ${FAST_SAMPLE_INTERVAL}th attempt, and matches only. ` : "Detailed mode: each completed attempt. ";
    ui.log_caption.textContent = sampling + `Export contains only the most recent ${fmt(Math.min(run.logsWritten, MAX_SAVED_LOGS))} logged results; older entries are discarded to save memory.`;
    ui.download_log.disabled = run.logsWritten === 0;
  }
  function draw(run, force = false) {
    if (run !== currentRun) return;
    const t = now();
    const paintInterval = run.logMode === "fast" ? 300 : 150;
    if (!force && t - run.lastPaint < paintInterval) return;
    run.lastPaint = t;
    const elapsed = Math.max(1, (run.finishTime ?? t) - run.started);
    // Integer basis points via BigInt: works even for 62^128 without overflow.
    const percentage = run.total > 0n ? Number((run.tested * 10000n) / run.total) / 100 : 0;
    ui.checked_label.textContent = fmt(run.tested);
    ui.total_label.textContent = `/ ${fmt(run.total)} attempts`;
    ui.percent_label.textContent = `${percentage.toFixed(2)}%`;
    ui.progress_fill.style.width = `${percentage}%`;
    ui.elapsed_label.textContent = mmss(elapsed);
    const checkedThisSession = run.tested - run.startedAtCount;
    ui.rate_label.textContent = checkedThisSession > 0n ? `${fmt((checkedThisSession * 1000n) / BigInt(Math.max(1, Math.floor(elapsed))))}/s` : "—";
    ui.length_label.textContent = run.lastPassword ? String(run.lastPassword.length) : "—";
    ui.current_password.textContent = run.lastPassword || "— — — — — —";
    ui.attempt_result.textContent = run.lastOutcome || "—";
    ui.attempt_result.className = `attempt-status ${run.lastOutcome === "FOUND" ? "success" : ""}`;
    ui.active_hint.textContent = run.message;
    drawRecent(run);
  }
  function markAttemptRejected(run) {
    // PDF.js calls onPassword again AFTER it rejects the preceding candidate.
    if (run.inFlight !== null) {
      run.tested += 1n;
      appendLog(run, run.inFlight.password, "WRONG");
      checkpoint(run);
      run.inFlight = null;
      run.message = "Password was rejected by the PDF authentication engine.";
      draw(run);
    }
  }
  function provideNext(run, updatePassword) {
    if (run !== currentRun || !["running", "paused"].includes(run.state)) return;
    if (run.state === "paused") {
      run.pendingUpdatePassword = updatePassword;
      run.message = "Paused safely between password attempts.";
      draw(run, true);
      return;
    }
    const item = nextCandidate(run);
    if (!item) {
      finish(run, "exhausted", "Every candidate was checked; no matching password was found.");
      void run.task?.destroy().catch(() => {});
      return;
    }
    run.inFlight = item;
    run.pendingUpdatePassword = null;
    try { updatePassword(item.password); }
    catch (error) { finish(run, "error", `PDF engine error: ${error.message}`); }
  }
  function onPassword(run, updatePassword) {
    if (run !== currentRun || run.terminal) return;
    markAttemptRejected(run);
    provideNext(run, updatePassword);
  }
  function finish(run, state, message) {
    if (run !== currentRun || run.terminal) return;
    run.state = state;
    run.terminal = true;
    run.finishTime = now();
    run.message = message;
    if (["found", "exhausted", "unencrypted"].includes(state)) {
      // Always discard terminal search checkpoints and opt-in PDF bytes.
      // Leave a recovery marker if the tab is closed before IndexedDB commits deletion.
      safeStorage.clear();
      if (rememberedRecord) {
        try { localStorage.setItem(PURGE_MARKER_KEY, '1'); } catch {}
        void forgetSavedPdf(false).then(ok => {
          if (ok) try { localStorage.removeItem(PURGE_MARKER_KEY); } catch {}
        });
      }
    } else checkpoint(run, true);
    refreshCheckpointHint(["found", "exhausted", "unencrypted"].includes(state)
      ? 'Recovery complete. Checkpoint cleared; stored PDF cleanup requested.' : null);
    const titles = {found:"PASSWORD FOUND",exhausted:"NOT FOUND",stopped:"STOPPED",error:"ERROR",unencrypted:"NOT ENCRYPTED"};
    setStatus(state === "exhausted" ? "stopped" : state, titles[state] ?? state.toUpperCase());
    controls(run);
    draw(run, true);
  }
  async function loadPdfJs() {
    if (pdfjsLib) return pdfjsLib;
    const lib = await import(PDF_JS_URL);
    lib.GlobalWorkerOptions.workerSrc = PDF_WORKER_URL;
    pdfjsLib = lib;
    return lib;
  }
  async function startSearch() {
    if (isBusy()) return;
    const config = validate();
    if (!selectedFile || !config) { showToast("Choose a PDF and valid patterns first."); return; }
    if (warnLargeSearch(config) && !window.confirm(`This search contains ${fmt(config.total)} candidates. It could take days or much longer and consume battery/CPU. Start anyway?`)) return;
    const run = {
      id: ++sequenceNumber, file: selectedFile, patterns: config.compiled, chars: config.chars,
      total: config.total, patternIndex: 0, tested: 0n, startedAtCount: 0n,
      logMode: ui.log_mode.value, saveProgress: ui.save_progress.checked || ui.remember_pdf.checked,
      fileHash: null, configHash: null, lastCheckpointCount: 0n, lastCheckpointTime: 0, warnedStorage: false,
      logRevision: 0, paintLogRevision: -1,
      inFlight: null, pendingUpdatePassword: null, state: "loading", terminal: false,
      logs: new Array(MAX_SAVED_LOGS), logsWritten: 0, recent: [],
      lastPassword: "", lastOutcome: "", message: "Loading PDF verification engine…",
      started: now(), lastPaint: 0, task: null, foundPassword: null
    };
    currentRun = run;
    ui.success_panel.hidden = true;
    setStatus("running", "PREPARING");
    controls(run);
    draw(run, true);
    try {
      const [lib, buffer] = await Promise.all([loadPdfJs(), run.file.arrayBuffer()]);
      if (currentRun !== run || run.terminal) return;
      if (run.saveProgress) {
        try {
          const signature = JSON.stringify({patterns: run.patterns.map(p => p.mask), alphabet: run.chars});
          [run.fileHash, run.configHash] = await Promise.all([sha256(buffer), sha256(signature)]);
          if (currentRun !== run || run.terminal) return;
          const saved = safeStorage.read();
          if (saved && [3, 4].includes(saved.version) && saved.fileHash === run.fileHash && saved.configHash === run.configHash) {
            const checked = BigInt(saved.checked);
            if (checked >= 0n && checked < run.total) {
              restoreProgress(run, checked);
              showToast(`Resuming from ${fmt(checked)} verified attempts.`);
            }
          } else if (saved) {
            if (!window.confirm("A checkpoint for a different PDF or pattern exists. Starting will replace it. Continue?")) {
              run.saveProgress = false;
              finish(run, "stopped", "Search canceled to preserve the existing checkpoint.");
              return;
            }
          }
          // Do not overwrite an old checkpoint until PDF replacement is approved.
        } catch (error) {
          if (/Web Crypto unavailable/.test(String(error))) {
            run.saveProgress = false;
            showToast("Checkpoint unavailable on this browser; testing can still run.");
          } else throw error;
        }
      }
      if (currentRun !== run || run.terminal) return;
      if (ui.remember_pdf.checked) {
        await rememberSelectedFile(run.file, run.fileHash);
        if (currentRun !== run || run.terminal) return;
      }
      checkpoint(run, true);
      if (run.tested === run.total) { finish(run, "exhausted", "Checkpoint was already complete."); return; }
      run.state = "running";
      run.message = run.tested ? `Resumed at candidate ${fmt(run.tested + 1n)}. PDF.js checks every attempt.` : "Opening PDF. Every candidate is submitted to PDF.js for verification.";
      setStatus("running", "SEARCHING");
      controls(run);
      draw(run, true);
      const bytes = new Uint8Array(buffer);
      run.task = lib.getDocument({data: bytes});
      run.task.onPassword = (updatePassword, _reason) => onPassword(run, updatePassword);
      const pdf = await run.task.promise;
      if (run !== currentRun || run.terminal) { await pdf.destroy(); return; }
      if (run.inFlight !== null) {
        // PDF.js resolved the document: the in-flight password was genuinely accepted.
        run.tested += 1n;
        appendLog(run, run.inFlight.password, "FOUND");
        run.inFlight = null;
        ui.found_password.textContent = run.foundPassword;
        ui.success_panel.hidden = false;
        finish(run, "found", `PDF authenticated successfully (${pdf.numPages} page${pdf.numPages === 1 ? "" : "s"}). Copy the password to open the document.`);
      } else {
        finish(run, "unencrypted", `The selected PDF opened without a password (${pdf.numPages} page${pdf.numPages === 1 ? "" : "s"}).`);
      }
      await pdf.destroy();
    } catch (error) {
      if (currentRun !== run || run.terminal) return;
      const explanation = /fetch|network|import|Failed to fetch|dynamically imported/i.test(error?.message ?? "")
        ? "Could not load PDF.js from the CDN. Connect to the internet and retry, or host the PDF.js files locally."
        : `Could not read or authenticate PDF: ${error?.message || error}`;
      finish(run, "error", explanation);
    }
  }
  function pauseSearch() {
    const run = currentRun;
    if (!run || run.state !== "running") return;
    run.state = "paused";
    checkpoint(run, true);
    run.message = "Finishing current authentication, then pausing before the next candidate.";
    setStatus("paused", "PAUSING");
    controls(run);
    draw(run, true);
  }
  function resumeSearch() {
    const run = currentRun;
    if (!run || run.state !== "paused") return;
    run.state = "running";
    run.message = "Resumed: validating candidates against the PDF.";
    setStatus("running", "SEARCHING");
    controls(run);
    const update = run.pendingUpdatePassword;
    if (update) provideNext(run, update);
    draw(run, true);
  }
  function stopSearch() {
    const run = currentRun;
    if (!run || !isBusy()) return;
    finish(run, "stopped", "Search stopped. Start again to resume from the saved verified checkpoint, or clear it to restart.");
    if (run.task) void run.task.destroy().catch(() => {});
  }
  async function copyRecovered() {
    const password = currentRun?.foundPassword;
    if (!password) return;
    try {
      await navigator.clipboard.writeText(password);
      showToast("Recovered password copied.");
    } catch {
      // Clipboard API may be unavailable on file:// and non-HTTPS origins.
      const box = document.createElement("textarea");
      box.value = password;
      box.style.position = "fixed";
      box.style.opacity = "0";
      document.body.append(box);
      box.select();
      const copied = document.execCommand("copy");
      box.remove();
      showToast(copied ? "Recovered password copied." : "Select the password above to copy it.");
    }
  }
  function exportLog() {
    const run = currentRun;
    if (!run || run.logsWritten === 0) return;
    const header = ["PatternLab recovery log", `File: ${run.file.name}`, `Verified: ${fmt(run.tested)}/${fmt(run.total)}`,
      `Status: ${run.state}`, `Log mode: ${run.logMode} (fast mode is sampled)`,
      `Only the latest ${Math.min(run.logsWritten, MAX_SAVED_LOGS)} logged results are kept; older logs were discarded.`, ""];
    const blob = new Blob([header.join("\n"), recentExportLines(run).join("\n"), "\n"], {type: "text/plain;charset=utf-8"});
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "patternlab-attempts.txt";
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1500);
  }
  ui.file_input.addEventListener("change", () => setFile(ui.file_input.files?.[0]));
  ui.dropzone.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") {event.preventDefault(); ui.file_input.click();}
  });
  for (const event of ["dragenter", "dragover"]) ui.dropzone.addEventListener(event, (e) => {e.preventDefault();if(!isBusy()) ui.dropzone.classList.add("dragover");});
  for (const event of ["dragleave", "drop"]) ui.dropzone.addEventListener(event, (e) => {e.preventDefault();ui.dropzone.classList.remove("dragover");});
  ui.dropzone.addEventListener("drop", (e) => {if(!isBusy()) setFile(e.dataTransfer?.files?.[0]);});
  for (const input of [ui.min_length, ui.max_length, ui.prefix, ui.suffix, ui.middle_value, ui.middle_position]) {
    input.addEventListener("input", () => {
      if ([ui.prefix, ui.suffix, ui.middle_value].includes(input)) input.value = cleanKnown(input.value);
      buildMasks();
    });
  }
  for (const input of [ui.set_digits, ui.set_lower, ui.set_upper]) {
    input.addEventListener("change", validate); // Preserve manually edited masks.
  }
  ui.warning_threshold.addEventListener("change", validate);
  ui.clear_checkpoint.addEventListener("click", clearCheckpoint);
  ui.remember_pdf.addEventListener('change', async () => {
    if (ui.remember_pdf.checked) {
      ui.save_progress.checked = true;
      updateRememberUI('PDF will be saved locally when recovery starts. Checkpoint saving enabled.');
    } else if (rememberedRecord) {
      await forgetSavedPdf(true);
    } else updateRememberUI();
  });
  ui.save_progress.addEventListener('change', async () => {
    if (!ui.save_progress.checked && ui.remember_pdf.checked) {
      ui.remember_pdf.checked = false;
      if (rememberedRecord) await forgetSavedPdf(true);
      else updateRememberUI('Remember PDF disabled because checkpoints were turned off.');
    }
  });
  ui.forget_pdf.addEventListener('click', async () => {
    if (!isBusy()) await forgetSavedPdf(true);
  });
  ui.clear_all.addEventListener('click', clearAllData);
  window.addEventListener("pagehide", () => {
    if (currentRun && isBusy()) checkpoint(currentRun, true);
  });
  ui.start_btn.addEventListener("click", startSearch);
  ui.pause_btn.addEventListener("click", pauseSearch);
  ui.resume_btn.addEventListener("click", resumeSearch);
  ui.stop_btn.addEventListener("click", stopSearch);
  ui.copy_password.addEventListener("click", copyRecovered);
  ui.download_log.addEventListener("click", exportLog);
  buildMasks();
  setStatus("idle", "READY");
  refreshCheckpointHint();
  updateRememberUI();
  void restoreRememberedOnOpen();
})();
