// Parcours d'achat complet dans un vrai navigateur (téléphone), comme un client.
//
// Exigence du domaine (1er octobre 2026) : « je veux que la prise de commande
// fonctionne du début à la fin ». La surveillance interne du site simule la
// commande côté serveur ; elle ne voit pas un bouton inerte, une fenêtre de
// points relais cassée, un formulaire de carte qui ne s'affiche pas. Ce robot,
// si.
//
// MODES (E2E_MODE)
//   parcours : fiche -> panier -> commande -> vrai point relais -> moyens de
//              paiement (le champ de carte Stripe doit se charger) -> CGV ->
//              bouton « Commander » actif. On s'arrête là. Chaque matin.
//   commande : idem, puis VRAIE commande par virement, page de confirmation,
//              et annulation par le site (netsolution-commande-robot.php), qui
//              confirme point relais et e-mails envoyés. Chaque lundi.
//
// Les balises Google sont bloquées : pas de fausse vente dans Google Ads.
// Un échec n'est retenu qu'après une seconde tentative complète (3 min plus tard).

import { chromium, devices } from 'playwright';
import { mkdirSync } from 'node:fs';
import { gh, envoyer, heure } from './commun.mjs';

const SITE = 'https://chateausaintlouis.fr';
const MODE = process.env.E2E_MODE === 'commande' ? 'commande' : 'parcours';
const FICHE = '/vin-fronton/chardonnay-bio-vin-blanc-sec/';
const CAPTURES = 'captures';
mkdirSync(CAPTURES, { recursive: true });

async function parcourir(essai) {
  const journal = [];
  const t0 = Date.now();
  const note = (m) => { const l = `[${((Date.now() - t0) / 1000).toFixed(1)} s] ${m}`; journal.push(l); console.log(l); };
  const b = await chromium.launch();
  const c = await b.newContext({ ...devices['Pixel 7'], locale: 'fr-FR' });
  await c.route(/googletagmanager|google-analytics|googleadservices|doubleclick/, (r) => r.abort());
  const p = await c.newPage();
  const erreursJs = [];
  p.on('pageerror', (e) => erreursJs.push(e.message.slice(0, 150)));
  p.on('dialog', (d) => d.accept()); // confirmation du point relais
  let etape = 'démarrage';
  const resultat = { ok: false, etape, journal, erreursJs };
  try {
    etape = 'fiche produit';
    const r = await p.goto(SITE + FICHE, { waitUntil: 'load', timeout: 60000 });
    if (r.status() !== 200) throw new Error(`HTTP ${r.status()}`);
    await p.evaluate(() => { const a = document.getElementById('nis-age-oui'); if (a) a.click(); });
    const bouton = p.locator('.single_add_to_cart_button');
    await bouton.waitFor({ timeout: 20000 });
    await bouton.click();
    await p.waitForLoadState('load');
    note('produit ajouté depuis la fiche');

    etape = 'panier';
    await p.goto(SITE + '/panier/', { waitUntil: 'load', timeout: 60000 });
    await p.waitForSelector('.wc-block-cart__submit-button', { timeout: 45000 });
    const lignes = await p.locator('.wc-block-cart-items__row').count();
    if (!lignes) throw new Error('panier vide après l\'ajout');
    note(`panier : ${lignes} ligne(s)`);

    etape = 'page de commande';
    await p.click('.wc-block-cart__submit-button');
    await p.waitForURL(/checkout/, { timeout: 45000 });
    await p.waitForSelector('#email', { timeout: 45000 });
    await p.waitForTimeout(2500);
    note('page de commande affichée');

    etape = 'coordonnées';
    await p.fill('#email', 'fcastellani31+testcommande@gmail.com');
    await p.fill('#shipping-first_name', 'TEST');
    await p.fill('#shipping-last_name', 'Veille ne pas expedier');
    await p.fill('#shipping-address_1', '380 chemin du Bois Vieux');
    await p.fill('#shipping-postcode', '82370');
    await p.fill('#shipping-city', 'Labastide-Saint-Pierre');
    await p.fill('#shipping-phone', '0650938825');
    await p.waitForTimeout(3500);

    etape = 'livraison en point relais';
    // Les options de livraison se recalculent après la saisie de l'adresse :
    // jusqu'à 30 s sur les serveurs de GitHub (faux échec du 1er octobre).
    const relaisRadio = p.locator('input[value^="mondial_relay_point_relais"]');
    try {
      await relaisRadio.first().waitFor({ state: 'attached', timeout: 30000 });
    } catch {
      throw new Error('Mondial Relay point relais n\'est pas proposé (30 s d\'attente)');
    }
    await relaisRadio.first().check();
    await p.waitForTimeout(3000);
    await p.click('.wms_pickup_selection_button');
    await p.waitForSelector('.wms_pickup_modal_listing_one_button_ship', { timeout: 40000 });
    const nbRelais = await p.locator('.wms_pickup_modal_listing_one').count();
    const relais = (await p.locator('.wms_pickup_modal_listing_one').first().innerText()).split('\n').slice(0, 2).join(', ');
    await p.locator('.wms_pickup_modal_listing_one_button_ship').first().click();
    await p.waitForTimeout(4000);
    note(`${nbRelais} points relais proposés, choisi : ${relais}`);

    etape = 'paiement par carte (Stripe)';
    const moyens = await p.$$eval('input[name="radio-control-wc-payment-method-options"]', (l) => l.map((i) => i.value));
    note('moyens de paiement : ' + moyens.join(', '));
    if (!moyens.includes('stripe_cc')) throw new Error('le paiement par carte (stripe_cc) n\'est pas proposé');
    await p.check('input[value="stripe_cc"]');
    await p.waitForSelector('iframe[src*="js.stripe.com"]', { state: 'attached', timeout: 30000 });
    note('formulaire de carte Stripe chargé');

    etape = 'virement et CGV';
    if (!moyens.includes('bacs')) throw new Error('le virement n\'est pas proposé');
    await p.check('input[value="bacs"]');
    await p.waitForTimeout(1500);
    const cgv = p.locator('#terms-and-conditions');
    if (await cgv.count()) await cgv.check();
    const commander = p.locator('.wc-block-components-checkout-place-order-button');
    if (await commander.isDisabled()) throw new Error('le bouton « Commander » est désactivé');
    const total = await p.locator('.wc-block-components-totals-footer-item .wc-block-components-totals-item__value').first().innerText();
    note(`bouton « Commander » actif, total ${total}`);

    if (MODE === 'commande') {
      etape = 'validation de la commande';
      await commander.click();
      await p.waitForURL(/order-received\/(\d+)/, { timeout: 90000 });
      const u = new URL(p.url());
      const id = Number(u.pathname.match(/order-received\/(\d+)/)[1]);
      const cle = u.searchParams.get('key');
      const texte = await p.locator('main').innerText();
      if (!texte.includes(String(id))) throw new Error('page de confirmation sans le numéro de commande');
      note(`commande n°${id} enregistrée, page de confirmation affichée`);

      etape = 'contrôle et annulation par le site';
      const rep = await fetch(SITE + '/wp-json/nis/v1/robot-annuler', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Nis-Robot': process.env.ROBOT_SECRET || '' },
        body: JSON.stringify({ commande: id, cle }),
      });
      const j = await rep.json().catch(() => ({}));
      if (!rep.ok || !j.ok) throw new Error(`annulation refusée : HTTP ${rep.status} ${j.raison || ''} (commande n°${id} à annuler à la main)`);
      const relaisCmd = j.relais && j.relais.pickup_name;
      const mails = (j.notes || []).filter((n) => /e-mail/i.test(n));
      note(`site : statut ${j.statut}, point relais enregistré ${relaisCmd || 'AUCUN'}, ${mails.length} e-mail(s) envoyé(s)`);
      if (!relaisCmd) throw new Error(`commande n°${id} : point relais non enregistré`);
      if (!mails.some((n) => /Nouvelle commande/i.test(n))) throw new Error(`commande n°${id} : e-mail « Nouvelle commande » non envoyé`);
    }
    if (erreursJs.length) note('erreurs JavaScript (non bloquantes) : ' + erreursJs.join(' | '));
    resultat.ok = true;
  } catch (e) {
    resultat.erreur = `${etape} : ${e.message.split('\n')[0]}`;
    note('ÉCHEC ' + resultat.erreur);
    await p.screenshot({ path: `${CAPTURES}/echec-essai${essai}.png`, fullPage: true }).catch(() => {});
  } finally {
    resultat.etape = etape;
    await b.close();
  }
  return resultat;
}

async function main() {
  console.log(`mode ${MODE}`);
  let r = await parcourir(1);
  if (!r.ok) {
    console.log('nouvelle tentative complète dans 3 minutes');
    await new Promise((s) => setTimeout(s, 180000));
    r = await parcourir(2);
  }
  const ouverts = await gh('/issues?state=open&labels=commande&per_page=1');
  const ticket = ouverts[0];
  const detail = r.journal.join('\n');
  if (!r.ok && !ticket) {
    const corps = `Le parcours d'achat a échoué le ${heure()}, deux fois de suite, dans un vrai navigateur (téléphone).\n\nÉtape en échec : ${r.erreur}\n\nDéroulé :\n${detail}`;
    await gh('/issues', { method: 'POST', body: JSON.stringify({ title: `Commande impossible : ${r.etape}`, body: corps, labels: ['commande'] }) });
    await envoyer('ALERTE chateausaintlouis.fr : la prise de commande est en panne', `${corps}\n\nCaptures d'écran : https://github.com/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`);
  } else if (!r.ok && ticket) {
    await gh(`/issues/${ticket.number}/comments`, { method: 'POST', body: JSON.stringify({ body: `Toujours en échec le ${heure()} : ${r.erreur}` }) });
    await envoyer('RAPPEL chateausaintlouis.fr : la prise de commande est toujours en panne', `Toujours en échec le ${heure()} : ${r.erreur}\n\n${detail}`);
  } else if (r.ok && ticket) {
    await gh(`/issues/${ticket.number}/comments`, { method: 'POST', body: JSON.stringify({ body: `Parcours de nouveau complet le ${heure()}.\n\n${detail}` }) });
    await gh(`/issues/${ticket.number}`, { method: 'PATCH', body: JSON.stringify({ state: 'closed' }) });
    await envoyer('RETABLI chateausaintlouis.fr : la prise de commande fonctionne de nouveau', `Parcours complet réussi le ${heure()} :\n\n${detail}`);
  }
  if (!r.ok) process.exitCode = 1; // une fois par jour au plus : l'échec est visible dans GitHub
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
