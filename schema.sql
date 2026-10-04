-- ============================================================================
-- Odlarnörden – databasschema
--
-- GENERERAD UR DEN LEVANDE DATABASEN 2026-08-15, påbyggd 2026-08-30 med
-- avsnittet PUSH-NOTISER och 2026-10-04 med KLAR MED NÄRING
-- (projekt rciaqovopajrkdtuhkdo).
-- Skriv inte om den här filen för hand när du ändrar databasen – då driver den
-- isär igen. Gör ändringen i databasen och generera om filen därifrån.
--
-- Sanningskällan är Supabase: tabellerna, `pg_policies`, `pg_get_functiondef`
-- och migrationshistoriken (25 migrationer, från `initial_schema` 2026-05-29 till
-- `cron_naringsnotis` 2026-08-30). Den här filen är en läsbar kopia
-- för repot – och en väg tillbaka om projektet någon gång försvinner.
--
-- Läget 2026-10-04: 11 tabeller, 12 funktioner, 33 policies.
--
-- Ordningen nedan spelar roll: funktionerna måste finnas före policyerna som
-- anropar dem, och tomato_varieties före tabellerna som pekar på den.
--
-- TÄCKS INTE av den här filen:
--   * Edge Functions `bjud-in` (inbjudningsmejlen) och `naringsnotis`
--     (push-utskicken) – deployas separat.
--   * Vault-hemligheterna `naringsnotis_secret` och `vapid_keys` – de skapades
--     inne i databasen och ska inte ut ur den.
--   * Auth-inställningar (Site URL, Redirect URLs, avstängd e-postbekräftelse) –
--     de klickas i Supabase-konsolen och går inte att nå via SQL.
--   * Innehållet (sorter, plantor, skördar, recept) – ligger i Exportera-ZIP:en.
-- ============================================================================


-- ---------------------------------------------------------------- TABELLER --

-- Allowlist. Bara förgodkända adresser kommer in i appen. RLS är på men helt
-- utan policies, så bara service role och SECURITY DEFINER-funktioner når den.
create table if not exists public.allowed_emails (
  email    text primary key,
  added_at timestamptz default now(),
  is_admin boolean not null default false
);

-- Sortbibliotek. Privat per användare sedan 2026-08-14: created_by äger raden
-- och är den enda som ser den. Nya användare hämtar kopior via startpaketet
-- (se list_starter_varieties / copy_starter_varieties längre ner).
create table if not exists public.tomato_varieties (
  id               uuid primary key default gen_random_uuid(),
  name             text not null,
  notes            text,                          -- visas bara på bärkort i appen
  created_by       uuid references auth.users(id),
  created_at       timestamptz default now(),
  category         text,                          -- Bifftomat, Körsbär, Cocktail, Plommon, Chili, Bär, Gurka ...
  growth_type      text,                          -- Stjälk, Dvärg, Buske, Varierar
  height_min_cm    int,
  height_max_cm    int,
  pruning          text,                          -- kort Skötsel-val
  default_location text,                          -- Kruka, Växthus, Planteringslåda, Friland
  use_tags         text[] default '{}'::text[],   -- Sallad, Söt, Sås ...
  pruning_notes    text,                          -- fritext om beskärning (bärbuskar m.m.)
  flavor           text                           -- smakminne: hur smakade den?
);

-- Plantor per säsong.
-- OBS: variety_id är ON DELETE CASCADE. Raderar man en sort försvinner alla
-- plantor av den – och därmed deras foton. Det är skälet till att biblioteket
-- är privat och att startpaketet ger KOPIOR i stället för delade rader.
create table if not exists public.user_tomatoes (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references auth.users(id) on delete cascade,
  variety_id   uuid not null references public.tomato_varieties(id) on delete cascade,
  planted_date date,
  location     text,                       -- Kruka, Planteringslåda, Växthus, Friland, Ej placerad
  plant_count  int,
  notes        text,
  created_at   timestamptz default now(),
  season       text default '2026'::text,
  pruned_on    date                        -- senast beskuren
);

create table if not exists public.harvests (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references auth.users(id) on delete cascade,
  variety_id   uuid references public.tomato_varieties(id) on delete set null,
  harvested_at date not null default current_date,
  weight_g     int,
  notes        text,
  created_at   timestamptz default now()
);

-- Recept. Var och en lägger upp egna och väljer om de ska delas (2026-08-16).
-- `locked` betyder "sköts utanför appen" – Laras recept är låsta och kan bara
-- ändras med servicenyckeln. Egen kolumn i stället för att knyta regeln till
-- admin-rollen, så den inte följer med om någon annan görs till admin.
create table if not exists public.recipes (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users(id) on delete cascade,
  name        text not null,
  body        text,
  variety_ids uuid[] default '{}'::uuid[],
  created_at  timestamptz default now(),
  -- Två former: "images/..." är en fil i repot (Laras), allt annat är en
  -- sökväg i Storage-bucketen och behöver signerad URL.
  image_url   text,
  is_shared   boolean not null default false,
  locked      boolean not null default false,
  -- Fritext vid sidan av variety_ids: ingredienser som inte finns som sort,
  -- och en väg runt att sorterna är privata (ett delat recept pekar på
  -- ägarens sort-id, som ingen annan kan slå upp).
  extra_varieties text[] not null default '{}'::text[]
);

-- Växtnäringslogg, flera datum per plats.
create table if not exists public.feedings (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references auth.users(id) on delete cascade,
  season     text not null default '2026'::text,
  location   text not null,
  fed_on     date not null,
  notes      text,
  created_at timestamptz default now()
);

-- Foton kopplade till en planta. Filerna ligger i Supabase Storage, inte här.
-- Sökväg i bucketen: {user_id}/{tomato_id}/{uuid}.jpg
create table if not exists public.plant_photos (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references auth.users(id),
  tomato_id  uuid not null references public.user_tomatoes(id) on delete cascade,
  path       text not null,
  caption    text,                          -- finns i tabellen men används inte i UI:t
  created_at timestamptz default now()
);
create index if not exists plant_photos_tomato_id_idx on public.plant_photos using btree (tomato_id);

-- Fristående växthusgalleri – foton utan koppling till en enskild planta.
-- Samma bucket, undermapp: {user_id}/gallery/{uuid}.jpg
create table if not exists public.garden_photos (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references auth.users(id),
  path       text not null,
  caption    text,
  created_at timestamptz default now()
);


-- --------------------------------------------------------------- FUNKTIONER --
-- Alla är SECURITY DEFINER med search_path = '' (tomt), så de kör som ägaren
-- och alla objektnamn måste vara fullt kvalificerade.

-- Grinden. Anropas av VARJE RLS-policy i appen.
create or replace function public.is_allowed()
returns boolean language sql stable security definer set search_path = ''
as $function$
  select exists (
    select 1 from public.allowed_emails
    where email = lower(auth.jwt() ->> 'email')
  );
$function$;

create or replace function public.is_admin()
returns boolean language sql stable security definer set search_path = ''
as $function$
  select exists (
    select 1 from public.allowed_emails a
    where lower(a.email) = lower(auth.jwt() ->> 'email') and a.is_admin
  );
$function$;

create or replace function public.list_allowed()
returns table(email text, is_admin boolean, added_at timestamptz)
language plpgsql stable security definer set search_path = ''
as $function$
begin
  if not public.is_admin() then
    raise exception 'Endast administratörer får se inbjudningslistan';
  end if;
  return query
    select a.email, a.is_admin, a.added_at
    from public.allowed_emails a
    order by a.is_admin desc, a.email;
end;
$function$;

create or replace function public.add_allowed(p_email text)
returns text language plpgsql security definer set search_path = ''
as $function$
declare v_email text := lower(trim(p_email));
begin
  if not public.is_admin() then
    raise exception 'Endast administratörer får bjuda in';
  end if;
  if v_email !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' then
    raise exception 'Det där ser inte ut som en e-postadress';
  end if;
  insert into public.allowed_emails (email) values (v_email)
    on conflict (email) do nothing;
  return v_email;
end;
$function$;

create or replace function public.remove_allowed(p_email text)
returns text language plpgsql security definer set search_path = ''
as $function$
declare v_email text := lower(trim(p_email));
begin
  if not public.is_admin() then
    raise exception 'Endast administratörer får ta bort inbjudningar';
  end if;
  -- Skydd mot att låsa ut sig själv.
  if v_email = lower(auth.jwt() ->> 'email') then
    raise exception 'Du kan inte ta bort din egen åtkomst';
  end if;
  delete from public.allowed_emails where lower(email) = v_email;
  return v_email;
end;
$function$;

-- OBS: raderar INTE filerna i Storage. Supabase blockerar `delete from
-- storage.objects` inne i en definer-funktion ("Direct deletion from storage
-- tables is not allowed") och hela raderingen fallerar då transaktionellt.
-- Appen måste ta bort filerna med storage.remove(paths) FÖRE det här anropet.
create or replace function public.delete_my_account()
returns void language plpgsql security definer set search_path = ''
as $function$
declare
  v_uid uuid := auth.uid();
  v_email text := lower(auth.jwt() ->> 'email');
begin
  if v_uid is null then
    raise exception 'Inte inloggad';
  end if;

  delete from public.plant_photos     where user_id = v_uid;
  delete from public.garden_photos    where user_id = v_uid;
  delete from public.harvests         where user_id = v_uid;
  delete from public.feedings         where user_id = v_uid;
  delete from public.recipes          where user_id = v_uid;
  delete from public.user_tomatoes    where user_id = v_uid;
  delete from public.tomato_varieties where created_by = v_uid;
  delete from public.allowed_emails   where lower(email) = v_email;
  delete from auth.users              where id = v_uid;
end;
$function$;

-- ---- Startpaket: hämta färdiga sorter (2026-08-15) ----
-- Hjälpfunktion. Anropas bara inifrån de två nedan – se revoken längst ner.
create or replace function public.admin_user_ids()
returns table(id uuid)
language sql stable security definer set search_path = ''
as $function$
  select u.id
  from auth.users u
  join public.allowed_emails a on lower(a.email) = lower(u.email)
  where a.is_admin;
$function$;

-- Förlagor = admins sorter. `redan_i_biblioteket` flaggar namn man redan har,
-- så appen kan visa "Har redan" i stället för att skapa dubbletter.
create or replace function public.list_starter_varieties()
returns table(
  id uuid, name text, category text, growth_type text,
  height_min_cm int, height_max_cm int, pruning text,
  default_location text, use_tags text[], pruning_notes text,
  redan_i_biblioteket boolean
)
language sql stable security definer set search_path = ''
as $function$
  select v.id, v.name, v.category, v.growth_type,
         v.height_min_cm, v.height_max_cm, v.pruning,
         v.default_location, v.use_tags, v.pruning_notes,
         exists (
           select 1 from public.tomato_varieties egen
           where egen.created_by = auth.uid()
             and lower(egen.name) = lower(v.name)
         )
  from public.tomato_varieties v
  where public.is_allowed()
    and v.created_by is not null
    and v.created_by <> auth.uid()
    -- Aliaset behövs: funktionens egen utdatakolumn heter också id.
    and v.created_by in (select au.id from public.admin_user_ids() au)
  order by v.name;
$function$;

-- Returnerar antalet skapade sorter. flavor och notes kopieras medvetet INTE –
-- de är personliga minnen. Dubbletter hoppas tyst över, så det är ofarligt att
-- trycka två gånger.
create or replace function public.copy_starter_varieties(p_ids uuid[])
returns integer language plpgsql security definer set search_path = ''
as $function$
declare
  antal integer;
begin
  if not public.is_allowed() then
    raise exception 'Kontot har inte behörighet till appen.';
  end if;
  if p_ids is null or array_length(p_ids, 1) is null then
    return 0;
  end if;

  -- distinct on (lower(name)) skyddar mot att två förlagor med samma namn
  -- båda slinker igenom not exists-kontrollen i samma sats.
  insert into public.tomato_varieties
    (name, category, growth_type, height_min_cm, height_max_cm,
     pruning, default_location, use_tags, pruning_notes, created_by)
  select distinct on (lower(v.name))
         v.name, v.category, v.growth_type, v.height_min_cm, v.height_max_cm,
         v.pruning, v.default_location, v.use_tags, v.pruning_notes, auth.uid()
  from public.tomato_varieties v
  where v.id = any(p_ids)
    and v.created_by is not null
    and v.created_by <> auth.uid()
    and v.created_by in (select au.id from public.admin_user_ids() au)
    and not exists (
      select 1 from public.tomato_varieties egen
      where egen.created_by = auth.uid()
        and lower(egen.name) = lower(v.name)
    )
  order by lower(v.name), v.name;

  get diagnostics antal = row_count;
  return antal;
end;
$function$;


-- ------------------------------------------------------ RÄTTIGHETER (RPC) --
-- Ingen av funktionerna ska gå att anropa utloggad.
--
-- FÄLLA: Supabase har `alter default privileges ... grant execute on functions
-- to anon, authenticated, service_role`. Det ger varje ny funktion i public en
-- DIREKT grant till de rollerna. En `revoke ... from public` tar bara bort
-- PUBLIC-grantet – rollen måste namnges. Kontrollera med:
--   select has_function_privilege('authenticated', 'public.f()', 'EXECUTE');
revoke execute on function public.is_allowed()                    from anon, public;
revoke execute on function public.is_admin()                      from anon, public;
revoke execute on function public.list_allowed()                  from anon, public;
revoke execute on function public.add_allowed(text)               from anon, public;
revoke execute on function public.remove_allowed(text)            from anon, public;
revoke execute on function public.delete_my_account()             from anon, public;
revoke execute on function public.list_starter_varieties()        from anon, public;
revoke execute on function public.copy_starter_varieties(uuid[])  from anon, public;
revoke execute on function public.admin_user_ids()                from anon, public;

grant execute on function public.is_allowed()                   to authenticated;
grant execute on function public.is_admin()                     to authenticated;
grant execute on function public.list_allowed()                 to authenticated;
grant execute on function public.remove_allowed(text)           to authenticated;
grant execute on function public.delete_my_account()            to authenticated;
grant execute on function public.list_starter_varieties()       to authenticated;
grant execute on function public.copy_starter_varieties(uuid[]) to authenticated;

-- admin_user_ids() är intern och skulle annars lämna ut vilka användar-id som är
-- admin. De två funktionerna som anropar den är definer och kör som ägaren, så
-- de påverkas inte av den här revoken (verifierat 2026-08-15).
revoke execute on function public.admin_user_ids() from authenticated;

-- add_allowed() är föräldralös sedan 2026-08-14, då inbjudningar flyttades till
-- Edge Function "bjud-in" (som skriver till allowed_emails med servicenyckeln).
-- Den 2026-08-15 anropade en webbläsarflik med GAMMAL kod den ändå: adressen
-- hamnade på allowlistan men inget inbjudningsmejl skickades, helt under
-- tystnad. Låst för inloggade så att en gammal flik felar synligt i stället.
-- Servicenyckeln kan fortfarande anropa den, för att lägga upp någon utan mejl.
revoke execute on function public.add_allowed(text) from authenticated;


-- ---------------------------------------------------------- RLS + POLICIES --
-- Varje policy kräver public.is_allowed(). allowed_emails har RLS på men noll
-- policies – det är avsiktligt, tabellen ska bara nås av definer-funktionerna.
alter table public.allowed_emails   enable row level security;
alter table public.tomato_varieties enable row level security;
alter table public.user_tomatoes    enable row level security;
alter table public.harvests         enable row level security;
alter table public.recipes          enable row level security;
alter table public.feedings         enable row level security;
alter table public.plant_photos     enable row level security;
alter table public.garden_photos    enable row level security;

-- Sorter: privat bibliotek. SELECT kräver ägarskap sedan 2026-08-14.
create policy "Users see own varieties"    on public.tomato_varieties for select to public          using (auth.uid() = created_by and public.is_allowed());
create policy "Auth can insert varieties"  on public.tomato_varieties for insert to authenticated   with check (auth.uid() = created_by and public.is_allowed());
create policy "Owner can update varieties" on public.tomato_varieties for update to authenticated   using (auth.uid() = created_by and public.is_allowed());
create policy "Owner can delete varieties" on public.tomato_varieties for delete to authenticated   using (auth.uid() = created_by and public.is_allowed());

-- Odling: privat per användare.
create policy "Users see own tomatoes"   on public.user_tomatoes for select to authenticated using (auth.uid() = user_id and public.is_allowed());
create policy "Users insert own tomatoes" on public.user_tomatoes for insert to authenticated with check (auth.uid() = user_id and public.is_allowed());
create policy "Users update own tomatoes" on public.user_tomatoes for update to authenticated using (auth.uid() = user_id and public.is_allowed());
create policy "Users delete own tomatoes" on public.user_tomatoes for delete to authenticated using (auth.uid() = user_id and public.is_allowed());

-- Skörd: privat per användare.
create policy "Users see own harvests"   on public.harvests for select to authenticated using (auth.uid() = user_id and public.is_allowed());
create policy "Users insert own harvests" on public.harvests for insert to authenticated with check (auth.uid() = user_id and public.is_allowed());
create policy "Users update own harvests" on public.harvests for update to authenticated using (auth.uid() = user_id and public.is_allowed());
create policy "Users delete own harvests" on public.harvests for delete to authenticated using (auth.uid() = user_id and public.is_allowed());

-- Recept: man ser delade plus sina egna. Låsta rader går varken att ändra
-- eller radera, och man kan inte låsa sina egna – `locked` sätts bara med
-- servicenyckeln. Verifierat med ett riktigt konto: försök att radera eller
-- ändra ett låst recept lämnar raden orörd, och att sätta locked ger HTTP 403.
create policy "Read shared and own recipes"
  on public.recipes for select to authenticated
  using (public.is_allowed() and (is_shared or auth.uid() = user_id));
create policy "Users insert own recipes"
  on public.recipes for insert to authenticated
  with check (auth.uid() = user_id and public.is_allowed() and not locked);
create policy "Users update own recipes"
  on public.recipes for update to authenticated
  using      (auth.uid() = user_id and public.is_allowed() and not locked)
  with check (auth.uid() = user_id and public.is_allowed() and not locked);
create policy "Users delete own recipes"
  on public.recipes for delete to authenticated
  using (auth.uid() = user_id and public.is_allowed() and not locked);

-- Växtnäring: privat per användare.
create policy "Users see own feedings"   on public.feedings for select to authenticated using (auth.uid() = user_id and public.is_allowed());
create policy "Users insert own feedings" on public.feedings for insert to authenticated with check (auth.uid() = user_id and public.is_allowed());
create policy "Users update own feedings" on public.feedings for update to authenticated using (auth.uid() = user_id and public.is_allowed());
create policy "Users delete own feedings" on public.feedings for delete to authenticated using (auth.uid() = user_id and public.is_allowed());

-- Plantfoton: privat per användare.
create policy "Users see own plant photos"   on public.plant_photos for select to public using (auth.uid() = user_id and public.is_allowed());
create policy "Users insert own plant photos" on public.plant_photos for insert to public with check (auth.uid() = user_id and public.is_allowed());
create policy "Users update own plant photos" on public.plant_photos for update to public using (auth.uid() = user_id and public.is_allowed());
create policy "Users delete own plant photos" on public.plant_photos for delete to public using (auth.uid() = user_id and public.is_allowed());

-- Galleri: privat per användare.
create policy "Users see own garden photos"   on public.garden_photos for select to public using (auth.uid() = user_id and public.is_allowed());
create policy "Users insert own garden photos" on public.garden_photos for insert to public with check (auth.uid() = user_id and public.is_allowed());
create policy "Users update own garden photos" on public.garden_photos for update to public using (auth.uid() = user_id and public.is_allowed());
create policy "Users delete own garden photos" on public.garden_photos for delete to public using (auth.uid() = user_id and public.is_allowed());


-- ------------------------------------------------------------------ STORAGE --
-- Privat bucket för alla foton (både plantfoton och galleriet). 3 MB per fil.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('plant-photos', 'plant-photos', false, 3145728,
        array['image/jpeg','image/webp','image/png'])
on conflict (id) do nothing;

-- Första mappnivån i sökvägen måste vara användarens eget id. Det är det som
-- skiljer användarna åt i lagringen: {user_id}/{tomato_id}/... och
-- {user_id}/gallery/...
create policy "plant-photos select own" on storage.objects for select to public
  using (bucket_id = 'plant-photos' and (storage.foldername(name))[1] = auth.uid()::text and public.is_allowed());
create policy "plant-photos insert own" on storage.objects for insert to public
  with check (bucket_id = 'plant-photos' and (storage.foldername(name))[1] = auth.uid()::text and public.is_allowed());
create policy "plant-photos update own" on storage.objects for update to public
  using (bucket_id = 'plant-photos' and (storage.foldername(name))[1] = auth.uid()::text and public.is_allowed());
create policy "plant-photos delete own" on storage.objects for delete to public
  using (bucket_id = 'plant-photos' and (storage.foldername(name))[1] = auth.uid()::text and public.is_allowed());


-- ============================================================================
-- PUSH-NOTISER (2026-08-30)
--
-- Hämtat ur den levande databasen samma dag. Delen hänger ihop med:
--   * Edge Function `naringsnotis` – skickar utskicken, deployas separat.
--   * sw.js i repot – service workern som tar emot dem.
--   * cron-jobbet längst ner i det här avsnittet.
--
-- Två hemligheter ligger i Vault och finns med flit INTE i den här filen:
--   `naringsnotis_secret` (delad hemlighet cron ↔ Edge Function) och
--   `vapid_keys` (VAPID-nyckelparet). Båda skapades inne i databasen och har
--   aldrig funnits utanför den. Tappas de bort går de att skapa om: radera
--   raderna ur vault.secrets och töm push_config, så genererar Edge-funktionen
--   nya vid nästa körning – men då måste alla prenumerera på nytt, eftersom
--   prenumerationerna är låsta till den gamla publika nyckeln.
-- ============================================================================

-- Krävs för det schemalagda utskicket. pg_cron kör jobbet, pg_net gör anropet.
create extension if not exists pg_cron;
create extension if not exists pg_net;

-- En rad per webbläsare/telefon. Samma person kan ha flera. endpoint är unik
-- globalt – den ÄR adressen som pushtjänsten levererar till.
create table if not exists public.push_subscriptions (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references auth.users(id) on delete cascade,
  endpoint     text not null unique,
  p256dh       text not null,          -- prenumerantens publika nyckel
  auth_secret  text not null,          -- prenumerantens delade hemlighet
  created_at   timestamptz not null default now(),
  last_ok_at   timestamptz,
  last_error   text,
  last_sent_at timestamptz             -- jobbet tiger i tre dygn efter utskick
);

create index if not exists push_subscriptions_user_idx
  on public.push_subscriptions (user_id);

-- Den publika VAPID-nyckeln. Avsiktligt läsbar för inloggade: klienten måste
-- ha den för att kunna prenumerera. En enda rad, låst med check(id).
create table if not exists public.push_config (
  id         boolean primary key default true check (id),
  public_key text not null,
  updated_at timestamptz not null default now()
);


-- --------------------------------------------------------------- FUNKTIONER --

-- Vilka platser som är försenade, för alla användare. Samma regel som bannern
-- i appen: platsen måste ha plantor den här säsongen, och sista gödslingen
-- ligga minst min_dagar tillbaka. Aldrig gödslad = alltid försenad (dagar null).
-- Säsong och dygnsgräns räknas i svensk tid – på UTC ligger dygnet kvar på
-- gårdagens datum mellan midnatt och klockan två.
create or replace function public.naring_forsenade(min_dagar integer default 7)
returns table(user_id uuid, plats text, dagar integer)
language sql
security definer
set search_path to 'public'
as $function$
  with idag as (
    select (now() at time zone 'Europe/Stockholm')::date as d
  ),
  sasong as (
    select to_char((select d from idag), 'YYYY') as ar
  ),
  platser as (
    select distinct t.user_id, t.location as plats
    from public.user_tomatoes t
    where t.season = (select ar from sasong)
      and t.location is not null
      and t.location <> 'Ej placerad'
      -- Tillagt 2026-10-04: den som sagt "klar med näring för i år" räknas
      -- inte som försenad. Se avsnittet KLAR MED NÄRING längst ner.
      and not exists (
        select 1 from public.feeding_done k
         where k.user_id = t.user_id
           and k.season = (select ar from sasong)
      )
  ),
  senaste as (
    select p.user_id, p.plats,
      (select max(f.fed_on)
         from public.feedings f
        where f.user_id = p.user_id
          and f.location = p.plats
          and f.season = (select ar from sasong)) as sista
    from platser p
  )
  select s.user_id,
         s.plats,
         case when s.sista is null then null
              else ((select d from idag) - s.sista)::int end as dagar
  from senaste s
  where s.sista is null
     or ((select d from idag) - s.sista) >= min_dagar
  order by s.user_id, (s.sista is null) desc, s.sista;
$function$;

-- Läsare av Vault för Edge-funktionen. Bara de två namn den behöver, inte en
-- generell nyckel till hela valvet.
create or replace function public.hemlighet(namn text)
returns text
language plpgsql
security definer
set search_path to 'public', 'vault'
as $function$
declare
  varde text;
begin
  if namn not in ('naringsnotis_secret', 'vapid_keys') then
    raise exception 'Otillåtet hemlighetsnamn: %', namn;
  end if;
  select decrypted_secret into varde from vault.decrypted_secrets where name = namn;
  return varde;
end;
$function$;

-- Skriver ner VAPID-nycklarna första gången Edge-funktionen kör. Vägrar skriva
-- över befintliga – en oavsiktlig omgenerering skulle döda alla prenumerationer.
create or replace function public.spara_vapid(jwks text, publik text)
returns void
language plpgsql
security definer
set search_path to 'public', 'vault'
as $function$
begin
  if exists (select 1 from vault.secrets where name = 'vapid_keys') then
    raise exception 'VAPID-nycklarna finns redan och skrivs inte över';
  end if;
  perform vault.create_secret(jwks, 'vapid_keys', 'VAPID-nyckelpar (JWKS) för push-notiser');
  insert into public.push_config (id, public_key) values (true, publik)
    on conflict (id) do update set public_key = excluded.public_key, updated_at = now();
end;
$function$;

-- anon ÄRVER EXECUTE från PUBLIC. Att bara återkalla från anon gör ingenting –
-- rättigheten ligger kvar. Ta bort från public först, ge sedan till den som
-- behöver. Ingen av de tre körs av inloggade användare.
revoke all on function public.naring_forsenade(integer) from public, anon, authenticated;
revoke all on function public.hemlighet(text)           from public, anon, authenticated;
revoke all on function public.spara_vapid(text, text)   from public, anon, authenticated;
grant execute on function public.naring_forsenade(integer) to service_role;
grant execute on function public.hemlighet(text)           to service_role;
grant execute on function public.spara_vapid(text, text)   to service_role;


-- ---------------------------------------------------------- RLS + POLICIES --

alter table public.push_subscriptions enable row level security;
alter table public.push_config        enable row level security;

-- Var och en styr bara sina egna prenumerationer. Ingen update-policy: en
-- ändrad prenumeration ersätts genom att raderas och läggas in på nytt.
create policy "egna prenumerationer syns"
  on public.push_subscriptions for select to authenticated
  using (user_id = auth.uid());
create policy "egna prenumerationer laggs till"
  on public.push_subscriptions for insert to authenticated
  with check (user_id = auth.uid());
create policy "egna prenumerationer tas bort"
  on public.push_subscriptions for delete to authenticated
  using (user_id = auth.uid());

-- Bara läsning. Skrivning sker enbart av service_role, som går förbi RLS.
create policy "publika nyckeln far lasas av inloggade"
  on public.push_config for select to authenticated
  using (true);


-- ------------------------------------------------------------------- CRON --

-- 06:12 UTC = 08:12 svensk sommartid, på morgonen innan man går ut i växthuset.
-- Hemligheten läses ur Vault vid varje körning och finns aldrig i klartext i
-- vare sig schemat eller repot.
--
-- Pausa med:  select cron.unschedule('naringsnotis');
select cron.schedule(
  'naringsnotis',
  '12 6 * * *',
  $job$
  select net.http_post(
    url := 'https://rciaqovopajrkdtuhkdo.supabase.co/functions/v1/naringsnotis',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-naringsnotis-nyckel', public.hemlighet('naringsnotis_secret')
    ),
    timeout_milliseconds := 20000
  );
  $job$
);


-- ============================================================================
-- KLAR MED NÄRING (2026-10-04)
--
-- Gödslingen upphör innan skörden gör det – man slutar ge näring på slutet för
-- att frukten ska mogna. Laras egen logg 2026 visar det tydligt: 32
-- gödslingar i augusti, 7 i september, 0 i oktober, samtidigt som september
-- blev den tyngsta skördemånaden (35,9 kg) och skörd fortfarande registrerades
-- den 4 oktober.
--
-- Utan den här flaggan kan varken bannern eller push-notisen skilja "du har
-- glömt" från "jag är klar för i år", och eftersom både naringsLage() och
-- naring_forsenade() utgår från PLACERADE PLANTOR – som ligger kvar till nyår
-- – tjatade påminnelsen hela hösten och tystnade sedan av en slump vid
-- årsskiftet i stället för av design.
--
-- Flaggan är säsongsscopad: nästa säsong börjar påslagen utan att någon
-- behöver komma ihåg att slå på den igen.
-- ============================================================================

create table public.feeding_done (
  user_id uuid not null references auth.users(id) on delete cascade,
  season  text not null,
  done_at timestamptz not null default now(),
  primary key (user_id, season)
);

alter table public.feeding_done enable row level security;

-- Rollen står utskriven, till skillnad från de äldre tabellerna – se skavank 2.
create policy "egna rader" on public.feeding_done
  for all to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

-- naring_forsenade() byggdes om samma dag så att push-vägen stängs vid roten:
-- den som är klar för säsongen räknas inte som försenad, oavsett hur länge det
-- gått. Samma regel som naringsLage(klar) i app.js. Funktionen i det här
-- dokumentet (under FUNKTIONER i avsnittet PUSH-NOTISER) är uppdaterad – det
-- är villkoret `not exists` i CTE:n `platser`.
--
-- Regeln finns alltså på två ställen, med flit: bannern måste kunna avgöra
-- läget utan att fråga servern, och notisen måste kunna det utan att appen är
-- öppen. Ändras tröskeln eller villkoret ska BÅDA följas åt.
--
-- Verifierat 2026-10-04 med riktigt konto via /auth/v1/signup + REST:
-- spara egen flagga 201, upsert igen 200 utan dubblett, se andras rader nej,
-- sätta flaggan åt någon annan 403, ta bort egen 204.

-- ============================================================================
-- SKAVANKER SOM FINNS I DATABASEN IDAG
-- Nedtecknade för att filen ska spegla verkligheten, inte en snyggare version
-- av den. Inget av det är trasigt just nu – men det är sådant som biter senare.
--
-- 1. is_allowed() jämför `email = lower(jwt-adressen)` utan att gemenera den
--    LAGRADE adressen, till skillnad från is_admin() som gemenerar båda. Det
--    fungerar bara för att add_allowed() normaliserar vid insert. En adress som
--    lagts in för hand med versaler skulle tyst sakna åtkomst.
--
-- 2. Policy-rollerna är inkonsekventa: vissa är `to authenticated`, andra
--    `to public` (dvs. även anon). Det är inget hål – anon har ingen auth.uid()
--    och faller på villkoret ändå – men mönstret ser slarvigt ut vid granskning.
--
-- 3. plant_photos.user_id, garden_photos.user_id och tomato_varieties.created_by
--    saknar ON DELETE CASCADE mot auth.users, till skillnad från de övriga
--    tabellerna. delete_my_account() städar dem explicit, men raderas en
--    användare direkt i Supabase-konsolen fallerar det på främmande nyckel.
-- ============================================================================
