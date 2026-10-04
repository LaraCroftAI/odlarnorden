// Tester för satsberäkningen i recepten.
//
// Kör med:  node test/batch.test.mjs
// Avslutar med felkod 1 om något test går fel, så den kan användas i CI.
//
// Testerna läser funktionerna direkt ur app.js i stället för att kopiera dem,
// så det är den skarpa koden som körs. Block-gränserna nedan måste därför följa
// med om satsblocket i app.js döps om.

import { readFileSync } from "node:fs";

const APP = new URL("../app.js", import.meta.url);
const BLOCK_START = "// ---- Satsberäkning";
const BLOCK_END = "function renderRecipeBatch";

const src = readFileSync(APP, "utf8");
const start = src.indexOf(BLOCK_START);
const end = src.indexOf(BLOCK_END);
if (start === -1 || end === -1) {
  console.error(`Hittade inte satsblocket i app.js (letade efter "${BLOCK_START}" och "${BLOCK_END}").`);
  process.exit(1);
}
const { scaleRecipeBody, recipeIsScalable, formatQty, scaleLine, batchLabel, batchPhrase, BATCH_SIZES } =
  await import("data:text/javascript," + encodeURIComponent(
    src.slice(start, end) +
    "\nexport { scaleRecipeBody, recipeIsScalable, formatQty, scaleLine, batchLabel, batchPhrase, BATCH_SIZES };"
  ));

let fails = 0;
function check(label, got, want) {
  if (JSON.stringify(got) === JSON.stringify(want)) {
    console.log(`OK   ${label}`);
    return;
  }
  fails++;
  console.log(`FEL  ${label}\n     fick:  ${JSON.stringify(got)}\n     ville: ${JSON.stringify(want)}`);
}
function group(title) {
  console.log(`\n=== ${title} ===`);
}

// ---------------------------------------------------------------- etiketter
group("Etiketter");
check("knapparnas text", BATCH_SIZES.map(batchLabel), ["½ sats", "1 sats", "2 satser", "3 satser", "4 satser"]);
check("fras för halv sats", batchPhrase(0.5), "en halv sats");
check("fras för hel sats", batchPhrase(3), "3 satser");

// ------------------------------------------------------------- formatering
// Vikt skrivs med decimal, mått och styck med bråk. "107 ½ g" är inget man
// skriver i ett recept – det felet fanns på riktigt innan enhetskollen fanns.
group("Enhetsmedveten formatering");
check("gram får decimal", scaleLine("215 g strösocker till 5 dl avrunnen saft", 0.5), "107,5 g strösocker till 5 dl avrunnen saft");
check("gram-intervall får decimal", scaleLine("25–30 g färsk ingefära", 0.5), "12,5–15 g färsk ingefära");
check("kg får decimal", scaleLine("1 kg tomater", 0.5), "0,5 kg tomater");
check("dl behåller bråk", scaleLine("• 1 ½ dl ättiksprit (12 %)", 0.5), "• ¾ dl ättiksprit (12 %)");
check("tsk behåller bråk", scaleLine("• ½ tsk nymald svartpeppar", 0.5), "• ¼ tsk nymald svartpeppar");
check("styck behåller bråk", scaleLine("• 1 vitlöksklyfta", 0.5), "• ½ vitlöksklyfta");
check("heltal förblir heltal", scaleLine("500 g strösocker", 0.5), "250 g strösocker");
check("formatQty utan enhet", formatQty(1.5), "1 ½");
check("formatQty med gram", formatQty(1.5, "g"), "1,5");
check("tredjedel gånger tre blir jämnt", formatQty((1 / 3) * 3), "1");

// -------------------------------------------------------------- radskalning
group("Regler för vilka siffror som skalas");
check("bara första mängden på raden", scaleLine("• ev. 1 msk rapsolja", 2), "• ev. 2 msk rapsolja");
check("siffror i parentes lämnas", scaleLine("1 liten kvist rosmarin (5–7 cm)", 3), "3 liten kvist rosmarin (5–7 cm)");
check("procenttal lämnas", scaleLine("• 1 ½ dl ättiksprit (12 %)", 2), "• 3 dl ättiksprit (12 %)");
check("rad utan siffror lämnas", scaleLine("Atamon till burkarna (valfritt)", 4), "Atamon till burkarna (valfritt)");
check("siffra sent på raden hittas", scaleLine("Rivet skal och saft från 1 citron", 2), "Rivet skal och saft från 2 citron");

// Tusentalsmellanslag. Skrivs så i Word och gav tyst fel svar: "1 300 g"
// dubblades till "2 300 g" i stället för 2 600 g, eftersom bara ettan matchades.
group("Tusental skrivna med mellanslag");
check("1 300 g dubblas", scaleLine("1 300 g Black Sea Man", 2), "2600 g Black Sea Man");
check("1 300 g halveras", scaleLine("1 300 g Black Sea Man", 0.5), "650 g Black Sea Man");
check("1 300 g tredubblas", scaleLine("1 300 g Black Sea Man", 3), "3900 g Black Sea Man");
check("hårt blanksteg räknas också", scaleLine("1\u00A0300 g tomater", 2), "2600 g tomater");
check("två grupper", scaleLine("1 200 300 g", 2), "2400600 g");
// Måste INTE tolkas som tusental – annars blir "1 gul lök" fel.
check("ental följt av ord påverkas inte", scaleLine("1 gul lök", 2), "2 gul lök");
check("siffra följd av tvåsiffrigt tal", scaleLine("1 30 g", 2), "2 30 g");
check("siffra följd av fyrsiffrigt tal", scaleLine("1 3000 g", 2), "2 3000 g");

// ------------------------------------------------------------ hela recepten
// Texterna nedan speglar recepten som ligger i databasen. Ändras ett recept
// där behöver motsvarande text här följa med.
group("Mammas ketchup");
const ketchup = `Hemgjord ketchup. Tillsätter du 1 msk rapsolja i slutet minskar ytspänningen.

⏱ 15 min + ca 1 timme koktid
Ger ca 8 dl

INGREDIENSER
• 1 kg tomater
• 1 gul lök
• 2 dl strösocker
• 1 ½ dl ättiksprit (12 %)
• ½ tsk nymald svartpeppar

GÖR SÅ HÄR
3. Sjud ketchupen utan lock ca 1 timme.`;
const k3 = scaleRecipeBody(ketchup, 3);
check("x3 tomater", k3.includes("• 3 kg tomater"), true);
check("x3 ättiksprit", k3.includes("• 4 ½ dl ättiksprit (12 %)"), true);
check("x3 koktid orörd", k3.includes("ca 1 timme koktid"), true);
check("x3 mängd i brödtext orörd", k3.includes("Tillsätter du 1 msk rapsolja"), true);
// Ändrat 2026-10-04: utbytet SKA skala. Tidigare stod raden kvar, vilket Lara
// hittade i appen – "om jag dubblar receptet så står det fortfarande 8 dl".
check("x3 utbytet skalas", k3.includes("Ger ca 24 dl"), true);
check("1 sats ändrar ingenting", scaleRecipeBody(ketchup, 1), ketchup);

group("Grön tomatmarmelad");
const marmelad = `Ingredienser
1 kg gröna tomater
500 g strösocker
25–30 g färsk ingefära, fint riven
1 liten kvist rosmarin (5–7 cm)
Atamon till burkarna (valfritt)

Gör så här
2. Koka under lock cirka 20 minuter.`;
const m2 = scaleRecipeBody(marmelad, 2);
check("x2 tomater", m2.includes("2 kg gröna tomater"), true);
check("x2 ingefära", m2.includes("50–60 g färsk ingefära"), true);
check("x2 parentes orörd", m2.includes("(5–7 cm)"), true);
check("x2 koktid orörd", m2.includes("cirka 20 minuter"), true);

group("Svartvinbärs- och jordgubbssaft med rosmarin");
const saft = `Ingredienser
600 g mycket mogna svarta vinbär
200 g frysta jordgubbar
6 dl vatten totalt (börja gärna med 4 dl och tillsätt mer om bärmassan blir för tjock)
1 liten kvist rosmarin, cirka 4–5 cm
215 g strösocker till 5 dl avrunnen saft
1 tsk vaniljsocker
Atamon enligt förpackningen, om saften ska sparas länge

Gör så här
2. Koka upp under lock och låt sjuda cirka 15 minuter.
4. Lägg i rosmarinkvisten under de sista 3–5 minuterna.`;
check("satsväljaren visas", recipeIsScalable(saft), true);
const s2 = scaleRecipeBody(saft, 2);
check("x2 vinbär", s2.includes("1200 g mycket mogna svarta vinbär"), true);
check("x2 jordgubbar", s2.includes("400 g frysta jordgubbar"), true);
check("x2 socker", s2.includes("430 g strösocker"), true);
check("x2 centimetermått orört", s2.includes("2 liten kvist rosmarin, cirka 4–5 cm"), true);
check("x2 koktid orörd", s2.includes("sjuda cirka 15 minuter"), true);
check("x2 minuter i instruktion orörda", s2.includes("de sista 3–5 minuterna"), true);
const sHalv = scaleRecipeBody(saft, 0.5);
check("½ vinbär", sHalv.includes("300 g mycket mogna svarta vinbär"), true);
check("½ socker med decimal", sHalv.includes("107,5 g strösocker"), true);
check("½ tsk blir bråk", sHalv.includes("½ tsk vaniljsocker"), true);

group("Efterkoksgelé på svarta vinbär med svart te");
const gele = `Ingredienser
Den silade bärmassan från svartvinbärs- och jordgubbssaft med rosmarin
2–3 dl vatten
1 tsk lösviktste Earl Grey
8 g Gul Melatin
150 g strösocker
Cirka ⅓ tsk Atamon (ungefär 1,5–2 ml), om doseringen är 1 tsk per kg färdig gelé

Gör så här
5. Mät upp 8 g Gul Melatin och 150 g strösocker, enligt proportionerna på påsen: 40 g Melatin och 750 g socker per liter osockrad saft.`;
check("satsväljaren visas", recipeIsScalable(gele), true);
const g3 = scaleRecipeBody(gele, 3);
check("x3 vattenintervall", g3.includes("6–9 dl vatten"), true);
check("x3 melatin", g3.includes("24 g Gul Melatin"), true);
check("x3 socker", g3.includes("450 g strösocker"), true);
check("x3 tredjedels tsk blir 1", g3.includes("Cirka 1 tsk Atamon"), true);
check("x3 parentes orörd", g3.includes("(ungefär 1,5–2 ml)"), true);
check("x3 rad utan mängd orörd", g3.includes("Den silade bärmassan från svartvinbärs-"), true);
check("x3 proportioner i instruktion orörda", g3.includes("40 g Melatin och 750 g socker per liter"), true);
const gHalv = scaleRecipeBody(gele, 0.5);
check("½ melatin", gHalv.includes("4 g Gul Melatin"), true);
check("½ socker", gHalv.includes("75 g strösocker"), true);
check("½ te blir bråk", gHalv.includes("½ tsk lösviktste"), true);

// ------------------------------------------------------------------ utbyte
// Dubblar man ketchupen blir det dubbelt så mycket ketchup – men den kokar
// inte dubbelt så länge. Utbytesraden ska alltså skala, koktidsraden inte.
// Lara hittade det 2026-10-04: "om jag dubblar receptet så står det
// fortfarande 8 dl".
group("Utbytet räknas om, men inte koktiden");
const k2 = scaleRecipeBody(ketchup, 2);
check("x2 utbytet dubblas", k2.includes("Ger ca 16 dl"), true);
check("x2 koktidsraden orörd", k2.includes("⏱ 15 min + ca 1 timme koktid"), true);
check("x2 koktid i instruktionen orörd", k2.includes("Sjud ketchupen utan lock ca 1 timme"), true);
check("x2 ingredienserna skalas fortfarande", k2.includes("• 2 kg tomater"), true);
check("x2 procent i parentes orörd", k2.includes("(12 %)"), true);
check("x2 inledningen orörd", k2.includes("Tillsätter du 1 msk rapsolja"), true);
check("½ utbytet halveras", scaleRecipeBody(ketchup, 0.5).includes("Ger ca 4 dl"), true);

// Stegen är numrerade och inleds med en siffra. Skulle mönstret träffa dem
// skulle "5." bli "10." vid dubbel sats och receptet bli oläsligt.
const steg = `Ingredienser
2 dl socker

GÖR SÅ HÄR
1. Skär tomaterna i grova bitar.
3. Sjud utan lock ca 1 timme.
5. Rör ner Atamon enligt doseringen.`;
const steg2 = scaleRecipeBody(steg, 2);
check("stegnummer orörda", steg2.includes("1. Skär") && steg2.includes("3. Sjud") && steg2.includes("5. Rör"), true);

// "Blir" är lika naturligt som "Ger" och kostar ett ord i mönstret.
check("Blir-rad skalar också",
  scaleRecipeBody("Blir 4 burkar\n\nIngredienser\n2 dl socker", 2).includes("Blir 8 burkar"), true);
check("intervall i utbytet skalar",
  scaleRecipeBody("Ger 4–6 portioner\n\nIngredienser\n2 dl socker", 2).includes("Ger 8–12 portioner"), true);
// Ordet måste INLEDA raden. Annars träffas meningar mitt i en instruktion.
check("Ger mitt i en mening rör sig inte",
  scaleRecipeBody("Ingredienser\n2 dl socker\n\nGör så här\n1. Detta ger ca 8 dl sås.", 2)
    .includes("Detta ger ca 8 dl sås"), true);

// ------------------------------------------------------------------ övrigt
group("Recept utan tolkbar ingredienslista");
check("utbytesrad utan ingredienslista gör inte receptet skalbart",
  recipeIsScalable("Ger ca 8 dl\n\nGör så här\n1. Koka."), false);
check("tom text", recipeIsScalable(""), false);
check("löpande text utan rubrik", recipeIsScalable("Bara löpande text med 2 dl grädde."), false);
check("rubrik utan innehåll", recipeIsScalable("Ingredienser\n\nGör så här\n1. Koka."), false);

console.log(fails === 0 ? "\nALLA TESTER OK" : `\n${fails} TESTER MISSLYCKADES`);
process.exit(fails === 0 ? 0 : 1);
