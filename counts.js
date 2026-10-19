/* Cycle counts: request, count, review, results, schedules.
   Uses the shared helpers app.js puts on window.App. */
(function () {
  "use strict";
  const A = window.App;
  const { $, esc, num, plural, fmtDate, fmtStamp, api, busy, toast, fail, openModal, closeModal, confirmBox } = A;
  const CS = { which: "open", list: [], detail: null, bay: null, filter: "var", keepQty: false, selected: new Set(), cam: null };

  const isLwh = () => A.S.role === "lwh";
  const STATUS = { requested: "Requested", in_progress: "Counting", review: "In review", closed: "Completed", cancelled: "Cancelled" };
  const RESULT = { pending: "Not counted", counted: "Counted", match: "Match", qty_diff: "Qty off", wrong_bay: "Wrong bay",
                   missing: "Missing", extra: "Not on list", unknown: "Unknown tag" };
  const WEEKDAYS = ["", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
  const pill = (status, overdue) => `<span class="pill ${status}">${STATUS[status] || status}</span>${overdue ? ' <span class="pill overdue">Overdue</span>' : ""}`;
  const res = (r) => `<span class="res ${r}">${RESULT[r] || r}</span>`;
  const pct = (v) => (v === null || v === undefined ? "-" : `${Number(v).toFixed(1)}%`);
  const performerText = (c) => (c.performer === "customer" ? (isLwh() ? "Customer counts" : "You count") : "LWH counts");

  function scopeText(c, max = 8) {
    const s = c.scope || {};
    const list = (arr, word) => {
      const a = arr || [];
      return `${plural(a.length, word)}: ${a.slice(0, max).join(", ")}${a.length > max ? `, +${a.length - max} more` : ""}`;
    };
    if (c.scope_type === "items") return list(s.items, "item");
    if (c.scope_type === "bays") return list(s.bays, "bay");
    if (c.scope_type === "pallets") return list(s.pallets, "pallet");
    return "Everything on hand";
  }

  /* ================= list ================= */
  async function loadList(which) {
    CS.which = which || CS.which;
    document.querySelectorAll("#ccSeg .seg-btn").forEach((b) => b.classList.toggle("active", b.dataset.which === CS.which));
    $("ccList").hidden = CS.which === "schedules"; $("ccSchedules").hidden = CS.which !== "schedules";
    if (CS.which === "schedules") return loadSchedules();
    busy(true, "Loading counts");
    try {
      const r = await api("cc_list", { which: CS.which });
      CS.list = r.counts;
      if (r.made) toast(`${plural(r.made, "scheduled count")} created for today.`);
      renderList();
      if (CS.which === "open") summarize(CS.list);
    } catch (e) { fail(e); }
    finally { busy(false); }
  }

  function renderList() {
    const L = CS.list;
    $("ccInfo").textContent = CS.which === "open"
      ? (L.length ? `${plural(L.length, "open count")}. Select one to see it.` : "No open counts. Use Request a count to start one.")
      : (L.length ? `${plural(L.length, "count")} completed or cancelled in the last year.` : "No completed counts yet.");
    $("ccList").innerHTML = L.map((c) => {
      const st = c.stats || {};
      const done = st.expected_pallets ? Math.round((st.counted_pallets || 0) / st.expected_pallets * 100) : 0;
      let body;
      if (c.status === "closed") {
        body = `<div><span class="acc">${pct(st.pallet_accuracy)}</span> <span class="muted">pallet accuracy</span></div>
                <div class="cc-meta"><span>${plural(st.expected_pallets, "pallet")}</span><span>${plural(st.variances || 0, "variance")}</span>
                <span>Closed ${fmtStamp(c.closed_at)}</span></div>`;
      } else if (c.status === "requested") {
        body = `<div class="cc-meta"><span>${esc(scopeText(c, 4))}</span></div>`;
      } else if (c.status === "cancelled") {
        body = `<div class="cc-meta"><span>${esc(scopeText(c, 4))}</span></div>`;
      } else {
        body = `<div class="progress" title="${done}% counted"><span style="width:${done}%"></span></div>
                <div class="cc-meta"><span>${num(st.counted_pallets)} of ${plural(st.expected_pallets, "pallet")} counted</span>
                <span>${num(st.bays_done)} of ${plural(st.bays_total, "bay")} finished</span>
                ${c.status === "review" && isLwh() ? `<span><strong>${plural(st.unresolved || 0, "variance")} to resolve</strong></span>` : ""}</div>`;
      }
      return `<button class="cc-card st-${c.status}" data-id="${c.id}">
        <div>${pill(c.status, c.overdue)} <span class="pill">${esc(performerText(c))}</span>${c.source === "schedule" ? ' <span class="pill">Scheduled</span>' : ""}</div>
        <h3>#${c.id} &middot; ${esc(c.title)}</h3>
        ${body}
        <div class="cc-meta"><span>Requested by ${esc(c.requested_by)} ${fmtStamp(c.requested_at)}</span>${c.due_date ? `<span>Due ${fmtDate(c.due_date)}</span>` : ""}</div>
      </button>`;
    }).join("");
  }

  /* tab badge + dashboard card */
  function summarize(open) {
    const needs = open.filter((c) => isLwh() ? true : c.status !== "review");
    $("countsBadge").hidden = !needs.length; $("countsBadge").textContent = needs.length;
    const by = (s) => open.filter((c) => c.status === s).length;
    $("dashCounts").innerHTML = `
      <div class="dash-count"><span>Requested, not started</span><strong>${num(by("requested"))}</strong></div>
      <div class="dash-count"><span>Counting now</span><strong>${num(by("in_progress"))}</strong></div>
      <div class="dash-count"><span>Being reviewed by LWH</span><strong>${num(by("review"))}</strong></div>
      ${open.some((c) => c.overdue) ? `<div class="dash-count"><span class="status-open">Overdue</span><strong class="status-open">${num(open.filter((c) => c.overdue).length)}</strong></div>` : ""}
      <div class="dash-count"><button class="btn small primary" id="dashNewCount">Request a count</button>
        <button class="btn small" data-goto="counts">Open counts</button></div>`;
    const b = document.getElementById("dashNewCount"); if (b) b.onclick = () => request();
  }
  async function summary() {
    try { const r = await api("cc_list", { which: "open" }); summarize(r.counts); } catch { /* card stays empty */ }
  }

  /* ================= request dialog ================= */
  function chipEditor(host, initial, kind) {
    const vals = [...new Set((initial || []).map((v) => String(v).trim()).filter(Boolean))];
    host.innerHTML = `<div class="suggest-wrap"><input type="text" class="chip-in" autocomplete="off"
        placeholder="${kind === "items" ? "Type an item # or description, or paste a list" : kind === "bays" ? "Type a bay (E0* = all E0 bays), or paste a list" : "Scan or paste LWH IDs or Customer IDs"}">
        <div class="suggest" hidden></div></div><div class="chips"></div><p class="hint chip-count"></p>`;
    const input = host.querySelector(".chip-in"), box = host.querySelector(".suggest"), chips = host.querySelector(".chips");
    let opts = [], on = -1;
    const paint = () => {
      chips.innerHTML = vals.slice(0, 200).map((v, i) => `<span class="tag-chip">${esc(v)}<button type="button" data-x="${i}" aria-label="Remove ${esc(v)}">&times;</button></span>`).join("")
        + (vals.length > 200 ? `<span class="muted">+${vals.length - 200} more</span>` : "");
      host.querySelector(".chip-count").textContent = vals.length ? plural(vals.length, kind === "items" ? "item" : kind === "bays" ? "bay" : "pallet") + " added" : "";
    };
    const add = (raw, split) => {
      const parts = split ? String(raw).split(/[\n\r\t,;]+/) : [raw];
      parts.map((p) => p.trim()).filter(Boolean).forEach((p) => { if (!vals.some((v) => v.toUpperCase() === p.toUpperCase())) vals.push(p); });
      input.value = ""; box.hidden = true; paint();
    };
    const suggest = () => {
      const t = input.value.trim().toUpperCase(); on = -1;
      if (!t || kind === "pallets") { box.hidden = true; return; }
      const D = A.S.dash;
      opts = kind === "items"
        ? D.items.filter((i) => i.item_number.toUpperCase().startsWith(t) || (i.description || "").toUpperCase().includes(t))
            .slice(0, 8).map((i) => ({ v: i.item_number, sub: plural(i.pallets, "pallet") + (i.description !== i.item_number ? " · " + i.description : "") }))
        : D.bays.filter((b) => b.bay.toUpperCase().startsWith(t.replace("*", ""))).slice(0, 8).map((b) => ({ v: b.bay, sub: plural(b.pallets, "pallet") }));
      box.innerHTML = opts.map((o, i) => `<button type="button" data-i="${i}" class="${i === on ? "on" : ""}"><span>${esc(o.v)} <span class="sub">${esc(o.sub)}</span></span></button>`).join("");
      box.hidden = !opts.length;
    };
    input.addEventListener("input", suggest);
    input.addEventListener("keydown", (e) => {
      if (e.key === "ArrowDown" && !box.hidden) { on = Math.min(opts.length - 1, on + 1); box.querySelectorAll("button").forEach((b, i) => b.classList.toggle("on", i === on)); e.preventDefault(); }
      else if (e.key === "ArrowUp" && !box.hidden) { on = Math.max(-1, on - 1); box.querySelectorAll("button").forEach((b, i) => b.classList.toggle("on", i === on)); e.preventDefault(); }
      else if (e.key === "Enter") { e.preventDefault(); if (!box.hidden && on >= 0) add(opts[on].v); else if (input.value.trim()) add(input.value.trim()); }
    });
    input.addEventListener("paste", (e) => {
      const t = (e.clipboardData || window.clipboardData).getData("text");
      if (/[\n\r\t,;]/.test(t)) { e.preventDefault(); add(t, true); }
    });
    input.addEventListener("blur", () => setTimeout(() => (box.hidden = true), 150));
    box.addEventListener("mousedown", (e) => { const b = e.target.closest("button[data-i]"); if (b) { e.preventDefault(); add(opts[+b.dataset.i].v); input.focus(); } });
    chips.addEventListener("click", (e) => { const b = e.target.closest("button[data-x]"); if (b) { vals.splice(+b.dataset.x, 1); paint(); } });
    paint();
    return { values: () => { if (input.value.trim()) add(input.value.trim()); return vals.slice(); } };
  }

  function request(pre) {
    pre = pre || {};
    const due = new Date(); due.setDate(due.getDate() + 3);
    const lwh = isLwh();
    openModal("Request a cycle count", `
      <div class="field"><span class="lab">What should be counted?</span>
        <div class="choices">
          <label class="choice"><input type="radio" name="ccType" value="items"> Item numbers</label>
          <label class="choice"><input type="radio" name="ccType" value="bays"> Bay locations</label>
          <label class="choice"><input type="radio" name="ccType" value="pallets"> Specific pallets</label>
          <label class="choice" id="ccAllChoice"><input type="radio" name="ccType" value="all"> Everything</label>
        </div></div>
      <div class="field" id="ccValuesField"><span class="lab" id="ccValuesLab">Items</span><div id="ccValues"></div>
        <p class="hint" id="ccValuesHint"></p></div>
      <div class="field"><span class="lab">Who counts it?</span>
        <div class="choices">
          <label class="choice"><input type="radio" name="ccWho" value="lwh" checked> LWH counts it</label>
          <label class="choice"><input type="radio" name="ccWho" value="customer"> ${lwh ? "The customer counts it" : "We will count it ourselves"}</label>
        </div>
        <p class="hint">${lwh ? "" : "LWH reviews every count before results are final."}</p></div>
      <div class="field"><label for="ccDue">Needed by</label><input type="date" id="ccDue" value="${A.isoLocal(due)}"></div>
      <div class="field"><label for="ccTitle">Name (optional)</label><input type="text" id="ccTitle" maxlength="80" placeholder="Example: Month-end check on engines"></div>
      <div class="field"><label for="ccNotes">Notes for LWH (optional)</label><textarea id="ccNotes" maxlength="500"></textarea></div>
      <p class="form-err" id="ccErr"></p>`,
      [{ label: "Cancel" }, { label: "Request count", cls: "primary", onClick: submitRequest }]);

    let editor = null;
    const setType = (t, vals) => {
      document.querySelectorAll('input[name="ccType"]').forEach((r) => (r.checked = r.value === t));
      $("ccValuesField").hidden = t === "all";
      $("ccValuesLab").textContent = { items: "Item numbers", bays: "Bays", pallets: "Pallets (LWH ID or Customer ID)" }[t] || "";
      $("ccValuesHint").textContent = t === "items" ? "Every pallet of these items gets counted, wherever it is."
        : t === "bays" ? "Every pallet in these bays gets counted. Use * for a range, like E0* for E01 to E09."
        : t === "pallets" ? "Only these pallets get counted." : "";
      if (t !== "all") editor = chipEditor($("ccValues"), vals, t);
    };
    const whoAll = () => { // a full count by LWH is scheduled with the rep unless you are LWH
      const who = document.querySelector('input[name="ccWho"]:checked').value;
      $("ccAllChoice").hidden = !lwh && who === "lwh";
      if ($("ccAllChoice").hidden && document.querySelector('input[name="ccType"]:checked')?.value === "all") setType("items", []);
    };
    document.querySelectorAll('input[name="ccType"]').forEach((r) => (r.onchange = () => setType(r.value, [])));
    document.querySelectorAll('input[name="ccWho"]').forEach((r) => (r.onchange = whoAll));
    setType(pre.type || "items", pre.values || []);
    whoAll();

    async function submitRequest() {
      const type = document.querySelector('input[name="ccType"]:checked').value;
      const values = type === "all" ? [] : editor.values();
      $("ccErr").textContent = "";
      if (type !== "all" && !values.length) { $("ccErr").textContent = "Add at least one entry to count."; return; }
      if (values.length > 500) { $("ccErr").textContent = "That is more than 500 entries. Split it into smaller counts."; return; }
      const payload = { scope_type: type, performer: document.querySelector('input[name="ccWho"]:checked').value,
        due_date: $("ccDue").value, title: $("ccTitle").value.trim(), notes: $("ccNotes").value.trim() };
      payload[type] = values;
      busy(true, "Sending request");
      try {
        const r = await api("cc_request", payload);
        closeModal();
        toast(`Count #${r.id} requested: ${plural(r.pallets, "pallet")} right now.`);
        A.showTab("counts"); await openDetail(r.id);
      } catch (e) { if (e.message !== "SESSION_EXPIRED") $("ccErr").textContent = e.message; }
      finally { busy(false); }
    }
  }

  /* ================= detail ================= */
  async function openDetail(id, keepBay) {
    busy(true, "Loading count");
    try {
      CS.detail = await api("cc_get", { id });
      if (!keepBay) { CS.bay = null; CS.selected.clear(); CS.filter = "var"; }
      $("ccListView").hidden = true; $("ccDetail").hidden = false;
      renderDetail();
    } catch (e) { fail(e); }
    finally { busy(false); }
  }
  async function refresh() {
    try { CS.detail = await api("cc_get", { id: CS.detail.count.id }); renderDetail(); } catch (e) { fail(e); }
  }
  function backToList() {
    stopCam(); CS.detail = null; CS.bay = null;
    $("ccDetail").hidden = true; $("ccListView").hidden = false; loadList();
  }

  function renderDetail() {
    const d = CS.detail, c = d.count, st = d.stats || {};
    const canCancel = ["requested", "in_progress"].includes(c.status) && (isLwh() || (c.status === "requested" && c.requested_role !== "lwh"));
    const head = `<div class="cc-head">
      <div><button class="back" id="ccBack">&larr; All counts</button>
        <h2>#${c.id} &middot; ${esc(c.title)}</h2>
        <div>${pill(c.status, c.due_date && c.due_date < A.isoLocal(new Date()) && ["requested", "in_progress"].includes(c.status))}
          <span class="pill">${esc(performerText(c))}</span>${c.source === "schedule" ? ' <span class="pill">Scheduled</span>' : ""}</div>
        <div class="cc-meta" style="margin-top:6px"><span>${esc(scopeText(c))}</span></div>
        <div class="cc-meta"><span>Requested by ${esc(c.requested_by)} ${fmtStamp(c.requested_at)}</span>
          ${c.due_date ? `<span>Due ${fmtDate(c.due_date)}</span>` : ""}
          ${c.started_at ? `<span>Started by ${esc(c.started_by)} ${fmtStamp(c.started_at)}</span>` : ""}
          ${c.submitted_at ? `<span>Submitted ${fmtStamp(c.submitted_at)}</span>` : ""}
          ${c.closed_at ? `<span>Closed by ${esc(c.closed_by)} ${fmtStamp(c.closed_at)}</span>` : ""}</div>
        ${c.notes ? `<div class="cc-meta"><span>Notes: ${esc(c.notes)}</span></div>` : ""}
      </div>
      <div class="cc-actions">
        ${c.status === "in_progress" && d.can_count && d.lines.some((l) => l.expected) ? '<button class="btn" id="ccPrint">Print count sheets</button>' : ""}
        ${d.full ? '<button class="btn red-outline" id="ccExport">Export to Excel</button>' : ""}
        ${canCancel ? '<button class="btn" id="ccCancel">Cancel count</button>' : ""}
      </div></div>`;

    let body = "";
    if (c.status === "cancelled") {
      body = `<div class="notice">This count was cancelled by ${esc(c.cancelled_by)} ${fmtStamp(c.cancelled_at)}.</div>`;
    } else if (c.status === "requested") {
      body = d.can_count
        ? `<div class="notice">When you start, the app takes the list of pallets to expect from current inventory.
             Start when you are at the first bay.</div>
           <button class="btn primary" id="ccStart">Start counting</button>`
        : `<div class="notice">LWH has this request. ${c.due_date ? `It is due ${fmtDate(c.due_date)}.` : ""} You will see the results here once LWH has counted and reviewed it.</div>`;
    } else if (c.status === "in_progress") {
      body = d.can_count ? countingView() : `<div class="notice">LWH is counting now: ${num(st.counted_pallets)} of ${plural(st.expected_pallets, "pallet")} counted,
             ${num(st.bays_done)} of ${plural(st.bays_total, "bay")} finished. Results appear here after review.</div>`;
    } else if (c.status === "review") {
      body = isLwh() ? reviewView() : `<div class="notice amber">Counting is done. LWH is reviewing the results. You will see them here once the count is closed.</div>`;
    } else if (c.status === "closed") {
      body = resultsView();
    }
    $("ccDetail").innerHTML = head + body;
    wireDetail();
  }

  function statTiles(st) {
    return `<div class="stats">
      <div class="stat ${st.pallet_accuracy >= 98 ? "good" : st.pallet_accuracy < 95 ? "bad" : ""}"><span class="num">${pct(st.pallet_accuracy)}</span><span class="lbl">Pallet accuracy</span></div>
      <div class="stat ${st.qty_accuracy >= 99 ? "good" : st.qty_accuracy < 97 ? "bad" : ""}"><span class="num">${pct(st.qty_accuracy)}</span><span class="lbl">Quantity accuracy</span></div>
      <div class="stat"><span class="num">${num(st.expected_pallets)}</span><span class="lbl">Pallets expected</span></div>
      <div class="stat good"><span class="num">${num(st.match)}</span><span class="lbl">Matched</span></div>
      <div class="stat ${st.qty_diff ? "bad" : ""}"><span class="num">${num(st.qty_diff)}</span><span class="lbl">Qty off</span></div>
      <div class="stat ${st.wrong_bay ? "bad" : ""}"><span class="num">${num(st.wrong_bay)}</span><span class="lbl">Wrong bay</span></div>
      <div class="stat ${st.missing ? "bad" : ""}"><span class="num">${num(st.missing)}</span><span class="lbl">Missing</span></div>
      <div class="stat ${st.extra + st.unknown ? "bad" : ""}"><span class="num">${num((st.extra || 0) + (st.unknown || 0))}</span><span class="lbl">Found, not on list</span></div>
      <div class="stat"><span class="num">${(st.net_qty_diff > 0 ? "+" : "") + num(st.net_qty_diff)}</span><span class="lbl">Net qty difference</span></div>
    </div>`;
  }

  /* ----- counting ----- */
  function bayGroups() {
    const g = new Map(), lines = CS.detail.lines, done = new Set(CS.detail.bays_done);
    lines.forEach((l) => {
      if (l.expected) {
        const k = (l.bay || "").toUpperCase();
        const b = g.get(k) || { bay: k, total: 0, counted: 0, extra: 0 };
        b.total++; if (!["pending", "missing"].includes(l.result)) b.counted++;
        g.set(k, b);
      }
      if (!l.expected && l.counted_bay) {
        const k = l.counted_bay.toUpperCase();
        const b = g.get(k) || { bay: k, total: 0, counted: 0, extra: 0 };
        b.extra++; g.set(k, b);
      }
    });
    return [...g.values()].map((b) => ({ ...b, done: done.has(b.bay) }))
      .sort((a, b) => a.bay.localeCompare(b.bay, "en", { numeric: true }));
  }

  function countingView() {
    const st = CS.detail.stats;
    const pctDone = st.expected_pallets ? Math.round(st.counted_pallets / st.expected_pallets * 100) : 0;
    const top = `<div class="notice">${num(st.counted_pallets)} of ${plural(st.expected_pallets, "pallet")} counted &middot;
        ${num(st.bays_done)} of ${plural(st.bays_total, "bay")} finished
        <div class="progress" style="margin-top:8px"><span style="width:${pctDone}%"></span></div></div>`;
    if (CS.bay) return top + bayView();
    const bays = bayGroups();
    return top + `<h3 style="margin:16px 0 4px">Pick a bay to count</h3>
      <p class="muted">Counts are blind: scan each pallet and enter what you see. You will not see the expected quantity.</p>
      <div class="bay-grid">${bays.map((b) => `<button class="bay-btn ${b.done ? "done" : b.counted || b.extra ? "started" : ""}" data-bay="${esc(b.bay)}">
          <strong>${esc(b.bay)}</strong><small>${b.done ? "Finished" : `${num(b.counted)} of ${num(b.total)}`}${b.extra ? ` &middot; +${b.extra} extra` : ""}</small></button>`).join("")}</div>
      <div class="other-bay"><span>Scan a bay label, or type a bay not listed:</span><input id="ccOtherBay" type="text" maxlength="30" placeholder="Scan or type bay"><button class="btn" id="ccOtherGo">Go</button></div>
      <div class="cc-actions" style="margin-top:20px"><button class="btn dark" id="ccSubmit">Finish and send for review</button></div>`;
  }

  function bayView() {
    const bay = CS.bay, lines = CS.detail.lines;
    const here = lines.filter((l) => (l.expected && (l.bay || "").toUpperCase() === bay) || (l.counted_bay || "").toUpperCase() === bay);
    const done = CS.detail.bays_done.includes(bay);
    const cam = "BarcodeDetector" in window ? '<button class="btn cam-btn" id="ccCam" type="button">Camera</button>' : "";
    const rows = here.map((l) => {
      const elsewhere = l.expected && l.counted_bay && l.counted_bay.toUpperCase() !== bay && (l.bay || "").toUpperCase() === bay;
      const counted = l.counted_qty === null || l.counted_qty === undefined || l.result === "missing" ? "" : ` &middot; qty ${num(l.counted_qty)}`;
      return `<tr>
        <td class="wrap-id"><button class="btn link" data-fill="${esc(l.lwh_id || l.tag || "")}" title="Put this tag in the scan box">${esc(l.lwh_id || l.tag || "")}</button>
          ${l.customer_id ? `<small>${esc(l.customer_id)}</small>` : ""}</td>
        <td class="wrap">${esc(l.item_number || "")}</td>
        <td>${l.expected ? (elsewhere ? `<span class="res wrong_bay">Found in ${esc(l.counted_bay)}</span>` : res(l.result)) : res(l.result)}${counted}
          ${!l.expected && l.bay ? `<small>WMS bay ${esc(l.bay)}</small>` : ""}</td>
        <td>${l.counted_at && l.result !== "missing" ? `<button class="btn small" data-undo="${l.id}">Undo</button>` : ""}</td></tr>`;
    }).join("");
    return `<div class="scan">
        <button class="back" id="ccBays">&larr; All bays</button>
        <h3>Bay ${esc(bay)}${done ? ' <span class="pill closed">Finished</span>' : ""}</h3>
        <div class="scan-row">
          <div><label for="ccTag">Scan or type the tag (LWH ID or Customer ID)</label><input id="ccTag" autocomplete="off" autocapitalize="characters" enterkeyhint="next"></div>
          <div><label for="ccQty">Quantity</label><input id="ccQty" type="number" inputmode="decimal" min="0" step="any" enterkeyhint="done"></div>
          <button class="btn primary" id="ccSave">Save</button>
        </div>
        <div class="other-bay scan-note"><input id="ccNote" type="text" maxlength="300" placeholder="Note (optional): damaged, label missing..." style="flex:1;width:auto;text-transform:none">
          <label class="inline" style="font-weight:500"><input type="checkbox" id="ccKeep" ${CS.keepQty ? "checked" : ""}> Keep quantity for next pallet</label>${cam}</div>
        <div id="camBox" hidden><video id="camVideo" playsinline muted></video></div>
        <div id="ccFeedback" class="feedback" hidden></div>
      </div>
      <div class="table-wrap bay-table"><table><thead><tr><th>Tag</th><th>Item #</th><th>Status</th><th></th></tr></thead>
        <tbody>${rows || '<tr><td class="empty" colspan="4">No pallets expected in this bay. Scan anything you find here.</td></tr>'}</tbody></table></div>
      <div class="cc-actions" style="margin-top:14px"><button class="btn dark" id="ccBayDone">This bay is finished</button></div>`;
  }

  /* A scanned bay label in the tag box moves the counter to that bay (unless it is also a pallet tag). */
  function switchBayFromScan(raw) {
    const v = String(raw || "").trim().toUpperCase();
    if (!v || v === CS.bay) return false;
    const lines = CS.detail.lines;
    if (lines.some((l) => [l.lwh_id, l.customer_id, l.tag].some((t) => t && String(t).toUpperCase() === v))) return false;
    const known = new Set(lines.filter((l) => l.expected).map((l) => (l.bay || "").toUpperCase()));
    (A.S.dash.bays || []).forEach((b) => known.add(b.bay.toUpperCase()));
    if (!known.has(v)) return false;
    stopCam(); CS.bay = v; renderDetail(); toast(`Now counting bay ${v}.`);
    return true;
  }

  async function saveScan() {
    const tag = $("ccTag").value.trim(), qty = $("ccQty").value.trim();
    const fb = $("ccFeedback");
    if (!tag) { $("ccTag").focus(); return; }
    if (switchBayFromScan(tag)) return;
    if (qty === "") { $("ccQty").focus(); fb.hidden = false; fb.className = "feedback err"; fb.textContent = "Enter the quantity on the pallet."; return; }
    $("ccSave").disabled = true;
    try {
      const r = await api("cc_scan", { id: CS.detail.count.id, bay: CS.bay, tag, qty, note: $("ccNote").value.trim() });
      const keep = $("ccKeep").checked ? qty : "";
      CS.detail = await api("cc_get", { id: CS.detail.count.id });
      renderDetail();
      const f = $("ccFeedback"); f.hidden = false;
      f.className = "feedback " + (["extra", "unknown", "wrong_bay"].includes(r.result) ? "warn" : "ok");
      f.textContent = `${r.tag}${r.item_number ? " (" + r.item_number + ")" : ""}: ${r.message}`;
      $("ccQty").value = keep; $("ccTag").focus();
      if (navigator.vibrate) navigator.vibrate(["extra", "unknown", "wrong_bay"].includes(r.result) ? [80, 60, 80] : 40);
    } catch (e) {
      if (e.message === "SESSION_EXPIRED") return;
      fb.hidden = false; fb.className = "feedback err"; fb.textContent = e.message;
    } finally { const b = $("ccSave"); if (b) b.disabled = false; }
  }

  /* camera scanning where the browser supports it (most Android phones) */
  async function startCam() {
    if (CS.cam) return stopCam();
    try {
      const det = new window.BarcodeDetector({ formats: ["code_128", "code_39", "qr_code", "ean_13", "upc_a", "data_matrix", "itf"] });
      const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } });
      const v = $("camVideo"); v.srcObject = stream; await v.play(); $("camBox").hidden = false;
      CS.cam = { stream, on: true };
      const loop = async () => {
        if (!CS.cam || !CS.cam.on) return;
        try {
          const codes = await det.detect(v);
          if (codes.length) { $("ccTag").value = codes[0].rawValue; stopCam(); $("ccQty").focus(); if (navigator.vibrate) navigator.vibrate(40); return; }
        } catch { /* keep trying */ }
        setTimeout(loop, 250);
      };
      loop();
    } catch { toast("The camera is not available. Use a scanner or type the tag."); stopCam(); }
  }
  function stopCam() {
    if (CS.cam) { CS.cam.on = false; CS.cam.stream.getTracks().forEach((t) => t.stop()); CS.cam = null; }
    const b = document.getElementById("camBox"); if (b) b.hidden = true;
  }

  /* ----- review (LWH) and results ----- */
  function varianceRows(editable) {
    let lines = CS.detail.lines;
    if (CS.filter === "var") lines = lines.filter((l) => !["match", "pending"].includes(l.result));
    if (!lines.length) return `<tr><td class="empty" colspan="12">${CS.filter === "var" ? "No variances. Every pallet matched." : "No lines."}</td></tr>`;
    return lines.map((l) => {
      const diff = (l.counted_qty ?? 0) - (l.expected ? (l.expected_qty ?? 0) : 0);
      const isVar = !["match", "pending"].includes(l.result);
      return `<tr>
        ${editable ? `<td><input type="checkbox" data-sel="${l.id}" ${CS.selected.has(l.id) ? "checked" : ""} aria-label="Select for recount"></td>` : ""}
        <td>${esc(l.bay || "")}</td><td>${esc(l.counted_bay || "")}</td>
        <td>${esc(l.lwh_id || l.tag || "")}</td><td>${esc(l.customer_id || "")}</td>
        <td>${esc(l.item_number || "")}</td>
        <td class="r">${l.expected ? num(l.expected_qty) : ""}</td><td class="r">${num(l.counted_qty)}</td>
        <td class="r ${diff > 0 ? "diff-pos" : diff < 0 ? "diff-neg" : ""}">${diff ? (diff > 0 ? "+" : "") + num(diff) : ""}</td>
        <td>${res(l.result)}${l.note ? `<div class="muted" style="font-size:14px;white-space:normal">${esc(l.note)}</div>` : ""}</td>
        <td>${l.counted_by ? esc(l.counted_by) : ""}</td>
        <td class="res-cell">${editable && isVar
          ? `<input class="res-note" data-resn="${l.id}" maxlength="300" placeholder="What was found / done" value="${esc(l.resolution || "")}">
             <label class="adj"><input type="checkbox" data-adj="${l.id}" ${l.wms_adjusted ? "checked" : ""}> WMS adjusted</label>
             <button class="btn small" data-saveres="${l.id}">Save</button>`
          : `${esc(l.resolution || "")}${l.wms_adjusted ? ' <span class="res match">WMS adjusted</span>' : ""}`}</td></tr>`;
    }).join("");
  }
  const VAR_HEAD = (editable) => `<tr>${editable ? "<th></th>" : ""}<th>WMS bay</th><th>Found in</th><th>LWH ID</th><th>Customer ID</th><th>Item #</th>
      <th class="r">Expected</th><th class="r">Counted</th><th class="r">Diff</th><th>Result</th><th>Counted by</th><th>Resolution</th></tr>`;
  const filterSeg = () => `<div class="seg" id="ccFilter" style="margin:6px 0 10px">
      <button class="seg-btn ${CS.filter === "var" ? "active" : ""}" data-f="var">Variances</button>
      <button class="seg-btn ${CS.filter === "all" ? "active" : ""}" data-f="all">All lines</button></div>`;

  function reviewView() {
    const st = CS.detail.stats;
    return `<div class="notice amber">Review the variances. Recount anything that looks wrong, note what was found or adjusted in the WMS,
        then close the count. The customer sees the results once it is closed.
        ${st.unresolved ? `<strong>${plural(st.unresolved, "variance")} still without a note.</strong>` : ""}</div>
      ${statTiles(st)}
      ${filterSeg()}
      <div class="table-wrap"><table><thead>${VAR_HEAD(true)}</thead><tbody>${varianceRows(true)}</tbody></table></div>
      <div class="cc-actions" style="margin-top:14px">
        <button class="btn" id="ccRecount">Send selected back for recount</button>
        <button class="btn primary" id="ccClose">Close count</button></div>`;
  }

  function resultsView() {
    const c = CS.detail.count;
    return `<div class="notice good">Final results. ${c.close_note ? "LWH note: " + esc(c.close_note) : ""}</div>
      ${statTiles(CS.detail.stats)}
      ${filterSeg()}
      <div class="table-wrap"><table><thead>${VAR_HEAD(false)}</thead><tbody>${varianceRows(false)}</tbody></table></div>`;
  }

  function exportCount() {
    if (!A.xlsxReady()) return;
    const d = CS.detail, c = d.count, st = d.stats;
    const cols = [["bay", "WMS Bay"], ["counted_bay", "Found In"], ["lwh_id", "LWH ID"], ["customer_id", "Customer ID"], ["tag", "Scanned Tag"],
      ["item_number", "Item #"], ["item_description", "Item Description"], ["expected_qty", "Expected Qty"], ["counted_qty", "Counted Qty"],
      ["diff", "Diff"], ["result_label", "Result"], ["note", "Counter Note"], ["counted_by", "Counted By"], ["resolution", "Resolution"], ["wms", "WMS Adjusted"]];
    const rows = d.lines.map((l) => ({ ...l, diff: (l.counted_qty ?? 0) - (l.expected ? (l.expected_qty ?? 0) : 0),
      result_label: RESULT[l.result] || l.result, wms: l.wms_adjusted ? "Yes" : "" }));
    const sum = [["Count", `#${c.id} ${c.title}`], ["Status", STATUS[c.status]], ["Scope", scopeText(c, 50)],
      ["Requested", `${c.requested_by} ${fmtStamp(c.requested_at)}`], ["Closed", c.closed_at ? `${c.closed_by} ${fmtStamp(c.closed_at)}` : ""],
      ["Pallet accuracy", pct(st.pallet_accuracy)], ["Quantity accuracy", pct(st.qty_accuracy)], ["Pallets expected", st.expected_pallets],
      ["Matched", st.match], ["Qty off", st.qty_diff], ["Wrong bay", st.wrong_bay], ["Missing", st.missing],
      ["Found, not on list", (st.extra || 0) + (st.unknown || 0)], ["Net qty difference", st.net_qty_diff]];
    const wb = XLSX.utils.book_new();
    const ws0 = XLSX.utils.aoa_to_sheet(sum); ws0["!cols"] = [{ wch: 22 }, { wch: 60 }];
    XLSX.utils.book_append_sheet(wb, ws0, "Summary");
    XLSX.utils.book_append_sheet(wb, A.sheet(cols, rows.filter((l) => !["match", "pending"].includes(l.result))), "Variances");
    XLSX.utils.book_append_sheet(wb, A.sheet(cols, rows), "All Lines");
    XLSX.writeFile(wb, `${A.cfg.fileBase} Cycle Count ${c.id} ${A.stamp()}.xlsx`);
  }

  function wireDetail() {
    const on = (id, fn) => { const el = document.getElementById(id); if (el) el.onclick = fn; };
    const id = CS.detail.count.id;
    on("ccBack", backToList);
    on("ccExport", exportCount);
    on("ccPrint", () => window.Sheets.countSheets(CS.detail));
    on("ccCancel", async () => {
      if (!(await confirmBox("Cancel this count?", "<p>The count stays in the history as cancelled.</p>", "Cancel count", "primary"))) return;
      busy(true); try { await api("cc_cancel", { id }); toast("Count cancelled."); backToList(); } catch (e) { fail(e); } finally { busy(false); }
    });
    on("ccStart", async () => {
      busy(true, "Getting the pallet list");
      try { const r = await api("cc_start", { id }); toast(`${plural(r.pallets || 0, "pallet")} to count.`); await refresh(); }
      catch (e) { fail(e); } finally { busy(false); }
    });
    // bay picker
    document.querySelectorAll(".bay-btn[data-bay]").forEach((b) => (b.onclick = () => { CS.bay = b.dataset.bay; renderDetail(); }));
    const goOther = () => { const v = ($("ccOtherBay").value || "").trim().toUpperCase(); if (v) { CS.bay = v; renderDetail(); } };
    on("ccOtherGo", goOther);
    const ob = document.getElementById("ccOtherBay"); if (ob) ob.onkeydown = (e) => { if (e.key === "Enter") goOther(); };
    on("ccSubmit", async () => {
      const st = CS.detail.stats;
      const left = st.pending || 0;
      const msg = left ? `<p><strong>${plural(left, "pallet")} not counted yet</strong> will be marked missing.</p>` : "<p>Every expected pallet has been counted.</p>";
      if (!(await confirmBox("Send this count for review?", msg + "<p>LWH reviews the variances before the results are final.</p>", "Send for review"))) return;
      busy(true); try { await api("cc_submit", { id }); toast("Sent for review."); await refresh(); } catch (e) { fail(e); } finally { busy(false); }
    });
    // bay view
    on("ccBays", () => { stopCam(); CS.bay = null; renderDetail(); });
    on("ccSave", saveScan);
    on("ccCam", startCam);
    const tag = document.getElementById("ccTag");
    if (tag) {
      tag.onkeydown = (e) => {
        if (e.key !== "Enter") return;
        e.preventDefault();
        if (switchBayFromScan(tag.value)) return;
        if ($("ccQty").value.trim() !== "" && $("ccKeep").checked) saveScan(); else $("ccQty").focus();
      };
      $("ccQty").onkeydown = (e) => { if (e.key === "Enter") { e.preventDefault(); saveScan(); } };
      $("ccKeep").onchange = () => (CS.keepQty = $("ccKeep").checked);
      setTimeout(() => tag.focus(), 30);
    }
    document.querySelectorAll("[data-fill]").forEach((b) => (b.onclick = () => { $("ccTag").value = b.dataset.fill; $("ccQty").focus(); }));
    document.querySelectorAll("[data-undo]").forEach((b) => (b.onclick = async () => {
      try { await api("cc_undo", { id, line_id: +b.dataset.undo }); await refresh(); toast("Scan undone."); } catch (e) { fail(e); }
    }));
    on("ccBayDone", async () => {
      const left = CS.detail.lines.filter((l) => l.expected && (l.bay || "").toUpperCase() === CS.bay && l.result === "pending").length;
      if (left && !(await confirmBox(`Finish bay ${CS.bay}?`, `<p><strong>${plural(left, "pallet")} expected here were not scanned</strong> and will be marked missing. If you find them later, scanning them clears that.</p>`, "Finish bay"))) return;
      try { await api("cc_bay_done", { id, bay: CS.bay }); stopCam(); CS.bay = null; await refresh(); toast("Bay finished."); } catch (e) { fail(e); }
    });
    // review
    document.querySelectorAll("#ccFilter .seg-btn").forEach((b) => (b.onclick = () => { CS.filter = b.dataset.f; renderDetail(); }));
    document.querySelectorAll("[data-sel]").forEach((cb) => (cb.onchange = () => { const v = +cb.dataset.sel; cb.checked ? CS.selected.add(v) : CS.selected.delete(v); }));
    document.querySelectorAll("[data-saveres]").forEach((b) => (b.onclick = async () => {
      const lid = b.dataset.saveres;
      try {
        await api("cc_resolve", { id, line_id: +lid, resolution: document.querySelector(`[data-resn="${lid}"]`).value,
                                   wms_adjusted: document.querySelector(`[data-adj="${lid}"]`).checked });
        await refresh(); toast("Saved.");
      } catch (e) { fail(e); }
    }));
    on("ccRecount", async () => {
      if (!CS.selected.size) return toast("Tick the lines to recount first.");
      if (!(await confirmBox("Send for recount?", `<p>${plural(CS.selected.size, "line")} go back to "not counted" and their bays reopen. The count goes back to Counting.</p>`, "Send for recount"))) return;
      try { await api("cc_recount", { id, line_ids: [...CS.selected] }); CS.selected.clear(); await refresh(); toast("Sent back for recount."); } catch (e) { fail(e); }
    });
    on("ccClose", async () => {
      const st = CS.detail.stats;
      openModal("Close this count?", `${st.unresolved ? `<p class="form-err">${plural(st.unresolved, "variance")} still have no note or WMS adjustment.</p>` : ""}
        <p>Closing makes the results final and shows them to the customer.</p>
        <div class="field"><label for="ccCloseNote">Note for the customer (optional)</label><textarea id="ccCloseNote" maxlength="500"></textarea></div>`,
        [{ label: "Go back" }, { label: "Close count", cls: "primary", onClick: async () => {
          const note = $("ccCloseNote").value; closeModal();
          busy(true); try { await api("cc_close", { id, note }); toast("Count closed."); await refresh(); } catch (e) { fail(e); } finally { busy(false); }
        } }]);
    });
  }

  /* ================= schedules ================= */
  async function loadSchedules() {
    busy(true, "Loading schedules");
    try {
      const list = await api("cc_schedules");
      $("ccInfo").textContent = list.length
        ? (isLwh() ? "Scheduled counts are created automatically on their run date." : "LWH runs these counts on a schedule. Results show under Completed.")
        : (isLwh() ? "No schedules yet. Add one to run weekly or monthly counts automatically." : "No scheduled counts are set up yet.");
      const desc = (s) => {
        const when = s.frequency === "weekly" ? `Every ${WEEKDAYS[s.weekday]}` : `Monthly on day ${s.month_day}`;
        const what = s.scope_type === "rotation" ? `rotates through all bays over ${s.scope.cycle_runs} counts`
          : s.scope_type === "top_items" ? `top ${s.scope.top} items by pallets`
          : s.scope_type === "all" ? "everything on hand"
          : `${plural((s.scope[s.scope_type] || []).length, s.scope_type === "items" ? "item" : "bay")}`;
        return `${when} &middot; ${esc(what)}`;
      };
      $("ccSchedules").innerHTML = (isLwh() ? '<button class="btn primary" id="ccAddSched" style="margin-bottom:12px">Add a schedule</button>' : "") +
        `<div class="cc-list">${list.map((s) => `<div class="cc-card ${s.active ? "st-in_progress" : ""}" style="cursor:default">
            <div>${s.active ? '<span class="pill in_progress">Active</span>' : '<span class="pill">Paused</span>'}</div>
            <h3>${esc(s.name)}</h3>
            <div class="cc-meta"><span>${desc(s)}</span></div>
            <div class="cc-meta"><span>Next run ${fmtDate(s.next_run_on)}</span>${s.last_run_on ? `<span>Last run ${fmtDate(s.last_run_on)}</span>` : ""}
              <span>Due ${plural(s.lead_days, "day")} after it runs</span></div>
            ${isLwh() ? `<div class="cc-actions"><button class="btn small" data-edit="${s.id}">Edit</button><button class="btn small" data-rm="${s.id}">Remove</button></div>` : ""}
          </div>`).join("")}</div>`;
      const add = document.getElementById("ccAddSched"); if (add) add.onclick = () => scheduleForm(null);
      document.querySelectorAll("[data-edit]").forEach((b) => (b.onclick = () => scheduleForm(list.find((s) => s.id === +b.dataset.edit))));
      document.querySelectorAll("[data-rm]").forEach((b) => (b.onclick = async () => {
        if (!(await confirmBox("Remove this schedule?", "<p>No more counts will be created from it. Counts it already made stay.</p>", "Remove"))) return;
        try { await api("cc_schedule_remove", { schedule_id: +b.dataset.rm }); toast("Schedule removed."); loadSchedules(); } catch (e) { fail(e); }
      }));
    } catch (e) { fail(e); }
    finally { busy(false); }
  }

  function scheduleForm(s) {
    s = s || { frequency: "weekly", weekday: 1, month_day: 1, scope_type: "rotation", scope: { cycle_runs: 4 }, lead_days: 3, start_date: "2027-01-01", active: true };
    const bays = A.S.dash.total_bays || 0;
    openModal(s.id ? "Edit schedule" : "Add a schedule", `
      <div class="field"><label for="sName">Name</label><input type="text" id="sName" maxlength="60" value="${esc(s.name || "")}" placeholder="Example: Weekly bay rotation"></div>
      <div class="field"><span class="lab">How often</span><div class="choices">
        <label class="choice"><input type="radio" name="sFreq" value="weekly" ${s.frequency === "weekly" ? "checked" : ""}> Weekly</label>
        <label class="choice"><input type="radio" name="sFreq" value="monthly" ${s.frequency === "monthly" ? "checked" : ""}> Monthly</label></div></div>
      <div class="field" id="sWdF"><label for="sWd">Day of the week</label><select id="sWd">${WEEKDAYS.slice(1).map((d, i) => `<option value="${i + 1}" ${s.weekday === i + 1 ? "selected" : ""}>${d}</option>`).join("")}</select></div>
      <div class="field" id="sMdF"><label for="sMd">Day of the month (1 to 28)</label><input type="number" id="sMd" min="1" max="28" value="${s.month_day || 1}"></div>
      <div class="field"><label for="sType">Each count covers</label><select id="sType">
        <option value="rotation" ${s.scope_type === "rotation" ? "selected" : ""}>A rotating share of all bays</option>
        <option value="top_items" ${s.scope_type === "top_items" ? "selected" : ""}>The busiest items (most pallets)</option>
        <option value="items" ${s.scope_type === "items" ? "selected" : ""}>Specific items</option>
        <option value="bays" ${s.scope_type === "bays" ? "selected" : ""}>Specific bays</option>
        <option value="all" ${s.scope_type === "all" ? "selected" : ""}>Everything on hand</option></select></div>
      <div class="field" id="sRotF"><label for="sRot">Spread all bays over this many counts</label><input type="number" id="sRot" min="2" max="52" value="${(s.scope && s.scope.cycle_runs) || 4}">
        <p class="hint" id="sRotHint"></p></div>
      <div class="field" id="sTopF"><label for="sTop">How many items</label><input type="number" id="sTop" min="1" max="500" value="${(s.scope && s.scope.top) || 25}"></div>
      <div class="field" id="sListF"><span class="lab" id="sListLab"></span><div id="sList"></div></div>
      <div class="field"><label for="sLead">Due this many days after it is created</label><input type="number" id="sLead" min="0" max="31" value="${s.lead_days ?? 3}"></div>
      <div class="field"><label for="sStart">First run on or after</label><input type="date" id="sStart" value="${esc(s.start_date || "2027-01-01")}"></div>
      <div class="field"><label class="inline"><input type="checkbox" id="sActive" ${s.active !== false ? "checked" : ""}> Active</label></div>
      <p class="form-err" id="sErr"></p>`,
      [{ label: "Cancel" }, { label: "Save schedule", cls: "primary", onClick: save }]);
    let editor = null, editorType = null;
    const sync = () => {
      const f = document.querySelector('input[name="sFreq"]:checked').value, t = $("sType").value;
      $("sWdF").hidden = f !== "weekly"; $("sMdF").hidden = f !== "monthly";
      $("sRotF").hidden = t !== "rotation"; $("sTopF").hidden = t !== "top_items"; $("sListF").hidden = !["items", "bays"].includes(t);
      const n = Math.max(2, +$("sRot").value || 4);
      $("sRotHint").textContent = `About ${Math.ceil(bays / n)} of ${bays} bays per count. ${f === "weekly" ? `Every bay gets counted about every ${n} weeks.` : `Every bay gets counted about every ${n} months.`}`;
      if (["items", "bays"].includes(t) && editorType !== t) {
        editorType = t; $("sListLab").textContent = t === "items" ? "Items" : "Bays";
        editor = chipEditor($("sList"), (s.scope_type === t && s.scope[t]) || [], t);
      }
    };
    document.querySelectorAll('input[name="sFreq"]').forEach((r) => (r.onchange = sync));
    $("sType").onchange = sync; $("sRot").oninput = sync;
    sync();
    async function save() {
      const t = $("sType").value;
      const p = { id: s.id || null, name: $("sName").value.trim(), frequency: document.querySelector('input[name="sFreq"]:checked').value,
        weekday: +$("sWd").value, month_day: +$("sMd").value, scope_type: t, cycle_runs: +$("sRot").value, top: +$("sTop").value,
        lead_days: +$("sLead").value, start_date: $("sStart").value, active: $("sActive").checked };
      if (t === "items" || t === "bays") p[t] = editor ? editor.values() : [];
      try { const r = await api("cc_schedule_save", { schedule: p }); closeModal(); toast(`Schedule saved. Next run ${fmtDate(r.next_run_on)}.`); loadSchedules(); }
      catch (e) { if (e.message !== "SESSION_EXPIRED") $("sErr").textContent = e.message; }
    }
  }

  /* ================= wiring ================= */
  document.querySelectorAll("#ccSeg .seg-btn").forEach((b) => (b.onclick = () => loadList(b.dataset.which)));
  $("ccNewBtn").onclick = () => request();
  $("ccBayLabelsBtn").onclick = () => window.Sheets.baysDialog();
  $("ccList").addEventListener("click", (e) => { const b = e.target.closest(".cc-card[data-id]"); if (b) openDetail(+b.dataset.id); });

  window.Counts = {
    show() { if (CS.detail) refresh(); else loadList(); },
    request,
    summary,
  };
})();
