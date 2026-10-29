# PatternLab — PDF Pattern Recovery

A small, responsive website built with **Vanilla JavaScript, HTML and CSS**. It checks numeric password candidates against a **PDF selected from your own device**. No remote backend, accounts, or uploads.

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


