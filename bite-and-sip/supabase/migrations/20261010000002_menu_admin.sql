-- Saves a menu item and its add-ons in one transaction.
-- SECURITY INVOKER: the caller's RLS policies apply (owner-only inserts/deletes,
-- kitchen limited to availability by trigger), so this adds atomicity, not privilege.
create function public.save_menu_item(p_item jsonb)
returns uuid
language plpgsql volatile security invoker set search_path = ''
as $$
declare
  v_id uuid := nullif(p_item ->> 'id', '')::uuid;
  v_addon jsonb;
  v_addon_id uuid;
  v_pos integer := 0;
begin
  if not private.is_owner() then
    raise exception using errcode = '42501', message = 'owner_only';
  end if;
  if p_item is null or jsonb_typeof(p_item) <> 'object' then
    raise exception using errcode = '22023', message = 'invalid_request';
  end if;
  if jsonb_typeof(coalesce(p_item -> 'addons', '[]'::jsonb)) <> 'array'
     or jsonb_array_length(coalesce(p_item -> 'addons', '[]'::jsonb)) > 12 then
    raise exception using errcode = '22023', message = 'invalid_addons';
  end if;

  if v_id is null then
    insert into public.menu_items (category_id, name, description, price, is_veg, is_available, is_popular, image_path, sort_order)
    values (
      (p_item ->> 'category_id')::uuid,
      btrim(p_item ->> 'name'),
      coalesce(btrim(p_item ->> 'description'), ''),
      (p_item ->> 'price')::integer,
      coalesce((p_item ->> 'is_veg')::boolean, true),
      coalesce((p_item ->> 'is_available')::boolean, true),
      coalesce((p_item ->> 'is_popular')::boolean, false),
      nullif(p_item ->> 'image_path', ''),
      coalesce((p_item ->> 'sort_order')::integer,
               (select coalesce(max(sort_order), 0) + 1 from public.menu_items where category_id = (p_item ->> 'category_id')::uuid))
    )
    returning id into v_id;
  else
    update public.menu_items set
      category_id = (p_item ->> 'category_id')::uuid,
      name = btrim(p_item ->> 'name'),
      description = coalesce(btrim(p_item ->> 'description'), ''),
      price = (p_item ->> 'price')::integer,
      is_veg = coalesce((p_item ->> 'is_veg')::boolean, true),
      is_available = coalesce((p_item ->> 'is_available')::boolean, true),
      is_popular = coalesce((p_item ->> 'is_popular')::boolean, false),
      image_path = nullif(p_item ->> 'image_path', '')
    where id = v_id;
    if not found then
      raise exception using errcode = 'P0002', message = 'item_not_found';
    end if;
  end if;

  -- Remove add-ons that are no longer listed first, so their names can be reused.
  delete from public.addons a
  where a.menu_item_id = v_id
    and a.id not in (
      select (x ->> 'id')::uuid from jsonb_array_elements(coalesce(p_item -> 'addons', '[]'::jsonb)) x
      where nullif(x ->> 'id', '') is not null
    );

  for v_addon in select * from jsonb_array_elements(coalesce(p_item -> 'addons', '[]'::jsonb)) loop
    v_pos := v_pos + 1;
    v_addon_id := nullif(v_addon ->> 'id', '')::uuid;
    if v_addon_id is not null and exists (select 1 from public.addons where id = v_addon_id and menu_item_id = v_id) then
      update public.addons set
        name = btrim(v_addon ->> 'name'),
        price = (v_addon ->> 'price')::integer,
        is_available = coalesce((v_addon ->> 'is_available')::boolean, true),
        sort_order = v_pos
      where id = v_addon_id;
    else
      insert into public.addons (menu_item_id, name, price, is_available, sort_order)
      values (v_id, btrim(v_addon ->> 'name'), (v_addon ->> 'price')::integer,
              coalesce((v_addon ->> 'is_available')::boolean, true), v_pos)
      returning id into v_addon_id;
    end if;
  end loop;

  return v_id;
end
$$;

revoke all on function public.save_menu_item(jsonb) from public, anon, authenticated;
grant execute on function public.save_menu_item(jsonb) to authenticated;
