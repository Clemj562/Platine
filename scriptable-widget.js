// Platine — widget iPhone pour l'app gratuite Scriptable
// Généré par l'appli web Platine. Il contient ton accès Spotify : ne le partage pas.
// Tailles : petit, moyen, grand (écran d'accueil) et rectangulaire, rond ou en ligne (écran verrouillé).
// Toucher le widget ouvre Spotify.

const CLIENT_ID = "__CLIENT_ID__";
const JETON_INITIAL = "__REFRESH_TOKEN__";
const APPLI_WEB = "__ADRESSE_APPLI__";
const CLE = "platine.refreshToken." + CLIENT_ID;
const OUVRIR = "spotify:";

// ---------- Jeton Spotify (renouvelé et gardé dans le trousseau de l'iPhone) ----------
async function jetonAcces() {
  const essais = [];
  if (Keychain.contains(CLE)) essais.push(Keychain.get(CLE));
  if (!essais.includes(JETON_INITIAL)) essais.push(JETON_INITIAL);
  let erreur = "Jeton refusé";
  for (const rt of essais) {
    const r = new Request("https://accounts.spotify.com/api/token");
    r.method = "POST";
    r.headers = { "Content-Type": "application/x-www-form-urlencoded" };
    r.body = "grant_type=refresh_token&refresh_token=" + encodeURIComponent(rt) +
      "&client_id=" + encodeURIComponent(CLIENT_ID);
    let j = {};
    try { j = await r.loadJSON(); } catch (e) { erreur = "Pas de connexion internet"; continue; }
    if (j && j.access_token) {
      Keychain.set(CLE, j.refresh_token || rt);
      return j.access_token;
    }
    erreur = (j && (j.error_description || j.error)) || erreur;
  }
  throw new Error(erreur);
}

async function spotify(chemin, jeton) {
  const r = new Request("https://api.spotify.com/v1" + chemin);
  r.headers = { Authorization: "Bearer " + jeton };
  const data = await r.load();
  const code = r.response ? r.response.statusCode : 0;
  if (code === 204) return null;
  let j = null;
  try { j = JSON.parse(data.toRawString()); } catch (e) { j = null; }
  if (code >= 400) throw new Error((j && j.error && j.error.message) || ("Erreur Spotify " + code));
  return j;
}

async function lireEtat() {
  const jeton = await jetonAcces();
  const p = await spotify("/me/player?additional_types=episode", jeton);
  if (!p || !p.item) return { actif: false };
  const it = p.item;
  const ep = it.type === "episode";
  const images = ep ? (it.images || (it.show && it.show.images) || []) : ((it.album && it.album.images) || []);
  // image la plus proche de 300 px : assez nette, légère pour le widget
  const img = images.slice().sort((a, b) => Math.abs((a.width || 0) - 300) - Math.abs((b.width || 0) - 300))[0];
  return {
    actif: true,
    lecture: !!p.is_playing,
    titre: it.name || "",
    artiste: ep ? ((it.show && it.show.name) || "") : (it.artists || []).map((a) => a.name).join(", "),
    pochette: img ? img.url : null,
    position: p.progress_ms || 0,
    duree: it.duration_ms || 0,
    appareil: (p.device && p.device.name) || "",
  };
}

// ---------- Dessin du vinyle (pochette au centre) ----------
function vinyle(pochette, taille) {
  const dc = new DrawContext();
  dc.size = new Size(taille, taille);
  dc.opaque = false;
  dc.respectScreenScale = false;
  const c = taille / 2;
  const cercle = (r) => new Rect(c - r, c - r, r * 2, r * 2);

  dc.setFillColor(new Color("#121212"));
  dc.fillEllipse(cercle(c));

  // sillons
  dc.setLineWidth(Math.max(1, taille / 300));
  for (let k = 0; k < 14; k++) {
    const r = taille * (0.26 + k * 0.016);
    dc.setStrokeColor(new Color(k % 4 === 3 ? "#3a3a3a" : "#1f1f1f"));
    dc.strokeEllipse(cercle(r));
  }

  // pochette : carré de 40 % du diamètre, coins cachés par un anneau couleur disque
  const s = taille * 0.4;
  if (pochette) {
    dc.drawImageInRect(pochette, new Rect(c - s / 2, c - s / 2, s, s));
  } else {
    dc.setFillColor(new Color("#e9e4da"));
    dc.fillEllipse(cercle(s / 2));
  }
  dc.setStrokeColor(new Color("#121212"));
  dc.setLineWidth(s * 0.215);
  dc.strokeEllipse(cercle(s * 0.604));

  // liseré de l'étiquette, reflet, trou
  dc.setStrokeColor(new Color("#000000", 0.55));
  dc.setLineWidth(Math.max(1.5, taille / 150));
  dc.strokeEllipse(cercle(s / 2));
  dc.setStrokeColor(new Color("#ffffff", 0.08));
  dc.setLineWidth(taille * 0.06);
  dc.strokeEllipse(cercle(taille * 0.42));
  dc.setFillColor(new Color("#0b0b0b"));
  dc.fillEllipse(cercle(taille * 0.022));
  return dc.getImage();
}

function mmss(ms) {
  const t = Math.max(0, Math.floor(ms / 1000));
  return Math.floor(t / 60) + ":" + String(t % 60).padStart(2, "0");
}

// ---------- Mise en page ----------
function fond(w) {
  const g = new LinearGradient();
  g.colors = [new Color("#1e1e20"), new Color("#0b0b0b")];
  g.locations = [0, 1];
  w.backgroundGradient = g;
}

function ajouterTexte(conteneur, texte, police, opacite, centre) {
  const t = conteneur.addText(texte);
  t.font = police;
  t.textColor = Color.white();
  t.textOpacity = opacite;
  t.lineLimit = 1;
  t.minimumScaleFactor = 0.7;
  if (centre) t.centerAlignText();
  return t;
}

function lignePosition(conteneur, e, taillePolice) {
  const ligne = conteneur.addStack();
  ligne.layoutHorizontally();
  ligne.centerAlignContent();
  const icone = ligne.addText(e.lecture ? "▶︎ " : "❚❚ ");
  icone.font = Font.systemFont(taillePolice - 2);
  icone.textColor = Color.white();
  icone.textOpacity = 0.7;
  if (e.lecture) {
    // compteur qui avance tout seul dans le widget
    const d = ligne.addDate(new Date(Date.now() - e.position));
    d.applyTimerStyle();
    d.font = Font.regularMonospacedSystemFont(taillePolice);
    d.textColor = Color.white();
    d.textOpacity = 0.7;
    d.lineLimit = 1;
  } else {
    const p = ligne.addText(mmss(e.position));
    p.font = Font.regularMonospacedSystemFont(taillePolice);
    p.textColor = Color.white();
    p.textOpacity = 0.7;
  }
  const total = ligne.addText(" / " + mmss(e.duree));
  total.font = Font.regularMonospacedSystemFont(taillePolice);
  total.textColor = Color.white();
  total.textOpacity = 0.45;
}

async function construire(e) {
  const famille = config.widgetFamily || "medium";
  const w = new ListWidget();
  w.url = OUVRIR;
  w.refreshAfterDate = new Date(Date.now() + (e.actif && e.lecture ? 60 : 300) * 1000);

  // Écran verrouillé
  if (famille === "accessoryInline") {
    w.addText(e.actif ? "♫ " + e.titre + " — " + e.artiste : "Platine");
    return w;
  }
  if (famille === "accessoryCircular") {
    const img = await chargerPochette(e);
    const im = w.addImage(vinyle(img, 160));
    im.imageSize = new Size(60, 60);
    return w;
  }
  if (famille === "accessoryRectangular") {
    ajouterTexte(w, e.actif ? e.titre : "Rien en lecture", Font.boldSystemFont(14), 1, false);
    ajouterTexte(w, e.actif ? e.artiste : "Platine", Font.systemFont(12), 0.75, false);
    if (e.actif) lignePosition(w, e, 12);
    return w;
  }

  // Écran d'accueil
  fond(w);
  const disque = vinyle(await chargerPochette(e), 360);
  if (famille === "small") {
    w.setPadding(12, 12, 10, 12);
    const h = w.addStack();
    h.addSpacer();
    const im = h.addImage(disque);
    im.imageSize = new Size(88, 88);
    h.addSpacer();
    w.addSpacer(6);
    ajouterTexte(w, e.actif ? e.titre : "Rien en lecture", Font.boldSystemFont(13), 1, true);
    ajouterTexte(w, e.actif ? e.artiste : "Platine", Font.systemFont(11), 0.7, true);
    return w;
  }
  const grand = famille === "large" || famille === "extraLarge";
  w.setPadding(14, 14, 14, 16);
  const h = w.addStack();
  h.layoutHorizontally();
  h.centerAlignContent();
  const im = h.addImage(disque);
  const cote = grand ? 150 : 120;
  im.imageSize = new Size(cote, cote);
  h.addSpacer(14);
  const v = h.addStack();
  v.layoutVertically();
  ajouterTexte(v, e.actif ? e.titre : "Rien en lecture", Font.boldSystemFont(grand ? 19 : 16), 1, false);
  v.addSpacer(2);
  ajouterTexte(v, e.actif ? e.artiste : "Lance un titre sur Spotify", Font.systemFont(grand ? 15 : 13), 0.7, false);
  if (e.actif) {
    v.addSpacer(8);
    lignePosition(v, e, grand ? 14 : 12);
    if (e.appareil) {
      v.addSpacer(3);
      ajouterTexte(v, e.appareil, Font.systemFont(grand ? 12 : 10.5), 0.45, false);
    }
  }
  return w;
}

async function chargerPochette(e) {
  if (!e.actif || !e.pochette) return null;
  try { return await new Request(e.pochette).loadImage(); } catch (err) { return null; }
}

function widgetErreur(message) {
  const w = new ListWidget();
  fond(w);
  w.setPadding(14, 14, 14, 14);
  w.url = APPLI_WEB;
  ajouterTexte(w, "Platine", Font.boldSystemFont(15), 1, false);
  w.addSpacer(4);
  const t = w.addText("Reconnecte le widget : appli web Platine → ⚙ → Créer mon widget iPhone.");
  t.font = Font.systemFont(11);
  t.textColor = Color.white();
  t.textOpacity = 0.7;
  w.addSpacer(4);
  const d = w.addText(message);
  d.font = Font.systemFont(9);
  d.textColor = Color.white();
  d.textOpacity = 0.4;
  return w;
}

// ---------- Lancement ----------
let widget;
try {
  widget = await construire(await lireEtat());
} catch (e) {
  widget = widgetErreur(String(e && e.message ? e.message : e));
}
if (config.runsInWidget) Script.setWidget(widget);
else await widget.presentMedium();
Script.complete();
