-- Bite & Sip: core schema, security model and business rules.
--
-- Security model (see docs/SECURITY.md):
--   * Students are anonymous. They never read or write order tables directly.
--     They call SECURITY DEFINER functions that validate every input and
--     compute prices from the menu (never from the client).
--   * A student proves ownership of an order with a 256-bit secret generated
--     on their device. Only its SHA-256 hash is stored.
--   * Staff authenticate with Supabase Auth. Being "authenticated" is not
--     enough: every staff policy checks an active row in public.staff.
--   * Column-level grants limit which order columns staff may update, and a
--     trigger enforces the order/payment state machine for every caller.

create schema if not exists private;
revoke all on schema private from public;
-- Policies and triggers call private helpers as the requesting role.
grant usage on schema private to authenticated, service_role;

-- New objects in public must be granted explicitly (Supabase grants all by default).
alter default privileges for role postgres in schema public revoke all on tables from anon, authenticated;
alter default privileges for role postgres in schema public revoke all on sequences from anon, authenticated;
alter default privileges for role postgres in schema public revoke execute on functions from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Types
-- ---------------------------------------------------------------------------
create type public.order_status as enum ('placed', 'preparing', 'ready', 'completed', 'cancelled');
create type public.payment_method as enum ('cash', 'upi');
create type public.payment_status as enum ('unpaid', 'paid');
create type public.staff_role as enum ('owner', 'kitchen');

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------
create table public.staff (
  user_id uuid primary key references auth.users (id) on delete cascade,
  display_name text not null check (char_length(btrim(display_name)) between 1 and 60),
  role public.staff_role not null default 'kitchen',
  is_active boolean not null default true,
  created_at timestamptz not null default now()
);

create table public.cafe_settings (
  id boolean primary key default true check (id),
  cafe_name text not null default 'Bite & Sip' check (char_length(btrim(cafe_name)) between 1 and 60),
  is_open boolean not null default true,
  closed_message text not null default 'We''re closed right now. Please check back soon.'
    check (char_length(closed_message) <= 160),
  upi_id text check (upi_id is null or upi_id ~ '^[A-Za-z0-9._-]{2,64}@[A-Za-z][A-Za-z0-9]{1,63}$'),
  upi_payee_name text not null default 'Bite & Sip' check (char_length(btrim(upi_payee_name)) between 1 and 50),
  updated_at timestamptz not null default now()
);

create table public.categories (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(btrim(name)) between 1 and 40),
  sort_order integer not null default 0,
  created_at timestamptz not null default now()
);
create unique index categories_name_key on public.categories (lower(btrim(name)));

create table public.menu_items (
  id uuid primary key default gen_random_uuid(),
  category_id uuid not null references public.categories (id) on delete restrict,
  name text not null check (char_length(btrim(name)) between 1 and 60),
  description text not null default '' check (char_length(description) <= 200),
  price integer not null check (price between 1 and 5000),
  is_veg boolean not null default true,
  is_available boolean not null default true,
  is_popular boolean not null default false,
  image_path text check (image_path is null or char_length(image_path) <= 300),
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index menu_items_category_idx on public.menu_items (category_id);

create table public.addons (
  id uuid primary key default gen_random_uuid(),
  menu_item_id uuid not null references public.menu_items (id) on delete cascade,
  name text not null check (char_length(btrim(name)) between 1 and 40),
  price integer not null check (price between 0 and 1000),
  is_available boolean not null default true,
  sort_order integer not null default 0,
  updated_at timestamptz not null default now()
);
create index addons_menu_item_idx on public.addons (menu_item_id);
create unique index addons_item_name_key on public.addons (menu_item_id, lower(btrim(name)));

create table public.cafe_tables (
  label text primary key check (label ~ '^[A-Z0-9-]{1,10}$'),
  is_active boolean not null default true,
  created_at timestamptz not null default now()
);

create table public.orders (
  id uuid primary key default gen_random_uuid(),
  order_no bigint generated always as identity (start with 1001) unique,
  access_hash bytea not null,
  track_key text not null unique,
  client_request_id uuid not null unique,
  customer_name text not null check (char_length(customer_name) between 1 and 40),
  customer_phone text not null check (customer_phone ~ '^[6-9][0-9]{9}$'),
  table_label text,
  status public.order_status not null default 'placed',
  payment_method public.payment_method not null,
  payment_status public.payment_status not null default 'unpaid',
  total integer not null check (total > 0),
  item_count integer not null check (item_count > 0),
  customer_reported_paid_at timestamptz,
  payment_reference text check (payment_reference is null or char_length(payment_reference) <= 40),
  paid_at timestamptz,
  paid_by uuid references auth.users (id) on delete set null,
  cancel_reason text check (cancel_reason is null or char_length(cancel_reason) <= 140),
  cancelled_by text check (cancelled_by in ('customer', 'staff')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  preparing_at timestamptz,
  ready_at timestamptz,
  completed_at timestamptz,
  cancelled_at timestamptz,
  constraint orders_completed_requires_paid check (status <> 'completed' or payment_status = 'paid'),
  constraint orders_paid_at_consistent check ((payment_status = 'paid') = (paid_at is not null)),
  constraint orders_cancel_consistent check ((status = 'cancelled') = (cancelled_at is not null))
);
create index orders_created_at_idx on public.orders (created_at desc);
create index orders_open_idx on public.orders (status) where status in ('placed', 'preparing', 'ready');
create index orders_open_phone_idx on public.orders (customer_phone) where status in ('placed', 'preparing', 'ready');

create table public.order_items (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.orders (id) on delete cascade,
  menu_item_id uuid references public.menu_items (id) on delete set null,
  name text not null,
  base_price integer not null check (base_price >= 0),
  addons jsonb not null default '[]'::jsonb check (jsonb_typeof(addons) = 'array'),
  unit_price integer not null check (unit_price >= 0),
  quantity integer not null check (quantity between 1 and 20),
  line_total integer not null,
  note text check (note is null or char_length(note) <= 120),
  constraint order_items_line_total check (line_total = unit_price * quantity)
);
create index order_items_order_idx on public.order_items (order_id);
create index order_items_menu_item_idx on public.order_items (menu_item_id);

-- ---------------------------------------------------------------------------
-- Role helpers (private schema: not reachable through the Data API)
-- ---------------------------------------------------------------------------
create function private.current_staff_role()
returns public.staff_role
language sql stable security definer set search_path = ''
as $$
  select s.role from public.staff s
  where s.user_id = (select auth.uid()) and s.is_active
$$;

create function private.is_staff()
returns boolean
language sql stable security definer set search_path = ''
as $$ select private.current_staff_role() is not null $$;

create function private.is_owner()
returns boolean
language sql stable security definer set search_path = ''
as $$ select coalesce(private.current_staff_role() = 'owner', false) $$;

revoke all on function private.current_staff_role() from public;
revoke all on function private.is_staff() from public;
revoke all on function private.is_owner() from public;
grant execute on function private.current_staff_role() to authenticated, service_role;
grant execute on function private.is_staff() to authenticated, service_role;
grant execute on function private.is_owner() to authenticated, service_role;

-- Normalises an Indian mobile number; returns null when invalid.
create function private.normalize_phone(p text)
returns text
language sql immutable set search_path = ''
as $$
  select case when d ~ '^[6-9][0-9]{9}$' then d end
  from (
    select regexp_replace(
             regexp_replace(coalesce(p, ''), '[\s()-]', '', 'g'),
             '^(\+91|91|0)(?=[6-9][0-9]{9}$)', '') as d
  ) x
$$;

-- Collapses whitespace and strips control characters from free text.
create function private.clean_text(p text)
returns text
language sql immutable set search_path = ''
as $$
  select nullif(btrim(regexp_replace(regexp_replace(coalesce(p, ''), '[[:cntrl:]]', ' ', 'g'), '\s+', ' ', 'g')), '')
$$;

-- ---------------------------------------------------------------------------
-- Generic triggers
-- ---------------------------------------------------------------------------
create function private.touch_updated_at()
returns trigger
language plpgsql set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end
$$;

create trigger cafe_settings_touch before update on public.cafe_settings
  for each row execute function private.touch_updated_at();
create trigger menu_items_touch before update on public.menu_items
  for each row execute function private.touch_updated_at();
create trigger addons_touch before update on public.addons
  for each row execute function private.touch_updated_at();

-- Kitchen staff may only flip availability on menu items and add-ons.
create function private.menu_kitchen_guard()
returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  if private.current_staff_role() = 'kitchen'
     and (to_jsonb(new) - 'is_available' - 'updated_at') is distinct from (to_jsonb(old) - 'is_available' - 'updated_at') then
    raise exception using errcode = '42501', message = 'kitchen_can_only_change_availability';
  end if;
  return new;
end
$$;

create trigger menu_items_kitchen_guard before update on public.menu_items
  for each row execute function private.menu_kitchen_guard();
create trigger addons_kitchen_guard before update on public.addons
  for each row execute function private.menu_kitchen_guard();

-- Owners cannot demote or deactivate themselves (prevents lock-out).
create function private.staff_self_guard()
returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  if old.user_id = (select auth.uid())
     and (new.role is distinct from old.role or new.is_active is distinct from old.is_active) then
    raise exception using errcode = '42501', message = 'cannot_change_own_role_or_status';
  end if;
  if new.user_id is distinct from old.user_id then
    raise exception using errcode = '42501', message = 'immutable_column';
  end if;
  return new;
end
$$;

create trigger staff_self_guard before update on public.staff
  for each row execute function private.staff_self_guard();

-- ---------------------------------------------------------------------------
-- Order state machine (applies to every update, whoever performs it)
--   placed → preparing → ready → completed
--   placed | preparing | ready → cancelled
--   completed requires payment_status = paid
--   unpaid → paid: any active staff;  paid → unpaid: owner only, not once completed
-- Customer actions arrive through SECURITY DEFINER functions that set
-- bite.actor = 'customer' for the current transaction.
-- ---------------------------------------------------------------------------
-- SECURITY INVOKER on purpose: current_user must identify the real caller.
create function private.orders_guard()
returns trigger
language plpgsql security invoker set search_path = ''
as $$
declare
  v_role public.staff_role := private.current_staff_role();
  v_customer boolean := coalesce(current_setting('bite.actor', true), '') = 'customer';
  v_trusted boolean := current_user in ('postgres', 'supabase_admin', 'service_role');
begin
  if v_role is null and not v_customer and not v_trusted then
    raise exception using errcode = '42501', message = 'not_allowed';
  end if;

  -- Fields fixed at creation.
  if new.id <> old.id or new.order_no <> old.order_no or new.access_hash <> old.access_hash
     or new.track_key <> old.track_key or new.client_request_id <> old.client_request_id
     or new.customer_name <> old.customer_name or new.customer_phone <> old.customer_phone
     or new.table_label is distinct from old.table_label or new.payment_method <> old.payment_method
     or new.total <> old.total or new.item_count <> old.item_count or new.created_at <> old.created_at then
    raise exception using errcode = '42501', message = 'immutable_column';
  end if;

  if new.customer_reported_paid_at is distinct from old.customer_reported_paid_at and not (v_customer or v_trusted) then
    raise exception using errcode = '42501', message = 'immutable_column';
  end if;

  -- Status transitions.
  if new.status is distinct from old.status then
    if not (
         (old.status = 'placed' and new.status in ('preparing', 'cancelled'))
      or (old.status = 'preparing' and new.status in ('ready', 'cancelled'))
      or (old.status = 'ready' and new.status in ('completed', 'cancelled'))
    ) then
      raise exception using errcode = 'P0001', message = 'invalid_transition',
        detail = format('%s -> %s', old.status, new.status);
    end if;

    if v_customer and not (old.status = 'placed' and new.status = 'cancelled') then
      raise exception using errcode = '42501', message = 'not_allowed';
    end if;

    case new.status
      when 'preparing' then new.preparing_at := now();
      when 'ready' then new.ready_at := now();
      when 'completed' then new.completed_at := now();
      when 'cancelled' then
        new.cancelled_at := now();
        new.cancelled_by := case when v_customer then 'customer' else 'staff' end;
        new.cancel_reason := private.clean_text(new.cancel_reason);
        if new.cancelled_by = 'staff' and new.cancel_reason is null then
          raise exception using errcode = 'P0001', message = 'cancel_reason_required';
        end if;
      else null;
    end case;
  elsif new.cancel_reason is distinct from old.cancel_reason then
    raise exception using errcode = '42501', message = 'immutable_column';
  end if;

  -- Payment transitions.
  if new.payment_status is distinct from old.payment_status then
    if v_customer then
      raise exception using errcode = '42501', message = 'not_allowed';
    end if;
    if old.status = 'cancelled' then
      raise exception using errcode = 'P0001', message = 'order_cancelled';
    end if;
    if new.payment_status = 'paid' then
      new.paid_at := now();
      new.paid_by := (select auth.uid());
      new.payment_reference := private.clean_text(new.payment_reference);
    else
      if not (v_role = 'owner' or v_trusted) then
        raise exception using errcode = '42501', message = 'owner_only';
      end if;
      new.paid_at := null;
      new.paid_by := null;
      new.payment_reference := null;
    end if;
  elsif new.payment_reference is distinct from old.payment_reference then
    if new.payment_status <> 'paid' then
      raise exception using errcode = 'P0001', message = 'reference_requires_paid';
    end if;
    new.payment_reference := private.clean_text(new.payment_reference);
  end if;

  if new.paid_by is distinct from old.paid_by and new.payment_status = old.payment_status and not v_trusted then
    raise exception using errcode = '42501', message = 'immutable_column';
  end if;

  if new.status = 'completed' and new.payment_status <> 'paid' then
    raise exception using errcode = 'P0001', message = 'payment_required';
  end if;

  new.updated_at := now();
  return new;
end
$$;

create trigger orders_guard before update on public.orders
  for each row execute function private.orders_guard();

create function private.orders_block_delete()
returns trigger
language plpgsql set search_path = ''
as $$
begin
  if current_user not in ('postgres', 'supabase_admin', 'service_role') then
    raise exception using errcode = '42501', message = 'not_allowed';
  end if;
  return old;
end
$$;

create trigger orders_block_delete before delete on public.orders
  for each row execute function private.orders_block_delete();

-- Tells a student's device that its order changed. The payload carries no
-- personal data; the device refetches through get_order() with its secret.
create function private.orders_notify()
returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  begin
    perform realtime.send(
      jsonb_build_object('status', new.status, 'payment_status', new.payment_status, 'updated_at', new.updated_at),
      'order_changed',
      'order:' || new.track_key,
      false
    );
  exception when others then
    raise warning 'realtime notify failed for order %: %', new.id, sqlerrm;
  end;
  return null;
end
$$;

create trigger orders_notify after update on public.orders
  for each row execute function private.orders_notify();

-- ---------------------------------------------------------------------------
-- Customer API (anonymous). SECURITY DEFINER by design: these are the only
-- paths by which anonymous users touch orders, and each validates its input.
-- ---------------------------------------------------------------------------
create function private.order_for_customer(p_order_id uuid, p_access_token text)
returns public.orders
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_order public.orders;
begin
  if p_order_id is null or p_access_token is null or p_access_token !~ '^[0-9a-f]{64}$' then
    raise exception using errcode = 'P0002', message = 'order_not_found';
  end if;
  select * into v_order from public.orders o
  where o.id = p_order_id and o.access_hash = extensions.digest(p_access_token, 'sha256');
  if not found then
    raise exception using errcode = 'P0002', message = 'order_not_found';
  end if;
  return v_order;
end
$$;
revoke all on function private.order_for_customer(uuid, text) from public;

create function private.order_json(p_order public.orders)
returns jsonb
language sql stable security definer set search_path = ''
as $$
  select jsonb_build_object(
    'id', p_order.id,
    'order_no', p_order.order_no,
    'customer_name', p_order.customer_name,
    'phone_last4', right(p_order.customer_phone, 4),
    'table_label', p_order.table_label,
    'status', p_order.status,
    'payment_method', p_order.payment_method,
    'payment_status', p_order.payment_status,
    'customer_reported_paid_at', p_order.customer_reported_paid_at,
    'total', p_order.total,
    'item_count', p_order.item_count,
    'cancel_reason', p_order.cancel_reason,
    'cancelled_by', p_order.cancelled_by,
    'track_key', p_order.track_key,
    'created_at', p_order.created_at,
    'updated_at', p_order.updated_at,
    'preparing_at', p_order.preparing_at,
    'ready_at', p_order.ready_at,
    'completed_at', p_order.completed_at,
    'cancelled_at', p_order.cancelled_at,
    'paid_at', p_order.paid_at,
    'items', coalesce((
      select jsonb_agg(jsonb_build_object(
               'name', i.name, 'base_price', i.base_price, 'addons', i.addons,
               'unit_price', i.unit_price, 'quantity', i.quantity,
               'line_total', i.line_total, 'note', i.note) order by i.name, i.id)
      from public.order_items i where i.order_id = p_order.id), '[]'::jsonb)
  )
$$;
revoke all on function private.order_json(public.orders) from public;

create function public.place_order(
  p_client_request_id uuid,
  p_access_token text,
  p_customer_name text,
  p_customer_phone text,
  p_payment_method public.payment_method,
  p_table_label text,
  p_items jsonb
)
returns jsonb
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_settings public.cafe_settings;
  v_name text := private.clean_text(p_customer_name);
  v_phone text := private.normalize_phone(p_customer_phone);
  v_table text := upper(private.clean_text(p_table_label));
  v_hash bytea;
  v_existing public.orders;
  v_order public.orders;
  v_line jsonb;
  v_item public.menu_items;
  v_addon_ids uuid[];
  v_addons jsonb;
  v_addon_total integer;
  v_addon_count integer;
  v_qty integer;
  v_note text;
  v_total integer := 0;
  v_count integer := 0;
  v_lines jsonb := '[]'::jsonb;
begin
  if p_client_request_id is null then
    raise exception using errcode = '22023', message = 'invalid_request';
  end if;
  if p_access_token is null or p_access_token !~ '^[0-9a-f]{64}$' then
    raise exception using errcode = '22023', message = 'invalid_request';
  end if;
  v_hash := extensions.digest(p_access_token, 'sha256');

  -- Idempotency: a retried submission returns the original order.
  select * into v_existing from public.orders where client_request_id = p_client_request_id;
  if found then
    if v_existing.access_hash <> v_hash then
      raise exception using errcode = '22023', message = 'invalid_request';
    end if;
    return private.order_json(v_existing);
  end if;

  select * into v_settings from public.cafe_settings where id;
  if not coalesce(v_settings.is_open, false) then
    raise exception using errcode = 'P0001', message = 'cafe_closed';
  end if;

  if v_name is null or char_length(v_name) > 40 then
    raise exception using errcode = '22023', message = 'invalid_name';
  end if;
  if v_phone is null then
    raise exception using errcode = '22023', message = 'invalid_phone';
  end if;
  if p_payment_method is null then
    raise exception using errcode = '22023', message = 'invalid_payment_method';
  end if;
  if p_payment_method = 'upi' and v_settings.upi_id is null then
    raise exception using errcode = 'P0001', message = 'upi_unavailable';
  end if;

  -- An unknown or inactive table is dropped rather than blocking the order:
  -- fulfilment is counter pickup, the table is only a hint for staff.
  if v_table is not null and not exists (
    select 1 from public.cafe_tables t where t.label = v_table and t.is_active
  ) then
    v_table := null;
  end if;

  if p_items is null or jsonb_typeof(p_items) <> 'array'
     or jsonb_array_length(p_items) = 0 or jsonb_array_length(p_items) > 30 then
    raise exception using errcode = '22023', message = 'invalid_items';
  end if;

  if (select count(*) from public.orders o
      where o.customer_phone = v_phone and o.status in ('placed', 'preparing', 'ready')) >= 3 then
    raise exception using errcode = 'P0001', message = 'too_many_open_orders';
  end if;

  for v_line in select * from jsonb_array_elements(p_items) loop
    if jsonb_typeof(v_line) <> 'object'
       or jsonb_typeof(v_line -> 'menu_item_id') <> 'string'
       or jsonb_typeof(v_line -> 'quantity') <> 'number'
       or (v_line ? 'addon_ids' and jsonb_typeof(v_line -> 'addon_ids') <> 'array')
       or (v_line ? 'note' and jsonb_typeof(v_line -> 'note') not in ('string', 'null')) then
      raise exception using errcode = '22023', message = 'invalid_items';
    end if;

    begin
      v_qty := (v_line ->> 'quantity')::integer;
      if (v_line ->> 'quantity')::numeric <> v_qty then
        raise exception using errcode = '22023', message = 'invalid_quantity';
      end if;
      select coalesce(array_agg(x::uuid), '{}') into v_addon_ids
      from jsonb_array_elements_text(coalesce(v_line -> 'addon_ids', '[]'::jsonb)) x;
      select * into v_item from public.menu_items m where m.id = (v_line ->> 'menu_item_id')::uuid for share;
    exception
      when invalid_text_representation or numeric_value_out_of_range then
        raise exception using errcode = '22023', message = 'invalid_items';
    end;

    if v_qty is null or v_qty < 1 or v_qty > 20 then
      raise exception using errcode = '22023', message = 'invalid_quantity';
    end if;
    if v_item.id is null then
      raise exception using errcode = 'P0001', message = 'item_not_found';
    end if;
    if not v_item.is_available then
      raise exception using errcode = 'P0001', message = 'item_unavailable', detail = v_item.name;
    end if;
    if cardinality(v_addon_ids) <> (select count(distinct a) from unnest(v_addon_ids) a) then
      raise exception using errcode = '22023', message = 'invalid_addons';
    end if;

    select coalesce(jsonb_agg(jsonb_build_object('id', a.id, 'name', a.name, 'price', a.price)
                              order by a.sort_order, a.name), '[]'::jsonb),
           coalesce(sum(a.price), 0), count(*)
      into v_addons, v_addon_total, v_addon_count
    from public.addons a
    where a.id = any (v_addon_ids) and a.menu_item_id = v_item.id and a.is_available;

    if v_addon_count <> cardinality(v_addon_ids) then
      raise exception using errcode = 'P0001', message = 'addon_unavailable', detail = v_item.name;
    end if;

    v_note := private.clean_text(v_line ->> 'note');
    if v_note is not null and char_length(v_note) > 120 then
      raise exception using errcode = '22023', message = 'invalid_note';
    end if;

    v_total := v_total + (v_item.price + v_addon_total) * v_qty;
    v_count := v_count + v_qty;
    v_lines := v_lines || jsonb_build_array(jsonb_build_object(
      'menu_item_id', v_item.id, 'name', v_item.name, 'base_price', v_item.price,
      'addons', v_addons, 'unit_price', v_item.price + v_addon_total,
      'quantity', v_qty, 'note', v_note));
    v_item := null;
  end loop;

  if v_count > 50 then
    raise exception using errcode = '22023', message = 'invalid_quantity';
  end if;

  insert into public.orders (
    access_hash, track_key, client_request_id, customer_name, customer_phone,
    table_label, payment_method, total, item_count
  ) values (
    v_hash, encode(extensions.gen_random_bytes(16), 'hex'), p_client_request_id, v_name, v_phone,
    v_table, p_payment_method, v_total, v_count
  )
  on conflict (client_request_id) do nothing
  returning * into v_order;

  if v_order.id is null then
    -- A concurrent duplicate won the race.
    select * into v_order from public.orders where client_request_id = p_client_request_id;
    if v_order.access_hash <> v_hash then
      raise exception using errcode = '22023', message = 'invalid_request';
    end if;
    return private.order_json(v_order);
  end if;

  insert into public.order_items (order_id, menu_item_id, name, base_price, addons, unit_price, quantity, line_total, note)
  select v_order.id, (l ->> 'menu_item_id')::uuid, l ->> 'name', (l ->> 'base_price')::integer, l -> 'addons',
         (l ->> 'unit_price')::integer, (l ->> 'quantity')::integer,
         (l ->> 'unit_price')::integer * (l ->> 'quantity')::integer, l ->> 'note'
  from jsonb_array_elements(v_lines) l;

  return private.order_json(v_order);
end
$$;

create function public.get_order(p_order_id uuid, p_access_token text)
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
begin
  return private.order_json(private.order_for_customer(p_order_id, p_access_token));
end
$$;

-- Batch lookup for "My orders" on this device. Unknown refs are skipped.
create function public.get_orders(p_refs jsonb)
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_ref jsonb;
  v_result jsonb := '[]'::jsonb;
  v_order public.orders;
begin
  if p_refs is null or jsonb_typeof(p_refs) <> 'array' or jsonb_array_length(p_refs) > 20 then
    raise exception using errcode = '22023', message = 'invalid_request';
  end if;
  for v_ref in select * from jsonb_array_elements(p_refs) loop
    begin
      v_order := private.order_for_customer((v_ref ->> 'id')::uuid, v_ref ->> 'token');
      v_result := v_result || jsonb_build_array(private.order_json(v_order));
    exception
      when no_data_found or invalid_text_representation then null;
      when others then
        if sqlstate = 'P0002' then null; else raise; end if;
    end;
  end loop;
  return v_result;
end
$$;

create function public.report_upi_payment(p_order_id uuid, p_access_token text)
returns jsonb
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_order public.orders := private.order_for_customer(p_order_id, p_access_token);
begin
  if v_order.payment_method <> 'upi' or v_order.status = 'cancelled' then
    raise exception using errcode = 'P0001', message = 'not_allowed';
  end if;
  if v_order.payment_status = 'unpaid' and v_order.customer_reported_paid_at is null then
    perform set_config('bite.actor', 'customer', true);
    update public.orders set customer_reported_paid_at = now()
    where id = v_order.id returning * into v_order;
    perform set_config('bite.actor', '', true);
  end if;
  return private.order_json(v_order);
end
$$;

create function public.cancel_my_order(p_order_id uuid, p_access_token text)
returns jsonb
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_order public.orders := private.order_for_customer(p_order_id, p_access_token);
begin
  if v_order.status <> 'placed' or v_order.payment_status <> 'unpaid'
     or v_order.customer_reported_paid_at is not null then
    raise exception using errcode = 'P0001', message = 'cannot_cancel';
  end if;
  perform set_config('bite.actor', 'customer', true);
  update public.orders set status = 'cancelled', cancel_reason = 'Cancelled by customer'
  where id = v_order.id and status = 'placed'
  returning * into v_order;
  perform set_config('bite.actor', '', true);
  if v_order.status <> 'cancelled' then
    raise exception using errcode = 'P0001', message = 'cannot_cancel';
  end if;
  return private.order_json(v_order);
end
$$;

-- ---------------------------------------------------------------------------
-- Owner reporting. Business day = Asia/Kolkata calendar date of placement.
-- Rules (docs/PRODUCT_SPEC.md §Reporting):
--   sales            = total of non-cancelled orders
--   cash collected   = non-cancelled, cash, paid
--   UPI confirmed    = non-cancelled, upi, paid (verified by staff)
--   outstanding      = non-cancelled, unpaid (split by method)
--   sales = cash collected + UPI confirmed + outstanding (always)
--   refunds due      = cancelled orders that had been marked paid
-- ---------------------------------------------------------------------------
create function public.sales_summary(p_from date, p_to date)
returns jsonb
language plpgsql stable security invoker set search_path = ''
as $$
declare
  v_result jsonb;
begin
  if not private.is_owner() then
    raise exception using errcode = '42501', message = 'owner_only';
  end if;
  if p_from is null or p_to is null or p_to < p_from or p_to - p_from > 92 then
    raise exception using errcode = '22023', message = 'invalid_range';
  end if;

  with o as (
    select * from public.orders
    where created_at >= (p_from::timestamp at time zone 'Asia/Kolkata')
      and created_at < ((p_to + 1)::timestamp at time zone 'Asia/Kolkata')
  ),
  live as (select * from o where status <> 'cancelled')
  select jsonb_build_object(
    'from', p_from,
    'to', p_to,
    'orders', (select count(*) from live),
    'items_sold', (select coalesce(sum(item_count), 0) from live),
    'sales', (select coalesce(sum(total), 0) from live),
    'average_order_value', (select coalesce(round(avg(total)), 0) from live),
    'cash_collected', (select coalesce(sum(total), 0) from live where payment_method = 'cash' and payment_status = 'paid'),
    'upi_confirmed', (select coalesce(sum(total), 0) from live where payment_method = 'upi' and payment_status = 'paid'),
    'outstanding_cash', (select coalesce(sum(total), 0) from live where payment_method = 'cash' and payment_status = 'unpaid'),
    'outstanding_upi', (select coalesce(sum(total), 0) from live where payment_method = 'upi' and payment_status = 'unpaid'),
    'upi_awaiting_verification', (select count(*) from live where payment_method = 'upi' and payment_status = 'unpaid' and customer_reported_paid_at is not null),
    'open_orders', (select count(*) from live where status in ('placed', 'preparing', 'ready')),
    'completed_orders', (select count(*) from live where status = 'completed'),
    'cancelled_orders', (select count(*) from o where status = 'cancelled'),
    'cancelled_value', (select coalesce(sum(total), 0) from o where status = 'cancelled'),
    'refunds_due', (select coalesce(sum(total), 0) from o where status = 'cancelled' and payment_status = 'paid'),
    'refunds_due_count', (select count(*) from o where status = 'cancelled' and payment_status = 'paid'),
    'top_items', coalesce((
      select jsonb_agg(t order by t.quantity desc, t.sales desc, t.name)
      from (
        select i.name, sum(i.quantity)::integer as quantity, sum(i.line_total)::integer as sales
        from public.order_items i join live on live.id = i.order_id
        group by i.name
        order by sum(i.quantity) desc, sum(i.line_total) desc, i.name
        limit 10
      ) t), '[]'::jsonb),
    'by_day', coalesce((
      select jsonb_agg(d order by d.day)
      from (
        select (created_at at time zone 'Asia/Kolkata')::date as day,
               count(*)::integer as orders, sum(total)::integer as sales
        from live group by 1
      ) d), '[]'::jsonb),
    'by_hour', coalesce((
      select jsonb_agg(h order by h.hour)
      from (
        select extract(hour from created_at at time zone 'Asia/Kolkata')::integer as hour,
               count(*)::integer as orders, sum(total)::integer as sales
        from live group by 1
      ) h), '[]'::jsonb)
  ) into v_result;

  return v_result;
end
$$;

-- ---------------------------------------------------------------------------
-- Row Level Security
-- ---------------------------------------------------------------------------
alter table public.staff enable row level security;
alter table public.cafe_settings enable row level security;
alter table public.categories enable row level security;
alter table public.menu_items enable row level security;
alter table public.addons enable row level security;
alter table public.cafe_tables enable row level security;
alter table public.orders enable row level security;
alter table public.order_items enable row level security;

-- staff
create policy "staff: read self or owner reads all" on public.staff
  for select to authenticated
  using (user_id = (select auth.uid()) or (select private.is_owner()));
create policy "staff: owner updates" on public.staff
  for update to authenticated
  using ((select private.is_owner())) with check ((select private.is_owner()));

-- cafe_settings
create policy "settings: public read" on public.cafe_settings
  for select to anon, authenticated using (true);
create policy "settings: owner updates" on public.cafe_settings
  for update to authenticated
  using ((select private.is_owner())) with check ((select private.is_owner()));

-- categories
create policy "categories: public read" on public.categories
  for select to anon, authenticated using (true);
create policy "categories: owner inserts" on public.categories
  for insert to authenticated with check ((select private.is_owner()));
create policy "categories: owner updates" on public.categories
  for update to authenticated using ((select private.is_owner())) with check ((select private.is_owner()));
create policy "categories: owner deletes" on public.categories
  for delete to authenticated using ((select private.is_owner()));

-- menu_items
create policy "menu: public read" on public.menu_items
  for select to anon, authenticated using (true);
create policy "menu: owner inserts" on public.menu_items
  for insert to authenticated with check ((select private.is_owner()));
create policy "menu: staff updates (kitchen limited by trigger)" on public.menu_items
  for update to authenticated using ((select private.is_staff())) with check ((select private.is_staff()));
create policy "menu: owner deletes" on public.menu_items
  for delete to authenticated using ((select private.is_owner()));

-- addons
create policy "addons: public read" on public.addons
  for select to anon, authenticated using (true);
create policy "addons: owner inserts" on public.addons
  for insert to authenticated with check ((select private.is_owner()));
create policy "addons: staff updates (kitchen limited by trigger)" on public.addons
  for update to authenticated using ((select private.is_staff())) with check ((select private.is_staff()));
create policy "addons: owner deletes" on public.addons
  for delete to authenticated using ((select private.is_owner()));

-- cafe_tables
create policy "tables: public read" on public.cafe_tables
  for select to anon, authenticated using (true);
create policy "tables: owner inserts" on public.cafe_tables
  for insert to authenticated with check ((select private.is_owner()));
create policy "tables: owner updates" on public.cafe_tables
  for update to authenticated using ((select private.is_owner())) with check ((select private.is_owner()));
create policy "tables: owner deletes" on public.cafe_tables
  for delete to authenticated using ((select private.is_owner()));

-- orders / order_items: staff only; customers go through the functions above.
create policy "orders: staff read" on public.orders
  for select to authenticated using ((select private.is_staff()));
create policy "orders: staff update (state machine in trigger)" on public.orders
  for update to authenticated using ((select private.is_staff())) with check ((select private.is_staff()));
create policy "order_items: staff read" on public.order_items
  for select to authenticated using ((select private.is_staff()));

-- ---------------------------------------------------------------------------
-- Grants (least privilege; RLS still applies on top)
-- ---------------------------------------------------------------------------
revoke all on all tables in schema public from anon, authenticated;
revoke all on all sequences in schema public from anon, authenticated;
revoke all on all functions in schema public from public, anon, authenticated;

grant select on public.cafe_settings, public.categories, public.menu_items, public.addons, public.cafe_tables
  to anon, authenticated;

grant update (cafe_name, is_open, closed_message, upi_id, upi_payee_name) on public.cafe_settings to authenticated;
grant insert, update, delete on public.categories, public.menu_items, public.addons, public.cafe_tables to authenticated;
grant select on public.staff to authenticated;
grant update (display_name, role, is_active) on public.staff to authenticated;
grant select on public.orders, public.order_items to authenticated;
grant update (status, payment_status, payment_reference, cancel_reason) on public.orders to authenticated;

grant execute on function public.place_order(uuid, text, text, text, public.payment_method, text, jsonb) to anon, authenticated;
grant execute on function public.get_order(uuid, text) to anon, authenticated;
grant execute on function public.get_orders(jsonb) to anon, authenticated;
grant execute on function public.report_upi_payment(uuid, text) to anon, authenticated;
grant execute on function public.cancel_my_order(uuid, text) to anon, authenticated;
grant execute on function public.sales_summary(date, date) to authenticated;

-- ---------------------------------------------------------------------------
-- Realtime: staff receive order changes through Postgres Changes (RLS applies).
-- ---------------------------------------------------------------------------
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    alter publication supabase_realtime add table public.orders;
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- Storage: public bucket for menu photos; only owners can write.
-- ---------------------------------------------------------------------------
do $$
begin
  if exists (select 1 from pg_namespace where nspname = 'storage') then
    insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
    values ('menu-images', 'menu-images', true, 2097152, array['image/jpeg', 'image/png', 'image/webp'])
    on conflict (id) do update
      set public = excluded.public,
          file_size_limit = excluded.file_size_limit,
          allowed_mime_types = excluded.allowed_mime_types;

    create policy "menu images: owner uploads" on storage.objects
      for insert to authenticated
      with check (bucket_id = 'menu-images' and (select private.is_owner()));
    create policy "menu images: owner updates" on storage.objects
      for update to authenticated
      using (bucket_id = 'menu-images' and (select private.is_owner()))
      with check (bucket_id = 'menu-images' and (select private.is_owner()));
    create policy "menu images: owner deletes" on storage.objects
      for delete to authenticated
      using (bucket_id = 'menu-images' and (select private.is_owner()));
    create policy "menu images: owner reads metadata" on storage.objects
      for select to authenticated
      using (bucket_id = 'menu-images' and (select private.is_owner()));
  end if;
end
$$;

insert into public.cafe_settings (id) values (true) on conflict (id) do nothing;
