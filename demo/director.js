// Injected into the dashboard while recording: callouts, highlight rings, zooms
// and scene titles. Braid colours; nothing here ships in the product.
(() => {
  if (window.__dir) return;
  const style = document.createElement("style");
  style.textContent = `
    #dir-layer { position: fixed; inset: 0; pointer-events: none; z-index: 1000; font-family: "IBM Plex Sans", "Helvetica Neue", Arial, sans-serif; }
    .dir-ring { position: absolute; border: 3px solid #f6821f; border-radius: 10px; box-shadow: 0 0 0 6px rgba(246,130,31,.25), 0 0 32px rgba(246,130,31,.45); animation: dir-pulse 1.2s ease-in-out infinite, dir-in .25s ease-out; }
    @keyframes dir-pulse { 0%,100% { box-shadow: 0 0 0 4px rgba(246,130,31,.18), 0 0 24px rgba(246,130,31,.35); } 50% { box-shadow: 0 0 0 10px rgba(246,130,31,.32), 0 0 40px rgba(246,130,31,.6); } }
    .dir-label { position: absolute; background: #f6821f; color: #0f1420; font-size: 20px; line-height: 26px; font-weight: 600; padding: 10px 16px; border-radius: 10px; max-width: 360px; box-shadow: 0 10px 30px rgba(0,0,0,.45); animation: dir-in .3s ease-out; letter-spacing: -0.005em; }
    .dir-label::after { content: ""; position: absolute; width: 0; height: 0; border: 12px solid transparent; }
    .dir-label[data-side="left"]::after { left: 100%; top: 50%; margin-top: -12px; border-left-color: #f6821f; }
    .dir-label[data-side="right"]::after { right: 100%; top: 50%; margin-top: -12px; border-right-color: #f6821f; }
    .dir-label[data-side="top"]::after { top: 100%; left: 50%; margin-left: -12px; border-top-color: #f6821f; }
    .dir-label[data-side="bottom"]::after { bottom: 100%; left: 50%; margin-left: -12px; border-bottom-color: #f6821f; }
    .dir-title { position: absolute; left: 50%; top: 28px; transform: translateX(-50%); background: rgba(15,20,32,.92); color: #f3ece3; border: 1px solid #f6821f; font-size: 22px; line-height: 28px; font-weight: 600; padding: 12px 22px; border-radius: 999px; box-shadow: 0 10px 30px rgba(0,0,0,.5); animation: dir-in .35s ease-out; white-space: nowrap; }
    .dir-title b { color: #f6821f; font-family: "IBM Plex Mono", Menlo, monospace; font-weight: 500; margin-right: 10px; }
    .dir-out { animation: dir-out .3s ease-in forwards !important; }
    @keyframes dir-in { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: none; } }
    @keyframes dir-out { to { opacity: 0; transform: translateY(6px); } }
    .dir-title.dir-out { animation: dir-title-out .3s ease-in forwards !important; }
    @keyframes dir-title-out { to { opacity: 0; transform: translateX(-50%) translateY(-6px); } }
    body { transition: transform 800ms cubic-bezier(.2,.7,.2,1); }
  `;
  document.head.appendChild(style);
  const layer = document.createElement("div");
  layer.id = "dir-layer";
  document.body.appendChild(layer);
  const el = (cls) => { const d = document.createElement("div"); d.className = cls; layer.appendChild(d); return d; };
  const remove = (nodes, ms) => setTimeout(() => { for (const n of nodes) { n.classList.add("dir-out"); setTimeout(() => n.remove(), 320); } }, ms);
  const find = (sel) => { const n = typeof sel === "string" ? document.querySelector(sel) : sel; return n && n.getBoundingClientRect().width ? n : null; };

  window.__dir = {
    /** Highlight an element and attach a callout label on the given side. */
    point(sel, label, ms = 4000, side = "left") {
      const n = find(sel);
      if (!n) return false;
      const r = n.getBoundingClientRect();
      const ring = el("dir-ring");
      ring.style.cssText = `left:${r.left - 6}px;top:${r.top - 6}px;width:${r.width + 12}px;height:${r.height + 12}px`;
      const lab = el("dir-label");
      lab.dataset.side = side;
      lab.textContent = label;
      layer.appendChild(lab);
      const lr = lab.getBoundingClientRect();
      const gap = 22;
      let x, y;
      if (side === "left") { x = r.left - lr.width - gap; y = r.top + r.height / 2 - lr.height / 2; }
      else if (side === "right") { x = r.right + gap; y = r.top + r.height / 2 - lr.height / 2; }
      else if (side === "top") { x = r.left + r.width / 2 - lr.width / 2; y = r.top - lr.height - gap; }
      else { x = r.left + r.width / 2 - lr.width / 2; y = r.bottom + gap; }
      x = Math.max(12, Math.min(x, window.innerWidth - lr.width - 12));
      y = Math.max(12, Math.min(y, window.innerHeight - lr.height - 12));
      lab.style.left = `${x}px`;
      lab.style.top = `${y}px`;
      remove([ring, lab], ms);
      return true;
    },
    /** Zoom the whole page towards an element (or a point), then back. */
    zoom(sel, factor = 1.6, ms = 5000) {
      const n = find(sel);
      let cx = window.innerWidth / 2, cy = window.innerHeight / 2;
      if (n) { const r = n.getBoundingClientRect(); cx = r.left + r.width / 2; cy = r.top + r.height / 2; }
      // keep the zoomed viewport inside the page
      const w = window.innerWidth / factor, h = window.innerHeight / factor;
      cx = Math.max(w / 2, Math.min(cx, window.innerWidth - w / 2));
      cy = Math.max(h / 2, Math.min(cy, window.innerHeight - h / 2));
      document.body.style.transformOrigin = `${cx}px ${cy}px`;
      document.body.style.transform = `scale(${factor})`;
      setTimeout(() => { document.body.style.transform = "scale(1)"; }, ms);
      return Boolean(n);
    },
    /** A scene title chip at the top. */
    title(num, text, ms = 3800) {
      const t = el("dir-title");
      t.innerHTML = `<b>${num}</b>${text}`;
      remove([t], ms);
      return true;
    },
    clear() { layer.innerHTML = ""; document.body.style.transform = "scale(1)"; },
  };
})();
