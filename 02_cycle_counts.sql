/*===========================================================
  CYCLE COUNTS - shared customer-app backend (LWH Companion)
  Works for any customer in cust_app_customers whose features
  include {"cycle_counts": true}. First customer: FRAWI.

  Flow:  requested -> in_progress -> review -> closed
         (cancelled is possible before closing)
  - A request names items, bays (E0* wildcards ok), pallets or
    "everything". Expected pallets are frozen when counting STARTS,
    not when requested, so a count requested Monday and started
    Thursday compares against Thursday's inventory.
  - Counters scan an LWH ID or the customer's own tag and enter qty.
    Counts are blind by default: counters never see expected qty.
  - LWH reviews variances, can send lines back for recount, notes
    what was adjusted in the WMS, then closes. Customers see results
    only after close.
  - This app never changes the WMS. Adjustments are made in birdseye.
  - Nothing is ever deleted: an undone scan is voided, a reopened bay is
    flagged inactive, and a removed schedule is archived.

  Schedules (weekly / monthly) create their counts on their run
  date the first time anyone opens the Cycle Counts tab that day.
===========================================================*/

-- ---------- Tables ----------
create table if not exists public.cc_counts (
    id             bigserial primary key,
    customer_code  text not null references public.cust_app_customers(code),
    title          text not null,
    scope_type     text not null check (scope_type in ('items', 'bays', 'pallets', 'all')),
    scope          jsonb not null default '{}'::jsonb,       -- {"items":[..]} {"bays":[..]} {"pallets":[..]} {"location":"WHSE11"}
    performer      text not null default 'lwh' check (performer in ('lwh', 'customer')),
    source         text not null default 'request' check (source in ('request', 'schedule')),
    schedule_id    bigint,
    status         text not null default 'requested'
                   check (status in ('requested', 'in_progress', 'review', 'closed', 'cancelled')),
    blind          boolean not null default true,
    due_date       date,
    notes          text,
    requested_by   text not null,
    requested_role text not null,
    requested_at   timestamptz not null default now(),
    started_by     text, started_at   timestamptz,
    submitted_by   text, submitted_at timestamptz,
    closed_by      text, closed_at    timestamptz, close_note text,
    cancelled_by   text, cancelled_at timestamptz
);
create index if not exists cc_counts_cust_idx on public.cc_counts (customer_code, status, requested_at desc);

create table if not exists public.cc_lines (
    id               bigserial primary key,
    count_id         bigint not null references public.cc_counts(id) on delete cascade,
    lwh_id           bigint,                 -- null only for a tag nobody recognizes
    customer_id      text,
    scanned_tag      text,
    item_number      text,
    item_description text,
    lot_number       text,
    location_code    text,
    bay              text,                   -- where the WMS says it is
    expected         boolean not null default true,   -- false = found but not on the count list
    expected_qty     numeric,
    counted_qty      numeric,
    counted_bay      text,
    counted_by       text,
    counted_at       timestamptz,
    result           text not null default 'pending'
                     check (result in ('pending', 'match', 'qty_diff', 'wrong_bay', 'missing', 'extra', 'unknown')),
    note             text,
    resolution       text,
    wms_adjusted     boolean not null default false,
    resolved_by      text,
    resolved_at      timestamptz,
    voided           boolean not null default false,   -- an undone scan; kept for the audit trail
    voided_by        text,
    voided_at        timestamptz
);
create index if not exists cc_lines_count_idx on public.cc_lines (count_id, bay);
create unique index if not exists cc_lines_pallet_uq on public.cc_lines (count_id, lwh_id) where lwh_id is not null;
create unique index if not exists cc_lines_tag_uq    on public.cc_lines (count_id, scanned_tag) where lwh_id is null;

create table if not exists public.cc_bays_done (
    count_id bigint not null references public.cc_counts(id) on delete cascade,
    bay      text not null,
    done_by  text not null,
    done_at  timestamptz not null default now(),
    active   boolean not null default true,              -- false = reopened for a recount
    primary key (count_id, bay)
);

create table if not exists public.cc_schedules (
    id            bigserial primary key,
    customer_code text not null references public.cust_app_customers(code),
    name          text not null,
    frequency     text not null check (frequency in ('weekly', 'monthly')),
    weekday       smallint check (weekday between 1 and 7),       -- ISO: 1 = Monday
    month_day     smallint check (month_day between 1 and 28),
    scope_type    text not null check (scope_type in ('all', 'items', 'bays', 'rotation', 'top_items')),
    scope         jsonb not null default '{}'::jsonb,              -- rotation: {"cycle_runs":4}  top_items: {"top":25}
    lead_days     integer not null default 3,                      -- due this many days after it is created
    start_date    date not null default date '2027-01-01',
    next_run_on   date,
    last_run_on   date,
    cursor_bay    text,                                            -- rotation position: 'WHSE11|E04'
    active        boolean not null default true,
    archived      boolean not null default false,          -- "removed" schedules are archived, not deleted
    created_by    text not null,
    created_at    timestamptz not null default now()
);

alter table public.cc_counts    enable row level security;
alter table public.cc_lines     enable row level security;
alter table public.cc_bays_done enable row level security;
alter table public.cc_schedules enable row level security;
revoke all on public.cc_counts, public.cc_lines, public.cc_bays_done, public.cc_schedules from anon, authenticated;

-- ---------- helpers ----------
create or replace function public.cc_today() returns date language sql stable
as $$ select (now() at time zone 'America/Chicago')::date $$;

create or replace function public.cc_fail(p_msg text) returns void language plpgsql
as $$ begin raise exception using message = p_msg, errcode = 'P0001'; end $$;

create or replace function public.cc_bay_match(p_bay text, p_pats jsonb) returns boolean language sql immutable
as $$
    select exists (select 1 from jsonb_array_elements_text(coalesce(p_pats, '[]'::jsonb)) p
                   where upper(p_bay) like replace(replace(upper(trim(p)), '_', '\_'), '*', '%'))
$$;

-- Next run date on or after p_from
create or replace function public.cc_next_date(p_freq text, p_weekday smallint, p_month_day smallint, p_from date)
returns date language sql immutable
as $$
    select case when p_freq = 'weekly'
        then p_from + ((coalesce(p_weekday, 1) - extract(isodow from p_from)::int + 7) % 7)
        else case when extract(day from p_from)::int <= coalesce(p_month_day, 1)
                  then date_trunc('month', p_from)::date + (coalesce(p_month_day, 1) - 1)
                  else (date_trunc('month', p_from) + interval '1 month')::date + (coalesce(p_month_day, 1) - 1) end
    end
$$;

-- The pallets a scope covers, from live inventory
create or replace function public.cc_scope_rows(p_customer text, p_scope_type text, p_scope jsonb)
returns setof record language sql stable set search_path = public
as $$
    select r.lwh_id, r.customer_id, r.item_number, r.item_description, r.lot_number,
           r.location_code, r.bay, r.qty
    from public.cust_app_inventory(p_customer) r
    where (coalesce(p_scope->>'location', 'ALL') = 'ALL' or r.location_code = p_scope->>'location')
      and case p_scope_type
            when 'all'     then true
            when 'items'   then upper(r.item_number) in (select upper(trim(x)) from jsonb_array_elements_text(p_scope->'items') x)
            when 'bays'    then public.cc_bay_match(r.bay, p_scope->'bays')
            when 'pallets' then r.lwh_id::text in (select trim(x) from jsonb_array_elements_text(p_scope->'pallets') x)
                             or upper(r.customer_id) in (select upper(trim(x)) from jsonb_array_elements_text(p_scope->'pallets') x)
            else false end
$$;

create or replace function public.cc_auto_title(p_scope_type text, p_scope jsonb)
returns text language sql immutable
as $$
    with a as (select coalesce(jsonb_array_length(case p_scope_type when 'items' then p_scope->'items'
                                  when 'bays' then p_scope->'bays' when 'pallets' then p_scope->'pallets' end), 0) n)
    select case p_scope_type
        when 'all' then 'Full count'
        when 'items' then 'Item ' || (p_scope->'items'->>0) || case when n > 1 then ' + ' || (n - 1) || ' more' else '' end
        when 'bays'  then 'Bay '  || (p_scope->'bays'->>0)  || case when n > 1 then ' + ' || (n - 1) || ' more' else '' end
        when 'pallets' then n || ' pallet' || case when n = 1 then '' else 's' end
    end from a
$$;

-- Counter permission: LWH can work any count; customers only the counts they perform themselves
create or replace function public.cc_load(p_customer text, p_id bigint, p_role text, p_need_count boolean)
returns public.cc_counts language plpgsql stable set search_path = public
as $$
declare c public.cc_counts;
begin
    select * into c from cc_counts where id = p_id and customer_code = upper(trim(p_customer));
    if not found then perform cc_fail('That count was not found.'); end if;
    if p_need_count and p_role <> 'lwh' and c.performer <> 'customer' then
        perform cc_fail('LWH performs this count. You will see the results once it is reviewed.');
    end if;
    return c;
end $$;

-- ---------- Create ----------
create or replace function public.cc_create(
    p_customer text, p_user text, p_role text, p_scope_type text, p_scope jsonb,
    p_performer text default 'lwh', p_due date default null, p_notes text default null,
    p_title text default null, p_source text default 'request', p_schedule_id bigint default null,
    p_blind boolean default true)
returns jsonb language plpgsql set search_path = public
as $$
declare
    v_code text := upper(trim(p_customer));
    v_scope jsonb := coalesce(p_scope, '{}'::jsonb);
    v_key text := case p_scope_type when 'items' then 'items' when 'bays' then 'bays' when 'pallets' then 'pallets' end;
    v_n integer; v_id bigint;
begin
    if not exists (select 1 from cust_app_customers where code = v_code and active
                   and coalesce((features->>'cycle_counts')::boolean, false)) then
        perform cc_fail('Cycle counts are not turned on for this account.');
    end if;
    if p_scope_type not in ('items', 'bays', 'pallets', 'all') then perform cc_fail('Choose what to count.'); end if;
    if p_scope_type = 'all' and p_role <> 'lwh' and p_performer = 'lwh' then
        perform cc_fail('A full count needs to be scheduled with your LWH representative.');
    end if;
    if v_key is not null then
        v_scope := jsonb_set(v_scope, array[v_key], coalesce((select jsonb_agg(distinct upper(trim(x)))
                     from jsonb_array_elements_text(coalesce(v_scope->v_key, '[]'::jsonb)) x where trim(x) <> ''), '[]'::jsonb));
        if jsonb_array_length(v_scope->v_key) = 0 then perform cc_fail('Add at least one ' ||
            case v_key when 'items' then 'item' when 'bays' then 'bay' else 'pallet' end || ' to count.'); end if;
        if jsonb_array_length(v_scope->v_key) > 500 then perform cc_fail('That is more than 500 entries. Split it into smaller counts.'); end if;
    end if;
    select count(*) into v_n from cc_scope_rows(v_code, p_scope_type, v_scope)
        as r(lwh_id bigint, customer_id text, item_number text, item_description text, lot_number text,
             location_code text, bay text, qty numeric);
    if v_n = 0 and p_source = 'request' then
        perform cc_fail('Nothing in inventory matches that right now. Check the item numbers or bays.');
    end if;
    insert into cc_counts (customer_code, title, scope_type, scope, performer, source, schedule_id,
                           due_date, notes, requested_by, requested_role, blind)
    values (v_code, coalesce(nullif(trim(p_title), ''), cc_auto_title(p_scope_type, v_scope)), p_scope_type, v_scope,
            case when p_performer = 'customer' then 'customer' else 'lwh' end, p_source, p_schedule_id,
            p_due, nullif(trim(p_notes), ''), p_user, p_role, coalesce(p_blind, true))
    returning id into v_id;
    return jsonb_build_object('id', v_id, 'pallets', v_n);
end $$;

-- ---------- Start: freeze the expected pallets ----------
create or replace function public.cc_start(p_customer text, p_id bigint, p_user text, p_role text)
returns jsonb language plpgsql set search_path = public
as $$
declare c public.cc_counts; v_n integer;
begin
    c := cc_load(p_customer, p_id, p_role, true);
    if c.status = 'in_progress' then return jsonb_build_object('id', c.id, 'status', c.status); end if;
    if c.status <> 'requested' then perform cc_fail('This count is already ' || replace(c.status, '_', ' ') || '.'); end if;
    insert into cc_lines (count_id, lwh_id, customer_id, item_number, item_description, lot_number,
                          location_code, bay, expected, expected_qty)
    select c.id, r.lwh_id, nullif(r.customer_id, ''), r.item_number, r.item_description, r.lot_number,
           r.location_code, r.bay, true, r.qty
    from cc_scope_rows(c.customer_code, c.scope_type, c.scope)
         as r(lwh_id bigint, customer_id text, item_number text, item_description text, lot_number text,
              location_code text, bay text, qty numeric)
    on conflict do nothing;
    get diagnostics v_n = row_count;
    update cc_counts set status = 'in_progress', started_by = p_user, started_at = now() where id = c.id;
    return jsonb_build_object('id', c.id, 'status', 'in_progress', 'pallets', v_n);
end $$;

-- ---------- Scan one pallet ----------
create or replace function public.cc_scan(
    p_customer text, p_id bigint, p_user text, p_role text,
    p_bay text, p_tag text, p_qty numeric, p_note text default null)
returns jsonb language plpgsql set search_path = public
as $$
declare
    c public.cc_counts;
    v_tag text := upper(regexp_replace(coalesce(p_tag, ''), '\s', '', 'g'));
    v_bay text := upper(trim(coalesce(p_bay, '')));
    l public.cc_lines;
    inv record;
    v_res text; v_msg text; v_again boolean := false;
begin
    c := cc_load(p_customer, p_id, p_role, true);
    if c.status <> 'in_progress' then perform cc_fail('This count is not open for counting.'); end if;
    if v_tag = '' then perform cc_fail('Scan or type a tag.'); end if;
    if v_bay = '' then perform cc_fail('Pick the bay you are counting first.'); end if;
    if p_qty is null or p_qty < 0 then perform cc_fail('Enter the quantity on the pallet.'); end if;

    select * into l from cc_lines
     where count_id = c.id and (lwh_id::text = v_tag or upper(customer_id) = v_tag or scanned_tag = v_tag)
     order by expected desc, voided limit 1;

    if found then
        v_again := l.counted_at is not null and l.result <> 'missing' and not l.voided;
        v_res := case when not l.expected then case when l.lwh_id is null then 'unknown' else 'extra' end
                      when upper(l.bay) <> v_bay then 'wrong_bay'
                      when p_qty <> coalesce(l.expected_qty, 0) then 'qty_diff' else 'match' end;
        update cc_lines set counted_qty = p_qty, counted_bay = v_bay, counted_by = p_user, counted_at = now(),
               result = v_res, note = coalesce(nullif(trim(p_note), ''), note),
               voided = false, voided_by = null, voided_at = null
         where id = l.id returning * into l;
        v_msg := case when not l.expected and l.lwh_id is null then 'Saved, but this tag is not in this customer''s inventory. Double-check the tag.'
                      when not l.expected then 'Saved. Not on the count list; the WMS shows it in bay ' || coalesce(l.bay, '?') || '.'
                      when v_res = 'wrong_bay' then 'Saved. The WMS shows this pallet in bay ' || l.bay || '.'
                      when v_again then 'Updated.' else 'Counted.' end;
    else
        select r.* into inv from public.cust_app_inventory(c.customer_code) r
         where r.lwh_id::text = v_tag or upper(r.customer_id) = v_tag limit 1;
        if found then
            insert into cc_lines (count_id, lwh_id, customer_id, item_number, item_description, lot_number,
                                  location_code, bay, expected, expected_qty, counted_qty, counted_bay,
                                  counted_by, counted_at, result, note)
            values (c.id, inv.lwh_id, nullif(inv.customer_id, ''), inv.item_number, inv.item_description, inv.lot_number,
                    inv.location_code, inv.bay, false, inv.qty, p_qty, v_bay, p_user, now(), 'extra', nullif(trim(p_note), ''))
            returning * into l;
            v_msg := 'Saved. Not on the count list; the WMS shows it in bay ' || inv.bay || '.';
        else
            insert into cc_lines (count_id, scanned_tag, expected, counted_qty, counted_bay, counted_by, counted_at, result, note)
            values (c.id, v_tag, false, p_qty, v_bay, p_user, now(), 'unknown', nullif(trim(p_note), ''))
            returning * into l;
            v_msg := 'Saved, but this tag is not in this customer''s inventory. Double-check the tag.';
        end if;
    end if;

    return jsonb_build_object('line_id', l.id, 'result',
        case when c.blind and l.result in ('match', 'qty_diff') then 'counted' else l.result end,
        'message', v_msg, 'item_number', l.item_number, 'tag', coalesce(l.lwh_id::text, l.scanned_tag));
end $$;

-- Undo a scan: an expected pallet goes back to "not counted"; a pallet that wasn't on the list is voided (kept for the audit trail)
create or replace function public.cc_undo(p_customer text, p_id bigint, p_line bigint, p_user text, p_role text)
returns jsonb language plpgsql set search_path = public
as $$
declare c public.cc_counts;
begin
    c := cc_load(p_customer, p_id, p_role, true);
    if c.status <> 'in_progress' then perform cc_fail('This count is not open for counting.'); end if;
    update cc_lines set voided = true, voided_by = p_user, voided_at = now()
     where id = p_line and count_id = c.id and not expected;
    update cc_lines set counted_qty = null, counted_bay = null, counted_by = null, counted_at = null, result = 'pending'
     where id = p_line and count_id = c.id and expected;
    return jsonb_build_object('ok', true);
end $$;

-- Bay finished: anything expected there and not scanned is missing
create or replace function public.cc_bay_done(p_customer text, p_id bigint, p_bay text, p_user text, p_role text)
returns jsonb language plpgsql set search_path = public
as $$
declare c public.cc_counts; v_bay text := upper(trim(coalesce(p_bay, ''))); v_n integer;
begin
    c := cc_load(p_customer, p_id, p_role, true);
    if c.status <> 'in_progress' then perform cc_fail('This count is not open for counting.'); end if;
    if v_bay = '' then perform cc_fail('Pick a bay.'); end if;
    insert into cc_bays_done (count_id, bay, done_by) values (c.id, v_bay, p_user)
    on conflict (count_id, bay) do update set done_by = excluded.done_by, done_at = now(), active = true;
    update cc_lines set result = 'missing', counted_qty = 0, counted_by = p_user, counted_at = now()
     where count_id = c.id and expected and upper(bay) = v_bay and result = 'pending';
    get diagnostics v_n = row_count;
    return jsonb_build_object('bay', v_bay, 'not_found', v_n);
end $$;

-- Submit for LWH review: anything still not counted is missing
create or replace function public.cc_submit(p_customer text, p_id bigint, p_user text, p_role text)
returns jsonb language plpgsql set search_path = public
as $$
declare c public.cc_counts; v_n integer;
begin
    c := cc_load(p_customer, p_id, p_role, true);
    if c.status <> 'in_progress' then perform cc_fail('This count is not open for counting.'); end if;
    update cc_lines set result = 'missing', counted_qty = 0, counted_by = p_user, counted_at = now()
     where count_id = c.id and expected and result = 'pending';
    get diagnostics v_n = row_count;
    update cc_counts set status = 'review', submitted_by = p_user, submitted_at = now() where id = c.id;
    return jsonb_build_object('id', c.id, 'status', 'review', 'marked_missing', v_n);
end $$;

-- ---------- LWH review ----------
create or replace function public.cc_recount(p_customer text, p_id bigint, p_lines bigint[], p_user text, p_role text)
returns jsonb language plpgsql set search_path = public
as $$
declare c public.cc_counts; v_n integer;
begin
    if p_role <> 'lwh' then perform cc_fail('Only LWH can send lines back for recount.'); end if;
    c := cc_load(p_customer, p_id, p_role, false);
    if c.status not in ('review', 'in_progress') then perform cc_fail('Only a count in review can be recounted.'); end if;
    -- reopen the bays involved
    update cc_bays_done d set active = false
     where d.count_id = c.id and d.bay in
        (select upper(coalesce(bay, '')) from cc_lines where count_id = c.id and id = any(p_lines)
         union select upper(coalesce(counted_bay, '')) from cc_lines where count_id = c.id and id = any(p_lines));
    update cc_lines set voided = true, voided_by = p_user, voided_at = now()
     where count_id = c.id and id = any(p_lines) and not expected;
    update cc_lines set counted_qty = null, counted_bay = null, counted_by = null, counted_at = null,
                        result = 'pending', resolution = null, wms_adjusted = false, resolved_by = null, resolved_at = null
     where count_id = c.id and id = any(p_lines) and expected;
    get diagnostics v_n = row_count;
    update cc_counts set status = 'in_progress' where id = c.id;
    return jsonb_build_object('id', c.id, 'status', 'in_progress', 'lines', v_n);
end $$;

create or replace function public.cc_resolve(p_customer text, p_id bigint, p_line bigint, p_resolution text,
                                             p_wms_adjusted boolean, p_user text, p_role text)
returns jsonb language plpgsql set search_path = public
as $$
declare c public.cc_counts;
begin
    if p_role <> 'lwh' then perform cc_fail('Only LWH can resolve variances.'); end if;
    c := cc_load(p_customer, p_id, p_role, false);
    if c.status not in ('review', 'closed') then perform cc_fail('Resolve variances while the count is in review.'); end if;
    update cc_lines set resolution = nullif(trim(p_resolution), ''), wms_adjusted = coalesce(p_wms_adjusted, false),
                        resolved_by = p_user, resolved_at = now()
     where id = p_line and count_id = c.id;
    return jsonb_build_object('ok', true);
end $$;

create or replace function public.cc_close(p_customer text, p_id bigint, p_note text, p_user text, p_role text)
returns jsonb language plpgsql set search_path = public
as $$
declare c public.cc_counts;
begin
    if p_role <> 'lwh' then perform cc_fail('Only LWH can close a count.'); end if;
    c := cc_load(p_customer, p_id, p_role, false);
    if c.status <> 'review' then perform cc_fail('Only a count in review can be closed.'); end if;
    update cc_counts set status = 'closed', closed_by = p_user, closed_at = now(), close_note = nullif(trim(p_note), '')
     where id = c.id;
    return jsonb_build_object('id', c.id, 'status', 'closed');
end $$;

create or replace function public.cc_cancel(p_customer text, p_id bigint, p_user text, p_role text)
returns jsonb language plpgsql set search_path = public
as $$
declare c public.cc_counts;
begin
    c := cc_load(p_customer, p_id, p_role, false);
    if c.status not in ('requested', 'in_progress') then perform cc_fail('Only an open count can be cancelled.'); end if;
    if p_role <> 'lwh' and (c.status <> 'requested' or c.requested_role = 'lwh') then
        perform cc_fail('Ask your LWH representative to cancel this count.');
    end if;
    update cc_counts set status = 'cancelled', cancelled_by = p_user, cancelled_at = now() where id = c.id;
    return jsonb_build_object('id', c.id, 'status', 'cancelled');
end $$;

-- ---------- Results math (voided lines and reopened bays never count) ----------
create or replace function public.cc_stats(p_id bigint)
returns jsonb language sql stable set search_path = public
as $$
    select jsonb_build_object(
        'expected_pallets', count(*) filter (where expected),
        'counted_pallets',  count(*) filter (where expected and result not in ('pending', 'missing')),
        'pending',          count(*) filter (where result = 'pending'),
        'match',            count(*) filter (where result = 'match'),
        'qty_diff',         count(*) filter (where result = 'qty_diff'),
        'wrong_bay',        count(*) filter (where result = 'wrong_bay'),
        'missing',          count(*) filter (where result = 'missing'),
        'extra',            count(*) filter (where result = 'extra'),
        'unknown',          count(*) filter (where result = 'unknown'),
        'variances',        count(*) filter (where result in ('qty_diff', 'wrong_bay', 'missing', 'extra', 'unknown')),
        'unresolved',       count(*) filter (where result in ('qty_diff', 'wrong_bay', 'missing', 'extra', 'unknown')
                                             and resolution is null and not wms_adjusted),
        'expected_qty',     coalesce(sum(expected_qty) filter (where expected), 0),
        'counted_qty',      coalesce(sum(counted_qty), 0),
        'net_qty_diff',     coalesce(sum(counted_qty), 0) - coalesce(sum(expected_qty) filter (where expected), 0),
        'pallet_accuracy',  case when count(*) filter (where expected) = 0 then null
                                 else round(100.0 * count(*) filter (where result = 'match')
                                            / nullif(count(*), 0), 1) end,
        'qty_accuracy',     case when coalesce(sum(expected_qty) filter (where expected), 0) = 0 then null
                                 else greatest(0, round(100.0 * (1 - (
                                        coalesce(sum(abs(coalesce(counted_qty, 0) - coalesce(expected_qty, 0))) filter (where expected), 0)
                                      + coalesce(sum(counted_qty) filter (where not expected), 0))
                                      / sum(expected_qty) filter (where expected)), 1)) end,
        'bays_total',       count(distinct upper(bay)) filter (where expected),
        'bays_done',        (select count(*) from public.cc_bays_done d where d.count_id = p_id and d.active))
    from public.cc_lines where count_id = p_id and not voided
$$;

-- Progress only (no quantities): what customers and blind counters see
create or replace function public.cc_progress(p_id bigint)
returns jsonb language sql stable set search_path = public
as $$
    select jsonb_build_object(
        'expected_pallets', count(*) filter (where expected),
        'counted_pallets',  count(*) filter (where expected and result not in ('pending', 'missing')),
        'pending',          count(*) filter (where result = 'pending'),
        'bays_total',       count(distinct upper(bay)) filter (where expected),
        'bays_done',        (select count(*) from public.cc_bays_done d where d.count_id = p_id and d.active))
    from public.cc_lines where count_id = p_id and not voided
$$;

-- ---------- Read ----------
create or replace function public.cc_list(p_customer text, p_role text, p_which text default 'open')
returns jsonb language sql stable set search_path = public
as $$
    select coalesce(jsonb_agg(jsonb_build_object(
        'id', c.id, 'title', c.title, 'scope_type', c.scope_type, 'scope', c.scope, 'status', c.status,
        'performer', c.performer, 'source', c.source, 'due_date', c.due_date, 'notes', c.notes,
        'requested_by', c.requested_by, 'requested_at', c.requested_at,
        'started_by', c.started_by, 'started_at', c.started_at, 'submitted_at', c.submitted_at,
        'closed_by', c.closed_by, 'closed_at', c.closed_at, 'close_note', c.close_note,
        'overdue', c.due_date < public.cc_today() and c.status in ('requested', 'in_progress'),
        'stats', case when (p_role = 'lwh' and c.status in ('review', 'closed')) or c.status = 'closed'
                      then public.cc_stats(c.id) else public.cc_progress(c.id) end)
        order by case c.status when 'in_progress' then 1 when 'review' then 2 when 'requested' then 3 else 4 end,
                 coalesce(c.closed_at, c.cancelled_at, c.requested_at) desc), '[]'::jsonb)
    from public.cc_counts c
    where c.customer_code = upper(trim(p_customer))
      and case p_which when 'open'   then c.status in ('requested', 'in_progress', 'review')
                       when 'closed' then c.status in ('closed', 'cancelled')
                                          and coalesce(c.closed_at, c.cancelled_at) > now() - interval '400 days'
                       else true end
$$;

-- Customers see results only once a count is closed. On a blind count nobody sees expected qty while counting.
create or replace function public.cc_get(p_customer text, p_id bigint, p_role text)
returns jsonb language plpgsql stable set search_path = public
as $$
declare c public.cc_counts; v_full boolean;
begin
    c := cc_load(p_customer, p_id, p_role, false);
    v_full := (p_role = 'lwh' and c.status in ('review', 'closed', 'cancelled'))
           or (p_role = 'lwh' and c.status = 'in_progress' and not c.blind)
           or c.status = 'closed';
    return jsonb_build_object(
        'count', to_jsonb(c) - 'customer_code',
        'full', v_full,
        'can_count', c.status in ('requested', 'in_progress') and (p_role = 'lwh' or c.performer = 'customer'),
        'stats', case when v_full then cc_stats(c.id) else cc_progress(c.id) end,
        'bays_done', coalesce((select jsonb_agg(bay order by bay) from cc_bays_done where count_id = c.id and active), '[]'::jsonb),
        'lines', case when c.status = 'requested' then '[]'::jsonb else coalesce((select jsonb_agg(jsonb_build_object(
            'id', l.id, 'lwh_id', l.lwh_id::text, 'customer_id', l.customer_id, 'tag', l.scanned_tag,
            'item_number', l.item_number, 'item_description', l.item_description, 'lot_number', l.lot_number,
            'location_code', l.location_code, 'bay', l.bay, 'expected', l.expected,
            'expected_qty', case when v_full then l.expected_qty end,
            'counted_qty', l.counted_qty, 'counted_bay', l.counted_bay,
            'counted_by', l.counted_by, 'counted_at', l.counted_at,
            'result', case when not v_full and l.result in ('match', 'qty_diff') then 'counted' else l.result end,
            'note', l.note,
            'resolution', case when v_full then l.resolution end,
            'wms_adjusted', case when v_full then l.wms_adjusted end,
            'resolved_by', case when v_full then l.resolved_by end)
            order by l.location_code, l.bay, l.item_number, l.lwh_id)
            from cc_lines l where l.count_id = c.id and not l.voided), '[]'::jsonb) end);
end $$;

-- ---------- Schedules ----------
create or replace function public.cc_schedule_list(p_customer text)
returns jsonb language sql stable set search_path = public
as $$
    select coalesce(jsonb_agg(to_jsonb(s) - 'customer_code' - 'archived' order by s.active desc, s.next_run_on, s.name), '[]'::jsonb)
    from public.cc_schedules s where s.customer_code = upper(trim(p_customer)) and not s.archived
$$;

create or replace function public.cc_schedule_save(p_customer text, p_user text, p_role text, p jsonb)
returns jsonb language plpgsql set search_path = public
as $$
declare
    v_code text := upper(trim(p_customer));
    v_id bigint := nullif(p->>'id', '')::bigint;
    v_freq text := p->>'frequency';
    v_wd smallint := nullif(p->>'weekday', '')::smallint;
    v_md smallint := nullif(p->>'month_day', '')::smallint;
    v_start date := coalesce(nullif(p->>'start_date', '')::date, date '2027-01-01');
    v_type text := p->>'scope_type';
    v_scope jsonb := coalesce(p->'scope', '{}'::jsonb);
    v_next date;
begin
    if p_role <> 'lwh' then perform cc_fail('Only LWH can set up scheduled counts.'); end if;
    if coalesce(trim(p->>'name'), '') = '' then perform cc_fail('Give the schedule a name.'); end if;
    if coalesce(v_freq, '') not in ('weekly', 'monthly') then perform cc_fail('Pick weekly or monthly.'); end if;
    if v_freq = 'weekly' and v_wd is null then perform cc_fail('Pick the day of the week.'); end if;
    if v_freq = 'monthly' and v_md is null then perform cc_fail('Pick the day of the month (1 to 28).'); end if;
    if coalesce(v_type, '') not in ('all', 'items', 'bays', 'rotation', 'top_items') then perform cc_fail('Pick what each count covers.'); end if;
    if v_type = 'rotation' and coalesce((v_scope->>'cycle_runs')::int, 0) not between 2 and 52 then
        perform cc_fail('A rotation splits the bays over 2 to 52 counts.'); end if;
    if v_type = 'top_items' and coalesce((v_scope->>'top')::int, 0) not between 1 and 500 then
        perform cc_fail('Top items must be between 1 and 500.'); end if;
    if v_type in ('items', 'bays') and jsonb_array_length(coalesce(v_scope->v_type, '[]'::jsonb)) = 0 then
        perform cc_fail('Add at least one ' || rtrim(v_type, 's') || '.'); end if;
    v_next := cc_next_date(v_freq, v_wd, v_md, greatest(v_start, cc_today()));

    if v_id is null then
        insert into cc_schedules (customer_code, name, frequency, weekday, month_day, scope_type, scope,
                                  lead_days, start_date, next_run_on, active, created_by)
        values (v_code, trim(p->>'name'), v_freq, v_wd, v_md, v_type, v_scope,
                coalesce(nullif(p->>'lead_days', '')::int, case when v_freq = 'weekly' then 3 else 7 end),
                v_start, v_next, coalesce((p->>'active')::boolean, true), p_user)
        returning id into v_id;
    else
        update cc_schedules set name = trim(p->>'name'), frequency = v_freq, weekday = v_wd, month_day = v_md,
               cursor_bay = case when scope_type = v_type then cursor_bay end,
               scope_type = v_type, scope = v_scope,
               lead_days = coalesce(nullif(p->>'lead_days', '')::int, lead_days),
               start_date = v_start, next_run_on = v_next, active = coalesce((p->>'active')::boolean, active)
         where id = v_id and customer_code = v_code and not archived;
        if not found then perform cc_fail('That schedule was not found.'); end if;
    end if;
    return jsonb_build_object('id', v_id, 'next_run_on', v_next);
end $$;

create or replace function public.cc_schedule_remove(p_customer text, p_id bigint, p_user text, p_role text)
returns jsonb language plpgsql set search_path = public
as $$
begin
    if p_role <> 'lwh' then perform cc_fail('Only LWH can remove scheduled counts.'); end if;
    update cc_schedules set archived = true, active = false where id = p_id and customer_code = upper(trim(p_customer));
    return jsonb_build_object('ok', true);
end $$;

-- Creates the due scheduled counts. Runs whenever the Cycle Counts tab loads.
-- One count per schedule per run date and no backlog: if nobody opened the app for a while, only the current run is made.
create or replace function public.cc_run_due(p_customer text)
returns integer language plpgsql set search_path = public
as $$
declare
    s public.cc_schedules; v_today date := cc_today(); v_made integer := 0;
    v_type text; v_scope jsonb; v_list jsonb; v_last text; v_n integer; v_total integer; v_label text; v_keys text[];
begin
    for s in select * from cc_schedules
             where customer_code = upper(trim(p_customer)) and active and not archived and next_run_on <= v_today
             for update skip locked loop
        v_last := s.cursor_bay; v_label := s.name;
        if s.scope_type = 'rotation' then
            -- bays in a fixed order; each run takes the next 1/N of them after the cursor, wrapping around
            v_keys := array(select distinct location_code || '|' || bay
                            from cust_app_inventory(s.customer_code) where bay <> 'Not Assigned' order by 1);
            v_total := coalesce(array_length(v_keys, 1), 0);
            v_n := greatest(1, ceil(v_total::numeric / greatest((s.scope->>'cycle_runs')::int, 1))::int);
            v_keys := array(select k from (
                select k, case when s.cursor_bay is null or k > s.cursor_bay then 1 else 2 end grp
                from unnest(v_keys) k) z order by grp, k limit v_n);
            v_last := v_keys[coalesce(array_length(v_keys, 1), 0)];
            v_list := coalesce((select jsonb_agg(split_part(k, '|', 2) order by o)
                                from unnest(v_keys) with ordinality u(k, o)), '[]'::jsonb);
            v_type := 'bays'; v_scope := jsonb_build_object('bays', v_list);
            if jsonb_array_length(v_list) > 0 then
                v_label := s.name || ' (' || (v_list->>0) || ' to ' || (v_list->>(jsonb_array_length(v_list) - 1)) || ')';
            end if;
        elsif s.scope_type = 'top_items' then
            select jsonb_agg(item_number) into v_list from (
                select item_number from cust_app_inventory(s.customer_code)
                group by item_number order by count(*) desc, item_number limit (s.scope->>'top')::int) x;
            v_type := 'items'; v_scope := jsonb_build_object('items', coalesce(v_list, '[]'::jsonb));
        else
            v_type := s.scope_type; v_scope := s.scope;
        end if;

        if v_type = 'all' or jsonb_array_length(coalesce(v_scope->v_type, '[]'::jsonb)) > 0 then
            perform cc_create(s.customer_code, 'Schedule: ' || s.name, 'lwh', v_type, v_scope, 'lwh',
                              s.next_run_on + s.lead_days, null, v_label || ' - ' || to_char(s.next_run_on, 'MM/DD/YYYY'),
                              'schedule', s.id, true);
            v_made := v_made + 1;
        end if;
        update cc_schedules set last_run_on = next_run_on,
               next_run_on = cc_next_date(frequency, weekday, month_day, v_today + 1),
               cursor_bay = case when scope_type = 'rotation' then v_last else cursor_bay end
         where id = s.id;
    end loop;
    return v_made;
end $$;

-- Only the service role (Edge Function) and the SQL editor can call these.
revoke execute on function
    public.cc_today(), public.cc_fail(text), public.cc_bay_match(text, jsonb),
    public.cc_next_date(text, smallint, smallint, date), public.cc_scope_rows(text, text, jsonb),
    public.cc_auto_title(text, jsonb), public.cc_load(text, bigint, text, boolean),
    public.cc_create(text, text, text, text, jsonb, text, date, text, text, text, bigint, boolean),
    public.cc_start(text, bigint, text, text),
    public.cc_scan(text, bigint, text, text, text, text, numeric, text),
    public.cc_undo(text, bigint, bigint, text, text),
    public.cc_bay_done(text, bigint, text, text, text),
    public.cc_submit(text, bigint, text, text),
    public.cc_recount(text, bigint, bigint[], text, text),
    public.cc_resolve(text, bigint, bigint, text, boolean, text, text),
    public.cc_close(text, bigint, text, text, text),
    public.cc_cancel(text, bigint, text, text),
    public.cc_stats(bigint), public.cc_progress(bigint),
    public.cc_list(text, text, text), public.cc_get(text, bigint, text),
    public.cc_schedule_list(text), public.cc_schedule_save(text, text, text, jsonb),
    public.cc_schedule_remove(text, bigint, text, text), public.cc_run_due(text)
from public, anon, authenticated;


-- ---------- Later change (applied 2026-10-19): pallet check is the default ----------
-- Migration "cycle_counts_8_pallet_check_mode" replaced cc_scan and cc_run_due:
--   * scope.count_qty = true asks for quantities; otherwise a count is a pallet check.
--   * On a pallet check, cc_scan needs no qty and records a found pallet at its WMS quantity
--     (expected_qty), so results show found / wrong bay / missing / not on list only.
--   * cc_run_due copies the schedule's scope.count_qty onto every count it creates.
-- The live definitions are in Supabase: select pg_get_functiondef('public.cc_scan'::regproc);
