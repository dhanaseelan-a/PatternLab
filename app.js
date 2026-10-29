/* PatternLab — Vanilla JavaScript, browser-only PDF password recovery.
   PDF.js is loaded only when Start is clicked. No PDF bytes are uploaded. */
(() => {
  "use strict";
  const PDF_JS_URL = "https://cdn.jsdelivr.net/npm/pdfjs-dist@6.4.299/build/pdf.min.mjs";
  const PDF_WORKER_URL = "https://cdn.jsdelivr.net/npm/pdfjs-dist@6.4.299/build/pdf.worker.min.mjs";
  const MAX_CANDIDATES = 5_000_000;
  const MAX_SAVED_LOGS = 100_000;
  const FAST_SAMPLE_INTERVAL = 500;
  const MAX_VISIBLE_LOGS = 90;
  const $ = (id) => document.getElementById(id);
  const ui = Object.fromEntries([
    "file-input", "dropzone", "file-name", "file-meta", "min-length", "max-length",
    "prefix", "suffix", "middle-value", "middle-position", "set-digits", "set-lower", "set-upper", "log-mode",
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

  const fmt = (value) => Number(value).toLocaleString("en-US");
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
  function setFile(file) {
    if (!file) return;
    if (!(/\.pdf$/i.test(file.name) || file.type === "application/pdf")) {
      showToast("Please choose a PDF file.");
      return;
    }
    if (isBusy()) { showToast("Stop the current search before changing files."); return; }
    selectedFile = file;
    ui.file_name.textContent = file.name;
    ui.file_meta.textContent = `${(file.size / 1024 / 1024).toFixed(2)} MB · Local file · No upload`;
    ui.dropzone.classList.remove("dragover");
    validate();
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
    if (!Number.isInteger(min) || !Number.isInteger(max) || min < 1 || max > 20 || min > max || max - min > 12) {
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
      input.maxLength = 20;
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
    if (!Number.isInteger(min) || !Number.isInteger(max) || min < 1 || max > 20 || min > max || max - min > 12) {
      throw new Error("Choose a valid length range (1–20, up to 13 different lengths).");
    }
    for (const [length, message] of maskErrors) {
      if (length >= min && length <= max) throw new Error(message);
    }
    const chars = alphabet();
    const compiled = [];
    let total = 0;
    for (let length = min; length <= max; length++) {
      const mask = masks.get(length) ?? "";
      if (!maskValid(mask, length)) {
        throw new Error(`${length}-character pattern must have exactly ${length} letters, digits or ? characters.`);
      }
      const unknown = [...mask].filter((x) => x === "?").length;
      if (unknown && !chars.length) throw new Error("Enable at least one character set for unknown (?) positions.");
      const count = chars.length ** unknown;
      if (count > MAX_CANDIDATES || total + count > MAX_CANDIDATES) {
        throw new Error(`Search space exceeds ${fmt(MAX_CANDIDATES)} attempts. Fix more characters or narrow the length range / character sets.`);
      }
      compiled.push({length, mask, unknown, count, next: 0});
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
      const count = chars.length ** unknown;
      const valid = maskValid(field.value, len) && !maskErrors.has(len) && (unknown === 0 || chars.length > 0) && count <= MAX_CANDIDATES;
      field.classList.toggle("invalid", !valid);
      field.parentElement.querySelector(".mask-count").textContent = valid ? fmt(count) : "INVALID";
    }
    ui.validation_message.hidden = !validationError;
    ui.validation_message.textContent = validationError ?? "";
    ui.candidate_total.replaceChildren(document.createTextNode(config ? `${fmt(config.total)} ` : "— "));
    const small = document.createElement("small");
    small.textContent = "candidates";
    ui.candidate_total.append(small);
    if (!isBusy()) {
      ui.total_label.textContent = `/ ${config ? fmt(config.total) : "—"} attempts`;
      ui.start_btn.disabled = !selectedFile || !!validationError;
    }
    return config;
  }
  function candidateFromPattern(pattern, idx, chars) {
    if (pattern.unknown === 0) return pattern.mask;
    // Base-N encoding: selected alphabet controls each unknown slot.
    const base = chars.length;
    const slots = Array(pattern.unknown);
    for (let i = slots.length - 1; i >= 0; i--) {
      slots[i] = chars[idx % base];
      idx = Math.floor(idx / base);
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
    const locked = isBusy();
    for (const input of [ui.file_input, ui.min_length, ui.max_length, ui.prefix, ui.suffix, ui.middle_value, ui.middle_position, ui.set_digits, ui.set_lower, ui.set_upper, ui.log_mode, ...ui.mask_list.querySelectorAll("input")]) input.disabled = locked;
    ui.dropzone.style.pointerEvents = locked ? "none" : "";
    ui.download_log.disabled = !(run?.logs.length);
  }
  function validateConfigOnly() { try { compile(); return true; } catch { return false; } }
  function appendLog(run, password, outcome) {
    // All candidates reach PDF.js. Fast mode avoids costly per-attempt log strings and DOM updates.
    const shouldLog = run.logMode === "detailed" || run.tested <= 3 || run.tested % FAST_SAMPLE_INTERVAL === 0 || outcome === "FOUND";
    run.lastPassword = password;
    run.lastOutcome = outcome;
    if (outcome === "FOUND") run.foundPassword = password;
    if (!shouldLog) return;
    const line = `Checked ${fmt(run.tested)}/${fmt(run.total)} | Password: ${password} | ${outcome}`;
    run.recent.push({password, outcome, count: fmt(run.tested)});
    if (run.recent.length > MAX_VISIBLE_LOGS) run.recent.shift();
    if (run.logs.length < MAX_SAVED_LOGS) run.logs.push(line);
    else run.logsTruncated = true;
    run.logRevision++;
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
    ui.log_caption.textContent = sampling + (run.logsTruncated
      ? `Export limited to first ${fmt(MAX_SAVED_LOGS)} recorded entries.`
      : `${fmt(run.logs.length)} entries recorded for export.`);
    ui.download_log.disabled = !run.logs.length;
  }
  function draw(run, force = false) {
    if (run !== currentRun) return;
    const t = now();
    const paintInterval = run.logMode === "fast" ? 300 : 150;
    if (!force && t - run.lastPaint < paintInterval) return;
    run.lastPaint = t;
    const elapsed = Math.max(1, (run.finishTime ?? t) - run.started);
    const percentage = run.total > 0 ? run.tested / run.total * 100 : 0;
    ui.checked_label.textContent = fmt(run.tested);
    ui.total_label.textContent = `/ ${fmt(run.total)} attempts`;
    ui.percent_label.textContent = `${percentage.toFixed(2)}%`;
    ui.progress_fill.style.width = `${percentage}%`;
    ui.elapsed_label.textContent = mmss(elapsed);
    ui.rate_label.textContent = run.tested ? `${Math.round(run.tested / (elapsed / 1000)).toLocaleString("en-US")}/s` : "—";
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
      run.tested++;
      appendLog(run, run.inFlight.password, "WRONG");
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
    const run = {
      id: ++sequenceNumber, file: selectedFile, patterns: config.compiled, chars: config.chars,
      total: config.total, patternIndex: 0, tested: 0, logMode: ui.log_mode.value,
      logRevision: 0, paintLogRevision: -1,
      inFlight: null, pendingUpdatePassword: null, state: "loading", terminal: false,
      logs: [], recent: [], logsTruncated: false, lastPassword: "", lastOutcome: "",
      message: "Loading PDF verification engine…", started: now(), lastPaint: 0,
      task: null, foundPassword: null
    };
    currentRun = run;
    ui.success_panel.hidden = true;
    setStatus("running", "PREPARING");
    controls(run);
    draw(run, true);
    try {
      const [lib, buffer] = await Promise.all([loadPdfJs(), run.file.arrayBuffer()]);
      if (currentRun !== run || run.terminal) return;
      run.state = "running";
      run.message = "Opening PDF. Every candidate is submitted to PDF.js for verification.";
      setStatus("running", "SEARCHING");
      controls(run);
      const bytes = new Uint8Array(buffer);
      run.task = lib.getDocument({data: bytes});
      run.task.onPassword = (updatePassword, _reason) => onPassword(run, updatePassword);
      const pdf = await run.task.promise;
      if (run !== currentRun || run.terminal) { await pdf.destroy(); return; }
      if (run.inFlight !== null) {
        // The document resolved; therefore the last candidate was accepted.
        run.tested++;
        appendLog(run, run.inFlight.password, "FOUND");
        run.inFlight = null;
        ui.found_password.textContent = run.foundPassword;
        ui.success_panel.hidden = false;
        finish(run, "found", `PDF authenticated successfully (${pdf.numPages} page${pdf.numPages === 1 ? "" : "s"}). Copy the recovered password to open the original document.`);
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
    finish(run, "stopped", "Search stopped. Start again to restart from the beginning.");
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
    if (!run?.logs.length) return;
    const header = [`PatternLab recovery log`, `File: ${run.file.name}`, `Tested: ${fmt(run.tested)}/${fmt(run.total)}`, `Status: ${run.state}`, `Log mode: ${run.logMode} (fast mode is sampled)`, `Log limit: ${MAX_SAVED_LOGS} entries`, ...(run.logsTruncated ? ["WARNING: Additional attempts were not saved in this log."] : []), "", ""];
    const blob = new Blob([header.join("\n"), run.logs.join("\n"), "\n"], {type: "text/plain;charset=utf-8"});
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
  ui.start_btn.addEventListener("click", startSearch);
  ui.pause_btn.addEventListener("click", pauseSearch);
  ui.resume_btn.addEventListener("click", resumeSearch);
  ui.stop_btn.addEventListener("click", stopSearch);
  ui.copy_password.addEventListener("click", copyRecovered);
  ui.download_log.addEventListener("click", exportLog);
  buildMasks();
  setStatus("idle", "READY");
})();
