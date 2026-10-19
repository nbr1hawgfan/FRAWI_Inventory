/*===========================================================
  CUSTOMER APP v2 - dashboard, smart search, roles (LWH Companion)
  Additive only. The Trane (TRAFO) app and its customer-inventory
  Edge Function keep using the original cust_app_* functions,
  which are not changed here.

  Adds:
    - cust_app_users.role   'customer' (default) or 'lwh'
    - cust_app_customers.features   e.g. {"cycle_counts": true}
    - FRAWI customer row
    - cust_app_dashboard()      search-first home screen data
    - cust_app_smart_search()   multi-word, field prefixes, bulk IDs
    - cust_app_suggest()        type-ahead for items and bays
===========================================================*/

alter table public.cust_app_users add column if not exists role text not null default 'customer';
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'cust_app_users_role_chk') then
    alter table public.cust_app_users add constraint cust_app_users_role_chk check (role in ('customer', 'lwh'));
  end if;
end $$;

alter table public.cust_app_customers add column if not exists features jsonb not null default '{}'::jsonb;

insert into public.cust_app_customers (code, display_name, columns, features) values
('FRAWI', 'Franklin', '[
  {"key":"location",         "label":"Warehouse"},
  {"key":"bay",              "label":"Bay"},
  {"key":"item_number",      "label":"Item #"},
  {"key":"item_description", "label":"Item Description"},
  {"key":"lwh_id",           "label":"LWH ID"},
  {"key":"customer_id",      "label":"Customer ID"},
  {"key":"inv_receipt",      "label":"INV Receipt"},
  {"key":"bill_to_ref",      "label":"Bill-To Ref"},
  {"key":"qty",              "label":"Qty"},
  {"key":"date_received",    "label":"Date Received"},
  {"key":"age_days",         "label":"Age (Days)"}
]'::jsonb, '{"cycle_counts": true}'::jsonb)
on conflict (code) do update set features = excluded.features;

-- PIN admin with a role (the original cust_app_add_user still works and leaves role alone)
create or replace function public.cust_app_add_user_role(p_customer text, p_name text, p_pin text, p_role text)
returns text language plpgsql set search_path = public
as $$
declare r text;
begin
    if coalesce(p_role, '') not in ('customer', 'lwh') then raise exception 'Role must be customer or lwh'; end if;
    r := public.cust_app_add_user(p_customer, p_name, p_pin);
    update cust_app_users set role = p_role where customer_code = upper(trim(p_customer)) and name = trim(p_name);
    return r || ' (' || p_role || ')';
end $$;

/*-----------------------------------------------------------
  Dashboard: totals, aging, top items, bays, recent activity.
  Item and bay lists feed the search type-ahead and the
  cycle count picker.
-----------------------------------------------------------*/
create or replace function public.cust_app_dashboard(p_customer text)
returns jsonb language sql stable set search_path = public
as $$
    with r as (select * from public.cust_app_inventory(p_customer)),
    cu as (select code, display_name, columns, features from public.cust_app_customers
           where code = upper(trim(p_customer)) and active),
    loc as (
        select location_code, location, min(location_sort) so,
               count(*) pallets, coalesce(sum(qty), 0) qty, count(distinct item_number) items,
               count(distinct bay) bays
        from r group by location_code, location
    ),
    it as (
        select item_number, max(item_description) description, count(*) pallets,
               coalesce(sum(qty), 0) qty, count(distinct bay) bays,
               min(date_received) oldest, max(age_days) max_age
        from r group by item_number
    ),
    bay as (
        select location_code, bay, count(*) pallets, coalesce(sum(qty), 0) qty,
               count(distinct item_number) items
        from r group by location_code, bay
    ),
    ag as (
        select case when age_days is null or age_days <= 30 then 1
                    when age_days <= 90 then 2 when age_days <= 180 then 3
                    when age_days <= 365 then 4 else 5 end b,
               count(*) pallets, coalesce(sum(qty), 0) qty
        from r group by 1
    ),
    tx as (
        select th.transaction_date d, th.transaction_type t, count(*) pallets, coalesce(sum(th.quantity), 0) qty
        from public.transaction_history th, cu
        where upper(trim(th.customer)) = cu.code
          and th.transaction_date >= (now() at time zone 'America/Chicago')::date - 13
        group by 1, 2
    )
    select jsonb_build_object(
        'customer', (select jsonb_build_object('code', code, 'name', display_name,
                            'columns', columns, 'features', features) from cu),
        'as_of',         (select max(synced_at) from r),
        'total_pallets', (select count(*) from r),
        'total_qty',     (select coalesce(sum(qty), 0) from r),
        'total_items',   (select count(distinct item_number) from r),
        'total_bays',    (select count(*) from bay),
        'locations', coalesce((select jsonb_agg(jsonb_build_object(
                         'code', location_code, 'label', location, 'pallets', pallets,
                         'qty', qty, 'items', items, 'bays', bays) order by so, location_code) from loc), '[]'::jsonb),
        'aging', (select jsonb_agg(jsonb_build_object(
                     'bucket', x.label, 'pallets', coalesce(ag.pallets, 0), 'qty', coalesce(ag.qty, 0)) order by x.b)
                  from (values (1, '0-30 days'), (2, '31-90 days'), (3, '91-180 days'),
                               (4, '181-365 days'), (5, 'Over 1 year')) x(b, label)
                  left join ag on ag.b = x.b),
        'items', coalesce((select jsonb_agg(jsonb_build_object(
                         'item_number', item_number, 'description', description, 'pallets', pallets,
                         'qty', qty, 'bays', bays, 'oldest', oldest, 'max_age', max_age)
                     order by pallets desc, item_number) from it), '[]'::jsonb),
        'bays', coalesce((select jsonb_agg(jsonb_build_object(
                         'location_code', location_code, 'bay', bay, 'pallets', pallets,
                         'qty', qty, 'items', items) order by location_code, bay) from bay), '[]'::jsonb),
        'activity', coalesce((select jsonb_agg(jsonb_build_object(
                         'date', d, 'direction', t, 'pallets', pallets, 'qty', qty) order by d desc, t) from tx), '[]'::jsonb)
    );
$$;

/*-----------------------------------------------------------
  Smart search.
  - Several IDs pasted (LWH IDs, Customer IDs, INV receipts),
    separated by spaces, commas or new lines: exact bulk lookup,
    with the IDs that weren't found listed back.
  - Field prefixes: item:  bay:  id:  cust:  rcv:  ref:  lot:  desc:
    and age>90 / age<30. A * is a wildcard (bay:E0*).
  - Anything else: every word must appear somewhere on the pallet.
    "Quotes" keep a phrase together: "SPHFGS4  000 X".
-----------------------------------------------------------*/
create or replace function public.cust_app_smart_search(
    p_customer text, p_query text default '', p_location text default 'ALL',
    p_limit integer default 100, p_offset integer default 0)
returns jsonb language plpgsql stable set search_path = public
as $$
declare
    v_q     text := upper(trim(coalesce(p_query, '')));
    v_loc   text := upper(trim(coalesce(p_location, 'ALL')));
    v_tok   text[];
    v_mode  text;
    v_res   jsonb;
begin
    -- Words, or "quoted phrases" kept whole (item numbers with spaces), optionally with a prefix: item:"SPHFGS6 000 X"
    v_tok := array(select coalesce(m[1], '') || coalesce(m[2], m[3])
                   from regexp_matches(v_q, '([A-Z]+:)?"([^"]+)"|([^\s,;"]+)', 'g') m);

    -- Bulk ID mode: 2+ tokens and every one looks like an ID (has a digit, no field prefix, 4+ chars)
    if coalesce(array_length(v_tok, 1), 0) >= 2
       and not exists (select 1 from unnest(v_tok) t where t !~ '\d' or t ~ ':' or length(t) < 3 or t ~ '^AGE[<>]') then
        v_mode := 'bulk';
        with r as (select * from public.cust_app_inventory(p_customer)
                   where v_loc = 'ALL' or upper(location_code) = v_loc),
        hits as (
            select t.tok, r.*,
                   case when r.lwh_id::text = t.tok then 'LWH ID'
                        when upper(r.customer_id) = t.tok then 'Customer ID'
                        when r.inv_receipt::text = t.tok then 'INV Receipt'
                        when upper(r.item_number) = t.tok then 'Item #'
                        else 'Bay' end matched_on
            from unnest(v_tok) t(tok)
            join r on r.lwh_id::text = t.tok or upper(r.customer_id) = t.tok or r.inv_receipt::text = t.tok
                   or upper(r.item_number) = t.tok or upper(r.bay) = t.tok
        ),
        f as (select distinct on (lwh_id) * from hits order by lwh_id),
        pg as (select * from f order by location_sort, location_code, bay, inv_receipt, lwh_id
               limit greatest(p_limit, 1) offset greatest(p_offset, 0))
        select jsonb_build_object(
            'mode', 'bulk',
            'total', (select count(*) from f),
            'qty',   (select coalesce(sum(qty), 0) from f),
            'not_found', coalesce((select jsonb_agg(t.tok order by t.ord) from unnest(v_tok) with ordinality t(tok, ord)
                                   where not exists (select 1 from hits h where h.tok = t.tok)), '[]'::jsonb),
            'rows', coalesce((select jsonb_agg(jsonb_build_object(
                    'location', location, 'location_code', location_code, 'bay', bay,
                    'item_number', item_number, 'item_description', item_description,
                    'lwh_id', lwh_id::text, 'customer_id', customer_id, 'inv_receipt', inv_receipt::text,
                    'bill_to_ref', bill_to_ref, 'lot_number', lot_number, 'unique2', unique2,
                    'vendor', vendor, 'qty', qty, 'date_received', date_received,
                    'age_days', age_days, 'matched_on', matched_on)
                 order by location_sort, location_code, bay, inv_receipt, lwh_id) from pg), '[]'::jsonb))
        into v_res;
        return v_res;
    end if;

    -- Word / prefix mode
    with r as (select * from public.cust_app_inventory(p_customer)
               where v_loc = 'ALL' or upper(location_code) = v_loc),
    t as (
        select tok,
               case when tok ~ '^(ITEM|BAY|ID|CUST|RCV|REF|LOT|DESC):.' then split_part(tok, ':', 1)
                    when tok ~ '^AGE[<>]\d+$' then 'AGE'
                    else 'ANY' end fld,
               case when tok ~ '^(ITEM|BAY|ID|CUST|RCV|REF|LOT|DESC):.' then substr(tok, strpos(tok, ':') + 1)
                    else tok end val
        from unnest(v_tok) tok
    ),
    t2 as (
        select fld, val,
               '%' || replace(replace(replace(val, '%', '\%'), '_', '\_'), '*', '%') || '%' pat,
               replace(replace(replace(val, '%', '\%'), '_', '\_'), '*', '%') xpat   -- exact-with-wildcards (bay:E0*)
        from t
    ),
    m as (
        select r.*,
            (upper(r.item_number) || ' ' || upper(coalesce(r.item_description, '')) || ' ' || r.lwh_id::text || ' ' ||
             upper(r.customer_id) || ' ' || coalesce(r.inv_receipt::text, '') || ' ' || upper(r.bill_to_ref) || ' ' ||
             upper(r.lot_number) || ' ' || upper(r.bay) || ' ' || upper(r.vendor)) hay
        from r
    ),
    f as (
        select m.*,
            case when v_q = '' then ''
                 when exists (select 1 from t2 where t2.fld = 'ANY' and upper(m.item_number) like t2.pat)   then 'Item #'
                 when exists (select 1 from t2 where t2.fld = 'ANY' and m.lwh_id::text like t2.pat)         then 'LWH ID'
                 when exists (select 1 from t2 where t2.fld = 'ANY' and upper(m.customer_id) like t2.pat)   then 'Customer ID'
                 when exists (select 1 from t2 where t2.fld = 'ANY' and m.inv_receipt::text like t2.pat)    then 'INV Receipt'
                 when exists (select 1 from t2 where t2.fld = 'ANY' and upper(m.bay) like t2.pat)           then 'Bay'
                 when exists (select 1 from t2 where t2.fld = 'ANY' and upper(m.bill_to_ref) like t2.pat)   then 'Bill-To Ref'
                 when exists (select 1 from t2 where t2.fld = 'ANY') then 'Description'
                 else (select string_agg(distinct case fld when 'ITEM' then 'Item #' when 'BAY' then 'Bay'
                          when 'ID' then 'LWH ID' when 'CUST' then 'Customer ID' when 'RCV' then 'INV Receipt'
                          when 'REF' then 'Bill-To Ref' when 'LOT' then 'Lot #' when 'DESC' then 'Description'
                          when 'AGE' then 'Age' end, ', ') from t2)
            end matched_on,
            -- rank: exact hits first
            case when exists (select 1 from t2 where upper(m.item_number) = t2.val or m.lwh_id::text = t2.val
                                                  or upper(m.customer_id) = t2.val or upper(m.bay) = t2.val) then 0 else 1 end rnk
        from m
        where not exists (
            select 1 from t2 where not (
                case t2.fld
                    when 'ANY'  then m.hay like t2.pat
                    when 'ITEM' then upper(m.item_number) like t2.pat
                    when 'BAY'  then upper(m.bay) like (case when t2.val like '%*%' then t2.xpat else t2.pat end)
                    when 'ID'   then m.lwh_id::text like t2.pat
                    when 'CUST' then upper(m.customer_id) like t2.pat
                    when 'RCV'  then coalesce(m.inv_receipt::text, '') like t2.pat
                    when 'REF'  then upper(m.bill_to_ref) like t2.pat
                    when 'LOT'  then upper(m.lot_number) like t2.pat
                    when 'DESC' then upper(coalesce(m.item_description, '')) like t2.pat
                    when 'AGE'  then case when t2.val like 'AGE>%' then coalesce(m.age_days, 0) > substr(t2.val, 5)::int
                                          else coalesce(m.age_days, 0) < substr(t2.val, 5)::int end
                end))
    ),
    pg as (select * from f order by rnk, location_sort, location_code, bay, inv_receipt, lwh_id
           limit greatest(p_limit, 1) offset greatest(p_offset, 0))
    select jsonb_build_object(
        'mode', case when v_q = '' then 'all' else 'words' end,
        'total', (select count(*) from f),
        'qty',   (select coalesce(sum(qty), 0) from f),
        'items', (select count(distinct item_number) from f),
        'bays',  (select count(distinct bay) from f),
        'not_found', '[]'::jsonb,
        'rows',  coalesce((select jsonb_agg(jsonb_build_object(
                    'location', location, 'location_code', location_code, 'bay', bay,
                    'item_number', item_number, 'item_description', item_description,
                    'lwh_id', lwh_id::text, 'customer_id', customer_id, 'inv_receipt', inv_receipt::text,
                    'bill_to_ref', bill_to_ref, 'lot_number', lot_number, 'unique2', unique2,
                    'vendor', vendor, 'qty', qty, 'date_received', date_received,
                    'age_days', age_days, 'matched_on', matched_on)
                 order by rnk, location_sort, location_code, bay, inv_receipt, lwh_id) from pg), '[]'::jsonb))
    into v_res;
    return v_res;
end $$;

-- Type-ahead: up to 8 items and 8 bays starting with / containing the text
create or replace function public.cust_app_suggest(p_customer text, p_text text)
returns jsonb language sql stable set search_path = public
as $$
    with r as (select item_number, item_description, bay from public.cust_app_inventory(p_customer)),
    q as (select upper(trim(coalesce(p_text, ''))) v)
    select jsonb_build_object(
      'items', coalesce((select jsonb_agg(x) from (
            select item_number, max(item_description) description, count(*) pallets
            from r, q where q.v <> '' and (upper(item_number) like q.v || '%' or upper(item_description) like '%' || q.v || '%')
            group by item_number, q.v order by (upper(item_number) like q.v || '%') desc, count(*) desc limit 8) x), '[]'::jsonb),
      'bays', coalesce((select jsonb_agg(x) from (
            select bay, count(*) pallets from r, q where q.v <> '' and upper(bay) like q.v || '%'
            group by bay order by bay limit 8) x), '[]'::jsonb));
$$;

revoke execute on function
    public.cust_app_add_user_role(text, text, text, text),
    public.cust_app_dashboard(text),
    public.cust_app_smart_search(text, text, text, integer, integer),
    public.cust_app_suggest(text, text)
from public, anon, authenticated;
