# Franklin (FRAWI) Inventory + Cycle Counts - LWH customer PWA

PIN-protected inventory app for Franklin, hosted on GitHub Pages. Same red/black LWH portal look as the
One Source and Trane apps, with the time, temperature and today's forecast in the header.

**Tabs**
- **Dashboard**: one "find anything" search box with type-ahead, totals, inventory age, last 14 days in/out,
  top items, and a cycle count summary. Built for hundreds of items, so it does not list every item up front.
- **Inventory**: smart search (below), paging, Excel export, and "Request a count of these".
- **Items**: every item number with pallets, qty, bays and oldest age; sortable, filterable, with a Count button per item.
- **Transactions**: loads and pallets in/out, by-shipper rollup, up to 92 days (same as Trane).
- **Cycle Counts**: request, count, review and results, plus weekly/monthly schedules.

## Smart search
| Type this | You get |
|---|---|
| `volute 12x8` | every pallet where all the words match somewhere |
| a pasted list of LWH IDs, Customer IDs, INV receipts, item numbers or bays | an exact lookup of all of them, with the ones **not found** listed (and in the export) |
| `item:` `bay:` `id:` `cust:` `rcv:` `ref:` `lot:` `desc:` | search one field only |
| `bay:E0*` | wildcard: bays E01 to E09 |
| `age>180` / `age<30` | by days on hand |
| `"SPHFGS4  000 X"` | quotes keep an item number with spaces together |

## Cycle counts, start to finish
1. **Request.** Anyone signed in picks item numbers, bays (wildcards ok), specific pallets, or everything,
   and says who counts it: LWH, or the customer themselves (for their own random counts). Customers can't
   request an LWH full count from the app; that gets scheduled with their rep.
2. **Start.** When counting starts (not when requested), the app freezes the list of pallets to expect from
   current inventory. A count requested Monday and started Thursday compares against Thursday's inventory.
3. **Count.** Pick a bay, scan or type the LWH ID **or** the customer's tag, enter the quantity. Works with a
   hardware scanner (scan, Enter, qty, Enter), and on Android phones the Camera button scans barcodes.
   Counts are **blind**: counters never see expected quantities. The app flags pallets found in the wrong
   bay, pallets not on the list, and unknown tags as they're scanned. "This bay is finished" marks anything
   not scanned there as missing (scanning it later clears that). Undo is available on every scan.
4. **Review (LWH only).** Variances list with expected vs counted. Tick lines and "Send back for recount",
   or note what was found and tick **WMS adjusted** once the fix is made in birdseye. Then close.
5. **Results.** Customers see results only after LWH closes the count: pallet accuracy, quantity accuracy,
   matched / qty off / wrong bay / missing / found-not-on-list, and an Excel export.

**The app never changes the WMS.** All adjustments are still made in birdseye; the "WMS adjusted" box is the record that it was done.
**Nothing is ever deleted**: undone scans are voided, reopened bays are flagged, removed schedules are archived. Full audit trail.

## Schedules (for the weekly/monthly counts after Jan 1)
LWH users set these up in Cycle Counts > Schedules. Each run creates a count on its date, due a set number of days later.
Options per schedule: weekly (pick a day) or monthly (day 1 to 28), covering:
- **A rotating share of all bays**: e.g. weekly over 4 runs = every bay counted about once a month (about 111 of 443 bays per count today).
- **The busiest items**: top N items by pallet count, re-picked each run.
- **Specific items** or **specific bays**, or **everything**.

First run defaults to Jan 1, 2027. There is no server timer: due counts are created the first time anyone opens the
Cycle Counts tab on or after the run date, one per run date, with no backlog if nobody opened it for a while.

## Roles
- **customer** (default): sees inventory and transactions, requests counts, can count the counts they chose to do
  themselves, sees results once closed.
- **lwh**: everything above plus counting any count, review, recount, close, and schedules. The header shows an LWH tag.

## What's already live in Supabase (LWH Companion, `tjivcqxnkftujceumdtx`)
Everything below is additive. The Trane app, its `customer-inventory` function, and the original `cust_app_*` functions are unchanged.
- `supabase/01_customer_app_v2.sql`: `role` on `cust_app_users`, `features` on `cust_app_customers`, the FRAWI customer row,
  `cust_app_dashboard`, `cust_app_smart_search`, `cust_app_suggest`, `cust_app_add_user_role`.
- `supabase/02_cycle_counts.sql`: `cc_counts`, `cc_lines`, `cc_bays_done`, `cc_schedules` and the `cc_*` functions.
- `supabase/functions/customer-app`: the new shared Edge Function (PIN gate, `verify_jwt` off because it does its own auth).
  All tables have RLS on with no policies, and every function is service-role only. The browser never holds a database key.

## Publish
1. Create a GitHub repo named `FRAWI_Inventory` and upload everything in this folder **except** the `supabase/` folder
   (keep that in your own records; the repo is public).
2. Settings > Pages > Deploy from branch `main` / root.
3. App URL: `https://nbr1hawgfan.github.io/FRAWI_Inventory/`

## Manage PIN users (Supabase SQL editor)
```sql
select public.cust_app_add_user_role('FRAWI', 'Jane Smith - Franklin', '12345678', 'customer');  -- customer user
select public.cust_app_add_user_role('FRAWI', 'Tim - LWH', '87654321', 'lwh');                    -- LWH counter / reviewer
select public.cust_app_remove_user('FRAWI', 'Jane Smith - Franklin');                             -- revoke (ends their sessions)
select * from public.cust_app_list_users('FRAWI');                                                -- who has access
select * from public.cust_app_activity('FRAWI', 50);                                              -- sign-ins, exports, count actions
```
LWH users are per customer: add an LWH user to each customer app they count for.
PINs are 6 to 8 digits, salted hashes only, unique within a customer. Sessions last 10 hours.
Two inactive users named "Claude test ... (temp)" were left from setup; they can't sign in.

## Small follow-ups
- **Display name**: the app says "Franklin" (from the vendor on the pallets). Change `display_name` in
  `cust_app_customers` and `title` / `shortTitle` / `fileBase` in `config.js` if they go by another name.
- **WHSE11** has no friendly name yet, so it shows as "WHSE11". Add a row to `cust_app_locations` (code, name, short_name, sort_order).

## Turning cycle counts on for Trane (TRAFO) later
1. `update cust_app_customers set features = '{"cycle_counts": true}' where code = 'TRAFO';`
2. Either copy this repo for Trane (change `config.js` and `manifest.json`), or point the Trane app's `config.js`
   `api` at `.../functions/v1/customer-app` and swap in this repo's `index.html`, `app.js`, `counts.js`, `styles.css`, `sw.js`.
3. Add their LWH counter PINs with `cust_app_add_user_role(..., 'lwh')`.
At about 11,300 pallets and 987 bays, a weekly rotation over 8 to 12 runs is a more realistic size per count for Trane.
