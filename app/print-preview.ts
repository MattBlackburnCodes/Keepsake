/** Open a print document while keeping a clear route back to the original app tab. */
export function openPrintPreview(html: string, autoPrint = false): boolean {
  const source = window;
  const returnUrl = source.location.href;
  const popup = source.open("", "_blank");
  if (!popup) return false;
  popup.opener = null;
  const style = `<style>.keepsake-print-controls{display:flex;flex-wrap:wrap;gap:12px;position:sticky;top:0;z-index:10;padding:14px;margin-bottom:24px;background:#fffdf9;border:1px solid #e9e1d7;border-radius:12px}.keepsake-print-controls button{min-height:44px;padding:10px 16px;border:1px solid #d8c8b8;border-radius:8px;background:#fff;color:#25231f;font:600 14px system-ui,sans-serif;cursor:pointer}@media print{.keepsake-print-controls,.print-help{display:none!important}}</style>`;
  const controls = `<nav class="keepsake-print-controls" aria-label="Print preview actions"><button type="button" id="keepsake-print-back">← Back to Keepsake</button><button type="button" id="keepsake-print-now">Print / Save PDF</button></nav>`;
  const document = html.replace("</head>", `${style}</head>`).replace(/<body[^>]*>/i, (body) => `${body}${controls}`);
  popup.document.write(document);
  popup.document.close();
  popup.document.getElementById("keepsake-print-back")?.addEventListener("click", () => {
    if (!source.closed) {
      source.focus();
      popup.close();
      if (popup.closed) return;
    }
    // Some mobile browsers keep a newly opened tab alive instead of closing it.
    popup.location.replace(returnUrl);
  });
  popup.document.getElementById("keepsake-print-now")?.addEventListener("click", () => popup.print());
  popup.focus();
  if (autoPrint) source.setTimeout(() => { if (!popup.closed) popup.print(); }, 250);
  return true;
}
