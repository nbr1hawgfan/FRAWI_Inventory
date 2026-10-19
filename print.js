/* Printable barcode sheets (Code 128). Rendered into #printArea and sent to the browser's print dialog,
   where the person can print or "Save as PDF".
   Sheets: bay labels, bay barcode list, bays with their pallets, item list, pallet list (search results),
   and blind count sheets for a cycle count. */
(function () {
  "use strict";
  const A = window.App;
  const { $, esc, num, plural, fmtDate, fmtStamp, api, busy, toast, fail, openModal, closeModal } = A;

  function ready() {
    if (window.JsBarcode) return true;
    alert("The barcode tool didn't load. Check your connection, refresh the page and try again.");
    return false;
  }
  const bc = (value, cls) => `<svg class="bc ${cls || ""}" data-bc="${esc(value)}"></svg>`;

  function draw(root) {
    root.querySelectorAll("svg[data-bc]").forEach((svg) => {
      const big = svg.classList.contains("big"), small = svg.classList.contains("small");
      try {
        window.JsBarcode(svg, svg.getAttribute("data-bc"), {
          format: "CODE128", displayValue: false, margin: 0,
          width: big ? 3 : small ? 1.3 : 1.7, height: big ? 120 : small ? 34 : 48,
        });
      } catch { svg.outerHTML = '<span class="bc-err">Can\'t make a barcode for this value</span>'; }
    });
  }

  function header(title, sub) {
    return `<header class="ps-head"><div class="ps-badge">LWH</div>
      <div><h1>${esc(title)}</h1><p>${esc(A.cfg.title)} &middot; ${esc(sub || "")}</p></div>
      <div class="ps-date">Printed ${esc(new Date().toLocaleString("en-US", { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" }))}</div></header>`;
  }

  function print(html, title) {
    const area = $("printArea");
    area.innerHTML = html;
    draw(area);
    const old = document.title;
    document.title = `${A.cfg.fileBase} ${title} ${A.stamp()}`;   // becomes the default PDF file name
    const done = () => { area.innerHTML = ""; document.title = old; window.removeEventListener("afterprint", done); };
    window.addEventListener("afterprint", done);
    setTimeout(() => window.print(), 60);
  }

  const chunk = (arr, n) => { const out = []; for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n)); return out; };
  const bayMatch = (bay, pats) => !pats.length || pats.some((p) => new RegExp("^" + p.toUpperCase().replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*") + "$").test(bay.toUpperCase()));
  const sortBays = (a, b) => a.bay.localeCompare(b.bay, "en", { numeric: true });

  /* ---------- bays: labels, list, or bays with their pallets ---------- */
  function baysDialog(preset) {
    openModal("Print bay barcodes", `
      <div class="field"><label for="pbBays">Which bays</label>
        <input type="text" id="pbBays" value="${esc(preset || "")}" placeholder="Leave blank for all bays, or E0*, A01, A02...">
        <p class="hint">Separate with commas or spaces. Use * for a range, like E0* or DF*.</p></div>
      <div class="field"><span class="lab">Layout</span><div class="choices">
        <label class="choice"><input type="radio" name="pbLayout" value="labels" checked> Bay labels (2 per page, for the racks)</label>
        <label class="choice"><input type="radio" name="pbLayout" value="list"> Bay list (many per page)</label>
        <label class="choice"><input type="radio" name="pbLayout" value="pallets"> Bays with their pallets</label>
      </div></div>
      <p class="form-err" id="pbErr"></p>`,
      [{ label: "Cancel" }, { label: "Print", cls: "primary", onClick: go }]);
    async function go() {
      if (!ready()) return;
      const pats = $("pbBays").value.split(/[\s,;]+/).map((s) => s.trim()).filter(Boolean);
      const layout = document.querySelector('input[name="pbLayout"]:checked').value;
      const bays = A.S.dash.bays.filter((b) => b.bay !== "Not Assigned" && bayMatch(b.bay, pats)).sort(sortBays);
      if (!bays.length) { $("pbErr").textContent = "No bays in use match that."; return; }
      if (layout === "pallets" && bays.length > 150) { $("pbErr").textContent = `That is ${bays.length} bays. Pick 150 or fewer for pallet sheets.`; return; }
      closeModal();
      if (layout === "labels") {
        print(chunk(bays, 2).map((pair) => `<section class="ps-page ps-labels">${pair.map((b) => `
            <div class="ps-label"><div class="ps-label-name">${esc(b.bay)}</div>${bc(b.bay, "big")}
              <div class="ps-label-sub">${esc(A.cfg.title)} &middot; ${esc(b.location_code)}</div></div>`).join("")}</section>`).join(""), "Bay Labels");
      } else if (layout === "list") {
        print(chunk(bays, 30).map((page, i, all) => `<section class="ps-page">${header("Bay barcodes", `${plural(bays.length, "bay")} · page ${i + 1} of ${all.length}`)}
            <div class="ps-grid">${page.map((b) => `<div class="ps-cell"><strong>${esc(b.bay)}</strong>${bc(b.bay)}<small>${plural(b.pallets, "pallet")}</small></div>`).join("")}</div></section>`).join(""), "Bay Barcodes");
      } else {
        busy(true, "Getting the pallets");
        try {
          const r = await api("export", { query: "", location: "ALL", purpose: "count" });
          const by = {}; r.rows.forEach((p) => (by[p.bay] = by[p.bay] || []).push(p));
          print(bays.map((b) => palletPage(`Bay ${b.bay}`, b.bay, (by[b.bay] || []), false)).join(""), "Bay Sheets");
        } catch (e) { fail(e); } finally { busy(false); }
      }
    }
  }

  const showCust = () => !(A.S.dash && A.S.dash.has_customer_ids === false);
  function palletRows(rows, blind, check) {
    return rows.map((p) => `<tr>
        <td>${bc(p.lwh_id || p.tag || "", "small")}<div class="ps-id">${esc(p.lwh_id || p.tag || "")}</div></td>
        ${showCust() ? `<td>${p.customer_id ? `${bc(p.customer_id, "small")}<div class="ps-id">${esc(p.customer_id)}</div>` : ""}</td>` : ""}
        <td><div class="ps-item">${esc(p.item_number || "")}</div><div class="ps-desc">${p.item_description && p.item_description !== p.item_number ? esc(p.item_description) : ""}</div></td>
        ${check ? '<td class="ps-check"><span></span></td><td class="ps-write"></td><td class="ps-write wide"></td>'
          : blind ? '<td class="ps-write"></td><td class="ps-write wide"></td>' : `<td class="r">${num(p.qty)}</td>`}</tr>`).join("");
  }
  function palletPage(title, bay, rows, blind, sub, check) {
    const pages = chunk(rows.length ? rows : [null], 9);   // 9 pallets fit a page with two barcodes each
    return pages.map((pg, i) => `<section class="ps-page">
        ${header(title, (sub ? sub + " · " : "") + (pages.length > 1 ? `page ${i + 1} of ${pages.length}` : plural(rows.length, "pallet")))}
        ${bay ? `<div class="ps-bayline"><span>Bay <strong>${esc(bay)}</strong></span>${bc(bay)}</div>` : ""}
        ${pg[0] ? `<table class="ps-table"><thead><tr><th>LWH ID</th>${showCust() ? "<th>Customer ID</th>" : ""}<th>Item</th>${check ? "<th>Found</th><th>Found in bay</th><th>Notes</th>" : blind ? "<th>Qty counted</th><th>Notes</th>" : '<th class="r">Qty</th>'}</tr></thead>
          <tbody>${palletRows(pg, blind, check)}</tbody></table>` : '<p class="ps-empty">No pallets in this bay.</p>'}
        ${blind ? `<div class="ps-found"><strong>Found here, not listed above</strong> (tag${check ? "" : " and qty"}):<div class="ps-lines"></div></div>
          <div class="ps-sign">Counted by ____________________ &nbsp; Date ___________ &nbsp; Time ________</div>` : ""}
      </section>`).join("");
  }

  /* ---------- items ---------- */
  function items(rows, label) {
    if (!ready()) return;
    rows = rows || A.S.dash.items;
    if (!rows.length) return toast("No items to print.");
    print(chunk(rows, 10).map((page, i, all) => `<section class="ps-page">${header("Item barcodes", `${label || plural(rows.length, "item")} · page ${i + 1} of ${all.length}`)}
        <table class="ps-table"><thead><tr><th>Item #</th><th>Description</th><th class="r">Pallets</th><th class="r">Qty</th><th class="r">Bays</th></tr></thead>
        <tbody>${page.map((it) => `<tr><td>${bc(it.item_number)}<div class="ps-item ps-pre">${esc(it.item_number)}</div></td>
          <td class="ps-desc-cell">${it.description !== it.item_number ? esc(it.description) : ""}</td>
          <td class="r">${num(it.pallets)}</td><td class="r">${num(it.qty)}</td><td class="r">${num(it.bays)}</td></tr>`).join("")}</tbody></table></section>`).join(""), "Item Barcodes");
  }

  /* ---------- pallets from a search ---------- */
  async function pallets(query, location) {
    if (!ready()) return;
    busy(true, "Getting the pallets");
    try {
      const r = await api("export", { query, location: location || "ALL" });
      if (!r.rows.length) return toast("Nothing to print.");
      if (r.rows.length > 900) { alert(`That is ${num(r.rows.length)} pallets, about ${Math.ceil(r.rows.length / 9)} pages. Narrow the search to 900 pallets or fewer.`); return; }
      print(palletPage("Pallet barcodes", null, r.rows, false, query ? `"${query.slice(0, 60)}"` : "all pallets"), "Pallet Barcodes");
    } catch (e) { fail(e); } finally { busy(false); }
  }

  /* ---------- cycle count sheets (blind: no expected qty) ---------- */
  function countSheets(detail) {
    if (!ready()) return;
    const c = detail.count, check = !(c.scope && c.scope.count_qty);
    const lines = detail.lines.filter((l) => l.expected);
    if (!lines.length) return toast("Start the count first. The pallet list is set when counting starts.");
    const by = {}; lines.forEach((l) => (by[l.bay || "Not Assigned"] = by[l.bay || "Not Assigned"] || []).push(l));
    const bays = Object.keys(by).sort((a, b) => a.localeCompare(b, "en", { numeric: true }));
    const cover = `<section class="ps-page">${header(`Cycle count #${c.id}`, c.title)}
        <table class="ps-table ps-cover"><tbody>
          <tr><th>Count</th><td>#${c.id} ${esc(c.title)}</td></tr>
          <tr><th>Due</th><td>${fmtDate(c.due_date) || "-"}</td></tr>
          <tr><th>Started</th><td>${esc(c.started_by || "")} ${fmtStamp(c.started_at)}</td></tr>
          <tr><th>Pallets</th><td>${plural(lines.length, "pallet")} in ${plural(bays.length, "bay")}</td></tr>
        </tbody></table>
        <p>${check ? "Check every pallet in each bay: tick Found for each one that is there, and write the bay if you find it somewhere else."
            : "Count every pallet in each bay. Write the quantity you see; expected quantities are not shown on purpose."}
           List anything you find that is not printed for that bay. Enter results in the app afterwards
           (Cycle Counts &gt; #${c.id}), or hand the sheets to the office.</p>
        <table class="ps-table"><thead><tr><th>Bay</th><th class="r">Pallets</th><th>Done</th></tr></thead>
          <tbody>${bays.map((b) => `<tr><td>${esc(b)}</td><td class="r">${num(by[b].length)}</td><td class="ps-write"></td></tr>`).join("")}</tbody></table></section>`;
    print(cover + bays.map((b) => palletPage(`Count #${c.id}: bay ${b}`, b, by[b], true, c.title, check)).join(""), `Count ${c.id} Sheets`);
  }

  window.Sheets = { baysDialog, items, pallets, countSheets };
})();
