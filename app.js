import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { zip } from "https://esm.sh/fflate@0.8.2";

const SUPABASE_URL = "https://rciaqovopajrkdtuhkdo.supabase.co";
const SUPABASE_ANON_KEY = "sb_publishable_F1wn2SYtPbldAoCV2j9f9w_-2ZqSf8C";
// Säsongen var hårdkodad till "2026" fram till 2026-08-16. Nu väljs den i
// Odling-fliken, så ett nytt odlingsår kan startas utan kodändring och gamla
// år går att bläddra tillbaka till. Plantor och växtnäring hör till en säsong;
// skörd gör det inte (den har ett eget datum och ett eget årsfilter).
const INNEVARANDE_AR = String(new Date().getFullYear());
const NY_SASONG = "__ny__";
const SASONG_NYCKEL = "odlarnorden.sasong";

// Läs adressfältet INNAN klienten skapas – supabase-js städar bort taggen efter sig.
const urlParams = new URLSearchParams(location.hash.slice(1));
const linkType = urlParams.get("type");
// Inbjudan och lösenordsåterställning landar båda med en giltig session men utan
// att användaren satt något lösenord. Samma skärm, olika ord.
const isInviteLink = linkType === "invite";
const isRecoveryLink = linkType === "recovery" || isInviteLink;
const urlAuthError = urlParams.get("error_description") || urlParams.get("error");

const sb = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);
const el = (tag, props = {}, ...children) => {
  const node = Object.assign(document.createElement(tag), props);
  for (const c of children) if (c != null) node.append(c);
  return node;
};

// ---- Fritext från formulär
// Fritext ska aldrig bära med sig inledande eller avslutande blanksteg. Utan
// det här blev "Rhizoferm" och "Rhizoferm " två skilda poster i
// näringshistoriken, trots att det är samma preparat. Ett fält som bara
// innehåller blanksteg ska bli null, inte en tom sträng.
const trimmad = (fd, key) => (fd.get(key) || "").trim() || null;
// ---- slut fritext

let currentUser = null;
let season = INNEVARANDE_AR;   // vald säsong
let seasons = [];              // säsonger som har data, nyast först
let varieties = [];
let starterVarieties = [];
let plantings = [];
let harvests = [];
let recipes = [];
let feedings = [];
let naringKlar = false;        // "klar med näring" för den valda säsongen
let plantPhotos = [];
let galleryPhotos = [];
let currentRecipe = null;
let recipeBatch = 1;

const authView = $("#auth-view");
const appView = $("#app-view");
const recoveryView = $("#recovery-view");
const authForm = $("#auth-form");
const authMsg = $("#auth-msg");

// Sant medan användaren kommit hit via en återställningslänk och ännu inte satt nytt lösenord.
// Måste sättas direkt vid start: supabase-js meddelar "du har en session" innan vår egen
// uppstart hunnit köra, och utan flaggan öppnas appen i stället för lösenordsskärmen.
let recoveryMode = isRecoveryLink;

function showAuth() { authView.hidden = false; appView.hidden = true; recoveryView.hidden = true; }
function showRecovery() {
  if (isInviteLink) {
    $("#recovery-title").textContent = "Välkommen till Odlarnörden";
    $("#recovery-intro").textContent = "Välj ett lösenord, så är du igång. Din odling blir bara din.";
    $("#recovery-intro").hidden = false;
    $("#recovery-submit").textContent = "Kom igång";
  }
  recoveryView.hidden = false;
  authView.hidden = true;
  appView.hidden = true;
}
function authError(text) {
  authMsg.textContent = text;
  authMsg.classList.add("error");
}
// Plockar bort token/felkod ur adressfältet så en omladdning inte kör om flödet.
function cleanUrl() { history.replaceState(null, "", location.pathname); }

// Vem är inloggad? Visas i topbaren bredvid säsongen. Bara delen före @ –
// hela adressen får inte plats på en telefon. Full adress ligger i title,
// och i "Om dina uppgifter" står den utskriven.
function visaInloggad() {
  const ruta = $("#brand-user");
  const epost = currentUser?.email || "";
  ruta.hidden = !epost;
  // Rensa texten också, inte bara dölj – annars ligger förra användarens namn
  // kvar i sidan efter utloggning.
  ruta.textContent = epost ? ` · ${epost.split("@")[0]}` : "";
  if (epost) ruta.title = epost;
  else ruta.removeAttribute("title");
}

async function showApp() {
  const { data: allowed } = await sb.rpc("is_allowed");
  if (!allowed) {
    await sb.auth.signOut();
    showAuth();
    authMsg.textContent = "Det här kontot har inte behörighet till appen ännu. Kontakta administratören.";
    authMsg.classList.add("error");
    return;
  }
  authView.hidden = true;
  recoveryView.hidden = true;
  appView.hidden = false;
  visaInloggad();
  const { data: admin } = await sb.rpc("is_admin");
  $("#admin-btn").hidden = !admin;
  await loadAll();
}

// ---------------- INBJUDNA (admin) ----------------
async function renderInviteList() {
  const list = $("#admin-list");
  const { data, error } = await sb.rpc("list_allowed");
  list.replaceChildren();
  if (error) {
    list.append(el("li", { className: "msg error", textContent: error.message }));
    return;
  }
  const mine = (currentUser?.email || "").toLowerCase();
  for (const rad of data || []) {
    const row = el("li", { className: "invite-row" });
    row.append(el("span", { className: "invite-mail", textContent: rad.email }));
    if (rad.is_admin) row.append(tag("admin", "beige"));
    if (rad.email.toLowerCase() !== mine) {
      const x = el("button", { type: "button", className: "danger", textContent: "Ta bort" });
      x.addEventListener("click", async () => {
        if (!confirm(`Ta bort åtkomsten för ${rad.email}?\n\nDeras konto och data finns kvar, men de kommer inte in i appen.`)) return;
        const { error: rmErr } = await sb.rpc("remove_allowed", { p_email: rad.email });
        $("#admin-msg").textContent = rmErr ? rmErr.message : `${rad.email} har inte längre åtkomst.`;
        await renderInviteList();
      });
      row.append(x);
    }
    list.append(row);
  }
}

$("#admin-btn").addEventListener("click", async () => {
  $("#admin-form").reset();
  $("#admin-msg").textContent = "";
  await renderInviteList();
  $("#admin-dialog").showModal();
});

$("#admin-add").addEventListener("click", async () => {
  const field = $("#admin-form").elements.email;
  const knapp = $("#admin-add");
  const msg = $("#admin-msg");
  const value = field.value.trim();
  if (!value) return;

  knapp.disabled = true;
  msg.classList.remove("error");
  msg.textContent = "Skickar inbjudan …";

  // Utskicket sker i serverfunktionen "bjud-in" – adminnyckeln som krävs för att
  // skicka mejl får inte finnas här i webbläsaren.
  const { data, error } = await sb.functions.invoke("bjud-in", {
    body: { email: value, redirectTo: location.origin + location.pathname },
  });
  knapp.disabled = false;

  if (error) {
    // Funktionen svarar med förklarande text i kroppen även vid felkod.
    let text = error.message;
    try { text = (await error.context?.json())?.fel || text; } catch { /* behåll originalet */ }
    msg.textContent = text;
    msg.classList.add("error");
    await renderInviteList();
    return;
  }

  msg.textContent = data?.meddelande || "Inbjudan skickad.";
  if (data?.mejlSkickat === false) msg.classList.add("error");
  field.value = "";
  await renderInviteList();
});

// ---------------- OM DINA UPPGIFTER ----------------
function openPrivacyDialog() {
  $("#privacy-msg").textContent = "";
  // Radera-knappen visas bara för den som är inloggad – på inloggningsskärmen
  // finns inget konto att radera.
  $("#delete-account-btn").hidden = !currentUser;
  const konto = $("#privacy-account");
  konto.hidden = !currentUser?.email;
  konto.textContent = currentUser?.email ? `Inloggad som ${currentUser.email}` : "";
  $("#privacy-dialog").showModal();
}
$("#privacy-btn").addEventListener("click", openPrivacyDialog);
$("#privacy-btn-auth").addEventListener("click", openPrivacyDialog);

$("#delete-account-btn").addEventListener("click", async () => {
  if (!confirm("Radera ditt konto och all din data?\n\nSorter, plantor, skördar, växtnäring, recept och foton tas bort. Det går inte att ångra.")) return;
  if (prompt('Skriv RADERA för att bekräfta.')?.trim().toUpperCase() !== "RADERA") return;

  const msg = $("#privacy-msg");
  msg.textContent = "Raderar …";

  // Filerna först, medan inloggningen fortfarande gäller. Databasen kan inte
  // radera dem åt oss – Supabase blockerar DELETE direkt mot lagringstabellerna –
  // så går det inte här avbryter vi hellre än att lämna föräldralösa filer kvar.
  const paths = [
    ...plantPhotos.map((p) => p.path),
    ...galleryPhotos.map((p) => p.path),
    // Egna receptbilder ligger också i lagringen. Laras ligger i repot och
    // ska inte röras.
    ...recipes.filter((r) => r.user_id === currentUser?.id && r.image_url && !arRepobild(r.image_url)).map((r) => r.image_url),
  ].filter(Boolean);
  if (paths.length) {
    const { error: filErr } = await sb.storage.from("plant-photos").remove(paths);
    if (filErr) {
      msg.textContent = `Kunde inte ta bort dina foton: ${filErr.message}. Ingenting har raderats.`;
      msg.classList.add("error");
      return;
    }
  }

  const { error } = await sb.rpc("delete_my_account");
  if (error) {
    msg.textContent = error.message;
    msg.classList.add("error");
    return;
  }
  await sb.auth.signOut();
  location.reload();
});

authForm.addEventListener("submit", (e) => e.preventDefault());
authForm.querySelector('[data-action="login"]').addEventListener("click", async () => {
  authMsg.textContent = "";
  const { error } = await sb.auth.signInWithPassword({
    email: $("#email").value,
    password: $("#password").value,
  });
  if (error) { authMsg.textContent = error.message; authMsg.classList.add("error"); }
});
authForm.querySelector('[data-action="signup"]').addEventListener("click", async () => {
  authMsg.textContent = "";
  const { error } = await sb.auth.signUp({
    email: $("#email").value,
    password: $("#password").value,
  });
  if (error) { authMsg.textContent = error.message; authMsg.classList.add("error"); }
  else { authMsg.textContent = "Konto skapat — du är inloggad."; authMsg.classList.remove("error"); }
});
$("#logout").addEventListener("click", async () => { await sb.auth.signOut(); });

// ---------------- VISA/DÖLJ LÖSENORD ----------------
// Gäller alla tre fälten: inloggningen och de två i "Nytt lösenord". Man ser
// annars inte att man knappat fel förrän inloggningen nekas.
function satLosenordSynlighet(knapp, visa) {
  const falt = knapp.parentElement.querySelector("input");
  falt.type = visa ? "text" : "password";
  knapp.textContent = visa ? "Dölj" : "Visa";
  knapp.setAttribute("aria-label", visa ? "Dölj lösenordet" : "Visa lösenordet");
  return falt;
}
for (const knapp of $$(".pw-toggle")) {
  knapp.addEventListener("click", () => {
    const dolt = knapp.parentElement.querySelector("input").type === "password";
    // Tillbaka till fältet, annars försvinner tangentbordet på mobilen.
    satLosenordSynlighet(knapp, dolt).focus();
  });
}

// ---------------- BYT LÖSENORD (inloggad) ----------------
// Glömt-flödet via mejl finns kvar för den som inte kommer in alls. Här krävs
// inte det nuvarande lösenordet: sessionen är redan beviset, på samma sätt som
// för "Radera mitt konto".
$("#password-btn").addEventListener("click", () => {
  $("#password-form").reset();
  $("#password-msg").textContent = "";
  $("#password-msg").classList.remove("error");
  // Fälten kan ha lämnats synliga från förra gången dialogen var öppen.
  for (const k of $$("#password-dialog .pw-toggle")) satLosenordSynlighet(k, false);
  $("#password-dialog").showModal();
});

$("#password-form").addEventListener("submit", async (e) => {
  if (e.submitter?.value === "cancel") return;
  e.preventDefault();

  const msg = $("#password-msg");
  const btn = $("#password-save");
  msg.classList.remove("error");

  const pw = $("#change-password").value;
  if (pw !== $("#change-password-2").value) {
    msg.textContent = "Lösenorden är inte lika – skriv samma på båda raderna.";
    msg.classList.add("error");
    return;
  }

  btn.disabled = true;
  msg.textContent = "Sparar …";
  const { error } = await sb.auth.updateUser({ password: pw });
  btn.disabled = false;

  if (error) {
    msg.textContent = error.message;
    msg.classList.add("error");
    return;
  }
  $("#password-dialog").close();
  alert("Lösenordet är ändrat. Nästa gång du loggar in använder du det nya.");
});

// ---------------- GLÖMT LÖSENORD ----------------
$("#forgot-btn").addEventListener("click", async () => {
  const btn = $("#forgot-btn");
  const email = $("#email").value.trim();
  authMsg.textContent = "";
  authMsg.classList.remove("error");
  if (!email) {
    authError("Fyll i din e-postadress först, så skickar jag en återställningslänk dit.");
    $("#email").focus();
    return;
  }
  const prev = btn.textContent;
  btn.disabled = true;
  btn.textContent = "Skickar…";
  // Länken i mailet ska leda tillbaka hit, till samma sida.
  const { error } = await sb.auth.resetPasswordForEmail(email, {
    redirectTo: location.origin + location.pathname,
  });
  btn.textContent = prev;
  btn.disabled = false;
  if (error) return authError(error.message);
  authMsg.textContent = `Ett mail är på väg till ${email}. Klicka på länken i mailet så får du välja ett nytt lösenord. Kolla skräpposten om det dröjer.`;
});

$("#recovery-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const msg = $("#recovery-msg");
  const btn = e.target.querySelector('button[type="submit"]');
  msg.classList.remove("error");
  const pw = $("#new-password").value;
  if (pw !== $("#new-password-2").value) {
    msg.textContent = "Lösenorden är inte lika – skriv samma på båda raderna.";
    msg.classList.add("error");
    return;
  }
  btn.disabled = true;
  msg.textContent = "Sparar…";
  const { error } = await sb.auth.updateUser({ password: pw });
  btn.disabled = false;
  if (error) {
    msg.textContent = error.message;
    msg.classList.add("error");
    return;
  }
  recoveryMode = false;
  cleanUrl();
  msg.textContent = "Lösenordet är ändrat.";
  await showApp();
});

function triggerDownload(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = el("a", { href: url, download: filename });
  document.body.append(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
function sanitizeName(s) {
  return (s || "").replace(/[\\/:*?"<>|]+/g, "-").replace(/\s+/g, " ").trim().slice(0, 60) || "namnlos";
}
function basename(path) {
  return path.split("/").pop();
}
$("#export-btn").addEventListener("click", async () => {
  const btn = $("#export-btn");
  const label = $("#export-label");
  const prevText = label.textContent;
  btn.disabled = true;
  btn.classList.add("busy"); // visar förloppstexten även på mobilen
  try {
    const data = {
      app: "Odlarnörden",
      exported_at: new Date().toISOString(),
      varieties,
      plantings,
      harvests,
      recipes,
      feedings,
      plant_photos: plantPhotos.map(({ signedUrl, ...r }) => r),
      garden_photos: galleryPhotos.map(({ signedUrl, ...r }) => r),
    };
    const files = { "odlarnorden.json": new TextEncoder().encode(JSON.stringify(data, null, 2)) };

    // Hämta ner de faktiska bildfilerna ur storage och lägg i zip:en.
    const allPhotos = [
      ...plantPhotos.map((p) => ({ ...p, kind: "plant" })),
      ...galleryPhotos.map((p) => ({ ...p, kind: "gallery" })),
    ];
    let failed = 0;
    for (let i = 0; i < allPhotos.length; i++) {
      const ph = allPhotos[i];
      label.textContent = `Laddar ner… ${i + 1}/${allPhotos.length}`;
      const { data: blob, error } = await sb.storage.from("plant-photos").download(ph.path);
      if (error || !blob) { failed++; continue; }
      const bytes = new Uint8Array(await blob.arrayBuffer());
      let name;
      if (ph.kind === "plant") {
        const p = plantings.find((x) => x.id === ph.tomato_id);
        const v = p && varieties.find((x) => x.id === p.variety_id);
        name = `foton/plantor/${sanitizeName(`${v?.name || "planta"} - ${p?.location || ""}`)}/${basename(ph.path)}`;
      } else {
        const cap = ph.caption ? sanitizeName(ph.caption) + "-" : "";
        name = `foton/galleri/${cap}${basename(ph.path)}`;
      }
      files[name] = [bytes, { level: 0 }]; // JPEG är redan komprimerad → lagra utan omkomprimering
    }

    label.textContent = "Packar…";
    const zipped = await new Promise((resolve, reject) =>
      zip(files, { level: 6 }, (err, out) => (err ? reject(err) : resolve(out)))
    );
    triggerDownload(new Blob([zipped], { type: "application/zip" }), `odlarnorden-${new Date().toISOString().slice(0, 10)}.zip`);
    if (failed) alert(`${failed} av ${allPhotos.length} foton kunde inte laddas ner och saknas i zip-filen.`);
  } catch (err) {
    alert("Kunde inte skapa exporten: " + (err.message || err));
  } finally {
    label.textContent = prevText;
    btn.classList.remove("busy");
    btn.disabled = false;
  }
});

sb.auth.onAuthStateChange((event, session) => {
  currentUser = session?.user ?? null;
  if (event === "PASSWORD_RECOVERY") {
    recoveryMode = true;
    return showRecovery();
  }
  // Utloggning ska alltid gå igenom, även mitt i en påbörjad återställning.
  if (event === "SIGNED_OUT") {
    recoveryMode = false;
    return showAuth();
  }
  // Under återställningen finns en giltig session, men appen ska vänta tills
  // det nya lösenordet är satt – annars hoppar vi rakt in i appen i stället.
  if (recoveryMode) return session ? showRecovery() : undefined;
  if (session) showApp();
  else showAuth();
});

// ---------------- TABS ----------------
$$(".tab").forEach((btn) => {
  btn.addEventListener("click", () => {
    $$(".tab").forEach((b) => b.classList.toggle("active", b === btn));
    $$(".tab-panel").forEach((p) => (p.hidden = true));
    $(`#tab-${btn.dataset.tab}`).hidden = false;
  });
});

// ---------------- LOAD ----------------
async function loadAll() {
  // Måste gå först: plantor och växtnäring hämtas filtrerade på vald säsong.
  await loadSeasons();
  await Promise.all([loadVarieties(), loadStarterVarieties(), loadPlantings(), loadHarvests(), loadRecipes(), loadFeedings(), loadFeedingDone(), loadPlantPhotos(), loadGalleryPhotos()]);
  renderAll();
}

// Vilka säsonger finns det data för? Plantor och växtnäring är de enda
// tabellerna med säsongskolumn.
async function loadSeasons() {
  const [p, f] = await Promise.all([
    sb.from("user_tomatoes").select("season"),
    sb.from("feedings").select("season"),
  ]);
  const funna = new Set([...(p.data || []), ...(f.data || [])].map((r) => r.season).filter(Boolean));
  seasons = [...funna].sort().reverse();
  season = valjSasong(seasons, localStorage.getItem(SASONG_NYCKEL), INNEVARANDE_AR);
}

// ---- Val av säsong -----------------------------------------------------
// Ren funktion, utan DOM och lagring, så regeln går att testa. Se
// test/season.test.mjs (klipper ut blocket mellan markörerna).
function valjSasong(tillgangliga, sparad, innevarande) {
  // Ett sparat val gäller bara om året fortfarande finns – eller är i år, som
  // man alltid får börja på även innan det finns data.
  if (sparad && (tillgangliga.includes(sparad) || sparad === innevarande)) return sparad;
  // Annars senaste året MED data, hellre än ett tomt innevarande år. Öppnar man
  // appen i januari ska det inte se ut som att allt försvunnit.
  return tillgangliga[0] || innevarande;
}
// ---- slut val av säsong ------------------------------------------------
async function loadVarieties() {
  const { data, error } = await sb.from("tomato_varieties").select("*").order("name");
  if (error) return console.error(error);
  varieties = data;
}
// Förlagor att hämta in i det egna biblioteket. Går via RPC eftersom RLS döljer
// andras sorter. Ett fel här får inte stoppa appen – då visas bara ingen knapp.
async function loadStarterVarieties() {
  const { data, error } = await sb.rpc("list_starter_varieties");
  if (error) { starterVarieties = []; return console.error(error); }
  starterVarieties = data || [];
}
async function loadPlantings() {
  const { data, error } = await sb
    .from("user_tomatoes")
    .select("*")
    .eq("season", season)
    .order("created_at", { ascending: false });
  if (error) return console.error(error);
  plantings = data;
}
async function loadHarvests() {
  const { data, error } = await sb.from("harvests").select("*").order("harvested_at", { ascending: false });
  if (error) return console.error(error);
  harvests = data;
}
// Omslagsbilder finns i två former. Laras egna ligger som filer i repot
// (`images/...`) och deployas statiskt. Bilder som användare laddar upp kan
// inte committas, så de hamnar i samma privata Storage-bucket som fotona och
// behöver en signerad URL. Prefixet skiljer dem åt.
function arRepobild(url) {
  return !!url && url.startsWith("images/");
}
function recipeBild(r) {
  if (!r.image_url) return null;
  return arRepobild(r.image_url) ? r.image_url : r.signedUrl || null;
}

async function loadRecipes() {
  const { data, error } = await sb.from("recipes").select("*").order("name");
  if (error) return console.error(error);
  recipes = data;

  const paths = recipes.map((r) => r.image_url).filter((u) => u && !arRepobild(u));
  if (!paths.length) return;
  const { data: signed, error: sErr } = await sb.storage.from("plant-photos").createSignedUrls(paths, 28800);
  if (sErr) return console.error(sErr);
  const map = new Map((signed || []).map((s) => [s.path, s.signedUrl]));
  for (const r of recipes) if (!arRepobild(r.image_url)) r.signedUrl = map.get(r.image_url);
}
async function loadFeedings() {
  const { data, error } = await sb
    .from("feedings")
    .select("*")
    .eq("season", season)
    .order("fed_on", { ascending: false });
  if (error) return console.error(error);
  feedings = data;
}
// Har man sagt "klar med näring" för den här säsongen? Raden finns eller finns
// inte; innehållet spelar ingen roll. maybeSingle() i stället för single(),
// som ger ett fel när det inte finns någon rad – vilket är det normala läget.
async function loadFeedingDone() {
  const { data, error } = await sb
    .from("feeding_done")
    .select("season")
    .eq("season", season)
    .maybeSingle();
  if (error) { naringKlar = false; return console.error(error); }
  naringKlar = data !== null;
}
async function loadPlantPhotos() {
  const { data, error } = await sb
    .from("plant_photos")
    .select("*")
    .order("created_at", { ascending: false });
  if (error) return console.error(error);
  plantPhotos = data;
  const paths = plantPhotos.map((p) => p.path);
  if (!paths.length) return;
  // Privat bucket → signerade URL:er för visning (giltiga 8 h).
  const { data: signed, error: sErr } = await sb.storage.from("plant-photos").createSignedUrls(paths, 28800);
  if (sErr) return console.error(sErr);
  const map = new Map((signed || []).map((s) => [s.path, s.signedUrl]));
  for (const p of plantPhotos) p.signedUrl = map.get(p.path);
}
function photosFor(tomatoId) {
  return plantPhotos.filter((p) => p.tomato_id === tomatoId);
}
async function loadGalleryPhotos() {
  const { data, error } = await sb
    .from("garden_photos")
    .select("*")
    .order("created_at", { ascending: false });
  if (error) return console.error(error);
  galleryPhotos = data;
  const paths = galleryPhotos.map((p) => p.path);
  if (!paths.length) return;
  const { data: signed, error: sErr } = await sb.storage.from("plant-photos").createSignedUrls(paths, 28800);
  if (sErr) return console.error(sErr);
  const map = new Map((signed || []).map((s) => [s.path, s.signedUrl]));
  for (const p of galleryPhotos) p.signedUrl = map.get(p.path);
}

// ---------------- PLANT PHOTOS ----------------
// Komprimerar en bild i webbläsaren till JPEG innan uppladdning (håller gratis-tierns lagring nere).
async function compressImage(file, maxDim = 1280, quality = 0.82) {
  const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
  const scale = Math.min(1, maxDim / Math.max(bitmap.width, bitmap.height));
  const width = Math.round(bitmap.width * scale);
  const height = Math.round(bitmap.height * scale);
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  canvas.getContext("2d").drawImage(bitmap, 0, 0, width, height);
  bitmap.close?.();
  return await new Promise((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("Kunde inte läsa bilden"))), "image/jpeg", quality)
  );
}
async function uploadPlantPhoto(tomatoId, file) {
  const blob = await compressImage(file);
  const path = `${currentUser.id}/${tomatoId}/${crypto.randomUUID()}.jpg`;
  const { error: upErr } = await sb.storage.from("plant-photos").upload(path, blob, { contentType: "image/jpeg" });
  if (upErr) throw upErr;
  const { error: insErr } = await sb.from("plant_photos").insert({
    user_id: currentUser.id,
    tomato_id: tomatoId,
    path,
  });
  if (insErr) throw insErr;
}
async function deletePlantPhoto(ph) {
  const { error: sErr } = await sb.storage.from("plant-photos").remove([ph.path]);
  if (sErr) console.error(sErr);
  const { error } = await sb.from("plant_photos").delete().eq("id", ph.id);
  if (error) alert(error.message);
}

function renderAll() {
  renderStats();
  renderLibrary();
  populateSeasonFilter();
  populatePlantingLocationFilter();
  renderPlantings();
  renderFeedings();
  renderFeedingReminder();
  renderNaringKlarRad();
  fyllFeedingNotesList();
  // Registreringen är idempotent och rendering av raden kräver ett svar från
  // service worker-API:et, så den får hänga med utanför det synkrona flödet.
  registreraServiceWorker().then(renderPushRad);
  renderHarvests();
  renderRecipes();
  renderGallery();
  populateVarietySelects();
}

// ---------------- STATS ----------------
function plantsForVariety(varietyId) {
  return plantings.filter((p) => p.variety_id === varietyId);
}
function plantCountAt(varietyId, locationPredicate) {
  return plantsForVariety(varietyId)
    .filter((p) => locationPredicate(p.location))
    .reduce((sum, p) => sum + (p.plant_count || 0), 0);
}
function totalPlants(varietyId) {
  return plantsForVariety(varietyId).reduce((sum, p) => sum + (p.plant_count || 0), 0);
}
function renderStats() {
  const total = plantings.reduce((s, p) => s + (p.plant_count || 0), 0);
  const pot = plantings.filter((p) => p.location === "Kruka").reduce((s, p) => s + (p.plant_count || 0), 0);
  const gh = plantings.filter((p) => p.location === "Växthus").reduce((s, p) => s + (p.plant_count || 0), 0);
  const box = plantings.filter((p) => p.location === "Planteringslåda").reduce((s, p) => s + (p.plant_count || 0), 0);
  const field = plantings.filter((p) => p.location === "Friland").reduce((s, p) => s + (p.plant_count || 0), 0);
  const rem = plantings.filter((p) => p.location === "Ej placerad").reduce((s, p) => s + (p.plant_count || 0), 0);
  $("#stat-total").textContent = total;
  $("#stat-pot").textContent = pot;
  $("#stat-greenhouse").textContent = gh;
  $("#stat-box").textContent = box;
  $("#stat-field").textContent = field;
  $("#stat-remaining").textContent = rem;
}

// ---------------- VARIETIES (Sorter) ----------------
const CATEGORY_PINK = new Set(["Bifftomat", "Körsbär", "Cocktail", "Plommon", "Körsbär/Cocktail", "Chili"]);
function tag(label, kind = "outline") {
  return el("span", { className: `tag ${kind}`, textContent: label });
}
function varietyIcon(v) {
  const n = (v.name || "").toLowerCase();
  if (v.category === "Chili") return "🌶️";
  if (v.category === "Gurka" || n.includes("gurka")) return "🥒";
  if (n.includes("blåbär")) return "🫐";
  if (n.includes("vinbär")) return "🍇";
  return "🍅";
}
function heightText(v) {
  if (v.height_min_cm && v.height_max_cm) return `${v.height_min_cm}-${v.height_max_cm} cm`;
  if (v.height_min_cm) return `${v.height_min_cm} cm`;
  if (v.height_max_cm) return `${v.height_max_cm} cm`;
  return null;
}
function plantingSummary(v) {
  const total = totalPlants(v.id);
  if (total === 0) return null;
  const pot = plantCountAt(v.id, (l) => l === "Kruka");
  const gh = plantCountAt(v.id, (l) => l === "Växthus");
  const parts = [`${total} ${total === 1 ? "planta" : "plantor"}`];
  if (pot) parts.push(`${pot} i kruka`);
  if (gh) parts.push(`${gh} i växthus`);
  return parts.join(" · ");
}
function varietyCard(v) {
  const card = el("li", { className: "card" });
  const head = el("div", { className: "card-head" });
  head.append(el("h3", {}, el("span", { className: "tomato-icon", textContent: varietyIcon(v) }), v.name));
  card.append(head);

  const tags = el("div", { className: "tags" });
  if (v.category) tags.append(tag(v.category, CATEGORY_PINK.has(v.category) ? "pink" : "green"));
  if (v.growth_type) tags.append(tag(v.growth_type, "outline"));
  if (tags.children.length) card.append(tags);

  const meta = el("div", { className: "meta-list" });
  if (v.default_location) meta.append(metaRow("📍", v.default_location));
  const h = heightText(v);
  if (h) meta.append(metaRow("📏", h));
  if (v.pruning) meta.append(metaRow("✂️", v.pruning));
  const psum = plantingSummary(v);
  if (psum) meta.append(metaRow("🌱", psum));
  if (meta.children.length) card.append(meta);

  if (v.flavor) {
    const flavor = el("p", { className: "card-flavor" });
    flavor.append(el("span", { className: "meta-icon", textContent: "😋" }));
    flavor.append(el("span", { textContent: v.flavor }));
    card.append(flavor);
  }

  if (v.use_tags?.length) {
    const ut = el("div", { className: "use-tags" });
    for (const t of v.use_tags) ut.append(tag(t, "beige"));
    card.append(ut);
  }

  if (v.category === "Bär" && v.notes) {
    card.append(el("p", { className: "card-notes", textContent: v.notes }));
  }

  card.addEventListener("click", () => openVarietyDialog(v));
  return card;
}
function metaRow(icon, text) {
  const row = el("div", { className: "meta-row" });
  row.append(el("span", { className: "meta-icon", textContent: icon }));
  row.append(el("span", { textContent: text }));
  return row;
}
function renderLibrary(filter = "") {
  const list = $("#variety-list");
  list.replaceChildren();

  // Tomt bibliotek: förklara vad fliken är till för i stället för att visa en
  // tom lista med ett sökfält över.
  const tomt = varieties.length === 0;
  $("#library-empty").hidden = !tomt;
  $("#library-search").hidden = tomt;
  $("#sorter-heading").hidden = tomt;
  // Utan sorter kan man inte ha plantor heller, så rutorna visar garanterat
  // bara nollor. På mobilen staplas de sex på varandra och skjuter ner
  // förklaringen under vikningen.
  $("#sorter-stats").hidden = tomt;
  $("#starter-btn").hidden = tomt || starterVarieties.length === 0;
  $("#empty-starter-btn").hidden = starterVarieties.length === 0;
  if (tomt) return;

  const f = filter.toLowerCase();
  const filtered = f
    ? varieties.filter((v) => `${v.name} ${v.category || ""} ${v.growth_type || ""} ${(v.use_tags || []).join(" ")} ${v.flavor || ""} ${v.notes || ""}`.toLowerCase().includes(f))
    : varieties;
  $("#sorter-heading").textContent = `Sorter · ${filtered.length} st`;
  for (const v of filtered) list.append(varietyCard(v));
}
$("#library-search").addEventListener("input", (e) => renderLibrary(e.target.value.trim()));

// ---------------- VARIETY DIALOG ----------------
$("#add-variety-btn").addEventListener("click", () => openVarietyDialog(null));
function openVarietyDialog(v) {
  const form = $("#variety-form");
  form.reset();
  $("#variety-dialog-title").textContent = v ? "Redigera sort" : "Ny sort";
  $("#variety-delete").hidden = !v;
  if (v) {
    form.elements.id.value = v.id;
    form.elements.name.value = v.name || "";
    form.elements.category.value = v.category || "";
    form.elements.growth_type.value = v.growth_type || "";
    form.elements.height_min_cm.value = v.height_min_cm ?? "";
    form.elements.height_max_cm.value = v.height_max_cm ?? "";
    form.elements.pruning.value = v.pruning || "";
    form.elements.default_location.value = v.default_location || "";
    form.elements.use_tags.value = (v.use_tags || []).join(", ");
    form.elements.flavor.value = v.flavor || "";
    form.elements.pruning_notes.value = v.pruning_notes || "";
    form.elements.notes.value = v.notes || "";
  } else {
    form.elements.id.value = "";
  }
  $("#variety-dialog").showModal();
}
$("#variety-form").addEventListener("submit", async (e) => {
  const action = e.submitter?.value;
  if (action === "cancel") return;
  e.preventDefault();
  const fd = new FormData(e.target);
  const id = fd.get("id");
  if (action === "delete") {
    if (!confirm("Ta bort denna sort?")) return;
    const { error } = await sb.from("tomato_varieties").delete().eq("id", id);
    if (error) return alert(error.message);
    $("#variety-dialog").close();
    await loadAll();
    return;
  }
  const useTags = (fd.get("use_tags") || "").split(",").map((s) => s.trim()).filter(Boolean);
  const row = {
    name: (fd.get("name") || "").trim(),
    category: fd.get("category") || null,
    growth_type: fd.get("growth_type") || null,
    height_min_cm: fd.get("height_min_cm") ? Number(fd.get("height_min_cm")) : null,
    height_max_cm: fd.get("height_max_cm") ? Number(fd.get("height_max_cm")) : null,
    pruning: fd.get("pruning") || null,
    default_location: fd.get("default_location") || null,
    use_tags: useTags,
    flavor: trimmad(fd, "flavor"),
    pruning_notes: trimmad(fd, "pruning_notes"),
    notes: trimmad(fd, "notes"),
  };
  let error;
  if (id) {
    ({ error } = await sb.from("tomato_varieties").update(row).eq("id", id));
  } else {
    row.created_by = currentUser.id;
    ({ error } = await sb.from("tomato_varieties").insert(row));
  }
  if (error) return alert(error.message);
  $("#variety-dialog").close();
  await loadAll();
});

// ---------------- HÄMTA SORTER (startpaket) ----------------
// Biblioteket är privat per användare, så en ny användare ser noll sorter och
// kan inte registrera en planta förrän hen skapat en. Här hämtar man i stället
// kopior av admins sorter. Kopior, inte kopplingar: user_tomatoes.variety_id är
// ON DELETE CASCADE, så en delad rad hade låtit den som raderar en sort radera
// allas plantor av den.
function starterRow(s) {
  const row = el("label", { className: "starter-row" });
  const box = el("input", { type: "checkbox", value: s.id });
  box.disabled = s.redan_i_biblioteket;
  row.append(box);

  // Ikonen ligger utanför texten så att namn och faktarad börjar i samma kant.
  row.append(el("span", { className: "starter-icon", textContent: varietyIcon(s) }));

  const text = el("span", { className: "starter-text" });
  text.append(el("span", { className: "starter-name", textContent: s.name }));
  const facts = [s.category, s.growth_type, heightText(s), s.default_location].filter(Boolean);
  if (facts.length) text.append(el("span", { className: "starter-facts", textContent: facts.join(" · ") }));
  row.append(text);

  if (s.redan_i_biblioteket) {
    row.classList.add("starter-had");
    row.append(tag("Har redan", "beige"));
  }
  return row;
}

function starterBoxes() {
  return [...$$("#starter-rows input[type=checkbox]")].filter((b) => !b.disabled);
}

function updateStarterSummary() {
  const boxes = starterBoxes();
  const valda = boxes.filter((b) => b.checked).length;
  $("#starter-save").disabled = valda === 0;
  $("#starter-msg").classList.remove("error");
  if (!boxes.length) {
    $("#starter-msg").textContent = starterVarieties.length
      ? "Du har redan alla sorter som finns att hämta."
      : "Det finns inga sorter att hämta just nu.";
    return;
  }
  $("#starter-msg").textContent = valda
    ? `${valda} ${valda === 1 ? "sort" : "sorter"} vald${valda === 1 ? "" : "a"}.`
    : "Kryssa i de sorter du vill lägga till.";
}

function openStarterDialog() {
  const list = $("#starter-rows");
  list.replaceChildren();
  for (const s of starterVarieties) list.append(starterRow(s));
  updateStarterSummary();
  $("#starter-dialog").showModal();
}
$("#starter-btn").addEventListener("click", openStarterDialog);
$("#empty-starter-btn").addEventListener("click", openStarterDialog);
$("#empty-new-btn").addEventListener("click", () => openVarietyDialog(null));

$("#starter-rows").addEventListener("change", updateStarterSummary);
$("#starter-all").addEventListener("click", () => {
  for (const b of starterBoxes()) b.checked = true;
  updateStarterSummary();
});
$("#starter-none").addEventListener("click", () => {
  for (const b of starterBoxes()) b.checked = false;
  updateStarterSummary();
});

$("#starter-save").addEventListener("click", async () => {
  const ids = starterBoxes().filter((b) => b.checked).map((b) => b.value);
  if (!ids.length) return;
  const knapp = $("#starter-save");
  const msg = $("#starter-msg");
  knapp.disabled = true;
  msg.classList.remove("error");
  msg.textContent = "Lägger till …";

  const { data, error } = await sb.rpc("copy_starter_varieties", { p_ids: ids });
  if (error) {
    msg.textContent = error.message;
    msg.classList.add("error");
    knapp.disabled = false;
    return;
  }
  $("#starter-dialog").close();
  await loadAll();
  // Sorter som redan fanns hoppas över i databasen, så antalet kan bli lägre
  // än vad man kryssade i.
  alert(data === 1 ? "1 sort tillagd i ditt bibliotek." : `${data} sorter tillagda i ditt bibliotek.`);
});

// ---------------- SÄSONG ----------------
// Listan innehåller alla år med data, plus innevarande år och det valda året
// (ett nyss påbörjat år har ju ingen data än).
function populateSeasonFilter() {
  const sel = $("#season-filter");
  const alla = [...new Set([...seasons, INNEVARANDE_AR, season])].sort().reverse();
  sel.replaceChildren();
  for (const s of alla) sel.append(el("option", { value: s, textContent: s }));
  sel.append(el("option", { value: NY_SASONG, textContent: "Ny säsong…" }));
  sel.value = season;
  // Året står redan i väljaren bredvid och i topbaren – en tredje gång i
  // rubriken är bara brus.
  $("#brand-season").textContent = `Säsong ${season}`;
}

async function bytSasong(nyttAr) {
  season = nyttAr;
  localStorage.setItem(SASONG_NYCKEL, season);
  await Promise.all([loadPlantings(), loadFeedings(), loadFeedingDone()]);
  renderAll();
}

$("#season-filter").addEventListener("change", async (e) => {
  if (e.target.value !== NY_SASONG) return bytSasong(e.target.value);

  const svar = prompt("Vilket odlingsår vill du börja på?", String(Number(INNEVARANDE_AR) + 1));
  const ar = (svar || "").trim();
  if (!/^\d{4}$/.test(ar)) {
    e.target.value = season; // avbrutet eller obegripligt svar – ändra ingenting
    return;
  }
  await bytSasong(ar);
});

// ---------------- PLANTINGS (Odling) ----------------
function plantingCard(p) {
  const v = varieties.find((x) => x.id === p.variety_id);
  const card = el("li", { className: "card" });
  const head = el("div", { className: "card-head" });
  head.append(el("h3", { textContent: v?.name || "(okänd sort)" }));
  card.append(head);

  const tags = el("div", { className: "tags" });
  tags.append(tag(p.location, "green"));
  tags.append(tag(`${p.plant_count} st`, "outline"));
  if (v?.category === "Bär") {
    const prunedThisYear = p.pruned_on && new Date(p.pruned_on).getFullYear() === new Date().getFullYear();
    tags.append(tag(prunedThisYear ? "✂️ Beskuren i år" : "✂️ Behöver beskäras i år", prunedThisYear ? "green" : "warn"));
  }
  card.append(tags);

  if (p.planted_date || p.pruned_on) {
    const meta = el("div", { className: "meta-list" });
    if (p.planted_date) meta.append(metaRow("📅", "Planterad " + new Date(p.planted_date).toLocaleDateString("sv-SE")));
    if (p.pruned_on) meta.append(metaRow("✂️", "Beskuren " + new Date(p.pruned_on).toLocaleDateString("sv-SE")));
    card.append(meta);
  }
  if (p.notes) card.append(el("p", { className: "msg", textContent: p.notes }));

  const photos = photosFor(p.id);
  if (photos.length) {
    const strip = el("div", { className: "photo-strip" });
    for (const ph of photos.slice(0, 4)) {
      strip.append(el("img", { className: "photo-thumb", src: ph.signedUrl || "", alt: "", loading: "lazy" }));
    }
    if (photos.length > 4) strip.append(el("span", { className: "photo-more", textContent: `+${photos.length - 4}` }));
    card.append(strip);
  }

  card.addEventListener("click", () => openPlantingDialog(p));
  return card;
}
function populatePlantingLocationFilter() {
  const sel = $("#planting-location-filter");
  const prev = sel.value;
  const locs = [...new Set(plantings.map((p) => p.location).filter(Boolean))].sort((a, b) => a.localeCompare(b, "sv"));
  sel.replaceChildren(el("option", { value: "", textContent: "Alla platser" }));
  for (const l of locs) sel.append(el("option", { value: l, textContent: l }));
  sel.value = locs.includes(prev) ? prev : "";
}
function renderPlantings() {
  const list = $("#planting-list");
  list.replaceChildren();
  const f = $("#planting-search").value.trim().toLowerCase();
  const loc = $("#planting-location-filter").value;
  const filtered = plantings.filter((p) => {
    if (loc && p.location !== loc) return false;
    if (!f) return true;
    const v = varieties.find((x) => x.id === p.variety_id);
    return `${v?.name || ""} ${p.location || ""} ${p.notes || ""}`.toLowerCase().includes(f);
  });
  const empty = $("#planting-empty");
  empty.hidden = filtered.length > 0;
  empty.textContent = plantings.length === 0
    ? "Inga plantor inlagda än. Lägg till från en sort eller via knappen ovan."
    : "Inga plantor matchar filtret.";
  for (const p of filtered) list.append(plantingCard(p));
}
$("#planting-search").addEventListener("input", renderPlantings);
$("#planting-location-filter").addEventListener("change", renderPlantings);
$("#add-planting-btn").addEventListener("click", () => openPlantingDialog(null));
let plantingDialogTomatoId = null;
// Kort datumetikett för foton: "10 jul", med årtal när det inte är innevarande år.
function photoDateLabel(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  const base = `${d.getDate()} ${MONTHS_SV[d.getMonth()]}`;
  return d.getFullYear() === new Date().getFullYear() ? base : `${base} ${d.getFullYear()}`;
}
function renderPlantingPhotoGrid(tomatoId) {
  const grid = $("#planting-photo-grid");
  grid.replaceChildren();
  // Äldst först i plantdialogen så fotona läses som en tidslinje.
  const photos = photosFor(tomatoId).slice().sort((a, b) => (a.created_at || "").localeCompare(b.created_at || ""));
  for (const ph of photos) {
    const cell = el("div", { className: "photo-cell" });
    const img = el("img", { src: ph.signedUrl || "", alt: ph.caption || "Plantfoto", loading: "lazy" });
    img.addEventListener("click", () => { if (ph.signedUrl) window.open(ph.signedUrl, "_blank"); });
    const del = el("button", { type: "button", className: "photo-del", textContent: "✕", title: "Ta bort foto" });
    del.addEventListener("click", async () => {
      if (!confirm("Ta bort detta foto?")) return;
      await deletePlantPhoto(ph);
      await loadPlantPhotos();
      renderPlantingPhotoGrid(tomatoId);
      renderPlantings();
    });
    cell.append(img, del, el("span", { className: "photo-date", textContent: photoDateLabel(ph.created_at) }));
    grid.append(cell);
  }
}
function openPlantingDialog(p) {
  const form = $("#planting-form");
  form.reset();
  $("#planting-dialog-title").textContent = p ? "Redigera plantor" : "Lägg till plantor";
  $("#planting-delete").hidden = !p;
  plantingDialogTomatoId = p?.id || null;
  const addLabel = $("#planting-photo-add-label");
  const hint = $("#planting-photo-hint");
  $("#planting-photo-grid").replaceChildren();
  if (p) {
    form.elements.id.value = p.id;
    form.elements.variety_id.value = p.variety_id || "";
    form.elements.location.value = p.location || "";
    form.elements.plant_count.value = p.plant_count ?? 1;
    form.elements.planted_date.value = p.planted_date || "";
    form.elements.pruned_on.value = p.pruned_on || "";
    form.elements.notes.value = p.notes || "";
    renderPlantingPhotoGrid(p.id);
    addLabel.hidden = false;
    hint.hidden = true;
  } else {
    form.elements.id.value = "";
    addLabel.hidden = true;
    hint.hidden = false;
    hint.textContent = "Spara plantan först — öppna den sedan igen för att lägga till foton.";
  }
  $("#planting-dialog").showModal();
}
$("#planting-photo-input").addEventListener("change", async (e) => {
  const file = e.target.files?.[0];
  e.target.value = "";
  if (!file || !plantingDialogTomatoId) return;
  const text = $("#planting-photo-add-text");
  const label = $("#planting-photo-add-label");
  const prev = text.textContent;
  text.textContent = "Laddar upp…";
  label.classList.add("busy");
  try {
    await uploadPlantPhoto(plantingDialogTomatoId, file);
    await loadPlantPhotos();
    renderPlantingPhotoGrid(plantingDialogTomatoId);
    renderPlantings();
  } catch (err) {
    alert("Kunde inte ladda upp bilden: " + (err.message || err));
  } finally {
    text.textContent = prev;
    label.classList.remove("busy");
  }
});
$("#planting-form").addEventListener("submit", async (e) => {
  const action = e.submitter?.value;
  if (action === "cancel") return;
  e.preventDefault();
  const fd = new FormData(e.target);
  const id = fd.get("id");
  if (action === "delete") {
    if (!confirm("Ta bort dessa plantor?")) return;
    // Ta även bort plantans foton ur storage (DB-raderna städas via cascade).
    const paths = photosFor(id).map((p) => p.path);
    if (paths.length) await sb.storage.from("plant-photos").remove(paths);
    const { error } = await sb.from("user_tomatoes").delete().eq("id", id);
    if (error) return alert(error.message);
    $("#planting-dialog").close();
    await loadAll();
    return;
  }
  const row = {
    variety_id: fd.get("variety_id"),
    location: fd.get("location"),
    plant_count: Number(fd.get("plant_count")) || 1,
    planted_date: fd.get("planted_date") || null,
    pruned_on: fd.get("pruned_on") || null,
    notes: trimmad(fd, "notes"),
    season,
  };
  let error;
  if (id) {
    ({ error } = await sb.from("user_tomatoes").update(row).eq("id", id));
  } else {
    row.user_id = currentUser.id;
    ({ error } = await sb.from("user_tomatoes").insert(row));
  }
  if (error) return alert(error.message);
  $("#planting-dialog").close();
  await loadAll();
});

// ---------------- FEEDING (Växtnäring per plats) ----------------
function placedLocations() {
  const set = new Set(plantings.map((p) => p.location).filter((l) => l && l !== "Ej placerad"));
  return [...set].sort((a, b) => a.localeCompare(b, "sv"));
}
// Hur många gödslingstillfällen som visas innan "Visa alla".
const FEEDING_ANTAL = 5;

// ---- Näringspåminnelse
// Trösklarna är valda ur Laras egen logg 2026: i högsäsong ligger hon på 3–9
// dagar mellan gödslingarna, men säsongen rymmer också glapp på 10, 14 och 28
// dagar. Sju dagar betyder alltså "snart dags", fjorton "det har gått för
// länge". Ändras de här ska test/naring.test.mjs följa med.
const NARING_PAMINN_DAGAR = 7;
const NARING_SENT_DAGAR = 14;

// Hela dygn mellan ett datum och idag. Räknas på lokal midnatt i båda ändar,
// annars ger klockslaget ett dygns fel åt endera hållet.
function dagarSedan(isoDatum, idag = new Date()) {
  const d = new Date(isoDatum + "T00:00:00");
  const noll = new Date(idag.getFullYear(), idag.getMonth(), idag.getDate());
  return Math.round((noll - d) / 86400000);
}

// Platser som behöver näring, mest försenad först. En plats utan plantor finns
// inte med – den har ingenting att gödsla. dagar === null betyder att platsen
// aldrig fått näring den här säsongen, vilket alltid räknas som försenat.
//
// klar === true tystar allt. Gödslingen upphör innan skörden gör det – man
// slutar ge näring på slutet för att frukten ska mogna – och utan det här
// kan påminnelsen inte skilja "du har glömt" från "jag är klar för i år".
// Samma regel finns i naring_forsenade() i databasen, som styr push-notiserna.
function naringsLage(platser, rader, idag = new Date(), klar = false) {
  if (klar) return [];
  const lage = [];
  for (const plats of platser) {
    const senaste = rader.filter((f) => f.location === plats)[0];
    const dagar = senaste ? dagarSedan(senaste.fed_on, idag) : null;
    if (dagar !== null && dagar < NARING_PAMINN_DAGAR) continue;
    lage.push({ plats, dagar, sent: dagar === null || dagar >= NARING_SENT_DAGAR });
  }
  const nyckel = (x) => (x.dagar === null ? Number.MAX_SAFE_INTEGER : x.dagar);
  return lage.sort((a, b) => nyckel(b) - nyckel(a));
}
// Dagens datum som YYYY-MM-DD, räknat lokalt. toISOString() ger UTC, vilket i
// svensk sommartid lägger allt som loggas efter klockan 22 på gårdagens datum.
function idagIso(d = new Date()) {
  const tva = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${tva(d.getMonth() + 1)}-${tva(d.getDate())}`;
}

// Vilka rader ett sparande för flera platser faktiskt ska skapa. En redan
// loggad kombination av plats + datum + anteckning hoppas över, annars ger ett
// andra klick på "Alla platser" dubbletter i historiken. Samma plats och datum
// med ett ANNAT preparat är däremot giltigt – 11 augusti 2026 fick alla fyra
// platser både Rhizoferm och flytande tomatnäring.
function nyaNaringsrader(platser, datum, anteckning, befintliga) {
  // Jämför fälten direkt i stället för att bygga en nyckelsträng: en
  // separator måste vara ett tecken som aldrig kan förekomma i datan, och
  // sådana tecken är osynliga i källkoden.
  const redanLoggad = (plats) => befintliga.some(
    (f) => f.location === plats
      && f.fed_on === datum
      && (f.notes ?? "") === (anteckning ?? ""),
  );
  const nya = [];
  const hoppade = [];
  for (const plats of platser) (redanLoggad(plats) ? hoppade : nya).push(plats);
  return { nya, hoppade };
}
// ---- slut näringspåminnelse

function feedingTag(location, f) {
  const label = new Date(f.fed_on).toLocaleDateString("sv-SE") + (f.notes ? ` · ${f.notes}` : "");
  const t = tag(label, "green");
  t.classList.add("clickable");
  t.addEventListener("click", () => openFeedingDialog(location, f));
  return t;
}

function feedingCard(location) {
  const card = el("li", { className: "card static" });
  const list = feedings.filter((f) => f.location === location);

  const head = el("div", { className: "card-head" });
  head.append(el("h3", {}, el("span", { className: "tomato-icon", textContent: "💧" }), location));
  card.append(head);

  const latest = list[0];
  const daysSince = latest ? Math.floor((Date.now() - new Date(latest.fed_on)) / 86400000) : null;
  const overdue = daysSince === null || daysSince > 14;
  card.append(el("p", {
    className: `feeding-latest${overdue ? " overdue" : ""}`,
    textContent: latest
      ? `Senast gödslat: ${new Date(latest.fed_on).toLocaleDateString("sv-SE")}`
      : "Senast gödslat: aldrig",
  }));

  if (list.length) {
    // Sent på säsongen blir listan lång – växthuset låg på tio tillfällen i
    // mitten av augusti. Visa de senaste, med resten en knapptryckning bort.
    const tags = el("div", { className: "tags" });
    const rita = (alla) => {
      tags.replaceChildren();
      for (const f of alla ? list : list.slice(0, FEEDING_ANTAL)) tags.append(feedingTag(location, f));
    };
    rita(false);
    card.append(tags);

    if (list.length > FEEDING_ANTAL) {
      const mer = el("button", { type: "button", className: "linkish feeding-more" });
      let utfalld = false;
      const etikett = () => (utfalld ? "Visa färre" : `Visa alla ${list.length}`);
      mer.textContent = etikett();
      mer.addEventListener("click", () => {
        utfalld = !utfalld;
        rita(utfalld);
        mer.textContent = etikett();
      });
      card.append(mer);
    }
  }

  const add = el("button", { type: "button", className: "primary add-date", textContent: "+ Datum" });
  add.addEventListener("click", () => openFeedingDialog(location, null));
  card.append(add);
  return card;
}
function renderFeedings() {
  const list = $("#feeding-list");
  list.replaceChildren();
  const locs = placedLocations();
  $("#feeding-empty").hidden = locs.length > 0;
  for (const loc of locs) list.append(feedingCard(loc));
}

function renderFeedingReminder() {
  const ruta = $("#feeding-reminder");
  // Bläddrar man tillbaka till ett gammalt odlingsår ska ingenting tjata –
  // de plantorna är sedan länge urdragna.
  const lage = season === INNEVARANDE_AR
    ? naringsLage(placedLocations(), feedings, new Date(), naringKlar)
    : [];
  ruta.hidden = lage.length === 0;
  if (!lage.length) return;

  const nagotSent = lage.some((l) => l.sent);
  ruta.classList.toggle("sent", nagotSent);
  $("#reminder-title").textContent = nagotSent
    ? "Det var ett tag sedan du gav näring"
    : "Snart dags att ge näring";

  const lista = $("#reminder-places");
  lista.replaceChildren();
  for (const l of lage) {
    lista.append(el(
      "li",
      {},
      el("span", { className: "reminder-place", textContent: l.plats }),
      el("span", {
        className: `reminder-days${l.sent ? " sent" : ""}`,
        textContent: l.dagar === null ? "aldrig i år" : `${l.dagar} dagar sedan`,
      }),
    ));
  }

  // onclick, inte addEventListener: renderAll() kör om det här vid varje
  // omladdning och lyssnarna skulle annars staplas på varandra.
  // Knappen går till flerplatsdialogen även när bara en plats är försenad –
  // näring ges nästan alltid överallt samtidigt, och där syns alla platser.
  $("#reminder-log").onclick = () => openFeedAllDialog();
  $("#reminder-klar").onclick = () => sattNaringKlar(true);
}

// Raden som visar att påminnelsen är avstängd. Den måste finnas: stänger man
// av den enda ruta som nämner näringspåminnelsen finns det annars ingenstans
// att ångra sig, och funktionen blir en enkelriktad dörr.
function renderNaringKlarRad() {
  const rad = $("#naring-klar-rad");
  rad.hidden = !(naringKlar && season === INNEVARANDE_AR);
  if (rad.hidden) return;
  $("#naring-klar-text").textContent = `Påminnelser om näring är pausade för ${season}.`;
  $("#naring-klar-angra").onclick = () => sattNaringKlar(false);
}

// Flaggan är säsongsscopad, så nästa år börjar påslaget av sig självt utan att
// någon behöver komma ihåg att slå på den igen.
async function sattNaringKlar(klar) {
  if (season !== INNEVARANDE_AR) return;
  const { error } = klar
    ? await sb.from("feeding_done").upsert({ user_id: currentUser.id, season })
    : await sb.from("feeding_done").delete().eq("user_id", currentUser.id).eq("season", season);
  if (error) return console.error(error);
  naringKlar = klar;
  renderFeedingReminder();
  renderNaringKlarRad();
}

// ---- Push-notiser
// Vad raden ska visa, uträknat utan att röra webbläsarens API:er. Tillstånden
// är fler än man tror, och flera av dem går inte att framkalla på en dator –
// därför är den här delen ren och testbar för sig.
function pushLaget({ stods, arIos, installerad, tillstand, prenumererad }) {
  if (!stods && arIos && !installerad) {
    return {
      text: "Lägg till appen på hemskärmen först – iPhone tillåter notiser bara då.",
      knapp: null,
      test: false,
    };
  }
  if (!stods) {
    return { text: "Den här webbläsaren kan inte visa notiser.", knapp: null, test: false };
  }
  if (tillstand === "denied") {
    return {
      text: "Notiser är blockerade för sidan. Det ändras i webbläsarens inställningar.",
      knapp: null,
      test: false,
    };
  }
  if (prenumererad) {
    // Testknappen finns bara när det går att testa. Utan den skulle man behöva
    // vänta en vecka på den första riktiga påminnelsen för att veta om
    // notiserna alls kommer fram i just den här telefonen.
    return { text: "Påminnelser i telefonen är på.", knapp: "Stäng av", test: true };
  }
  return {
    text: "Få en påminnelse i telefonen när en plats väntat en vecka på näring.",
    knapp: "Slå på",
    test: false,
  };
}

// Ska erbjudandet om telefonnotiser visas högst upp? Bara till den som
// faktiskt kan svara ja, och bara tills hon svarat. Ett erbjudande som ligger
// kvar efter att man tackat nej är inte ett erbjudande, det är tjat.
function visaPushPrompt({ stods, tillstand, prenumererad, avvisad }) {
  if (!stods) return false;
  if (tillstand === "denied") return false;
  if (prenumererad) return false;
  return !avvisad;
}

// Den publika VAPID-nyckeln är base64url; PushManager vill ha den som bytes.
function nyckelTillBytes(base64url) {
  const pad = base64url.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(pad + "=".repeat((4 - pad.length % 4) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}
// ---- slut push-notiser

let swRegistrering = null;

function pushStods() {
  return "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
}
function arIosEnhet() {
  return /iPad|iPhone|iPod/.test(navigator.userAgent)
    || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
}
function arInstallerad() {
  return window.matchMedia("(display-mode: standalone)").matches
    || navigator.standalone === true;
}

async function registreraServiceWorker() {
  if (!pushStods() || swRegistrering) return swRegistrering;
  try {
    swRegistrering = await navigator.serviceWorker.register("sw.js");
    return swRegistrering;
  } catch (e) {
    console.error("Kunde inte registrera service worker:", e);
    return null;
  }
}

async function nuvarandePrenumeration() {
  if (!swRegistrering) return null;
  return await swRegistrering.pushManager.getSubscription();
}

const PUSH_PROMPT_NYCKEL = "odlarnorden.push-erbjudande-avvisat";

async function renderPushRad() {
  const status = $("#push-status");
  const knapp = $("#push-toggle");
  const stods = pushStods();
  const tillstand = stods ? Notification.permission : "default";
  const prenumererad = Boolean(await nuvarandePrenumeration());

  const lage = pushLaget({
    stods,
    arIos: arIosEnhet(),
    installerad: arInstallerad(),
    tillstand,
    prenumererad,
  });
  status.textContent = lage.text;
  knapp.hidden = !lage.knapp;
  if (lage.knapp) knapp.textContent = lage.knapp;
  // Den permanenta knappen var en grå spökknapp och missades. "Slå på" är ett
  // erbjudande och ska synas; "Stäng av" är en åtgärd man redan letar efter.
  knapp.classList.toggle("primary", lage.knapp === "Slå på");
  knapp.classList.toggle("ghost", lage.knapp !== "Slå på");
  $("#push-test").hidden = !lage.test;

  $("#push-prompt").hidden = !visaPushPrompt({
    stods,
    tillstand,
    prenumererad,
    avvisad: localStorage.getItem(PUSH_PROMPT_NYCKEL) === "1",
  });
}

$("#push-prompt-ja").addEventListener("click", async () => {
  const knapp = $("#push-prompt-ja");
  knapp.disabled = true;
  try {
    await slaPaPush();
  } finally {
    knapp.disabled = false;
  }
});

$("#push-prompt-nej").addEventListener("click", async () => {
  localStorage.setItem(PUSH_PROMPT_NYCKEL, "1");
  await renderPushRad();
});

$("#push-test").addEventListener("click", async () => {
  const knapp = $("#push-test");
  const original = knapp.textContent;
  knapp.disabled = true;
  knapp.textContent = "Skickar…";
  try {
    // Funktionen har verify_jwt avstängt (cron har ingen JWT), så den
    // kontrollerar token själv och skickar bara till anroparens egna enheter.
    const { data: session } = await sb.auth.getSession();
    const token = session?.session?.access_token;
    if (!token) throw new Error("Ingen giltig session.");

    const res = await fetch(`${SUPABASE_URL}/functions/v1/naringsnotis`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
    });
    const svar = await res.json();
    if (!res.ok) throw new Error(svar.fel || `HTTP ${res.status}`);
    if (svar.skickade > 0) {
      knapp.textContent = "Skickad ✓";
    } else {
      alert("Ingen enhet att skicka till. Slå på påminnelser igen och försök om.");
      knapp.textContent = original;
    }
  } catch (e) {
    alert(`Testnotisen gick inte att skicka: ${e.message}`);
    knapp.textContent = original;
  } finally {
    knapp.disabled = false;
    setTimeout(() => { knapp.textContent = original; }, 4000);
  }
});

async function slaPaPush() {
  const reg = await registreraServiceWorker();
  if (!reg) return alert("Kunde inte starta notistjänsten i den här webbläsaren.");

  // Måste ske i ett klick – webbläsare avvisar förfrågan utan användargest.
  const svar = await Notification.requestPermission();
  if (svar !== "granted") return renderPushRad();

  const { data: konf, error: konfFel } = await sb
    .from("push_config").select("public_key").maybeSingle();
  if (konfFel || !konf?.public_key) {
    return alert("Hittade ingen nyckel för notiser. Säg till så tittar jag på det.");
  }

  const pren = await reg.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: nyckelTillBytes(konf.public_key),
  });

  const rad = pren.toJSON();
  const { error } = await sb.from("push_subscriptions").insert({
    user_id: currentUser.id,
    endpoint: rad.endpoint,
    p256dh: rad.keys.p256dh,
    auth_secret: rad.keys.auth,
  });
  // 23505 = redan registrerad endpoint. Det är inget fel: samma enhet igen.
  if (error && error.code !== "23505") {
    await pren.unsubscribe();
    return alert(error.message);
  }
  await renderPushRad();
}

async function stangAvPush() {
  const pren = await nuvarandePrenumeration();
  if (pren) {
    await sb.from("push_subscriptions").delete().eq("endpoint", pren.endpoint);
    await pren.unsubscribe();
  }
  await renderPushRad();
}

$("#push-toggle").addEventListener("click", async () => {
  const knapp = $("#push-toggle");
  knapp.disabled = true;
  try {
    if (await nuvarandePrenumeration()) await stangAvPush();
    else await slaPaPush();
  } finally {
    knapp.disabled = false;
  }
});

function fyllFeedingNotesList() {
  // Förslagen gör att samma preparat stavas likadant varje gång.
  const namn = [...new Set(feedings.map((f) => f.notes).filter(Boolean))]
    .sort((a, b) => a.localeCompare(b, "sv"));
  $("#feeding-notes-list").replaceChildren(...namn.map((n) => el("option", { value: n })));
}

function openFeedAllDialog() {
  const form = $("#feeding-all-form");
  form.reset();
  form.elements.fed_on.value = idagIso();
  $("#feeding-all-msg").hidden = true;

  const platser = placedLocations();
  const rutor = $("#feeding-all-places");
  rutor.replaceChildren(...platser.map((plats) => {
    const rad = el("label", { className: "check-row" });
    const box = el("input", { type: "checkbox", name: "plats", value: plats, checked: true });
    rad.append(box, el("span", { textContent: plats }));
    return rad;
  }));

  $("#feeding-all-dialog").showModal();
}

$("#feed-all-btn").addEventListener("click", () => openFeedAllDialog());

$("#feeding-all-form").addEventListener("submit", async (e) => {
  if (e.submitter?.value === "cancel") return;
  e.preventDefault();
  const fd = new FormData(e.target);
  const datum = fd.get("fed_on");
  const anteckning = trimmad(fd, "notes");
  const valda = fd.getAll("plats");

  const msg = $("#feeding-all-msg");
  if (!valda.length) {
    msg.textContent = "Kryssa i minst en plats.";
    msg.hidden = false;
    return;
  }

  const { nya, hoppade } = nyaNaringsrader(valda, datum, anteckning, feedings);
  if (!nya.length) {
    msg.textContent = "Allt det här är redan loggat på det datumet.";
    msg.hidden = false;
    return;
  }

  const { error } = await sb.from("feedings").insert(nya.map((plats) => ({
    user_id: currentUser.id,
    season,
    location: plats,
    fed_on: datum,
    notes: anteckning,
  })));
  if (error) return alert(error.message);

  $("#feeding-all-dialog").close();
  await loadAll();
  if (hoppade.length) {
    alert(`Sparat för ${nya.length} platser. ${hoppade.join(", ")} var redan loggade på det datumet.`);
  }
});
function openFeedingDialog(location, f) {
  const form = $("#feeding-form");
  form.reset();
  $("#feeding-dialog-title").textContent = (f ? "Redigera näring · " : "Ny näring · ") + location;
  $("#feeding-delete").hidden = !f;
  form.elements.location.value = location;
  form.elements.fed_on.value = f?.fed_on || idagIso();
  if (f) {
    form.elements.id.value = f.id;
    form.elements.notes.value = f.notes || "";
  } else {
    form.elements.id.value = "";
  }
  $("#feeding-dialog").showModal();
}
$("#feeding-form").addEventListener("submit", async (e) => {
  const action = e.submitter?.value;
  if (action === "cancel") return;
  e.preventDefault();
  const fd = new FormData(e.target);
  const id = fd.get("id");
  if (action === "delete") {
    if (!confirm("Ta bort detta datum?")) return;
    const { error } = await sb.from("feedings").delete().eq("id", id);
    if (error) return alert(error.message);
    $("#feeding-dialog").close();
    await loadAll();
    return;
  }
  const row = {
    location: fd.get("location"),
    fed_on: fd.get("fed_on"),
    notes: trimmad(fd, "notes"),
    season,
  };
  let error;
  if (id) {
    ({ error } = await sb.from("feedings").update(row).eq("id", id));
  } else {
    row.user_id = currentUser.id;
    ({ error } = await sb.from("feedings").insert(row));
  }
  if (error) return alert(error.message);
  $("#feeding-dialog").close();
  await loadAll();
});

// ---------------- HARVEST (Skörd) ----------------
function harvestCard(h) {
  const v = varieties.find((x) => x.id === h.variety_id);
  const card = el("li", { className: "card" });
  const head = el("div", { className: "card-head" });
  head.append(el("h3", { textContent: v?.name || "(ingen sort)" }));
  card.append(head);

  const tags = el("div", { className: "tags" });
  if (h.weight_g) tags.append(tag(`${h.weight_g} g`, "green"));
  tags.append(tag(new Date(h.harvested_at).toLocaleDateString("sv-SE"), "outline"));
  card.append(tags);

  if (h.notes) card.append(el("p", { className: "msg", textContent: h.notes }));
  card.addEventListener("click", () => openHarvestDialog(h));
  return card;
}
// Årsfilter: gäller hela fliken (summering, diagram och listan) — inte per diagram.
let harvestYear = null;
function harvestYears() {
  return [...new Set(harvests.map((h) => (h.harvested_at || "").slice(0, 4)).filter(Boolean))].sort().reverse();
}
function populateHarvestYearFilter() {
  const sel = $("#harvest-year-filter");
  const years = harvestYears();
  if (harvestYear === null) {
    const thisYear = String(new Date().getFullYear());
    harvestYear = years.includes(thisYear) ? thisYear : years[0] ?? "";
  }
  if (harvestYear && !years.includes(harvestYear)) harvestYear = years[0] ?? "";
  sel.replaceChildren();
  for (const y of years) sel.append(el("option", { value: y, textContent: y }));
  sel.append(el("option", { value: "", textContent: "Alla år" }));
  sel.value = harvestYear;
  sel.hidden = years.length < 2; // visas först när det finns skörd från flera år
}
// Sortfilter. "" = alla sorter. Scopar hela fliken: nyckeltal, diagram och
// lista – så man kan se en enskild sorts utveckling över veckorna.
let harvestVariety = "";

// Bara sorter som faktiskt har skörd under valt år hamnar i listan – annars
// fylls den med sorter man inte kan välja meningsfullt.
function harvestVarietyOptions() {
  const ids = new Set(arsFiltrerade().map((h) => h.variety_id).filter(Boolean));
  return [...ids]
    .map((id) => {
      const v = varieties.find((x) => x.id === id);
      return { id, name: v ? `${varietyIcon(v)} ${v.name}` : "🧺 (ingen sort)" };
    })
    .sort((a, b) => a.name.localeCompare(b.name, "sv"));
}

function populateHarvestVarietyFilter() {
  const sel = $("#harvest-variety-filter");
  const opts = harvestVarietyOptions();
  // Byter man år kan den valda sorten sakna skörd det året.
  if (harvestVariety && !opts.some((o) => o.id === harvestVariety)) harvestVariety = "";
  sel.replaceChildren();
  sel.append(el("option", { value: "", textContent: "Alla sorter" }));
  for (const o of opts) sel.append(el("option", { value: o.id, textContent: o.name }));
  sel.value = harvestVariety;
  sel.hidden = opts.length < 2;
}

function arsFiltrerade() {
  return harvestYear ? harvests.filter((h) => (h.harvested_at || "").startsWith(harvestYear)) : harvests;
}

function filteredHarvests() {
  const rows = arsFiltrerade();
  return harvestVariety ? rows.filter((h) => h.variety_id === harvestVariety) : rows;
}

$("#harvest-year-filter").addEventListener("change", (e) => {
  harvestYear = e.target.value;
  renderHarvests();
});
$("#harvest-variety-filter").addEventListener("change", (e) => {
  harvestVariety = e.target.value;
  renderHarvests();
});

const nf = (n, d = 0) => n.toLocaleString("sv-SE", { minimumFractionDigits: d, maximumFractionDigits: d });
// Skalstrecken håller sig till en enhet: kg om största värdet är minst ett kilo, annars gram.
function pickUnit(maxGrams) { return maxGrams >= 1000 ? "kg" : "g"; }
function weightText(grams, unit) {
  return unit === "kg" ? `${nf(grams / 1000, 1)} kg` : `${nf(Math.round(grams))} g`;
}
// Enskilda värden får sin egen enhet, annars blir en liten skörd "0,0 kg".
function autoWeight(grams) { return weightText(grams, pickUnit(grams)); }
function harvestWord(n) { return n === 1 ? "skörd" : "skördar"; }

// Tomat eller övrigt (bär/chili/gurka)? Samma logik som varietyIcon: allt som visas
// med 🍅 räknas som tomat, resten (🌶️ chili, 🫐 blåbär, 🍇 vinbär, 🥒 gurka) som
// övrigt. Bär utan igenkänt namn fångas dessutom på kategorin. Ingen/okänd sort
// räknas som tomat.
function isTomatoHarvest(varietyId) {
  const v = varieties.find((x) => x.id === varietyId);
  if (!v) return true;
  if (v.category === "Bär" || v.category === "Chili") return false;
  return varietyIcon(v) === "🍅";
}

function renderHarvests() {
  populateHarvestYearFilter();
  populateHarvestVarietyFilter();   // efter årsfiltret: sortlistan beror på valt år
  const rows = filteredHarvests();

  const list = $("#harvest-list");
  list.replaceChildren();
  for (const h of rows) list.append(harvestCard(h));
  const valdSort = harvestVariety && varieties.find((v) => v.id === harvestVariety);
  const sortNamn = valdSort ? `${varietyIcon(valdSort)} ${valdSort.name}` : null;

  const empty = $("#harvest-empty");
  empty.hidden = rows.length > 0;
  empty.textContent = harvests.length === 0
    ? "Inga skördar registrerade än."
    : `Inga skördar registrerade för ${[sortNamn, harvestYear].filter(Boolean).join(" ")}.`;
  const rubrik = sortNamn ? `Skörd av ${sortNamn}` : "Alla skördar";
  $("#harvest-list-heading").textContent = rows.length ? `${rubrik} · ${rows.length} st` : rubrik;

  const sum = $("#harvest-summary");
  sum.replaceChildren();
  sum.hidden = rows.length === 0;
  if (rows.length) {
    const grams = rows.reduce((s, h) => s + (h.weight_g || 0), 0);
    const tomatoGrams = rows.filter((h) => isTomatoHarvest(h.variety_id)).reduce((s, h) => s + (h.weight_g || 0), 0);
    const otherGrams = grams - tomatoGrams;
    // Uppdelningen tomat/övrigt är meningslös när man filtrerat fram en enda
    // sort – då är den ena alltid 0. Visa bara den som har vikt.
    if (!harvestVariety || tomatoGrams) sum.append(stat("Tomater", autoWeight(tomatoGrams)));
    if (!harvestVariety || otherGrams) sum.append(stat("Övrigt", autoWeight(otherGrams)));
    sum.append(stat("Antal skördar", rows.length));
    // "Antal sorter: 1" säger ingenting när man filtrerat fram en enda sort –
    // snittet per skörd är mer användbart då.
    sum.append(harvestVariety
      ? stat("Snitt per skörd", autoWeight(Math.round(grams / rows.length)))
      : stat("Antal sorter", new Set(rows.map((h) => h.variety_id).filter(Boolean)).size));
    sum.append(stat("Senaste skörd", new Date(rows[0].harvested_at).toLocaleDateString("sv-SE")));
  }

  renderHarvestCharts(rows);
}

// ---------------- HARVEST CHARTS ----------------
const MONTHS_SV = ["jan", "feb", "mar", "apr", "maj", "jun", "jul", "aug", "sep", "okt", "nov", "dec"];
const SKALA_NYCKEL = "odlarnorden.diagramskala";
let chartScale = localStorage.getItem(SKALA_NYCKEL) === "vecka" ? "vecka" : "manad";

// ---- Tidsindelning för skördediagrammet --------------------------------
// Skörden pågår bara några veckor (2026: 12 juli–15 augusti), så per månad
// blir det ett par staplar. Veckoläget delar samma data på ISO-veckor.
// Rena funktioner utan DOM – se test/vecka.test.mjs.

// ISO-vecka: veckan tillhör det år där dess TORSDAG ligger. Det är därför
// 1 januari kan höra till vecka 52 eller 53 föregående år.
function isoVecka(datum) {
  const d = new Date(Date.UTC(datum.getUTCFullYear(), datum.getUTCMonth(), datum.getUTCDate()));
  const dagNr = (d.getUTCDay() + 6) % 7;              // mån=0 … sön=6
  d.setUTCDate(d.getUTCDate() - dagNr + 3);           // hoppa till torsdagen
  const ar = d.getUTCFullYear();
  const forstaTorsdag = new Date(Date.UTC(ar, 0, 4)); // 4 jan ligger alltid i vecka 1
  const fDagNr = (forstaTorsdag.getUTCDay() + 6) % 7;
  forstaTorsdag.setUTCDate(forstaTorsdag.getUTCDate() - fDagNr + 3);
  return { ar, vecka: 1 + Math.round((d - forstaTorsdag) / 604800000) };
}

// Måndagen i datumets vecka, som "YYYY-MM-DD".
function veckansMandag(iso) {
  const d = new Date(iso + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return d.toISOString().slice(0, 10);
}

function datumKort(d) {
  return `${d.getUTCDate()} ${MONTHS_SV[d.getUTCMonth()]}`;
}

function manadsHinkar(rows) {
  const per = new Map();
  for (const h of rows) {
    if (!h.harvested_at) continue;
    const key = h.harvested_at.slice(0, 7);
    const cur = per.get(key) || { grams: 0, count: 0 };
    cur.grams += h.weight_g || 0;
    cur.count++;
    per.set(key, cur);
  }
  const keys = [...per.keys()].sort();
  if (!keys.length) return [];

  const flerAr = keys[0].slice(0, 4) !== keys[keys.length - 1].slice(0, 4);
  const ut = [];
  let [y, m] = keys[0].split("-").map(Number);
  const [slutY, slutM] = keys[keys.length - 1].split("-").map(Number);
  // Fyll ut månader utan skörd så tidsaxeln blir jämn.
  while (y < slutY || (y === slutY && m <= slutM)) {
    const v = per.get(`${y}-${String(m).padStart(2, "0")}`) || { grams: 0, count: 0 };
    // Årtal på x-axeln bara när diagrammet spänner över flera år.
    const arSuffix = flerAr && (m === 1 || ut.length === 0) ? ` -${String(y).slice(2)}` : "";
    ut.push({ ...v, label: MONTHS_SV[m - 1] + arSuffix, full: `${MONTHS_SV[m - 1]} ${y}` });
    if (++m > 12) { m = 1; y++; }
  }
  return ut;
}

function veckoHinkar(rows) {
  const per = new Map();   // nyckel: måndagens datum
  for (const h of rows) {
    if (!h.harvested_at) continue;
    const key = veckansMandag(h.harvested_at);
    const cur = per.get(key) || { grams: 0, count: 0 };
    cur.grams += h.weight_g || 0;
    cur.count++;
    per.set(key, cur);
  }
  const keys = [...per.keys()].sort();
  if (!keys.length) return [];

  const ut = [];
  let d = new Date(keys[0] + "T00:00:00Z");
  const slut = new Date(keys[keys.length - 1] + "T00:00:00Z");
  while (d <= slut) {
    const v = per.get(d.toISOString().slice(0, 10)) || { grams: 0, count: 0 };
    const { ar, vecka } = isoVecka(d);
    const sondag = new Date(d.getTime() + 6 * 86400000);
    ut.push({
      ...v,
      label: `v${vecka}`,
      full: `v. ${vecka} ${ar} (${datumKort(d)}–${datumKort(sondag)})`,
    });
    d = new Date(d.getTime() + 7 * 86400000);
  }
  return ut;
}

function harvestHinkar(rows, skala) {
  return skala === "vecka" ? veckoHinkar(rows) : manadsHinkar(rows);
}

// Med många staplar hinner x-etiketterna inte få plats – visa var n:te.
function etikettSteg(antal) {
  return Math.ceil(antal / 8) || 1;
}
// ---- slut tidsindelning -------------------------------------------------

for (const knapp of $$(".scale-btn")) {
  knapp.addEventListener("click", () => {
    chartScale = knapp.dataset.scale;
    localStorage.setItem(SKALA_NYCKEL, chartScale);
    renderHarvests();
  });
}

function renderHarvestCharts(rows) {
  for (const knapp of $$(".scale-btn")) {
    const vald = knapp.dataset.scale === chartScale;
    knapp.classList.toggle("active", vald);
    knapp.setAttribute("aria-pressed", String(vald));
  }
  const monthCols = renderMonthChart(rows);
  const varietyRows = renderVarietyChart(rows);
  // Ett ensamt streck är inget diagram — visa först när det finns något att jämföra.
  $("#month-figure").hidden = monthCols < 2;
  $("#variety-figure").hidden = varietyRows < 2;
  const nothing = monthCols < 2 && varietyRows < 2;
  $("#harvest-charts").hidden = nothing;
  $("#chart-hint").hidden = !nothing || rows.length === 0;
}

function renderMonthChart(rows) {
  const chart = $("#month-chart");
  chart.replaceChildren();

  const months = harvestHinkar(rows, chartScale);
  $("#month-title").textContent = chartScale === "vecka" ? "Skörd per vecka" : "Skörd per månad";
  if (months.length < 2) return months.length;

  const max = Math.max(...months.map((a) => a.grams), 1);
  const unit = pickUnit(max);
  chart.style.setProperty("--n", months.length);

  const yAxis = el("div", { className: "cm-y" });
  for (const v of [max, max / 2, 0]) yAxis.append(el("span", { textContent: v ? weightText(v, unit) : "0" }));

  const plot = el("div", { className: "cm-plot" });
  const grid = el("div", { className: "cm-grid" });
  grid.append(el("i"), el("i"), el("i"));
  plot.append(grid);

  const xAxis = el("div", { className: "cm-xaxis" });
  const caption = $("#month-caption");
  const totalGrams = months.reduce((s, a) => s + a.grams, 0);
  const totalCount = months.reduce((s, a) => s + a.count, 0);
  const defaultCaption = `${autoWeight(totalGrams)} totalt · ${totalCount} ${harvestWord(totalCount)}`;
  caption.textContent = defaultCaption;

  const last = months[months.length - 1];
  const steg = etikettSteg(months.length);
  months.forEach((a, i) => {
    const label = autoWeight(a.grams);
    const full = `${a.full}: ${label} · ${a.count} ${harvestWord(a.count)}`;
    const btn = el("button", { type: "button", className: "cm-btn" });
    btn.setAttribute("aria-label", full);
    // Bara toppen och den sista stapeln får en siffra – resten läses av på skalan eller vid klick.
    if (a.grams > 0 && (a.grams === max || a === last)) {
      btn.append(el("span", { className: "cm-cap", textContent: label }));
    }
    const bar = el("span", { className: a.grams ? "cm-bar" : "cm-bar empty" });
    bar.style.height = a.grams ? `${Math.max(2, (a.grams / max) * 100)}%` : "2px";
    btn.append(bar);
    const show = () => { caption.textContent = full; };
    btn.addEventListener("pointerenter", show);
    btn.addEventListener("focus", show);
    btn.addEventListener("click", show);
    plot.append(btn);
    // Med många veckor får inte alla etiketter plats – visa var n:te, men
    // alltid den sista så man ser var serien slutar.
    const visaEtikett = i % steg === 0 || a === last;
    xAxis.append(el("span", { className: "cm-x", textContent: visaEtikett ? a.label : "" }));
  });
  plot.addEventListener("pointerleave", () => { caption.textContent = defaultCaption; });

  chart.append(yAxis, plot, xAxis);
  return months.length;
}

function renderVarietyChart(rows) {
  const chart = $("#variety-chart");
  chart.replaceChildren();

  const byVariety = new Map();
  for (const h of rows) {
    const key = h.variety_id || "";
    const cur = byVariety.get(key) || { grams: 0, count: 0 };
    cur.grams += h.weight_g || 0;
    cur.count++;
    byVariety.set(key, cur);
  }
  const items = [...byVariety.entries()]
    .map(([id, v]) => {
      const variety = varieties.find((x) => x.id === id);
      return { name: variety ? `${varietyIcon(variety)} ${variety.name}` : "🧺 (ingen sort)", ...v };
    })
    .sort((a, b) => b.grams - a.grams || a.name.localeCompare(b.name, "sv"));
  if (items.length < 2) return items.length;

  const max = Math.max(...items.map((i) => i.grams), 1);
  for (const item of items) {
    const li = el("li", { className: "vb-row" });
    li.title = `${item.name}: ${autoWeight(item.grams)} · ${item.count} ${harvestWord(item.count)}`;
    const top = el("div", { className: "vb-top" });
    top.append(el("span", { className: "vb-name", textContent: item.name }));
    top.append(el("span", { className: "vb-val", textContent: autoWeight(item.grams) }));
    const track = el("div", { className: "vb-track" });
    const bar = el("div", { className: "vb-bar" });
    bar.style.width = `${Math.max(2, (item.grams / max) * 100)}%`;
    track.append(bar);
    li.append(top, track);
    chart.append(li);
  }
  $("#variety-caption").textContent = `Störst: ${items[0].name} · ${autoWeight(items[0].grams)}`;
  return items.length;
}
function stat(label, value) {
  const wrap = el("div", { className: "ks" });
  wrap.append(el("span", { className: "ks-label", textContent: label }));
  wrap.append(el("span", { className: "ks-value", textContent: value }));
  return wrap;
}
$("#add-harvest-btn").addEventListener("click", () => openHarvestDialog(null));

// ---------------- DAGENS SKÖRD ----------------
// En skörderunda gav tidigare ett dialogvarv per sort. Här fylls i stället flera
// vikter i på samma datum och sparas i en enda insert.

// Sorter med plantor i årets odling, senast skördade först (de plockas oftast).
function plantedVarieties() {
  const planted = new Set(plantings.map((p) => p.variety_id));
  const lastHarvest = new Map();
  for (const h of harvests) {
    const prev = lastHarvest.get(h.variety_id);
    if (!prev || h.harvested_at > prev) lastHarvest.set(h.variety_id, h.harvested_at);
  }
  return varieties
    .filter((v) => planted.has(v.id))
    .sort((a, b) => {
      const la = lastHarvest.get(a.id) || "";
      const lb = lastHarvest.get(b.id) || "";
      return lb.localeCompare(la) || a.name.localeCompare(b.name, "sv");
    });
}

// Tomma fält hoppas över, liksom nollor och skräp – en skörd på 0 g är ingen skörd.
function quickHarvestEntries() {
  const rows = [];
  for (const input of $$("#quick-harvest-rows input")) {
    const raw = input.value.trim();
    if (!raw) continue;
    const n = Number(raw.replace(",", "."));
    if (!Number.isFinite(n) || n <= 0) continue;
    rows.push({ variety_id: input.dataset.varietyId, weight_g: Math.round(n) });
  }
  return rows;
}

function updateQuickHarvestSummary() {
  const rows = quickHarvestEntries();
  const total = rows.reduce((sum, r) => sum + r.weight_g, 0);
  $("#quick-harvest-summary").textContent = rows.length
    ? `${rows.length} ${rows.length === 1 ? "sort" : "sorter"} ifyllda · ${autoWeight(total)}`
    : "Fyll i vikten för de sorter du plockat.";
  $("#quick-harvest-save").disabled = rows.length === 0;
}

function openQuickHarvestDialog() {
  const form = $("#quick-harvest-form");
  form.reset();
  form.elements.harvested_at.value = idagIso();

  const list = $("#quick-harvest-rows");
  list.replaceChildren();
  for (const v of plantedVarieties()) {
    const input = el("input", { type: "number", min: "0", step: "1", inputMode: "numeric", placeholder: "0" });
    input.dataset.varietyId = v.id;
    input.setAttribute("aria-label", `Vikt i gram för ${v.name}`);
    input.addEventListener("input", updateQuickHarvestSummary);
    list.append(el("div", { className: "qh-row" },
      el("span", { className: "qh-name", textContent: `${varietyIcon(v)} ${v.name}` }),
      input,
      el("span", { className: "qh-unit", textContent: "g" }),
    ));
  }

  updateQuickHarvestSummary();
  $("#quick-harvest-dialog").showModal();
}
$("#quick-harvest-btn").addEventListener("click", openQuickHarvestDialog);

$("#quick-harvest-form").addEventListener("submit", async (e) => {
  if (e.submitter?.value === "cancel") return;
  e.preventDefault();
  const entries = quickHarvestEntries();
  if (!entries.length) return;
  const harvested_at = e.target.elements.harvested_at.value;
  const rows = entries.map((r) => ({ ...r, harvested_at, user_id: currentUser.id }));
  const { error } = await sb.from("harvests").insert(rows);
  if (error) return alert(error.message);
  $("#quick-harvest-dialog").close();
  await loadAll();
});
function openHarvestDialog(h) {
  const form = $("#harvest-form");
  form.reset();
  $("#harvest-delete").hidden = !h;
  form.elements.harvested_at.value = h?.harvested_at || idagIso();
  if (h) {
    form.elements.id.value = h.id;
    form.elements.variety_id.value = h.variety_id || "";
    form.elements.weight_g.value = h.weight_g ?? "";
    form.elements.notes.value = h.notes || "";
  } else {
    form.elements.id.value = "";
  }
  $("#harvest-dialog").showModal();
}
$("#harvest-form").addEventListener("submit", async (e) => {
  const action = e.submitter?.value;
  if (action === "cancel") return;
  e.preventDefault();
  const fd = new FormData(e.target);
  const id = fd.get("id");
  if (action === "delete") {
    if (!confirm("Ta bort denna skörd?")) return;
    const { error } = await sb.from("harvests").delete().eq("id", id);
    if (error) return alert(error.message);
    $("#harvest-dialog").close();
    await loadAll();
    return;
  }
  const row = {
    variety_id: fd.get("variety_id") || null,
    harvested_at: fd.get("harvested_at"),
    weight_g: fd.get("weight_g") ? Number(fd.get("weight_g")) : null,
    notes: trimmad(fd, "notes"),
  };
  let error;
  if (id) {
    ({ error } = await sb.from("harvests").update(row).eq("id", id));
  } else {
    row.user_id = currentUser.id;
    ({ error } = await sb.from("harvests").insert(row));
  }
  if (error) return alert(error.message);
  $("#harvest-dialog").close();
  await loadAll();
});

// ---------------- RECIPES ----------------
// Egna recept som INTE är delade märks ut, så man vet vad de andra ser.
function privatMarke(r) {
  return r.user_id === currentUser?.id && !r.is_shared ? tag("Privat", "outline") : null;
}
// Får den inloggade ändra receptet? Låsta sköts utanför appen.
function kanAndraRecept(r) {
  return !!currentUser && r.user_id === currentUser.id && !r.locked;
}

function recipeCard(r) {
  const card = el("li", { className: "card" });
  const bild = recipeBild(r);

  if (bild) {
    card.classList.add("recipe-card");
    card.append(el("img", { className: "recipe-cover", src: bild, alt: r.name, loading: "lazy" }));
    card.append(el("h3", { className: "recipe-cover-title", textContent: r.name }));
    const markt = privatMarke(r);
    if (markt) { markt.classList.add("recipe-privat"); card.append(markt); }
    card.addEventListener("click", () => openRecipeDialog(r));
    return card;
  }

  const head = el("div", { className: "card-head" });
  head.append(el("h3", { textContent: r.name }));
  card.append(head);
  const markt = privatMarke(r);
  if (markt) card.append(el("div", { className: "tags" }, markt));

  const namn = recipeVarietyNames(r);
  if (namn.length) {
    const tags = el("div", { className: "tags" });
    for (const n of namn) tags.append(tag(n, "beige"));
    card.append(tags);
  }
  if (r.body) {
    const snippet = r.body.length > 140 ? r.body.slice(0, 140) + "…" : r.body;
    card.append(el("p", { className: "msg", textContent: snippet }));
  }
  card.addEventListener("click", () => openRecipeDialog(r));
  return card;
}
function renderRecipes() {
  const list = $("#recipe-list");
  list.replaceChildren();
  $("#recipe-empty").hidden = recipes.length > 0;
  $("#recept-heading").textContent = recipes.length ? `Recept · ${recipes.length} st` : "Recept";
  for (const r of recipes) list.append(recipeCard(r));
}
function escapeHtml(s) {
  return (s || "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}
function capitalize(s) {
  return s ? s[0].toUpperCase() + s.slice(1) : s;
}
$("#recipe-print").addEventListener("click", () => {
  if (!currentRecipe) return;
  const name = currentRecipe.name || "Recept";
  const body = scaleRecipeBody(currentRecipe.body || "", recipeBatch);
  const sorter = recipeVarietyNames(currentRecipe);
  const w = window.open("", "_blank", "width=720,height=900");
  if (!w) { alert("Tillåt popup-fönster för att kunna skriva ut."); return; }
  w.document.write(`<!doctype html><html lang="sv"><head><meta charset="utf-8"><title>${escapeHtml(name)}</title>
<style>
  body { font-family: Georgia, "Times New Roman", serif; color: #2a2a2a; max-width: 17cm; margin: 2cm auto; padding: 0 1cm; line-height: 1.5; }
  h1 { font-size: 1.8rem; margin: 0 0 .2rem; }
  .sorter { color: #6b6b6b; font-style: italic; margin: 0 0 1rem; }
  .sats { color: #6b6b6b; margin: 0 0 1rem; }
  .body { white-space: pre-wrap; font-size: 1.05rem; }
  @media print { body { margin: 1.2cm; } }
</style></head><body onload="window.print()">
  <h1>🍅 ${escapeHtml(name)}</h1>
  ${sorter.length ? `<p class="sorter">Passar bra med: ${escapeHtml(sorter.join(", "))}</p>` : ""}
  ${recipeBatch !== 1 ? `<p class="sats">${escapeHtml(capitalize(batchPhrase(recipeBatch)))} – mängderna i ingredienslistan är omräknade.</p>` : ""}
  <div class="body">${escapeHtml(body)}</div>
</body></html>`);
  w.document.close();
  w.focus();
});
// Namnen som visas under "Sorter som passar": de valda sorterna plus fritexten.
//
// Sorterna är privata per användare, så ett delat recept pekar på ägarens
// sort-id som ingen annan kan slå upp — då faller de namnen bort och bara
// fritexten återstår. Därför dubblerar vissa recept namnen i fritexten; listan
// avdubbleras här så ägaren inte ser dem två gånger.
function recipeVarietyNames(r) {
  const franBiblioteket = (r.variety_ids || [])
    .map((id) => varieties.find((v) => v.id === id)?.name)
    .filter(Boolean);
  const alla = [...franBiblioteket, ...(r.extra_varieties || [])];
  const sedda = new Set();
  return alla.filter((n) => {
    const nyckel = n.trim().toLowerCase();
    if (!nyckel || sedda.has(nyckel)) return false;
    sedda.add(nyckel);
    return true;
  });
}

// ---- Satsberäkning ----------------------------------------------------
// Räknar bara om mängderna i ingredienslistan. Instruktionerna lämnas orörda
// eftersom koktider, antal burkar o.dyl. inte skalar med satsstorleken.
const BATCH_SIZES = [0.5, 1, 2, 3, 4];
const FRACTIONS = { "½": 1 / 2, "⅓": 1 / 3, "⅔": 2 / 3, "¼": 1 / 4, "¾": 3 / 4, "⅕": 1 / 5, "⅛": 1 / 8 };
const FRACTION_CHARS = Object.keys(FRACTIONS).join("");
// "1 300" (svenskt tusentalsmellanslag) måste testas FÖRST, annars matchas bara
// "1" och 1 300 g blir 2 300 g vid dubbel sats i stället för 2 600 g.
// Kräver exakt tregrupper efter mellanslaget, så "1 gul lök" inte påverkas.
// Mellanslagen skrivs som koder: vanligt, hårt (U+00A0) och smalt hårt
// (U+202F) – Word använder de hårda. (?!\d) hindrar att "1 300" plockas ur
// "1 3000", vilket annars gav 26000 i stället för 6000.
const BLANKSTEG = " \\u00A0\\u202F";
const TUSENTAL = `\\d{1,3}(?:[${BLANKSTEG}]\\d{3})+(?!\\d)`;
// "1 ½" måste testas före "1", annars äts heltalet upp separat.
const NUM = `${TUSENTAL}|\\d+(?:[.,]\\d+)?\\s*[${FRACTION_CHARS}]|[${FRACTION_CHARS}]|\\d+(?:[.,]\\d+)?`;
const QTY_RE = new RegExp(`(${NUM})(\\s*[–—-]\\s*)(${NUM})|(${NUM})`, "g");

function parseQty(text) {
  // Ta bort tusentalsmellanslagen före tolkningen.
  const t = text.trim().replace(/(\d)[ \u00A0\u202F](?=\d{3}(?!\d))/g, "$1");
  const frac = t.match(new RegExp(`[${FRACTION_CHARS}]`));
  if (!frac) {
    const n = parseFloat(t.replace(",", "."));
    return Number.isFinite(n) ? n : null;
  }
  const whole = t.slice(0, frac.index).trim().replace(",", ".");
  const n = (whole ? parseFloat(whole) : 0) + FRACTIONS[frac[0]];
  return Number.isFinite(n) ? n : null;
}

// Vikt skrivs med decimal (107,5 g), mått och styck med bråk (¾ dl, 1 ½ tsk)
// – "107 ½ g" är inget man skriver i ett recept.
const DECIMAL_UNITS = new Set(["g", "gram", "hg", "kg"]);
function formatQty(value, unit) {
  const v = Math.round(value * 100) / 100;
  const whole = Math.floor(v + 1e-9);
  const rest = v - whole;
  if (rest < 1e-9) return String(whole);
  if (!DECIMAL_UNITS.has((unit || "").toLowerCase())) {
    const frac = Object.entries(FRACTIONS).find(([, f]) => Math.abs(f - rest) < 0.02);
    if (frac) return (whole ? `${whole} ` : "") + frac[0];
  }
  return v.toFixed(1).replace(".", ",");
}

// Enheten står efter mängden – även efter ett intervall ("25–30 g").
function unitAfter(line, index) {
  return line.slice(index).match(/^\s*(\p{L}+)/u)?.[1] || "";
}

function insideParens(line, index) {
  let depth = 0;
  for (let i = 0; i < index; i++) {
    if (line[i] === "(") depth++;
    else if (line[i] === ")") depth = Math.max(0, depth - 1);
  }
  return depth > 0;
}

// Skalar första mängden på raden. Siffror inom parentes ("(12 %)", "(5–7 cm)")
// och procenttal lämnas som de är – de beskriver något annat än mängden.
function scaleLine(line, factor) {
  let done = false;
  return line.replace(QTY_RE, (match, from, sep, to, single, offset) => {
    if (done || insideParens(line, offset)) return match;
    if (/^\s*%/.test(line.slice(offset + match.length))) return match;
    const unit = unitAfter(line, offset + match.length);
    if (single != null) {
      const n = parseQty(single);
      if (n == null) return match;
      done = true;
      return formatQty(n * factor, unit);
    }
    const a = parseQty(from);
    const b = parseQty(to);
    if (a == null || b == null) return match;
    done = true;
    return `${formatQty(a * factor, unit)}${sep}${formatQty(b * factor, unit)}`;
  });
}

// Ingredienslistan = raderna efter rubriken "Ingredienser" fram till tom rad.
function ingredientBlock(lines) {
  const start = lines.findIndex((l) => /^\s*(?:[•*-]\s*)?ingredienser\s*:?\s*$/i.test(l));
  if (start === -1) return null;
  let end = start;
  for (let i = start + 1; i < lines.length && lines[i].trim(); i++) end = i;
  return end > start ? { start: start + 1, end } : null;
}

function scaleRecipeBody(body, factor) {
  if (!body || factor === 1) return body;
  const lines = body.split("\n");
  const block = ingredientBlock(lines);
  if (!block) return body;
  for (let i = block.start; i <= block.end; i++) lines[i] = scaleLine(lines[i], factor);
  return lines.join("\n");
}

// Visa satsväljaren bara när det finns mängder att räkna om.
function recipeIsScalable(body) {
  return !!body && scaleRecipeBody(body, 2) !== body;
}

function batchLabel(n) {
  if (n === 1) return "1 sats";
  return n < 1 ? `${formatQty(n)} sats` : `${n} satser`;
}

function batchPhrase(n) {
  return n < 1 ? "en halv sats" : `${n} satser`;
}

function renderRecipeBatch() {
  const scalable = recipeIsScalable(currentRecipe?.body);
  $("#recipe-batch-field").hidden = !scalable;

  const buttons = $("#recipe-batch-buttons");
  buttons.replaceChildren();
  if (scalable) {
    for (const n of BATCH_SIZES) {
      const b = el("button", {
        type: "button",
        className: "batch-btn" + (n === recipeBatch ? " active" : ""),
        textContent: batchLabel(n),
      });
      b.setAttribute("aria-pressed", String(n === recipeBatch));
      b.addEventListener("click", () => {
        recipeBatch = n;
        renderRecipeBatch();
      });
      buttons.append(b);
    }
  }

  const note = $("#recipe-batch-note");
  note.hidden = recipeBatch === 1;
  note.textContent =
    `Mängderna nedan är omräknade för ${batchPhrase(recipeBatch)}. ` +
    "Koktider, antal burkar och liknande står kvar som i originalet.";

  const body = $("#recipe-dialog-body");
  const text = scaleRecipeBody(currentRecipe?.body || "", recipeBatch);
  body.textContent = text;
  body.hidden = !text;
}
// Läsvy — recept skapas och ändras utanför appen (via Supabase), inte här.
function openRecipeDialog(r) {
  currentRecipe = r;
  recipeBatch = 1;
  $("#recipe-dialog-title").textContent = r.name || "Recept";

  const dlgImg = $("#recipe-dialog-image");
  const bild = recipeBild(r);
  if (bild) {
    dlgImg.src = bild;
    dlgImg.alt = r.name || "";
    dlgImg.hidden = false;
  } else {
    dlgImg.hidden = true;
    dlgImg.removeAttribute("src");
  }
  $("#recipe-edit-btn").hidden = !kanAndraRecept(r);

  const names = recipeVarietyNames(r);
  const chips = $("#recipe-variety-chips");
  chips.replaceChildren();
  for (const n of names) chips.append(tag(n, "beige"));
  $("#recipe-variety-field").hidden = names.length === 0;

  renderRecipeBatch();

  $("#recipe-dialog").showModal();
}

// ---------------- SKAPA OCH ÄNDRA RECEPT ----------------
// Egen dialog, skild från läsvyn ovan. Läsvyn har satsberäkning och utskrift
// och fungerar för alla recept; den här rör bara de egna, olåsta.
//
// `locked` går inte att sätta härifrån — RLS vägrar (verifierat: HTTP 403).
// Att låsa ett recept görs med servicenyckeln, dvs. via mig.

let receptBildPath = null;   // vald bild, innan Spara
let receptBildRensad = false;

function renderReceptSortval(valda) {
  const lista = $("#recipe-variety-picker");
  lista.replaceChildren();
  $("#recipe-variety-empty").hidden = varieties.length > 0;
  for (const v of varieties) {
    const rad = el("label", { className: "starter-row" });
    const box = el("input", { type: "checkbox", value: v.id });
    box.checked = valda.includes(v.id);
    rad.append(box);
    rad.append(el("span", { className: "starter-icon", textContent: varietyIcon(v) }));
    rad.append(el("span", { className: "starter-text" }, el("span", { className: "starter-name", textContent: v.name })));
    lista.append(rad);
  }
}

function visaReceptbild(url) {
  const img = $("#recipe-edit-image");
  img.hidden = !url;
  if (url) img.src = url; else img.removeAttribute("src");
  $("#recipe-image-remove").hidden = !url;
  $("#recipe-image-text").textContent = url ? "📷 Byt bild" : "📷 Välj bild";
}

function openReceptDialog(r) {
  const form = $("#recipe-edit-form");
  form.reset();
  receptBildPath = r?.image_url || null;
  receptBildRensad = false;

  $("#recipe-edit-title").textContent = r ? "Ändra recept" : "Nytt recept";
  $("#recipe-delete").hidden = !r;
  $("#recipe-edit-msg").textContent = "";
  $("#recipe-edit-msg").classList.remove("error");

  form.elements.id.value = r?.id || "";
  form.elements.name.value = r?.name || "";
  form.elements.body.value = r?.body || "";
  form.elements.extra_varieties.value = (r?.extra_varieties || []).join(", ");
  form.elements.is_shared.checked = !!r?.is_shared;

  renderReceptSortval(r?.variety_ids || []);
  visaReceptbild(r ? recipeBild(r) : null);
  $("#recipe-edit-dialog").showModal();
}

$("#add-recipe-btn").addEventListener("click", () => openReceptDialog(null));
$("#recipe-edit-btn").addEventListener("click", () => {
  const r = currentRecipe;
  $("#recipe-dialog").close();
  openReceptDialog(r);
});

$("#recipe-image-remove").addEventListener("click", () => {
  receptBildRensad = true;
  receptBildPath = null;
  visaReceptbild(null);
});

$("#recipe-image-input").addEventListener("change", async (e) => {
  const file = e.target.files?.[0];
  e.target.value = "";
  if (!file) return;
  const text = $("#recipe-image-text");
  const prev = text.textContent;
  text.textContent = "Laddar upp…";
  $("#recipe-image-label").classList.add("busy");
  try {
    const blob = await compressImage(file);
    // Samma bucket och mappmönster som fotona, så befintlig storage-RLS
    // (första mappnivån = användarens id) skyddar den utan nya regler.
    const path = `${currentUser.id}/recept/${crypto.randomUUID()}.jpg`;
    const { error: upErr } = await sb.storage.from("plant-photos").upload(path, blob, { contentType: "image/jpeg" });
    if (upErr) throw upErr;
    const { data: signed } = await sb.storage.from("plant-photos").createSignedUrl(path, 28800);
    receptBildPath = path;
    receptBildRensad = false;
    visaReceptbild(signed?.signedUrl || null);
  } catch (err) {
    alert("Kunde inte ladda upp bilden: " + (err.message || err));
    text.textContent = prev;
  } finally {
    $("#recipe-image-label").classList.remove("busy");
  }
});

$("#recipe-edit-form").addEventListener("submit", async (e) => {
  const action = e.submitter?.value;
  if (action === "cancel") return;
  e.preventDefault();

  const fd = new FormData(e.target);
  const id = fd.get("id");
  const befintligt = id ? recipes.find((x) => x.id === id) : null;
  const msg = $("#recipe-edit-msg");
  msg.classList.remove("error");

  if (action === "delete") {
    if (!confirm("Ta bort receptet? Det går inte att ångra.")) return;
    // Bilden ligger i Storage och måste tas bort separat – databasen kan inte
    // radera den (Supabase blockerar delete mot storage-tabellerna).
    if (befintligt && befintligt.image_url && !arRepobild(befintligt.image_url)) {
      await sb.storage.from("plant-photos").remove([befintligt.image_url]);
    }
    const { error } = await sb.from("recipes").delete().eq("id", id);
    if (error) { msg.textContent = error.message; msg.classList.add("error"); return; }
    $("#recipe-edit-dialog").close();
    await loadRecipes();
    renderRecipes();
    return;
  }

  const valdaSorter = [...$$("#recipe-variety-picker input:checked")].map((b) => b.value);
  const fritext = (fd.get("extra_varieties") || "").split(",").map((s) => s.trim()).filter(Boolean);
  const rad = {
    name: (fd.get("name") || "").trim(),
    body: trimmad(fd, "body"),
    variety_ids: valdaSorter,
    extra_varieties: fritext,
    is_shared: fd.get("is_shared") === "on",
    image_url: receptBildRensad ? null : receptBildPath,
  };

  $("#recipe-save").disabled = true;
  msg.textContent = "Sparar …";
  let error;
  if (id) {
    ({ error } = await sb.from("recipes").update(rad).eq("id", id));
  } else {
    rad.user_id = currentUser.id;
    ({ error } = await sb.from("recipes").insert(rad));
  }
  $("#recipe-save").disabled = false;

  if (error) { msg.textContent = error.message; msg.classList.add("error"); return; }

  // Byttes bilden ut ligger den gamla kvar i Storage – städa bort den.
  const gammal = befintligt?.image_url;
  if (gammal && !arRepobild(gammal) && gammal !== rad.image_url) {
    await sb.storage.from("plant-photos").remove([gammal]);
  }
  $("#recipe-edit-dialog").close();
  await loadRecipes();
  renderRecipes();
});

// ---------------- GALLERY (Växthusgalleri) ----------------
// Galleriet visar ALLA uppladdade foton: både de fristående (garden_photos)
// och de som hör till en planta (plant_photos). Plantfotona fanns tidigare
// bara inne på plantan, vilket gjorde att de flesta bilder inte syntes här.
function allaFoton() {
  return [
    ...galleryPhotos.map((p) => ({ ...p, kalla: "galleri" })),
    ...plantPhotos.map((p) => ({ ...p, kalla: "planta" })),
  ].sort((a, b) => String(b.created_at || "").localeCompare(String(a.created_at || "")));
}

// Vilken planta hör fotot till? Plantlistan är säsongsfiltrerad, så för ett
// foto från en tidigare säsong går namnet inte att slå upp – då visas inget.
function fotoPlanta(ph) {
  if (ph.kalla !== "planta") return null;
  const p = plantings.find((x) => x.id === ph.tomato_id);
  if (!p) return null;
  const v = varieties.find((x) => x.id === p.variety_id);
  const namn = v ? `${varietyIcon(v)} ${v.name}` : "🌱 Planta";
  return p.location ? `${namn} · ${p.location}` : namn;
}

function galleryCard(ph) {
  const card = el("li", { className: "gallery-item" });
  card.append(el("img", { src: ph.signedUrl || "", alt: ph.caption || fotoPlanta(ph) || "Foto", loading: "lazy" }));
  const overlay = el("div", { className: "gallery-overlay" });
  if (ph.caption) overlay.append(el("span", { className: "gallery-caption-text", textContent: ph.caption }));
  const planta = fotoPlanta(ph);
  if (planta) overlay.append(el("span", { className: "gallery-plant", textContent: planta }));
  overlay.append(el("span", { className: "gallery-date", textContent: photoDateLabel(ph.created_at) }));
  card.append(overlay);
  card.addEventListener("click", () => openGalleryDialog(ph));
  return card;
}

function renderGallery() {
  const list = $("#gallery-list");
  list.replaceChildren();
  const foton = allaFoton();
  $("#gallery-empty").hidden = foton.length > 0;
  $("#gallery-heading").textContent = foton.length ? `Alla foton · ${foton.length} st` : "Alla foton";
  for (const ph of foton) list.append(galleryCard(ph));
}
$("#gallery-photo-input").addEventListener("change", async (e) => {
  const file = e.target.files?.[0];
  e.target.value = "";
  if (!file) return;
  const text = $("#gallery-add-text");
  const label = $("#gallery-add-label");
  const prev = text.textContent;
  text.textContent = "Laddar upp…";
  label.classList.add("busy");
  try {
    const blob = await compressImage(file);
    const path = `${currentUser.id}/gallery/${crypto.randomUUID()}.jpg`;
    const { error: upErr } = await sb.storage.from("plant-photos").upload(path, blob, { contentType: "image/jpeg" });
    if (upErr) throw upErr;
    const { error: insErr } = await sb.from("garden_photos").insert({ user_id: currentUser.id, path });
    if (insErr) throw insErr;
    await loadGalleryPhotos();
    renderGallery();
  } catch (err) {
    alert("Kunde inte ladda upp bilden: " + (err.message || err));
  } finally {
    text.textContent = prev;
    label.classList.remove("busy");
  }
});
// Vilket foto dialogen visar. Behövs för att veta vilken tabell som ska
// uppdateras – galleri- och plantfoton ligger i olika tabeller.
let oppetFoto = null;

function openGalleryDialog(ph) {
  oppetFoto = ph;
  const planta = fotoPlanta(ph);
  $("#gallery-dialog-title").textContent = planta ? `Foto · ${planta}` : "Foto";
  const form = $("#gallery-form");
  form.reset();
  const img = $("#gallery-dialog-image");
  if (ph.signedUrl) {
    img.src = ph.signedUrl;
    img.alt = ph.caption || "";
    img.hidden = false;
  } else {
    img.hidden = true;
    img.removeAttribute("src");
  }
  form.elements.id.value = ph.id;
  form.elements.caption.value = ph.caption || "";
  $("#gallery-dialog").showModal();
}
$("#gallery-form").addEventListener("submit", async (e) => {
  const action = e.submitter?.value;
  if (action === "cancel") return;
  e.preventDefault();
  const fd = new FormData(e.target);
  const ph = oppetFoto;
  if (!ph) return;
  // Plantfoton och fristående foton ligger i olika tabeller.
  const tabell = ph.kalla === "planta" ? "plant_photos" : "garden_photos";

  // Efter en ändring måste båda listorna läsas om, annars ligger den gamla
  // versionen kvar i den lista fotot inte kom ifrån.
  const laddaOm = async () => {
    await Promise.all([loadGalleryPhotos(), loadPlantPhotos()]);
    renderGallery();
    renderPlantings();
  };

  if (action === "delete") {
    const varning = ph.kalla === "planta"
      ? "Ta bort detta foto?\n\nDet försvinner även från plantan under Odling."
      : "Ta bort detta foto?";
    if (!confirm(varning)) return;
    await sb.storage.from("plant-photos").remove([ph.path]);
    const { error } = await sb.from(tabell).delete().eq("id", ph.id);
    if (error) return alert(error.message);
    $("#gallery-dialog").close();
    await laddaOm();
    return;
  }

  const { error } = await sb.from(tabell).update({ caption: trimmad(fd, "caption") }).eq("id", ph.id);
  if (error) return alert(error.message);
  $("#gallery-dialog").close();
  await laddaOm();
});

// ---------------- SELECTS ----------------
function populateVarietySelects() {
  for (const id of ["#planting-variety-select", "#harvest-variety-select"]) {
    const sel = $(id);
    sel.replaceChildren();
    sel.append(el("option", { value: "", textContent: "—" }));
    for (const v of varieties) sel.append(el("option", { value: v.id, textContent: v.name }));
  }
}

// ---------------- BOOTSTRAP ----------------
(async () => {
  const { data: { session } } = await sb.auth.getSession();
  currentUser = session?.user ?? null;

  // Supabase skickar tillbaka fel i adressfältet, t.ex. utgången länk.
  if (urlAuthError) {
    recoveryMode = false;
    cleanUrl();
    showAuth();
    authError(
      /expired|invalid/i.test(urlAuthError)
        ? (isInviteLink
            ? "Inbjudningslänken har gått ut eller är redan använd. Be den som bjöd in dig om en ny."
            : "Återställningslänken har gått ut eller är redan använd. Be om en ny med \"Glömt lösenordet?\".")
        : urlAuthError
    );
    return;
  }

  if (recoveryMode) {
    if (session) return showRecovery();
    recoveryMode = false;
    cleanUrl();
    showAuth();
    authError(isInviteLink
      ? "Inbjudningslänken gick inte att använda. Be den som bjöd in dig om en ny."
      : "Återställningslänken gick inte att använda. Be om en ny med \"Glömt lösenordet?\".");
    return;
  }

  if (session) showApp();
  else showAuth();
})();
