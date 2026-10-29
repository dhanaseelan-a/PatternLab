/* PatternLab — Vanilla JavaScript, browser-only PDF password recovery.
   PDF.js is loaded only when Start is clicked. No PDF bytes are uploaded. */
(() => {
  "use strict";
  const PDF_JS_URL = "https://cdn.jsdelivr.net/npm/pdfjs-dist@6.4.299/build/pdf.min.mjs";
  const PDF_WORKER_URL = "https://cdn.jsdelivr.net/npm/pdfjs-dist@6.4.299/build/pdf.worker.min.mjs";
  const MAX_CANDIDATES = 5_000_000n;
  const MAX_SAVED_LOGS = 250_000;
  const MAX_VISIBLE_LOGS = 90;
  const $ = (id) => document.getElementById(id);
  const ui = Object.fromEntries([
    "file-input", "dropzone", "file-name", "file-meta", "min-length", "max-length",
    "prefix", "suffix", "mask-list", "validation-message", "candidate-total",
    "start-btn", "pause-btn", "resume-btn", "stop-btn", "state-pill", "state-label",
    "percent-label", "progress-fill", "checked-label", "total-label", "elapsed-label",
    "rate-label", "length-label", "current-password", "attempt-result", "active-hint",
    "success-panel", "found-password", "copy-password", "download-log", "terminal", "log-caption", "toast"
  ].map((id) => [id.replaceAll("-", "_"), $(id)]));

  let selectedFile = null;
  let masks = new Map();
  let pdfjsLib = null;
  let currentRun = null;
  let sequenceNumber = 0;
  let toastTimer = null;

  const fmt = (value) => BigInt(value).toLocaleString("en-US");
  const cleanDigits = (value) => value.replace(/\D/g, "");
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
    masks = new Map();
    ui.mask_list.replaceChildren();
    if (!Number.isInteger(min) || !Number.isInteger(max) || min < 1 || max > 20 || min > max || max - min > 12) {
      return validate();
    }
    for (let length = min; length <= max; length++) {
      let value = "";
      if (prefix.length + suffix.length > length) {
        value = prefix + suffix;
      } else {
        value = prefix + "?".repeat(length - prefix.length - suffix.length) + suffix;
      }
      masks.set(length, value);
      const row = document.createElement("label");
      row.className = "mask-row";
      const lenText = document.createElement("span");
      lenText.className = "mask-len";
      lenText.textContent = `${length} DIGITS`;
      const input = document.createElement("input");
      input.className = "mask-input";
      input.type = "text";
      input.autocomplete = "off";
      input.spellcheck = false;
      input.maxLength = 20;
      input.value = value;
      input.setAttribute("aria-label", `${length}-digit password pattern`);
      input.addEventListener("input", () => {
        masks.set(length, input.value);
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
    if (!/^\d*$/.test(ui.prefix.value) || !/^\d*$/.test(ui.suffix.value)) {
      throw new Error("Known starting and ending characters must be digits only.");
    }
    const compiled = [];
    let total = 0n;
    for (let length = min; length <= max; length++) {
      const mask = masks.get(length) ?? "";
      if (mask.length !== length || !/^[\d?]+$/.test(mask)) {
        throw new Error(`${length}-digit pattern must have exactly ${length} characters (digits or ?).`);
      }
      const unknown = [...mask].filter((x) => x === "?").length;
      const count = 10n ** BigInt(unknown);
      compiled.push({length, mask, unknown, count, next: 0n});
      total += count;
    }
    if (total > MAX_CANDIDATES) throw new Error(`Search space too large: ${fmt(total)} candidates. Narrow the unknown digits to 5,000,000 or fewer.`);
    return {compiled, total};
  }
  function validate() {
    let validationError = null;
    let config = null;
    try { config = compile(); } catch (error) { validationError = error.message; }
    const fields = [...ui.mask_list.querySelectorAll(".mask-input")];
    for (const field of fields) {
      const len = Number(field.parentElement.querySelector(".mask-count").dataset.length);
      const valid = field.value.length === len && /^[\d?]+$/.test(field.value);
      field.classList.toggle("invalid", !valid);
      field.parentElement.querySelector(".mask-count").textContent = valid ? fmt(10n ** BigInt((field.value.match(/\?/g) || []).length)) : "INVALID";
    }
    ui.validation_message.hidden = !validationError;
    ui.validation_message.textContent = validationError ?? "";
    ui.candidate_total.innerHTML = "";
    const number = document.createTextNode(config ? `${fmt(config.total)} ` : "— ");
    const small = document.createElement("small");
    small.textContent = "candidates";
    ui.candidate_total.append(number, small);
    if (!isBusy()) {
      ui.total_label.textContent = `/ ${config ? fmt(config.total) : "—"} attempts`;
      ui.start_btn.disabled = !selectedFile || !!validationError;
    }
    return config;
  }
  function candidateFromPattern(pattern, idx) {
    if (pattern.unknown === 0) return pattern.mask;
    const digits = idx.toString(10).padStart(pattern.unknown, "0");
    let pos = 0;
    return pattern.mask.replace(/\?/g, () => digits[pos++]);
  }
  function nextCandidate(run) {
    while (run.patternIndex < run.patterns.length) {
      const p = run.patterns[run.patternIndex];
      if (p.next < p.count) {
        const password = candidateFromPattern(p, p.next);
        p.next += 1n;
        return { password, length: p.length };
      }
      run.patternIndex += 1;
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
    for (const input of [ui.file_input, ui.min_length, ui.max_length, ui.prefix, ui.suffix, ...ui.mask_list.querySelectorAll("input")]) input.disabled = locked;
    ui.dropzone.style.pointerEvents = locked ? "none" : "";
    ui.download_log.disabled = !(run?.logs.length);
  }
  function validateConfigOnly() { try { compile(); return true; } catch { return false; } }
  function appendLog(run, password, outcome) {
    const line = `Checked ${fmt(run.tested)}/${fmt(run.total)} | Password: ${password} | ${outcome}`;
    run.recent.push({password, outcome, count: fmt(run.tested)});
    if (run.recent.length > MAX_VISIBLE_LOGS) run.recent.shift();
    if (run.logs.length < MAX_SAVED_LOGS) run.logs.push(line);
    else run.logsTruncated = true;
    run.lastPassword = password;
    run.lastOutcome = outcome;
    if (outcome === "FOUND") run.foundPassword = password;
  }
  function drawRecent(run) {
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
    ui.log_caption.textContent = run.logsTruncated
      ? `Showing last ${MAX_VISIBLE_LOGS} attempts. Export limited to first ${fmt(MAX_SAVED_LOGS)} results to protect browser memory.`
      : `Showing last ${MAX_VISIBLE_LOGS} attempts. Export includes each recorded result (${fmt(run.logs.length)}).`;
    ui.download_log.disabled = !run.logs.length;
  }
  function draw(run, force = false) {
    if (run !== currentRun) return;
    const t = now();
    if (!force && t - run.lastPaint < 80) return;
    run.lastPaint = t;
    const elapsed = Math.max(1, (run.finishTime ?? t) - run.started);
    const percentage = run.total > 0n ? Number(run.tested * 10000n / run.total) / 100 : 0;
    ui.checked_label.textContent = fmt(run.tested);
    ui.total_label.textContent = `/ ${fmt(run.total)} attempts`;
    ui.percent_label.textContent = `${percentage.toFixed(2)}%`;
    ui.progress_fill.style.width = `${percentage}%`;
    ui.elapsed_label.textContent = mmss(elapsed);
    ui.rate_label.textContent = run.tested ? `${Math.round(Number(run.tested) / (elapsed / 1000)).toLocaleString("en-US")}/s` : "—";
    ui.length_label.textContent = run.lastPassword ? String(run.lastPassword.length) : "—";
    ui.current_password.textContent = run.lastPassword ?? "— — — — — —";
    ui.attempt_result.textContent = run.lastOutcome ?? "—";
    ui.attempt_result.className = `attempt-status ${run.lastOutcome === "FOUND" ? "success" : ""}`;
    ui.active_hint.textContent = run.message;
    drawRecent(run);
  }
  function markAttemptRejected(run) {
    // PDF.js calls onPassword again AFTER it rejects the preceding candidate.
    if (run.inFlight !== null) {
      run.tested += 1n;
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
      id: ++sequenceNumber, file: selectedFile, patterns: config.compiled,
      total: config.total, patternIndex: 0, tested: 0n,
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
        run.tested += 1n;
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
    const header = [`PatternLab recovery log`, `File: ${run.file.name}`, `Tested: ${fmt(run.tested)}/${fmt(run.total)}`, `Status: ${run.state}`, `Log limit: ${MAX_SAVED_LOGS} entries`, ...(run.logsTruncated ? ["WARNING: Additional attempts were not saved in this log."] : []), "", ""];
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
  for (const input of [ui.min_length, ui.max_length, ui.prefix, ui.suffix]) {
    input.addEventListener("input", () => {
      if (input === ui.prefix || input === ui.suffix) input.value = cleanDigits(input.value);
      buildMasks();
    });
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
