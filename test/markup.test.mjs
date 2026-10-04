// Strukturkontroller av index.html. Ingen webbläsare behövs – de här felen syns
// i markupen, och de är sådana som annars upptäcks först av en användare som
// inte kommer in i appen.
//
// Kör med:  node test/markup.test.mjs

import { readFileSync } from "node:fs";

// Går att peka ut en annan fil som argument. Används för att kontrollera att
// testet verkligen fångar de fel det påstår sig fånga (se negativ kontroll
// längst ner i den här filen).
// readFileSync tar både en sträng och en URL, så sökvägen kan skickas rå.
const target = process.argv[2] || new URL("../index.html", import.meta.url);
const html = readFileSync(target, "utf8");

let fails = 0;
function check(label, got, want) {
  if (got === want) { console.log(`OK   ${label}`); return; }
  fails++;
  console.log(`FEL  ${label}\n     fick:  ${got}\n     ville: ${want}`);
}

// ---------------------------------------------------- visa/dölj lösenord ----
// Varje lösenordsfält ska ligga i en .pw-field tillsammans med en Visa-knapp.
// Missas det på ett nytt fält står användaren där utan möjlighet att se vad
// hen skrivit – hela poängen med funktionen.
const pwFields = [...html.matchAll(/<span class="pw-field">([\s\S]*?)<\/span>/g)].map((m) => m[1]);
const pwInputs = [...html.matchAll(/<input[^>]*type="password"[^>]*>/g)].map((m) => m[0]);

console.log("--- Visa/dölj lösenord ---");
check("alla lösenordsfält ligger i en .pw-field", pwFields.length, pwInputs.length);
check("det finns minst ett lösenordsfält", pwInputs.length > 0, true);

for (const field of pwFields) {
  const id = (field.match(/id="([^"]+)"/) || [])[1] || "(utan id)";
  const toggle = field.match(/<button[^>]*class="pw-toggle"[^>]*>/);
  check(`${id}: har en Visa-knapp`, Boolean(toggle), true);
  if (!toggle) continue;

  // Samma fälla som Avbryt-buggen: utan type="button" blir knappen en submit-
  // knapp. I inloggningsformuläret skulle ett klick då försöka logga in i
  // stället för att visa lösenordet.
  check(`${id}: knappen har type="button"`, /type="button"/.test(toggle[0]), true);
  check(`${id}: knappen har aria-label`, /aria-label="/.test(toggle[0]), true);
}

// ------------------------------------------- dialoger som nås utloggad ----
// #app-view har attributet hidden när man inte är inloggad, och regeln
// [hidden] { display: none !important } tar bort hela trädet ur renderingen.
// En dialog därinne kan därför öppnas med showModal() utan att synas – ytan
// blir 0x0 och för användaren "händer ingenting". Dialoger som går att nå
// från inloggningsskärmen måste ligga utanför.
console.log("\n--- Dialoger som nås utloggad ---");
const mainStart = html.indexOf('<main id="app-view"');
const mainEnd = html.indexOf("</main>", mainStart);
const appView = html.slice(mainStart, mainEnd);

check("#app-view finns och har hidden", /<main id="app-view"[^>]*\shidden/.test(html), true);
for (const id of ["privacy-dialog"]) {
  check(`#${id} ligger utanför #app-view`, appView.includes(`<dialog id="${id}">`), false);
  check(`#${id} finns i dokumentet`, html.includes(`<dialog id="${id}">`), true);
}

// ------------------------------------------------ element som koden kräver ----
// renderFeedingReminder() och renderNaringKlarRad() slår upp de här med $() och
// sätter .onclick direkt. Saknas ett id kastar renderAll() på null, och då
// renderas ingenting alls – inte bara näringsdelen. Felet syns som en tom app.
console.log("\n--- Element som renderingen slår upp ---");
for (const id of ["reminder-log", "reminder-klar", "naring-klar-rad", "naring-klar-text", "naring-klar-angra"]) {
  check(`#${id} finns`, new RegExp(`id="${id}"`).test(html), true);
}
// Knapparna ligger inte i ett formulär idag, men paret reminder/näring har
// flyttats runt förut. type="button" är billig försäkring mot att en framtida
// flytt in i ett <form> gör dem till submit-knappar.
for (const id of ["reminder-klar", "naring-klar-angra"]) {
  const knapp = html.match(new RegExp(`<button[^>]*id="${id}"[^>]*>`)) || [""];
  check(`#${id} har type="button"`, /type="button"/.test(knapp[0]), true);
}

console.log(fails === 0 ? "\nALLA TESTER OK" : `\n${fails} TESTER MISSLYCKADES`);
process.exit(fails === 0 ? 0 : 1);
