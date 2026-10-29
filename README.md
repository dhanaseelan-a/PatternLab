# PatternLab — PDF Pattern Recovery

A small, responsive website built with **Vanilla JavaScript, HTML and CSS**. It checks numeric password candidates against a **PDF selected from your own device**. No remote backend, accounts, or uploads.

## Getting started (Windows)

1. Extract the ZIP file.
2. In the extracted folder, open PowerShell.
3. Run:

   ```powershell
   py -m http.server 8080
   ```
4. Open **http://localhost:8080** in Chrome or Edge.
5. Select your own password-protected PDF, enter a minimum and maximum password length, specify known digits, then press **Start recovery**.

For a quick demo, select the bundled `demo-locked.pdf`, set both min/max length to `10`, starting digits to `3`, ending digits to `2766`. The demo password is `3000072766` and should be found on the eighth candidate.

The site fetches **Mozilla PDF.js 6.4.299** from jsDelivr when you click Start. An internet connection is needed to load that library. **The PDF file itself is not uploaded** by this application. To make the website fully offline, download the matching `pdf.min.mjs` and `pdf.worker.min.mjs` from [pdfjs-dist 6.4.299](https://cdn.jsdelivr.net/npm/pdfjs-dist@6.4.299/build/) and update `PDF_JS_URL` and `PDF_WORKER_URL` at the top of `app.js` to local URLs. Always use files from the same library version.

## Pattern rules

- `?` means **any single digit 0–9**.
- `3???2766` tries 1,000 eight-digit passwords.
- `3????2766` tries 10,000 nine-digit passwords.
- `3?????2766` tries 100,000 ten-digit passwords.
- Want a digit fixed in the middle? Edit an individual row, such as `3?5?2766`.
- Known start/end values provide defaults for every selected length. Per-length patterns can be customized afterwards.

## Operational notes

- **Real authentication:** Candidate success/failure is determined through PDF.js's `PDFDocumentLoadingTask.onPassword` callback. A failed candidate is logged only **after** PDF.js requests another password; the final successful candidate is logged only **after** the PDF successfully opens.
- **Pause:** The current candidate finishes; the next one is not submitted until you press Resume.
- **Stop:** Cancels the active document load. Starting again restarts from the first candidate; refreshing the page also restarts the search.
- **Logs:** The latest 90 attempts appear on screen. The export includes individual recorded results (up to 250,000 entries).
- **Large search spaces:** To protect browser memory, the UI limits search spaces to five million candidates. Browser-based recovery may be much slower than tools using native code, and is **not guaranteed** to recover the password.
- **Copy:** When successful, the recovered password is displayed and can be copied. This version does **not** produce a decrypted PDF file; open the original using the recovered password.
- Use this tool only for files that you own or have explicit permission to recover.

## Technology

- Vanilla HTML / CSS / JavaScript: no framework, no build process.
- PDF.js, an Apache-2.0 licensed Mozilla project. [PDF.js](https://mozilla.github.io/pdf.js/) · [npm version](https://www.npmjs.com/package/pdfjs-dist).

## Privacy

No analytics or server upload code. The browser makes a request for PDF.js JavaScript files from jsDelivr only when the recovery starts. The selected PDF data remains inside the browser. The recovered password stays inside the tab; copying it places it on your system clipboard. Exported logs contain attempted passwords and should be handled as sensitive.

## Production branding

Header: “Private by design” and “ON-DEVICE · NO UPLOADS”. Footer: “Created by Dhanaseelan”. These labels describe browser-local processing; they do not imply a security audit.
