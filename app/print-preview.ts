let dismissPreview: (() => void) | undefined;

/** Keep the preview in the installed website instead of depending on a blank pop-up tab. */
export function openPrintPreview(html: string, autoPrint = false): boolean {
  dismissPreview?.();
  const source = window;
  const document = source.document;
  const previousFocus = document.activeElement as HTMLElement | null;
  const dialog = document.createElement("dialog");
  dialog.id = "keepsake-print-preview";
  dialog.setAttribute("aria-label", "Keepsake print preview");
  const style = document.createElement("style");
  style.textContent = `#keepsake-print-preview{box-sizing:border-box;width:100%;max-width:1000px;height:100dvh;max-height:100dvh;padding:0;border:0;border-radius:0;background:#fffdf9;color:#25231f;margin:auto}#keepsake-print-preview::backdrop{background:rgba(0,0,0,.5)}#keepsake-print-preview .print-layout{display:flex;flex-direction:column;height:100%;min-height:0}#keepsake-print-preview .print-controls{display:flex;flex-wrap:wrap;gap:10px;padding:12px;padding-top:max(12px,env(safe-area-inset-top));border-bottom:1px solid #e9e1d7;flex-shrink:0}#keepsake-print-preview button,#keepsake-print-preview a{min-height:44px;padding:10px 14px;border:1px solid #d8c8b8;border-radius:8px;background:#fff;color:#25231f;font:600 14px system-ui,sans-serif;cursor:pointer}#keepsake-print-preview button:disabled{opacity:.5;cursor:wait}#keepsake-print-preview .print-status{padding:10px 14px;margin:0;font:13px/1.5 system-ui,sans-serif;flex-shrink:0}#keepsake-print-preview iframe{display:block;width:100%;flex:1;min-height:0;border:0;background:white}#keepsake-print-preview .print-browser-link{margin:0 14px 12px;align-self:flex-start}@media print{#keepsake-print-preview .print-controls,#keepsake-print-preview .print-status,#keepsake-print-preview .print-browser-link{display:none!important}}`;
  const layout = document.createElement("div");
  layout.className = "print-layout";
  const controls = document.createElement("div");
  controls.className = "print-controls";
  const back = document.createElement("button");
  back.type = "button";
  back.textContent = "← Back to Keepsake";
  const print = document.createElement("button");
  print.type = "button";
  print.textContent = "Print / Save PDF";
  print.disabled = true;
  controls.append(back, print);
  const status = document.createElement("p");
  status.className = "print-status";
  status.setAttribute("role", "status");
  status.textContent = "Preparing your print preview…";
  const browserLink = document.createElement("a");
  browserLink.className = "print-browser-link";
  browserLink.textContent = "Open browser version";
  browserLink.href = source.location.href;
  browserLink.target = "_blank";
  browserLink.rel = "noopener noreferrer";
  browserLink.hidden = true;
  const frame = document.createElement("iframe");
  frame.title = "Selected Keepsake details for printing";
  // No scripts run in the document; allow only same-origin access and the print dialog.
  frame.setAttribute("sandbox", "allow-same-origin allow-modals");
  const oldOverflow = document.body.style.overflow;
  let closed = false;
  let feedbackTimer: number | undefined;
  let printStarted = false;
  const beforePrint = () => { printStarted = true; };
  const afterPrint = () => { print.disabled = false; status.textContent = "You can print again or go back to Keepsake."; };
  const close = () => {
    if (closed) return;
    closed = true;
    if (feedbackTimer !== undefined) source.clearTimeout(feedbackTimer);
    source.removeEventListener("hashchange", close);
    frame.contentWindow?.removeEventListener("beforeprint", beforePrint);
    frame.contentWindow?.removeEventListener("afterprint", afterPrint);
    dialog.close();
    dialog.remove();
    document.body.style.overflow = oldOverflow;
    dismissPreview = undefined;
    if (previousFocus?.isConnected) previousFocus.focus();
  };
  const unavailable = () => {
    status.textContent = "If no print screen appears, open the browser version in Safari or Chrome and try Print / Save PDF there. Your export selection is still available in Keepsake.";
    browserLink.hidden = false;
    print.disabled = false;
  };
  const printDocument = () => {
    if (closed || print.disabled) return;
    const target = frame.contentWindow;
    if (!target || typeof target.print !== "function") { unavailable(); return; }
    printStarted = false;
    print.disabled = true;
    status.textContent = "Opening print options. Choose Save as PDF to save a file.";
    try {
      // Invoke from this button tap, not a delayed popup callback that mobile apps can ignore.
      target.focus();
      target.print();
      if (feedbackTimer !== undefined) source.clearTimeout(feedbackTimer);
      feedbackTimer = source.setTimeout(() => {
        if (closed) return;
        print.disabled = false;
        if (!printStarted) unavailable();
      }, 2000);
    } catch { unavailable(); }
  };
  frame.addEventListener("load", () => {
    if (closed) return;
    print.disabled = false;
    status.textContent = "Preview ready. Tap Print / Save PDF, then choose your printer or Save as PDF.";
    frame.contentWindow?.addEventListener("beforeprint", beforePrint);
    frame.contentWindow?.addEventListener("afterprint", afterPrint);
    // Installed sites and touch devices require an explicit print tap after the preview loads.
    if (autoPrint && source.matchMedia?.("(pointer: fine)").matches && !source.matchMedia?.("(display-mode: standalone)").matches) printDocument();
  });
  frame.srcdoc = html.replace("</head>", "<style>@media print{.print-help{display:none!important}}</style></head>");
  back.addEventListener("click", close);
  print.addEventListener("click", printDocument);
  dialog.addEventListener("cancel", (event) => { event.preventDefault(); close(); });
  layout.append(controls, status, browserLink, frame);
  dialog.append(style, layout);
  document.body.append(dialog);
  try { dialog.showModal(); }
  catch { dialog.remove(); return false; }
  document.body.style.overflow = "hidden";
  dismissPreview = close;
  source.addEventListener("hashchange", close);
  back.focus();
  return true;
}
