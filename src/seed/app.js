// Loom Conf site loader. Reads site.json and renders each listed section
// from sections/<name>.html. Kept dependency-free so agents can edit safely.
(async function () {
  const res = await fetch("site.json", { cache: "no-store" });
  const site = await res.json();
  document.title = site.title;
  const root = document.documentElement.style;
  for (const [k, v] of Object.entries(site.theme || {})) root.setProperty("--" + k, v);

  const nav = document.getElementById("site-nav");
  nav.innerHTML = (site.nav || []).map((n) => `<a href="${n.href}">${n.label}</a>`).join("");

  const main = document.getElementById("sections");
  for (const name of site.sections || []) {
    try {
      const html = await fetch(`sections/${name}.html`, { cache: "no-store" }).then((r) => (r.ok ? r.text() : ""));
      const el = document.createElement("section");
      el.id = name;
      el.className = "section section-" + name;
      el.innerHTML = html || `<p class="missing">Section “${name}” is listed in site.json but has no file yet.</p>`;
      main.appendChild(el);
    } catch (e) {
      console.error("section failed", name, e);
    }
  }
  const list = document.getElementById("sponsor-list");
  if (list) {
    try {
      const data = await fetch("sponsors.json", { cache: "no-store" }).then((r) => (r.ok ? r.json() : { sponsors: [] }));
      const items = data.sponsors || [];
      list.innerHTML = items.length
        ? items.map((s) => `<span class="sponsor" data-tier="${s.tier || "community"}"><strong>${s.name}</strong><span class="tier">${s.tier || "community"}</span></span>`).join("")
        : `<p class="missing">No sponsors yet. Spawn a swarm to fill this wall.</p>`;
      const count = document.getElementById("sponsor-count");
      if (count) count.textContent = String(items.length);
    } catch (e) {
      console.error("sponsors failed", e);
    }
  }
  const hero = document.querySelector(".hero-tagline");
  if (hero && !hero.textContent.trim()) hero.textContent = site.tagline || "";
})();
