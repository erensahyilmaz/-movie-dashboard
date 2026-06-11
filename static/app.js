// ===== State =====
let allData = [];                 // full dataset for the active user
let viewData = [];                // after filters + sort
let currentPage = 1;
let pageSize = 20;
let sortState = { key: "date", ascending: false };
let isRefresh = false;            // distinguishes refresh polling from first scrape

const FACETS = [
  { key: "studios",   field: "studios",  label: "Stüdyo" },
  { key: "cast",      field: "cast",     label: "Oyuncu" },
  { key: "directors", field: "director", label: "Yönetmen" },
  { key: "genres",    field: "genres",   label: "Tür" },
];

let selectedFilters = { search: "", studios: [], cast: [], directors: [], genres: [] };

// ===================================================================
// View switching (sidebar)
// ===================================================================
document.querySelectorAll(".nav-item").forEach(item => {
  item.addEventListener("click", () => {
    document.querySelectorAll(".nav-item").forEach(n => n.classList.remove("active"));
    document.querySelectorAll(".view").forEach(v => v.classList.remove("active"));
    item.classList.add("active");
    document.getElementById("view-" + item.dataset.view).classList.add("active");
  });
});

// ===================================================================
// Scrape / load
// ===================================================================
function startScrape() {
  const username = document.getElementById("username").value.trim();
  if (!username) {
    showToast("Lütfen bir kullanıcı adı girin", "error");
    return;
  }

  isRefresh = false;
  openModal();

  fetch("/start-scrape", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username }),
  })
    .then(r => r.json())
    .then(data => {
      if (data.status === "cached") {
        // Data already on disk - skip scraping.
        closeModal();
        loadResults().then(() => {
          showToast(`Önbellekten yüklendi · ${data.count} film`, "success");
        });
      } else if (data.status === "started") {
        pollProgress();
      } else {
        showToast("Hata: " + (data.message || "Bilinmeyen hata"), "error");
        closeModal();
      }
    })
    .catch(err => {
      showToast("Bağlantı hatası: " + err, "error");
      closeModal();
    });
}

function refreshData() {
  const prevCount = allData.length;
  isRefresh = true;
  openModal("Yeni filmler kontrol ediliyor...");

  fetch("/refresh", { method: "POST" })
    .then(r => r.json())
    .then(data => {
      if (data.status === "started") {
        pollProgress(prevCount);
      } else {
        showToast("Hata: " + (data.message || "Bilinmeyen hata"), "error");
        closeModal();
      }
    })
    .catch(err => {
      showToast("Bağlantı hatası: " + err, "error");
      closeModal();
    });
}

function pollProgress(prevCount) {
  fetch("/status")
    .then(r => r.json())
    .then(status => {
      const percent = status.percentage || 0;
      document.getElementById("progressFill").style.width = percent + "%";
      document.getElementById("progressPercent").textContent = percent + "%";

      let stageText = "";
      switch (status.stage) {
        case "counting":        stageText = "Sayfa sayısı hesaplanıyor..."; break;
        case "scraping_films":  stageText = `Günlük sayfaları taranıyor (${status.current_page}/${status.total_pages})`; break;
        case "scraping_details":stageText = `Film detayları alınıyor (${status.current_film}/${status.total_films})`; break;
        case "done":            stageText = "Tamamlandı!"; break;
        default:                stageText = "Başlatılıyor...";
      }
      document.getElementById("stageText").textContent = stageText;

      if (status.error) {
        document.getElementById("statusText").textContent = "Hata!";
        document.getElementById("stageText").textContent = status.error;
        document.getElementById("progressFill").style.backgroundColor = "#ef4444";
        return;
      }

      if (status.done) {
        if (isRefresh) {
          // For a refresh we close immediately and reload data silently.
          closeModal();
          loadResults().then(() => {
            const added = allData.length - (prevCount || 0);
            showToast(added > 0 ? `${added} yeni film eklendi` : "Zaten güncel", "success");
          });
        } else {
          document.getElementById("statusText").textContent = "Veriler alındı!";
          document.getElementById("showBtn").classList.remove("hidden");
        }
      } else {
        setTimeout(() => pollProgress(prevCount), 500);
      }
    })
    .catch(() => setTimeout(() => pollProgress(prevCount), 1000));
}

function showResults() {
  closeModal();
  loadResults();
}

function loadResults() {
  return fetch("/result")
    .then(r => r.json())
    .then(data => {
      allData = Array.isArray(data) ? data : [];
      document.getElementById("activeUser").textContent =
        document.getElementById("username").value.trim();
      buildFacets();
      applyAndRender();
      document.getElementById("emptyState").classList.add("hidden");
      document.getElementById("filterSection").classList.remove("hidden");
      document.getElementById("tableContainer").classList.remove("hidden");
      document.getElementById("refreshBtn").classList.remove("hidden");
    });
}

// ===================================================================
// Filtering
// ===================================================================
function uniqueValues(field) {
  const set = new Set();
  allData.forEach(f => {
    if (f[field]) {
      f[field].split(", ").forEach(v => {
        const t = v.trim();
        if (t) set.add(t);
      });
    }
  });
  return Array.from(set).sort((a, b) => a.localeCompare(b, "tr"));
}

function buildFacets() {
  const bar = document.getElementById("facetBar");
  bar.innerHTML = "";

  FACETS.forEach(facet => {
    const options = uniqueValues(facet.field);

    const wrap = document.createElement("div");
    wrap.className = "facet";

    const btn = document.createElement("button");
    btn.className = "facet-btn";
    btn.innerHTML = `${facet.label} <span class="facet-count" id="count-${facet.key}"></span> <span class="caret">▾</span>`;

    const panel = document.createElement("div");
    panel.className = "facet-panel hidden";
    panel.innerHTML = `
      <input type="text" class="facet-search" placeholder="Ara..." />
      <div class="facet-list"></div>
    `;

    btn.addEventListener("click", e => {
      e.stopPropagation();
      const isOpen = !panel.classList.contains("hidden");
      closeAllPanels();
      if (!isOpen) panel.classList.remove("hidden");
    });
    panel.addEventListener("click", e => e.stopPropagation());

    const list = panel.querySelector(".facet-list");
    const search = panel.querySelector(".facet-search");

    const renderList = () => {
      const term = search.value.toLowerCase().trim();
      const selected = selectedFilters[facet.key];
      list.innerHTML = "";
      options
        .filter(o => o.toLowerCase().includes(term))
        .slice(0, 300)
        .forEach(o => {
          const id = `${facet.key}-${o}`.replace(/[^a-z0-9]/gi, "_");
          const label = document.createElement("label");
          label.className = "facet-option";
          const checked = selected.includes(o) ? "checked" : "";
          label.innerHTML = `<input type="checkbox" ${checked} value="${escapeHtml(o)}"><span>${escapeHtml(o)}</span>`;
          label.querySelector("input").addEventListener("change", ev => {
            toggleFilter(facet.key, o, ev.target.checked);
          });
          list.appendChild(label);
        });
      if (list.children.length === 0) {
        list.innerHTML = `<div class="facet-empty">Sonuç yok</div>`;
      }
    };

    search.addEventListener("input", renderList);
    renderList();

    wrap.appendChild(btn);
    wrap.appendChild(panel);
    bar.appendChild(wrap);
  });

  updateFacetCounts();
}

function closeAllPanels() {
  document.querySelectorAll(".facet-panel").forEach(p => p.classList.add("hidden"));
}
document.addEventListener("click", closeAllPanels);

function toggleFilter(key, value, on) {
  const arr = selectedFilters[key];
  if (on) {
    if (!arr.includes(value)) arr.push(value);
  } else {
    const i = arr.indexOf(value);
    if (i > -1) arr.splice(i, 1);
  }
  currentPage = 1;
  applyAndRender();
}

function onFilterChange() {
  selectedFilters.search = document.getElementById("searchInput").value;
  currentPage = 1;
  applyAndRender();
}

function clearFilters() {
  selectedFilters = { search: "", studios: [], cast: [], directors: [], genres: [] };
  document.getElementById("searchInput").value = "";
  currentPage = 1;
  buildFacets();
  applyAndRender();
}

function matchesFacet(film, field, selected) {
  if (selected.length === 0) return true;
  if (!film[field]) return false;
  const values = film[field].split(", ").map(v => v.trim());
  return selected.some(s => values.includes(s));
}

function applyAndRender() {
  const term = (selectedFilters.search || "").toLowerCase().trim();

  viewData = allData.filter(f => {
    if (term && !(f.title && f.title.toLowerCase().includes(term))) return false;
    if (!matchesFacet(f, "studios", selectedFilters.studios)) return false;
    if (!matchesFacet(f, "cast", selectedFilters.cast)) return false;
    if (!matchesFacet(f, "director", selectedFilters.directors)) return false;
    if (!matchesFacet(f, "genres", selectedFilters.genres)) return false;
    return true;
  });

  sortData();
  renderChips();
  updateFacetCounts();
  document.getElementById("resultCount").textContent = viewData.length;
  renderPage();
}

// ===================================================================
// Sorting
// ===================================================================
function ratingToNumber(r) {
  if (!r) return -1;
  let n = (r.match(/★/g) || []).length;
  if (r.includes("½")) n += 0.5;
  return n;
}

function sortData() {
  const { key, ascending } = sortState;
  viewData.sort((a, b) => {
    let av, bv;
    if (key === "rating") {
      av = ratingToNumber(a.rating);
      bv = ratingToNumber(b.rating);
      return ascending ? av - bv : bv - av;
    }
    av = (a[key === "director" ? "director" : key] || "").toString();
    bv = (b[key === "director" ? "director" : key] || "").toString();
    if (!av) return 1;
    if (!bv) return -1;
    const cmp = av.localeCompare(bv, "tr", { numeric: true });
    return ascending ? cmp : -cmp;
  });
}

document.querySelectorAll("#resultsTable th").forEach(th => {
  th.addEventListener("click", () => {
    const key = th.dataset.key;
    if (sortState.key === key) {
      sortState.ascending = !sortState.ascending;
    } else {
      sortState.key = key;
      sortState.ascending = true;
    }
    applyAndRender();
    updateSortIndicators();
  });
});

function updateSortIndicators() {
  document.querySelectorAll("#resultsTable th").forEach(th => {
    const base = th.textContent.replace(/[▲▼]/g, "").trim();
    th.textContent = base + (th.dataset.key === sortState.key ? (sortState.ascending ? " ▲" : " ▼") : "");
  });
}

// ===================================================================
// Rendering (table + pagination)
// ===================================================================
function renderPage() {
  const tbody = document.getElementById("tableBody");
  tbody.innerHTML = "";

  const totalPages = Math.max(1, Math.ceil(viewData.length / pageSize));
  if (currentPage > totalPages) currentPage = totalPages;

  const start = (currentPage - 1) * pageSize;
  const slice = viewData.slice(start, start + pageSize);

  slice.forEach(film => {
    const row = tbody.insertRow();
    row.innerHTML = `
      <td class="nowrap">${fmtDate(film.date)}</td>
      <td><strong>${escapeHtml(film.title) || "-"}</strong></td>
      <td class="rating">${film.rating || "-"}</td>
      <td>${escapeHtml(film.director) || "-"}</td>
      <td class="muted-cell">${escapeHtml(film.studios) || "-"}</td>
      <td class="muted-cell">${escapeHtml(film.cast) || "-"}</td>
      <td>${renderGenres(film.genres)}</td>
    `;
  });

  if (slice.length === 0) {
    const row = tbody.insertRow();
    row.innerHTML = `<td colspan="7" class="no-rows">Eşleşen film yok</td>`;
  }

  renderPagination(totalPages);
}

function renderPagination(totalPages) {
  const el = document.getElementById("pagination");
  el.innerHTML = "";
  if (totalPages <= 1) return;

  const addBtn = (label, page, opts = {}) => {
    const b = document.createElement("button");
    b.className = "page-btn" + (opts.active ? " active" : "");
    b.textContent = label;
    b.disabled = !!opts.disabled;
    if (!opts.disabled && !opts.active) {
      b.addEventListener("click", () => { currentPage = page; renderPage(); });
    }
    el.appendChild(b);
  };

  addBtn("‹", currentPage - 1, { disabled: currentPage === 1 });

  // Windowed page numbers
  const pages = [];
  const win = 2;
  for (let p = 1; p <= totalPages; p++) {
    if (p === 1 || p === totalPages || (p >= currentPage - win && p <= currentPage + win)) {
      pages.push(p);
    } else if (pages[pages.length - 1] !== "...") {
      pages.push("...");
    }
  }
  pages.forEach(p => {
    if (p === "...") {
      const span = document.createElement("span");
      span.className = "page-ellipsis";
      span.textContent = "…";
      el.appendChild(span);
    } else {
      addBtn(p, p, { active: p === currentPage });
    }
  });

  addBtn("›", currentPage + 1, { disabled: currentPage === totalPages });
}

// Page-size segmented control
document.querySelectorAll("#pageSizeSeg button").forEach(b => {
  b.addEventListener("click", () => {
    document.querySelectorAll("#pageSizeSeg button").forEach(x => x.classList.remove("active"));
    b.classList.add("active");
    pageSize = parseInt(b.dataset.size, 10);
    currentPage = 1;
    renderPage();
  });
});

// ===================================================================
// Chips + counts
// ===================================================================
function renderChips() {
  const el = document.getElementById("activeChips");
  el.innerHTML = "";
  FACETS.forEach(facet => {
    selectedFilters[facet.key].forEach(val => {
      const chip = document.createElement("span");
      chip.className = "chip";
      chip.innerHTML = `<b>${facet.label}:</b> ${escapeHtml(val)} <span class="chip-x">×</span>`;
      chip.querySelector(".chip-x").addEventListener("click", () => {
        toggleFilter(facet.key, val, false);
        buildFacets();
      });
      el.appendChild(chip);
    });
  });
}

function updateFacetCounts() {
  FACETS.forEach(facet => {
    const n = selectedFilters[facet.key].length;
    const badge = document.getElementById("count-" + facet.key);
    if (badge) badge.textContent = n > 0 ? n : "";
    if (badge) badge.classList.toggle("show", n > 0);
  });
}

// ===================================================================
// Helpers
// ===================================================================
function renderGenres(genres) {
  if (!genres) return "-";
  return genres.split(", ")
    .map(g => `<span class="genre-tag">${escapeHtml(g.trim())}</span>`)
    .join("");
}

function fmtDate(d) {
  if (!d) return "-";
  return d.replace(/\/+$/, "").replace(/\//g, "-");
}

function escapeHtml(s) {
  if (s == null) return "";
  return String(s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function openModal(title) {
  document.getElementById("statusText").textContent = title || "Veriler alınıyor...";
  document.getElementById("stageText").textContent = "";
  document.getElementById("progressFill").style.width = "0%";
  document.getElementById("progressFill").style.backgroundColor = "";
  document.getElementById("progressPercent").textContent = "0%";
  document.getElementById("showBtn").classList.add("hidden");
  document.getElementById("modal").classList.remove("hidden");
}

function closeModal() {
  document.getElementById("modal").classList.add("hidden");
}

let toastTimer = null;
function showToast(msg, type = "info") {
  const t = document.getElementById("toast");
  t.textContent = msg;
  t.className = "toast " + type;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add("hidden"), 3000);
}

// Enter key triggers search
document.getElementById("username").addEventListener("keydown", e => {
  if (e.key === "Enter") startScrape();
});
