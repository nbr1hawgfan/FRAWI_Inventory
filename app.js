/* Customer Inventory PWA v2 - shared app code. Customer-specific values live in config.js.
   Dashboard, smart search, items, transactions. Cycle counts live in counts.js. */
(function () {
  "use strict";
  const C = window.APP_CONFIG;
  const KEY = "custapp_" + C.customer;
  const $ = (id) => document.getElementById(id);
  const S = { token: null, name: "", role: "customer", features: {}, dash: null, page: 1, pages: 1, query: "", loc: "ALL",
              lastSearch: null, itemSort: { key: "pallets", asc: false }, tx: null, txView: "loads", party: null, tab: "dashboard" };

  /* ---------- helpers ---------- */
  const store = {
    get() { try { return JSON.parse(localStorage.getItem(KEY) || "null"); } catch { return null; } },
    set(v) { try { localStorage.setItem(KEY, JSON.stringify(v)); } catch { /* private mode */ } },
    clear() { try { localStorage.removeItem(KEY); } catch { /* ignore */ } },
  };
  const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const num = (v) => (v === null || v === undefined || v === "") ? "" : Number(v).toLocaleString("en-US");
  const plural = (n, w) => `${num(n)} ${w}${Number(n) === 1 ? "" : "s"}`;
  function fmtDate(v) {                     // 'YYYY-MM-DD' -> MM/DD/YYYY without timezone shifts
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(v || ""); return m ? `${m[2]}/${m[3]}/${m[1]}` : "";
  }
  function fmtStamp(v) {                    // timestamp -> "Oct 19, 2:05 PM"
    if (!v) return ""; const d = new Date(v);
    return isNaN(d) ? "" : d.toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  }
  function xlDate(v) { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(v || ""); return m ? new Date(+m[1], +m[2] - 1, +m[3]) : ""; }
  function isoLocal(d) { return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; }
  function busy(on, text) { $("busyText").textContent = text || "Loading"; $("busy").hidden = !on; }
  let toastTimer = null;
  function toast(msg, ms = 3200) {
    $("toast").textContent = msg; $("toast").hidden = false;
    clearTimeout(toastTimer); toastTimer = setTimeout(() => ($("toast").hidden = true), ms);
  }
  const fail = (e) => { if (e && e.message !== "SESSION_EXPIRED") alert(e.message); };

  const NUM_KEYS = new Set(["qty", "age_days", "pallets", "bays", "max_age", "loads", "expected_qty", "counted_qty", "diff"]);
  const DATE_KEYS = new Set(["date_received", "date", "oldest", "first", "last"]);

  async function api(action, payload = {}) {
    let res;
    try {
      res = await fetch(C.api, { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, token: S.token, ...payload }) });
    } catch {
      throw new Error("Can't reach the inventory server. Check your connection and try again.");
    }
    const data = await res.json().catch(() => ({}));
    if (res.status === 401 && data.error === "SESSION_EXPIRED") { signOut(true); throw new Error("SESSION_EXPIRED"); }
    if (!res.ok) throw new Error(data.error || "Something went wrong. Please try again.");
    return data;
  }

  /* ---------- dialog ---------- */
  let modalOnClose = null;
  function openModal(title, bodyHtml, buttons, onClose) {
    $("modalTitle").textContent = title;
    $("modalBody").innerHTML = bodyHtml;
    $("modalFoot").innerHTML = "";
    buttons.forEach((b) => {
      const el = document.createElement("button");
      el.className = "btn " + (b.cls || ""); el.textContent = b.label;
      el.onclick = b.onClick || closeModal;
      $("modalFoot").appendChild(el);
    });
    modalOnClose = onClose || null;
    $("modal").hidden = false;
    const first = $("modalBody").querySelector("input,select,textarea");
    if (first) setTimeout(() => first.focus(), 30);
  }
  function closeModal() { $("modal").hidden = true; if (modalOnClose) { const f = modalOnClose; modalOnClose = null; f(); } }
  function confirmBox(title, html, okLabel, okCls) {
    return new Promise((resolve) => {
      let answered = false;
      openModal(title, html, [
        { label: "Go back", onClick: () => { answered = true; closeModal(); resolve(false); } },
        { label: okLabel, cls: okCls || "primary", onClick: () => { answered = true; closeModal(); resolve(true); } },
      ], () => { if (!answered) resolve(false); });
    });
  }
  $("modalClose").onclick = closeModal;
  $("modal").addEventListener("click", (e) => { if (e.target === $("modal")) closeModal(); });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !$("modal").hidden) closeModal(); });

  /* ---------- sign in / out ---------- */
  async function signIn() {
    const pin = $("pin").value.trim();
    $("loginMsg").textContent = "";
    if (!/^\d{6,8}$/.test(pin)) { $("loginMsg").textContent = "Your PIN is 6 to 8 digits."; return; }
    $("loginBtn").disabled = true; $("loginBtn").textContent = "Signing in";
    try {
      const r = await api("login", { customer: C.customer, pin });
      Object.assign(S, { token: r.token, name: r.name, role: r.role || "customer", features: r.features || {} });
      store.set({ token: r.token, name: r.name, role: S.role, features: S.features });
      $("pin").value = "";
      await openApp();
    } catch (e) {
      $("loginMsg").textContent = e.message;
    } finally {
      $("loginBtn").disabled = false; $("loginBtn").textContent = "Sign in";
    }
  }

  function signOut(expired) {
    if (S.token && !expired) api("logout").catch(() => {});
    S.token = null; store.clear();
    $("app").hidden = true; $("login").hidden = false; closeModal();
    $("loginMsg").textContent = expired ? "Your session ended. Sign in again to continue." : "";
    $("pin").focus();
  }

  async function openApp() {
    $("login").hidden = true; $("app").hidden = false;
    $("userName").textContent = S.name;
    $("roleTag").hidden = S.role !== "lwh";
    $("countsTab").hidden = !S.features.cycle_counts;
    busy(true, "Loading inventory");
    try {
      await loadDashboard();
      if (S.features.cycle_counts && window.Counts) window.Counts.summary();
      const hashTab = (location.hash || "").replace("#", "");
      showTab(["inventory", "items", "transactions", "counts"].includes(hashTab) ? hashTab : "dashboard");
    } catch (e) { fail(e); }
    finally { busy(false); }
  }

  /* ---------- weather + clock ---------- */
  const WX = { 0: "Clear", 1: "Mostly clear", 2: "Partly cloudy", 3: "Cloudy", 45: "Fog", 48: "Fog", 51: "Light drizzle", 53: "Drizzle",
    55: "Heavy drizzle", 56: "Freezing drizzle", 57: "Freezing drizzle", 61: "Light rain", 63: "Rain", 65: "Heavy rain",
    66: "Freezing rain", 67: "Freezing rain", 71: "Light snow", 73: "Snow", 75: "Heavy snow", 77: "Snow", 80: "Showers",
    81: "Showers", 82: "Heavy showers", 85: "Snow showers", 86: "Snow showers", 95: "Thunderstorms", 96: "Thunderstorms", 99: "Thunderstorms" };
  function tick() {
    $("wxTime").textContent = new Date().toLocaleString("en-US", { weekday: "short", hour: "numeric", minute: "2-digit" });
  }
  async function weather() {
    if (!C.weather) return;
    try {
      const u = `https://api.open-meteo.com/v1/forecast?latitude=${C.weather.lat}&longitude=${C.weather.lon}` +
        "&current=temperature_2m,weather_code&daily=temperature_2m_max,temperature_2m_min,weather_code,precipitation_probability_max" +
        "&temperature_unit=fahrenheit&timezone=America%2FChicago&forecast_days=1";
      const w = await (await fetch(u)).json();
      $("wxNow").textContent = `${Math.round(w.current.temperature_2m)}°F ${WX[w.current.weather_code] || ""} · ${C.weather.place}`;
      const d = w.daily, rain = d.precipitation_probability_max && d.precipitation_probability_max[0];
      $("wxDay").textContent = `Today ${WX[d.weather_code[0]] || ""}, high ${Math.round(d.temperature_2m_max[0])}° / low ${Math.round(d.temperature_2m_min[0])}°` +
        (rain ? `, ${rain}% rain` : "");
    } catch { /* weather is a nice-to-have */ }
  }
  tick(); setInterval(tick, 30000);
  weather(); setInterval(weather, 30 * 60000);

  /* ---------- dashboard ---------- */
  async function loadDashboard() {
    S.dash = await api("dashboard");
    renderDashboard();
  }

  function renderDashboard() {
    const d = S.dash;
    $("tPallets").textContent = num(d.total_pallets);
    $("tQty").textContent = num(d.total_qty);
    $("tItems").textContent = num(d.total_items);
    $("tBays").textContent = num(d.total_bays);
    if (d.as_of) $("asOf").textContent = "Inventory updated " + fmtStamp(d.as_of);
    if (d.has_customer_ids === false) {   // no customer tags yet: don't advertise searching by them
      $("dq").placeholder = "Item #, description, LWH ID, bay, receipt...";
      $("txQ").placeholder = "Find in these transactions: item #, bill-to ref, INV receipt, LWH ID, shipper";
    }

    const maxAge = Math.max(1, ...d.aging.map((a) => a.pallets));
    $("dashAging").innerHTML = d.aging.map((a, i) => `<div class="hbar${i >= 3 ? " old" : ""}" title="${num(a.qty)} qty">
        <span>${esc(a.bucket)}</span><div class="track"><div class="fill" style="width:${(a.pallets / maxAge * 100).toFixed(1)}%"></div></div>
        <span class="val">${plural(a.pallets, "pallet")}</span></div>`).join("");

    // last 14 days, oldest on the left
    const days = [];
    for (let i = 13; i >= 0; i--) { const t = new Date(); t.setDate(t.getDate() - i); days.push(isoLocal(t)); }
    const by = {}; d.activity.forEach((a) => { (by[a.date] = by[a.date] || {})[a.direction] = a; });
    const maxP = Math.max(1, ...d.activity.map((a) => a.pallets));
    let tin = 0, tout = 0;
    const bars = days.map((day) => {
      const i = (by[day] || {}).Inbound, o = (by[day] || {}).Outbound;
      tin += i ? i.pallets : 0; tout += o ? o.pallets : 0;
      return `<div class="act-day" title="${fmtDate(day)}: in ${num(i ? i.pallets : 0)}, out ${num(o ? o.pallets : 0)} pallets">
        <span class="act-in" style="height:${((i ? i.pallets : 0) / maxP * 100).toFixed(1)}%"></span>
        <span class="act-out" style="height:${((o ? o.pallets : 0) / maxP * 100).toFixed(1)}%"></span></div>`;
    }).join("");
    $("dashActivity").innerHTML = `<div class="act-legend"><span><i class="act-in"></i>Inbound</span><span><i class="act-out"></i>Outbound</span></div>
      <div class="act-chart">${bars}</div>
      <div class="act-axis"><span>${fmtDate(days[0])}</span><span>Today</span></div>
      <p class="act-sum"><strong>${num(tin)}</strong> pallets in, <strong>${num(tout)}</strong> out.
        <button class="btn link" data-goto="transactions">See transactions</button></p>`;

    $("dashTop").querySelector("tbody").innerHTML = d.items.slice(0, 10).map((i) => `<tr class="clickable" data-item="${esc(i.item_number)}" tabindex="0">
        <td>${esc(i.item_number)}</td><td class="wrap">${esc(i.description)}</td><td class="r">${num(i.pallets)}</td>
        <td class="r">${num(i.qty)}</td><td class="r">${num(i.bays)}</td><td class="r">${num(i.max_age)}</td></tr>`).join("")
      || `<tr><td class="empty" colspan="6">No inventory on hand.</td></tr>`;

    $("cardLocs").hidden = d.locations.length < 2;
    const maxL = Math.max(1, ...d.locations.map((l) => l.pallets));
    $("dashLocs").innerHTML = d.locations.map((l) => `<div class="hbar"><span>${esc(l.label)}</span>
        <div class="track"><div class="fill" style="width:${(l.pallets / maxL * 100).toFixed(1)}%"></div></div>
        <span class="val">${plural(l.pallets, "pallet")}</span></div>`).join("");

    const sel = $("loc");
    sel.innerHTML = '<option value="ALL">All warehouses</option>' +
      d.locations.map((l) => `<option value="${esc(l.code)}">${esc(l.label)} (${num(l.pallets)})</option>`).join("");
    sel.hidden = d.locations.length < 2;
    $("cardCounts").hidden = !S.features.cycle_counts;
    renderItems();
  }

  /* ---------- type-ahead ---------- */
  function quoteIfNeeded(v) { return /\s/.test(v) ? `"${v}"` : v; }
  function attachSuggest(input, box, onPick) {
    let timer = null, seq = 0, opts = [], on = -1;
    const close = () => { box.hidden = true; opts = []; on = -1; };
    const paint = () => {
      box.innerHTML = opts.map((o, i) => `<button type="button" data-i="${i}" class="${i === on ? "on" : ""}">
          <span>${esc(o.label)}${o.sub ? ` <span class="sub">${esc(o.sub)}</span>` : ""}</span><span class="kind">${esc(o.kind)}</span></button>`).join("");
      box.hidden = !opts.length;
    };
    input.addEventListener("input", () => {
      clearTimeout(timer);
      const v = input.value.trim();
      if (v.length < 2 || /[\n,]/.test(input.value) || v.includes(":")) return close();
      timer = setTimeout(async () => {
        const my = ++seq;
        try {
          const r = await api("suggest", { text: v });
          if (my !== seq) return;
          opts = r.items.map((i) => ({ kind: "Item", label: i.item_number, sub: (i.description !== i.item_number ? i.description + " · " : "") + plural(i.pallets, "pallet"),
                                       value: "item:" + quoteIfNeeded(i.item_number) }))
            .concat(r.bays.map((b) => ({ kind: "Bay", label: b.bay, sub: plural(b.pallets, "pallet"), value: "bay:" + b.bay })));
          on = -1; paint();
        } catch { close(); }
      }, 220);
    });
    input.addEventListener("keydown", (e) => {
      if (box.hidden) return;
      if (e.key === "ArrowDown") { on = Math.min(opts.length - 1, on + 1); paint(); e.preventDefault(); }
      else if (e.key === "ArrowUp") { on = Math.max(-1, on - 1); paint(); e.preventDefault(); }
      else if (e.key === "Enter" && on >= 0) { e.preventDefault(); e.stopImmediatePropagation(); const o = opts[on]; close(); onPick(o.value); }
      else if (e.key === "Escape") close();
    });
    box.addEventListener("mousedown", (e) => {
      const b = e.target.closest("button[data-i]"); if (!b) return;
      e.preventDefault(); const o = opts[+b.dataset.i]; close(); onPick(o.value);
    });
    input.addEventListener("blur", () => setTimeout(close, 150));
  }

  /* ---------- inventory (smart search) ---------- */
  /* Customer ID only shows once this customer's own tags are in the WMS (Trane from January). */
  function columns() {
    const hasCust = S.dash.has_customer_ids !== false;
    return S.dash.customer.columns.filter((c) => c.key !== "customer_id" || hasCust);
  }

  function cell(key, row) {
    const v = row[key];
    if (DATE_KEYS.has(key)) return `<td>${fmtDate(v)}</td>`;
    if (NUM_KEYS.has(key)) return `<td class="r">${num(v)}</td>`;
    if (key === "item_description") return `<td class="wrap">${esc(v)}</td>`;
    return `<td>${esc(v)}</td>`;
  }

  async function search(page) {
    S.query = $("q").value.trim(); S.loc = $("loc").value || "ALL";
    busy(true, "Searching");
    try {
      const r = await api("search", { query: S.query, location: S.loc, page });
      S.page = r.page; S.pages = r.pages; S.lastSearch = r;
      const cols = columns(), showMatch = !!S.query;
      $("invTable").querySelector("thead").innerHTML = "<tr>" +
        cols.map((c) => `<th${NUM_KEYS.has(c.key) ? ' class="r"' : ""}>${esc(c.label)}</th>`).join("") +
        (showMatch ? "<th>Matched on</th>" : "") + "</tr>";
      $("invTable").querySelector("tbody").innerHTML = r.rows.length
        ? r.rows.map((row) => "<tr>" + cols.map((c) => cell(c.key, row)).join("") +
            (showMatch ? `<td><span class="match">${esc(row.matched_on)}</span></td>` : "") + "</tr>").join("")
        : `<tr><td class="empty" colspan="${cols.length + 1}">Nothing matches "${esc(S.query)}". Try fewer words, part of a number, or the search tips above.</td></tr>`;
      const nf = r.not_found || [];
      $("notFound").hidden = !nf.length;
      if (nf.length) $("notFound").innerHTML = `<span><strong>${nf.length === 1 ? "1 entry" : num(nf.length) + " entries"} not found</strong> in current inventory: ${esc(nf.slice(0, 40).join(", "))}${nf.length > 40 ? " ..." : ""}</span>`;
      const extra = r.mode === "bulk" ? " from your list" : "";
      $("invInfo").textContent = S.query
        ? `${plural(r.total, "pallet")} found${extra} (qty ${num(r.qty)})`
        : `${plural(r.total, "pallet")} on hand (qty ${num(r.qty)})`;
      $("pageInfo").textContent = `Page ${S.page} of ${S.pages}`;
      $("prevBtn").disabled = S.page <= 1; $("nextBtn").disabled = S.page >= S.pages;
      $("countTheseBtn").hidden = !(S.features.cycle_counts && S.query && r.total > 0);
    } catch (e) { fail(e); }
    finally { busy(false); }
  }

  function runSearch(q) {
    $("q").value = q; autosize($("q")); showTab("inventory"); search(1);
  }
  function autosize(t) { t.style.height = "auto"; t.style.height = Math.min(240, Math.max(52, t.scrollHeight + 4)) + "px"; }

  /* ---------- items ---------- */
  function renderItems() {
    const f = $("itemFilter").value.trim().toUpperCase();
    const { key, asc } = S.itemSort;
    let rows = S.dash.items.filter((i) => !f || (i.item_number || "").toUpperCase().includes(f) ||
                                             (i.description || "").toUpperCase().includes(f));
    rows = rows.slice().sort((a, b) => {
      const x = a[key] ?? "", y = b[key] ?? "";
      const c = typeof x === "number" ? x - y : String(x).localeCompare(String(y), "en", { numeric: true });
      return asc ? c : -c;
    });
    $("itemTable").querySelectorAll("th[data-sort]").forEach((th) => {
      th.classList.toggle("sorted", th.dataset.sort === key);
      th.classList.toggle("asc", th.dataset.sort === key && asc);
    });
    const cc = S.features.cycle_counts;
    $("itemTable").querySelector("tbody").innerHTML = rows.length ? rows.slice(0, 1000).map((i) => `<tr>
        <td>${esc(i.item_number)}</td><td class="wrap">${esc(i.description)}</td>
        <td class="r">${num(i.pallets)}</td><td class="r">${num(i.qty)}</td><td class="r">${num(i.bays)}</td>
        <td>${fmtDate(i.oldest)}</td><td class="r">${num(i.max_age)}</td>
        <td><button class="btn link" data-item="${esc(i.item_number)}">View pallets</button>${cc
          ? ` <button class="btn link" data-count-item="${esc(i.item_number)}">Count</button>` : ""}</td></tr>`).join("")
      : `<tr><td class="empty" colspan="8">No items match "${esc(f)}".</td></tr>`;
    $("itemInfo").textContent = `${num(rows.length)} of ${num(S.dash.items.length)} item numbers`;
    S.itemRows = rows;
  }

  /* ---------- transactions ---------- */
  function setRange(days) {
    const to = new Date(), from = new Date();
    if (days === 1) { to.setDate(to.getDate() - 1); from.setDate(from.getDate() - 1); }
    else if (days > 1) from.setDate(from.getDate() - (days - 1));
    $("txFrom").value = isoLocal(from); $("txTo").value = isoLocal(to);
  }

  async function loadTx(log) {
    busy(true, "Loading transactions");
    try {
      S.party = null;
      S.tx = await api("transactions", { from: $("txFrom").value, to: $("txTo").value, direction: $("txDir").value, log: !!log });
      if (S.tx.from !== $("txFrom").value) $("txFrom").value = S.tx.from;
      renderTx();
      return S.tx;
    } catch (e) { fail(e); return null; }
    finally { busy(false); }
  }

  const LOAD_COLS = [["date", "Date"], ["direction", "Direction"], ["inv_receipt", "INV Receipt"], ["bill_to_ref", "Bill-To Ref"],
    ["pallets", "Pallets"], ["qty", "Qty"], ["items", "Item #s"], ["carrier", "Carrier"], ["trailer", "Trailer"],
    ["seal", "Seal"], ["shipper", "Shipper"], ["consignee", "Consignee"], ["location", "Warehouse"], ["status", "Status"]];
  const PALLET_COLS = [["date", "Date"], ["direction", "Direction"], ["inv_receipt", "INV Receipt"], ["bill_to_ref", "Bill-To Ref"],
    ["lwh_id", "LWH ID"], ["customer_id", "Customer ID"], ["item_number", "Item #"], ["item_description", "Item Description"],
    ["qty", "Qty"], ["location", "Warehouse"]];

  const palletCols = () => (S.dash && S.dash.has_customer_ids === false ? PALLET_COLS.filter(([k]) => k !== "customer_id") : PALLET_COLS);

  const OPEN_LABEL = "Not closed out yet";
  const partyOf = (l) => (l.direction === "Inbound" ? l.shipper : l.consignee) || (l.status === "Open" ? OPEN_LABEL : "Not recorded");
  const PARTY_COLS = [["party", "Shipper / Consignee"], ["direction", "Direction"], ["loads", "Loads"], ["pallets", "Pallets"],
    ["qty", "Qty"], ["first", "First Load"], ["last", "Last Load"]];

  function searched() {
    const t = S.tx, q = ($("txQ").value || "").trim().toUpperCase();
    if (!q) return { loads: t.loads, pallets: t.pallets };
    const has = (v) => String(v ?? "").toUpperCase().includes(q);
    const loadHit = new Set(t.loads.filter((l) => [l.inv_receipt, l.bill_to_ref, l.items, l.shipper, l.consignee, l.carrier, l.trailer].some(has))
                                    .map((l) => l.inv_receipt));
    const pallets = t.pallets.filter((p) => loadHit.has(p.inv_receipt) ||
      [p.item_number, p.item_description, p.bill_to_ref, p.inv_receipt, p.lwh_id, p.customer_id, p.lot_number].some(has));
    const ids = new Set([...loadHit, ...pallets.map((p) => p.inv_receipt)]);
    return { loads: t.loads.filter((l) => ids.has(l.inv_receipt)), pallets };
  }

  function partners() {
    const m = new Map();
    searched().loads.forEach((l) => {
      const k = l.direction + "|" + partyOf(l);
      const p = m.get(k) || { party: partyOf(l), direction: l.direction, loads: 0, pallets: 0, qty: 0, first: l.date, last: l.date };
      p.loads++; p.pallets += Number(l.pallets) || 0; p.qty += Number(l.qty) || 0;
      if (l.date < p.first) p.first = l.date; if (l.date > p.last) p.last = l.date;
      m.set(k, p);
    });
    return [...m.values()].sort((a, b) => (a.direction === b.direction ? b.loads - a.loads || a.party.localeCompare(b.party)
                                            : a.direction === "Inbound" ? -1 : 1));
  }

  function filtered() {
    const base = searched(), f = S.party;
    if (!f) return base;
    const loads = base.loads.filter((l) => l.direction === f.direction && partyOf(l) === f.party);
    const ids = new Set(loads.map((l) => l.inv_receipt));
    return { loads, pallets: base.pallets.filter((p) => ids.has(p.inv_receipt)) };
  }

  function setView(v) {
    S.txView = v;
    document.querySelectorAll("#txSeg .seg-btn").forEach((x) => x.classList.toggle("active", x.dataset.view === v));
    renderTx();
  }

  function renderTx() {
    const t = S.tx; if (!t) return;
    const T = t.totals;
    $("txTotals").innerHTML = `
      <div class="tx-box"><h3>Inbound</h3><p><strong>${num(T.inbound_loads)}</strong> loads &middot; <strong>${num(T.inbound_pallets)}</strong> pallets &middot; qty <strong>${num(T.inbound_qty)}</strong></p></div>
      <div class="tx-box out"><h3>Outbound</h3><p><strong>${num(T.outbound_loads)}</strong> loads &middot; <strong>${num(T.outbound_pallets)}</strong> pallets &middot; qty <strong>${num(T.outbound_qty)}</strong></p></div>`;

    const f = S.party, data = filtered();
    $("txFilter").hidden = !f || S.txView === "partners";
    if (f) $("txFilterText").textContent = `Showing ${f.direction.toLowerCase()} loads for ${f.party}: ${plural(data.loads.length, "load")}, ${plural(data.pallets.length, "pallet")}`;
    const q = $("txQ").value.trim();
    const range = `${fmtDate(t.from)} to ${fmtDate(t.to)}` + (q ? ` matching "${q}"` : "");

    if (S.txView === "partners") {
      const rows = partners(), max = Math.max(1, ...rows.map((r) => r.loads));
      $("txTable").querySelector("thead").innerHTML = "<tr>" + PARTY_COLS.map(([k, l]) => `<th${NUM_KEYS.has(k) ? ' class="r"' : ""}>${l}</th>`).join("") + "<th></th></tr>";
      $("txTable").querySelector("tbody").innerHTML = rows.length ? rows.map((r, i) => `<tr class="clickable" data-i="${i}" tabindex="0" title="Show these loads">
          <td>${esc(r.party)}</td><td><span class="dir ${r.direction}">${r.direction}</span></td>
          <td class="r"><strong>${num(r.loads)}</strong></td><td class="r">${num(r.pallets)}</td><td class="r">${num(r.qty)}</td>
          <td>${fmtDate(r.first)}</td><td>${fmtDate(r.last)}</td>
          <td class="bar-cell"><div class="bar ${r.direction === "Inbound" ? "in" : ""}" style="width:${Math.round(r.loads / max * 100)}%"></div></td></tr>`).join("")
        : `<tr><td class="empty" colspan="8">No loads in this date range.</td></tr>`;
      S.partnerRows = rows;
      const nIn = rows.filter((r) => r.direction === "Inbound").length;
      $("txInfo").textContent = rows.length
        ? `${range}: ${plural(nIn, "shipper")} sent inbound loads. Select a row to see those loads.`
        : `${range}: nothing found. Try part of the number, or widen the dates.`;
      return;
    }

    const loads = S.txView === "loads", cols = loads ? LOAD_COLS : palletCols(), rows = loads ? data.loads : data.pallets;
    $("txTable").querySelector("thead").innerHTML = "<tr>" + cols.map(([k, l]) => `<th${NUM_KEYS.has(k) ? ' class="r"' : ""}>${l}</th>`).join("") + "</tr>";
    $("txTable").querySelector("tbody").innerHTML = rows.length ? rows.map((r) => "<tr>" + cols.map(([k]) => {
      if (k === "direction") return `<td><span class="dir ${esc(r[k])}">${esc(r[k])}</span></td>`;
      if (k === "status") return `<td class="${r[k] === "Open" ? "status-open" : ""}">${esc(r[k] === "Open" ? "Open (not closed out)" : r[k])}</td>`;
      if (k === "items") return `<td class="wrap">${esc(r[k])}</td>`;
      return cell(k, r);
    }).join("") + "</tr>").join("")
      : `<tr><td class="empty" colspan="${cols.length}">No ${loads ? "loads" : "pallets"} in this date range.</td></tr>`;
    $("txInfo").textContent = rows.length || !q
      ? `${range}: ${plural(rows.length, loads ? "load" : "pallet")}`
      : `${range}: nothing found. Try part of the number, or widen the dates.`;
  }

  /* ---------- Excel ---------- */
  function sheet(cols, rows) {
    const aoa = [cols.map((c) => c[1])].concat(rows.map((r) => cols.map(([k]) => {
      const v = r[k];
      if (DATE_KEYS.has(k)) return xlDate(v);
      if (NUM_KEYS.has(k)) return v === null || v === undefined || v === "" ? "" : Number(v);
      return v === null || v === undefined ? "" : String(v);   // IDs stay text
    })));
    const ws = XLSX.utils.aoa_to_sheet(aoa, { cellDates: true, dateNF: "mm/dd/yyyy" });
    ws["!cols"] = cols.map(([k, l]) => ({ wch: Math.min(48, Math.max(l.length + 2,
      ...rows.slice(0, 300).map((r) => String(r[k] ?? "").length + 2))) }));
    if (aoa.length > 1) ws["!autofilter"] = { ref: XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: aoa.length - 1, c: cols.length - 1 } }) };
    return ws;
  }
  const safeTab = (s) => String(s).replace(/[\\/?*[\]:]/g, " ").slice(0, 31);
  const stamp = () => isoLocal(new Date());
  function xlsxReady() { if (!window.XLSX) { alert("The Excel tool didn't load. Refresh the page and try again."); return false; } return true; }

  async function exportInventory() {
    if (!xlsxReady()) return;
    busy(true, "Building Excel file");
    try {
      const r = await api("export", { query: $("q").value.trim(), location: $("loc").value || "ALL" });
      const cols = columns().map((c) => [c.key, c.label]);
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, sheet(cols, r.rows), "Inventory");
      if ((r.not_found || []).length) XLSX.utils.book_append_sheet(wb, sheet([["id", "Not found"]], r.not_found.map((id) => ({ id }))), "Not Found");
      const byLoc = {};
      r.rows.forEach((row) => (byLoc[row.location_code] = byLoc[row.location_code] || []).push(row));
      if (Object.keys(byLoc).length > 1) {
        S.dash.locations.forEach((l) => { if (byLoc[l.code]) XLSX.utils.book_append_sheet(wb, sheet(cols, byLoc[l.code]), safeTab(l.label)); });
      }
      XLSX.writeFile(wb, `${C.fileBase} Inventory ${stamp()}.xlsx`);
    } catch (e) { fail(e); }
    finally { busy(false); }
  }

  function exportItems() {
    if (!xlsxReady()) return;
    const cols = [["item_number", "Item #"], ["description", "Item Description"], ["pallets", "Pallets"], ["qty", "Qty"],
      ["bays", "Bays"], ["oldest", "Oldest Received"], ["max_age", "Oldest Age (Days)"]];
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, sheet(cols, S.itemRows || S.dash.items), "Item Summary");
    XLSX.writeFile(wb, `${C.fileBase} Item Summary ${stamp()}.xlsx`);
  }

  async function exportTx() {
    if (!xlsxReady()) return;
    const keep = S.party;
    const t = await loadTx(true); if (!t) return;
    if (keep) { S.party = keep; renderTx(); }
    const data = filtered(), wb = XLSX.utils.book_new();
    if (!keep) XLSX.utils.book_append_sheet(wb, sheet(PARTY_COLS, partners()), "By Shipper");
    XLSX.utils.book_append_sheet(wb, sheet(LOAD_COLS, data.loads), "Loads");
    XLSX.utils.book_append_sheet(wb, sheet(palletCols(), data.pallets), "Pallets");
    const tag = [keep ? keep.party : "", $("txQ").value.trim()].filter(Boolean).join(" ");
    const who = tag ? " " + tag.replace(/[^\w\- ]/g, "").slice(0, 40) : "";
    XLSX.writeFile(wb, `${C.fileBase} Transactions${who} ${t.from} to ${t.to}.xlsx`);
  }

  /* "Request a count of these": all matching pallets -> their item numbers (or the bays, for a bay search) */
  async function countThese() {
    busy(true, "Getting the pallets");
    try {
      const q = $("q").value.trim();
      const r = await api("export", { query: q, location: $("loc").value || "ALL", purpose: "count" });
      const bayOnly = /^bay:/i.test(q) && !/\s/.test(q.replace(/^bay:\S+/i, "").trim());
      const items = [...new Set(r.rows.map((x) => x.item_number))];
      const bays = [...new Set(r.rows.map((x) => x.bay))];
      busy(false);
      if (r.mode === "bulk" && r.rows.length <= 500) window.Counts.request({ type: "pallets", values: r.rows.map((x) => x.lwh_id) });
      else if (bayOnly || items.length > 500) window.Counts.request({ type: "bays", values: bays });
      else window.Counts.request({ type: "items", values: items });
    } catch (e) { busy(false); fail(e); }
  }

  /* ---------- tabs + wiring ---------- */
  function showTab(name) {
    if (name === "counts" && !S.features.cycle_counts) name = "dashboard";
    S.tab = name;
    document.querySelectorAll(".tab").forEach((b) => b.classList.toggle("active", b.dataset.tab === name));
    ["dashboard", "inventory", "items", "transactions", "counts"].forEach((t) => ($("tab-" + t).hidden = t !== name));
    try { history.replaceState(null, "", name === "dashboard" ? location.pathname : "#" + name); } catch { /* ignore */ }
    if (name === "inventory" && !S.lastSearch) search(1);
    if (name === "transactions" && !S.tx) loadTx(false);
    if (name === "counts" && window.Counts) window.Counts.show();
    window.scrollTo(0, 0);
  }

  document.title = C.title;
  $("loginTitle").textContent = C.title; $("appTitle").textContent = C.title;
  $("loginBtn").onclick = signIn;
  $("pin").addEventListener("keydown", (e) => { if (e.key === "Enter") signIn(); });
  $("logoutBtn").onclick = () => signOut(false);
  document.querySelectorAll(".tab").forEach((b) => (b.onclick = () => showTab(b.dataset.tab)));
  document.addEventListener("click", (e) => {
    const g = e.target.closest("[data-goto]"); if (g) showTab(g.dataset.goto);
  });

  // dashboard search + top items
  attachSuggest($("dq"), $("dqSuggest"), (v) => runSearch(v));
  $("dqBtn").onclick = () => runSearch($("dq").value.trim());
  $("dq").addEventListener("keydown", (e) => { if (e.key === "Enter") runSearch($("dq").value.trim()); });
  $("dashTop").addEventListener("click", (e) => { const tr = e.target.closest("tr[data-item]"); if (tr) runSearch("item:" + quoteIfNeeded(tr.dataset.item)); });
  $("dashTop").addEventListener("keydown", (e) => { const tr = e.target.closest("tr[data-item]"); if (tr && e.key === "Enter") runSearch("item:" + quoteIfNeeded(tr.dataset.item)); });

  // inventory
  attachSuggest($("q"), $("qSuggest"), (v) => { $("q").value = v; search(1); });
  $("searchBtn").onclick = () => search(1);
  $("clearBtn").onclick = () => { $("q").value = ""; autosize($("q")); search(1); };
  $("q").addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); search(1); } });
  $("q").addEventListener("input", () => autosize($("q")));
  $("q").addEventListener("paste", () => setTimeout(() => autosize($("q")), 0));
  $("loc").onchange = () => search(1);
  $("prevBtn").onclick = () => search(S.page - 1);
  $("nextBtn").onclick = () => search(S.page + 1);
  $("exportBtn").onclick = exportInventory;
  $("countTheseBtn").onclick = countThese;
  $("printPalletsBtn").onclick = () => window.Sheets.pallets($("q").value.trim(), $("loc").value || "ALL");
  $("itemPrintBtn").onclick = () => {
    const f = $("itemFilter").value.trim();
    window.Sheets.items(S.itemRows || S.dash.items, f ? `items matching "${f}"` : null);
  };

  // items
  $("itemFilter").addEventListener("input", renderItems);
  $("itemExportBtn").onclick = exportItems;
  $("itemTable").querySelectorAll("th[data-sort]").forEach((th) => (th.onclick = () => {
    const k = th.dataset.sort;
    S.itemSort = { key: k, asc: S.itemSort.key === k ? !S.itemSort.asc : ["item_number", "description", "oldest"].includes(k) };
    renderItems();
  }));
  $("itemTable").addEventListener("click", (e) => {
    const b = e.target.closest("[data-item]");
    if (b) return runSearch("item:" + quoteIfNeeded(b.dataset.item));
    const c = e.target.closest("[data-count-item]");
    if (c) window.Counts.request({ type: "items", values: [c.dataset.countItem] });
  });

  // transactions
  $("txBtn").onclick = () => loadTx(false);
  $("txExportBtn").onclick = exportTx;
  document.querySelectorAll(".chip[data-days]").forEach((c) => (c.onclick = () => { setRange(+c.dataset.days); loadTx(false); }));
  document.querySelectorAll("#txSeg .seg-btn").forEach((b) => (b.onclick = () => setView(b.dataset.view)));
  function pickParty(tr) {
    const r = S.partnerRows && S.partnerRows[+tr.dataset.i]; if (!r) return;
    S.party = { party: r.party, direction: r.direction }; setView("loads");
  }
  $("txTable").addEventListener("click", (e) => { const tr = e.target.closest("tr[data-i]"); if (tr) pickParty(tr); });
  $("txTable").addEventListener("keydown", (e) => { const tr = e.target.closest("tr[data-i]"); if (tr && e.key === "Enter") pickParty(tr); });
  $("txFilterClear").onclick = () => { S.party = null; renderTx(); };
  let txTimer = null;
  $("txQ").addEventListener("input", () => { clearTimeout(txTimer); txTimer = setTimeout(renderTx, 200); });
  setRange(7);

  /* shared with counts.js */
  window.App = { S, $, esc, num, plural, fmtDate, fmtStamp, isoLocal, api, busy, toast, fail, openModal, closeModal,
                 confirmBox, sheet, xlsxReady, stamp, safeTab, showTab, runSearch, quoteIfNeeded, cfg: C };

  if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});

  const saved = store.get();
  if (saved && saved.token) {
    Object.assign(S, { token: saved.token, name: saved.name, role: saved.role || "customer", features: saved.features || {} });
    openApp();
  } else { $("login").hidden = false; $("pin").focus(); }
})();
