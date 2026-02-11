/* global pdfjsLib, PDFLib */

pdfjsLib.GlobalWorkerOptions.workerSrc =
  "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.10.38/pdf.worker.min.js";

const els = {
  pdfCanvas: document.getElementById("pdfCanvas"),
  overlayCanvas: document.getElementById("overlayCanvas"),
  stage: document.getElementById("stage"),
  pageInfo: document.getElementById("pageInfo"),
  sheetInfo: document.getElementById("sheetInfo"),
  status: document.getElementById("status"),
  errorBox: document.getElementById("errorBox"),
  btnPrev: document.getElementById("btnPrev"),
  btnNext: document.getElementById("btnNext"),
  btnLine: document.getElementById("btnLine"),
  btnUndo: document.getElementById("btnUndo"),
  btnClear: document.getElementById("btnClear"),
  btnExport: document.getElementById("btnExport"),
  fileInput: document.getElementById("fileInput"),
  scaleSelect: document.getElementById("scaleSelect"),
  autoScaleInfo: document.getElementById("autoScaleInfo"),
};

let state = {
  pdf: null,
  pageNumber: 1,
  pageCount: 0,
  originalBytes: null,
  viewport: null,          // pdf.js viewport in CSS px
  pageSizeMm: null,        // {w,h, name}
  mmPerPx: null,           // paper-mm per CSS pixel (based on rendered viewport)
  mode: "idle",            // "idle" | "line"
  tempPoint: null,         // {x,y} first point in CSS px
  lines: [],               // per page: {page, x1,y1,x2,y2, lenMmPaper, lenRealM}
  fileNameBase: "pdf",
  detectedScale: null,
};

function showError(msg) {
  els.errorBox.style.display = "block";
  els.errorBox.textContent = msg;
}
function clearError() {
  els.errorBox.style.display = "none";
  els.errorBox.textContent = "";
}
function setStatus(parts) {
  els.status.innerHTML = "";
  for (const p of parts) {
    const s = document.createElement("span");
    s.className = "chip";
    s.textContent = p;
    els.status.appendChild(s);
  }
}

function getScaleValue() {
  const n = parseInt(els.scaleSelect.value, 10);
  return Number.isFinite(n) ? n : 250;
}

function isoSheetNameFromMm(wMm, hMm) {
  const candidates = [
    { name: "A0", w: 841, h: 1189 },
    { name: "A1", w: 594, h: 841 },
    { name: "A2", w: 420, h: 594 },
    { name: "A3", w: 297, h: 420 },
    { name: "A4", w: 210, h: 297 },
  ];

  // try both orientations; choose nearest by sum abs diff
  const tol = 8; // mm tolerance (PDFs can be slightly off)
  let best = null;

  for (const c of candidates) {
    const d1 = Math.abs(wMm - c.w) + Math.abs(hMm - c.h);
    const d2 = Math.abs(wMm - c.h) + Math.abs(hMm - c.w); // swapped
    const d = Math.min(d1, d2);

    if (!best || d < best.d) best = { ...c, d };
  }

  if (best && best.d <= tol * 2) return best.name;
  return `${Math.round(wMm)}×${Math.round(hMm)}mm`;
}

function pointsToMm(pt) {
  return pt * 25.4 / 72.0;
}

async function loadPdfFromUrl(url) {
  clearError();
  const resp = await fetch(url, { mode: "cors" });
  if (!resp.ok) throw new Error(`Konnte PDF nicht laden (HTTP ${resp.status}).`);
  const ab = await resp.arrayBuffer();
  return new Uint8Array(ab);
}

function parseBaseNameFromUrl(url) {
  try {
    const u = new URL(url);
    const p = u.pathname.split("/").pop() || "pdf";
    const clean = decodeURIComponent(p).replace(/\.pdf$/i, "");
    return clean || "pdf";
  } catch {
    return "pdf";
  }
}

async function detectScaleFromText(pdf, pageNumber) {
  // Try to find "1:250" etc. in first page text
  try {
    const page = await pdf.getPage(pageNumber);
    const text = await page.getTextContent();
    const joined = text.items.map(it => it.str).join(" ");

    // common patterns: "1:250", "M 1:250", "Maßstab 1:250", "1 : 250"
    const re = /1\s*[:]\s*(\d{2,5})/g;
    let m;
    const found = [];
    while ((m = re.exec(joined)) !== null) {
      const v = parseInt(m[1], 10);
      if (v && v >= 10 && v <= 10000) found.push(v);
      if (found.length > 10) break;
    }
    // Prefer common civil scales if multiple found
    const common = [25,50,100,150,200,250,500,1000,2000];
    for (const c of common) {
      if (found.includes(c)) return c;
    }
    return found[0] ?? null;
  } catch {
    return null;
  }
}

async function openPdfBytes(bytes, fileNameBase = "pdf") {
  state.originalBytes = bytes;
  state.fileNameBase = fileNameBase;
  state.pageNumber = 1;
  state.lines = [];
  state.tempPoint = null;
  state.mode = "idle";
  state.detectedScale = null;

  const loadingTask = pdfjsLib.getDocument({ data: bytes });
  state.pdf = await loadingTask.promise;
  state.pageCount = state.pdf.numPages;

  // attempt auto-scale read from text on page 1
  const auto = await detectScaleFromText(state.pdf, 1);
  if (auto) {
    state.detectedScale = auto;
    els.autoScaleInfo.textContent = `Auto-Maßstab: 1:${auto}`;
    // only set dropdown if it has that option; else leave as-is
    const opt = Array.from(els.scaleSelect.options).find(o => parseInt(o.value,10) === auto);
    if (opt) els.scaleSelect.value = String(auto);
  } else {
    els.autoScaleInfo.textContent = "Auto-Maßstab: –";
    // default stays 1:250 per HTML
  }

  await renderPage();
}

async function renderPage() {
  if (!state.pdf) return;

  const page = await state.pdf.getPage(state.pageNumber);

  // Fit page to available width, but keep sharp on iPad
  const containerWidth = Math.min(els.stage.clientWidth - 10, 1200);
  const unscaledVp = page.getViewport({ scale: 1 });

  const scale = containerWidth / unscaledVp.width;
  const viewport = page.getViewport({ scale });

  state.viewport = viewport;

  // canvas setup (device pixel ratio for crispness)
  const dpr = window.devicePixelRatio || 1;

  const pdfCanvas = els.pdfCanvas;
  pdfCanvas.width = Math.floor(viewport.width * dpr);
  pdfCanvas.height = Math.floor(viewport.height * dpr);
  pdfCanvas.style.width = `${Math.floor(viewport.width)}px`;
  pdfCanvas.style.height = `${Math.floor(viewport.height)}px`;

  const overlay = els.overlayCanvas;
  overlay.width = pdfCanvas.width;
  overlay.height = pdfCanvas.height;
  overlay.style.width = pdfCanvas.style.width;
  overlay.style.height = pdfCanvas.style.height;

  // Render PDF
  const ctx = pdfCanvas.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, viewport.width, viewport.height);

  await page.render({ canvasContext: ctx, viewport }).promise;

  // Detect sheet size (mm) from PDF points:
  // viewport in CSS px; get original page size in points:
  const view = page.view; // [xMin, yMin, xMax, yMax] in points
  const wPt = view[2] - view[0];
  const hPt = view[3] - view[1];
  const wMm = pointsToMm(wPt);
  const hMm = pointsToMm(hPt);

  const sheetName = isoSheetNameFromMm(wMm, hMm);
  state.pageSizeMm = { w: wMm, h: hMm, name: sheetName };

  // mm per CSS pixel based on rendered viewport width in CSS px
  // We use the longer side mapping correctly regardless of orientation.
  // viewport.width is CSS px width of page rendering.
  state.mmPerPx = (wMm / viewport.width);

  els.pageInfo.textContent = `Seite ${state.pageNumber} / ${state.pageCount}`;
  els.sheetInfo.textContent = `Blatt: ${sheetName}`;

  redrawOverlay();

  setStatus([
    `Modus: ${state.mode === "line" ? "Strecke" : "–"}`,
    `1px ≈ ${(state.mmPerPx ?? 0).toFixed(4)} mm (Papier)`,
    `Maßstab: 1:${getScaleValue()}`,
  ]);
}

function cssToOverlayPx(xCss, yCss) {
  const dpr = window.devicePixelRatio || 1;
  return { x: xCss * dpr, y: yCss * dpr };
}

function overlayPxToCss(xPx, yPx) {
  const dpr = window.devicePixelRatio || 1;
  return { x: xPx / dpr, y: yPx / dpr };
}

function getPointerCssPos(ev) {
  const rect = els.overlayCanvas.getBoundingClientRect();
  const x = (ev.clientX - rect.left);
  const y = (ev.clientY - rect.top);
  return { x, y };
}

function computeLineLengths(x1Css, y1Css, x2Css, y2Css) {
  const dx = x2Css - x1Css;
  const dy = y2Css - y1Css;
  const distPx = Math.hypot(dx, dy);

  const lenMmPaper = distPx * (state.mmPerPx ?? 0);
  const scale = getScaleValue();
  // Real length: paper mm * scale → real mm → meters
  const lenRealM = (lenMmPaper * scale) / 1000.0;

  return { distPx, lenMmPaper, lenRealM };
}

function redrawOverlay() {
  const c = els.overlayCanvas;
  const ctx = c.getContext("2d");
  ctx.clearRect(0, 0, c.width, c.height);

  const dpr = window.devicePixelRatio || 1;
  ctx.save();
  ctx.scale(dpr, dpr);

  // Draw existing lines of current page
  const current = state.lines.filter(l => l.page === state.pageNumber);

  // Style (keine fixen Farben nötig? -> hier minimal)
  ctx.lineWidth = 2;
  ctx.font = "14px system-ui";
  ctx.textBaseline = "middle";

  for (const l of current) {
    ctx.beginPath();
    ctx.moveTo(l.x1, l.y1);
    ctx.lineTo(l.x2, l.y2);
    ctx.stroke();

    // Label at midpoint
    const mx = (l.x1 + l.x2) / 2;
    const my = (l.y1 + l.y2) / 2;

    const label = `${l.lenRealM.toFixed(2)} m`;
    const pad = 6;
    const w = ctx.measureText(label).width;

    ctx.save();
    ctx.globalAlpha = 0.9;
    ctx.fillRect(mx - (w/2) - pad, my - 12, w + pad*2, 24);
    ctx.restore();

    ctx.fillStyle = "#000";
    ctx.fillText(label, mx - w/2, my);
    ctx.fillStyle = "#fff";
  }

  // Temporary first point marker
  if (state.mode === "line" && state.tempPoint) {
    ctx.beginPath();
    ctx.arc(state.tempPoint.x, state.tempPoint.y, 5, 0, Math.PI*2);
    ctx.fill();
  }

  ctx.restore();
}

function setMode(mode) {
  state.mode = mode;
  state.tempPoint = null;
  redrawOverlay();
  setStatus([
    `Modus: ${state.mode === "line" ? "Strecke" : "–"}`,
    `Blatt: ${state.pageSizeMm?.name ?? "–"}`,
    `Maßstab: 1:${getScaleValue()}`,
  ]);
}

els.overlayCanvas.addEventListener("pointerdown", (ev) => {
  if (!state.pdf) return;
  if (state.mode !== "line") return;

  const p = getPointerCssPos(ev);

  if (!state.tempPoint) {
    state.tempPoint = p;
    redrawOverlay();
    return;
  }

  const p1 = state.tempPoint;
  const p2 = p;
  state.tempPoint = null;

  const lengths = computeLineLengths(p1.x, p1.y, p2.x, p2.y);

  state.lines.push({
    page: state.pageNumber,
    x1: p1.x, y1: p1.y,
    x2: p2.x, y2: p2.y,
    lenMmPaper: lengths.lenMmPaper,
    lenRealM: lengths.lenRealM,
    scale: getScaleValue(),
  });

  redrawOverlay();
});

els.btnLine.addEventListener("click", () => setMode("line"));
els.btnUndo.addEventListener("click", () => {
  // remove last line on current page
  for (let i = state.lines.length - 1; i >= 0; i--) {
    if (state.lines[i].page === state.pageNumber) {
      state.lines.splice(i, 1);
      break;
    }
  }
  redrawOverlay();
});
els.btnClear.addEventListener("click", () => {
  state.lines = state.lines.filter(l => l.page !== state.pageNumber);
  state.tempPoint = null;
  redrawOverlay();
});

els.btnPrev.addEventListener("click", async () => {
  if (!state.pdf) return;
  if (state.pageNumber > 1) {
    state.pageNumber--;
    await renderPage();
  }
});
els.btnNext.addEventListener("click", async () => {
  if (!state.pdf) return;
  if (state.pageNumber < state.pageCount) {
    state.pageNumber++;
    await renderPage();
  }
});

els.scaleSelect.addEventListener("change", () => {
  // update labels in overlay (they recompute by stored real length at time of measurement)
  // (optional: you can decide to recompute all on scale change; currently measurements keep their own scale used at creation)
  redrawOverlay();
  setStatus([
    `Modus: ${state.mode === "line" ? "Strecke" : "–"}`,
    `Blatt: ${state.pageSizeMm?.name ?? "–"}`,
    `Maßstab: 1:${getScaleValue()} (neue Messungen)`,
  ]);
});

// File upload
els.fileInput.addEventListener("change", async (ev) => {
  const f = ev.target.files?.[0];
  if (!f) return;
  clearError();

  const ab = await f.arrayBuffer();
  const base = (f.name || "pdf").replace(/\.pdf$/i, "");
  await openPdfBytes(new Uint8Array(ab), base);
});

// click label triggers hidden input
document.querySelector('label.btn input#fileInput')?.parentElement?.addEventListener("click", () => {
  els.fileInput.click();
});

// Export PDF: embed overlay of current page into original PDF (current page only)
els.btnExport.addEventListener("click", async () => {
  if (!state.originalBytes || !state.pdf) return;

  try {
    clearError();

    // Load original PDF into pdf-lib
    const pdfDoc = await PDFLib.PDFDocument.load(state.originalBytes);

    const pageIndex = state.pageNumber - 1;
    const page = pdfDoc.getPages()[pageIndex];

    // Create overlay image canvas in the same pixel size as overlayCanvas,
    // BUT we need to include only current page lines.
    const overlayCanvas = els.overlayCanvas;
    const temp = document.createElement("canvas");
    temp.width = overlayCanvas.width;
    temp.height = overlayCanvas.height;

    const tctx = temp.getContext("2d");
    tctx.clearRect(0, 0, temp.width, temp.height);

    // Draw current overlay (it already contains only current page’s lines)
    tctx.drawImage(overlayCanvas, 0, 0);

    // Flip vertically for PDF coordinate system
    const flipped = document.createElement("canvas");
    flipped.width = temp.width;
    flipped.height = temp.height;
    const fctx = flipped.getContext("2d");
    fctx.translate(0, flipped.height);
    fctx.scale(1, -1);
    fctx.drawImage(temp, 0, 0);

    const pngBytes = await new Promise((resolve) => {
      flipped.toBlob(async (blob) => {
        const buf = await blob.arrayBuffer();
        resolve(new Uint8Array(buf));
      }, "image/png");
    });

    const pngImage = await pdfDoc.embedPng(pngBytes);

    const { width: pw, height: ph } = page.getSize();

    // Draw full-page overlay
    page.drawImage(pngImage, {
      x: 0,
      y: 0,
      width: pw,
      height: ph,
      opacity: 0.95,
    });

    const outBytes = await pdfDoc.save();
    const blob = new Blob([outBytes], { type: "application/pdf" });

    const name = `${state.fileNameBase}_pdf_measurements.pdf`;
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();

    setStatus([`Export: ${name}`, `Seite: ${state.pageNumber}`, `Messungen: ${state.lines.filter(l=>l.page===state.pageNumber).length}`]);
  } catch (e) {
    showError(`Export fehlgeschlagen: ${e?.message ?? String(e)}`);
  }
});

// Load by URL parameter ?file=
async function boot() {
  const params = new URLSearchParams(location.search);
  const fileUrl = params.get("file");

  if (fileUrl) {
    try {
      const decoded = decodeURIComponent(fileUrl);
      const bytes = await loadPdfFromUrl(decoded);
      const base = parseBaseNameFromUrl(decoded);
      await openPdfBytes(bytes, base);
      return;
    } catch (e) {
      showError(
        `Konnte PDF per URL nicht laden. Ursache ist oft SharePoint CORS/Anmeldung.\n` +
        `Fehler: ${e?.message ?? String(e)}\n` +
        `Workaround: Nutze einen echten Download-Link, oder lade die PDF über „PDF wählen“.`
      );
    }
  }

  setStatus(["Bereit", "Standard-Maßstab 1:250", "PDF per URL (?file=) oder Upload"]);
}
boot();

// Re-render on resize (debounced)
let resizeTimer = null;
window.addEventListener("resize", () => {
  if (!state.pdf) return;
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => renderPage(), 150);
});
