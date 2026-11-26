/*
 * Platine — widget.js
 * - Démarrage et arrêt progressifs du vinyle (comme une vraie platine)
 * - Défilement des titres trop longs
 */

/* --- Vinyle : la vitesse monte et descend en douceur ---------------------- */
(() => {
  const disque = document.querySelector('.disque');
  if (!disque || !disque.getAnimations) return;
  document.documentElement.classList.add('vitesse-js');

  const ACCELERATION = 1.8;   // tours de vitesse gagnés par seconde (démarrage)
  const FREINAGE = 1.1;       // perdus par seconde (arrêt)
  let vitesse = 0;
  let cible = 0;
  let precedent = 0;
  let boucle = 0;

  const animation = () => disque.getAnimations().find((a) => a.animationName === 'tourne');

  function etape(maintenant) {
    const a = animation();
    if (!a) { boucle = 0; return; }
    const dt = Math.min(0.05, (maintenant - precedent) / 1000);
    precedent = maintenant;
    vitesse = cible > vitesse
      ? Math.min(cible, vitesse + ACCELERATION * dt)
      : Math.max(cible, vitesse - FREINAGE * dt);
    a.playbackRate = vitesse;
    boucle = vitesse === cible ? 0 : requestAnimationFrame(etape);
  }

  function viser(enLecture, immediat) {
    cible = enLecture ? 1 : 0;
    if (immediat) {
      vitesse = cible;
      const a = animation();
      if (a) a.playbackRate = vitesse;
      return;
    }
    if (!boucle) {
      precedent = performance.now();
      boucle = requestAnimationFrame(etape);
    }
  }

  Platine.on('ready', (s) => viser(s.playing, true));
  Platine.on('change', (s) => viser(s.playing, false));
})();

/* --- Titre trop long : il défile ------------------------------------------ */
(() => {
  const titre = document.querySelector('.titre');
  const texte = titre && titre.querySelector('span');
  if (!texte) return;

  function mesurer() {
    titre.classList.remove('defile');
    const depassement = texte.scrollWidth - titre.clientWidth;
    if (depassement > 4) {
      titre.style.setProperty('--decalage', `${-(depassement + 14)}px`);
      titre.style.setProperty('--duree', `${Math.max(6, depassement / 20 + 4)}s`);
      titre.classList.add('defile');
    }
  }

  Platine.on('ready', () => requestAnimationFrame(mesurer));
  Platine.on('track', () => requestAnimationFrame(mesurer));
  window.addEventListener('resize', () => requestAnimationFrame(mesurer));
  if (document.fonts) document.fonts.ready.then(mesurer);
})();
