// Surveillance externe de chateausaintlouis.fr
//
// Tourne sur GitHub Actions, donc HORS de l'hébergement : si le serveur
// tombe entièrement, la surveillance interne (netsolution-veille-alertes.php)
// tombe avec lui ; celle-ci, non.
//
// Contrôles : pages clés (statut, contenu attendu, délai), API de la
// boutique (fait travailler PHP et la base, hors cache), certificat HTTPS,
// expiration du nom de domaine (RDAP de l'AFNIC).
//
// État d'une panne = un ticket GitHub ouvert, étiqueté « panne » : un seul
// e-mail à l'ouverture, un rappel toutes les 6 h, un e-mail au rétablissement.
// Un échec n'est retenu qu'après une seconde tentative, une minute plus tard.

import tls from 'node:tls';
import { gh, envoyer, heure } from './commun.mjs';

const SITE = 'https://chateausaintlouis.fr';
const DELAI_MAX_MS = 20000;
const RAPPEL_H = 6;

const PAGES = [
  { nom: 'Accueil', chemin: '/', attendu: 'Château Saint Louis' },
  { nom: 'Boutique', chemin: '/boutique/', attendu: 'Château Saint Louis' },
  { nom: 'Fiche produit', chemin: '/vin-fronton/chardonnay-bio-vin-blanc-sec/', attendu: 'Chardonnay' },
  { nom: 'Mariages', chemin: '/location-salle-mariage-toulouse/', attendu: 'Château Saint Louis' },
  // Hors cache (paramètre unique) : PHP, WooCommerce et la base répondent.
  { nom: 'API boutique (PHP + base)', chemin: '/wp-json/wc/store/v1/products?per_page=1&veille=' + Date.now(), attendu: '"prices"' },
];

const ENTETES = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36 veille-externe',
  'Accept': 'text/html,application/json;q=0.9,*/*;q=0.8',
  'Accept-Language': 'fr-FR,fr;q=0.9',
};

const attendre = (ms) => new Promise((r) => setTimeout(r, ms));

async function controlerPage(p) {
  const debut = Date.now();
  try {
    const r = await fetch(SITE + p.chemin, { headers: ENTETES, redirect: 'follow', signal: AbortSignal.timeout(DELAI_MAX_MS) });
    const corps = await r.text();
    const ms = Date.now() - debut;
    if (r.status !== 200) return { ok: false, detail: `HTTP ${r.status} en ${ms} ms` };
    if (!corps.includes(p.attendu)) return { ok: false, detail: `page sans « ${p.attendu} » (HTTP 200, ${corps.length} octets)` };
    return { ok: true, detail: `${ms} ms` };
  } catch (e) {
    return { ok: false, detail: e.name === 'TimeoutError' ? `aucune réponse en ${DELAI_MAX_MS / 1000} s` : `erreur réseau : ${e.message}` };
  }
}

function joursCertificat() {
  return new Promise((resolve) => {
    const s = tls.connect({ host: 'chateausaintlouis.fr', port: 443, servername: 'chateausaintlouis.fr', timeout: 15000 }, () => {
      const c = s.getPeerCertificate();
      s.end();
      resolve(c && c.valid_to ? Math.floor((new Date(c.valid_to) - Date.now()) / 864e5) : null);
    });
    s.on('error', () => resolve(null));
    s.on('timeout', () => { s.destroy(); resolve(null); });
  });
}

async function joursDomaine() {
  try {
    const r = await fetch('https://rdap.nic.fr/domain/chateausaintlouis.fr', { signal: AbortSignal.timeout(15000) });
    const j = await r.json();
    const e = (j.events || []).find((x) => x.eventAction === 'expiration');
    return e ? Math.floor((new Date(e.eventDate) - Date.now()) / 864e5) : null;
  } catch { return null; }
}

async function main() {
  // 1. Pages, avec une seconde chance une minute plus tard.
  let resultats = await Promise.all(PAGES.map(async (p) => ({ p, ...(await controlerPage(p)) })));
  if (resultats.some((r) => !r.ok)) {
    console.log('échec au premier passage, nouvelle tentative dans 60 s');
    await attendre(60000);
    resultats = await Promise.all(resultats.map(async (r) => (r.ok ? r : { p: r.p, ...(await controlerPage(r.p)) })));
  }
  for (const r of resultats) console.log(`${r.ok ? 'OK  ' : 'ECHEC'} ${r.p.nom} : ${r.detail}`);
  const pannes = resultats.filter((r) => !r.ok);

  // 2. Certificat et domaine (avertissements, pas des pannes).
  const cert = await joursCertificat();
  const dom = await joursDomaine();
  console.log(`certificat HTTPS : ${cert ?? '?'} jours ; nom de domaine : ${dom ?? '?'} jours`);
  const avertissements = [];
  if (cert !== null && cert < 14) avertissements.push(`Le certificat HTTPS expire dans ${cert} jours.`);
  if (dom !== null && dom < 30) avertissements.push(`Le nom de domaine chateausaintlouis.fr expire dans ${dom} jours (registre AFNIC).`);

  // 3. Ticket de panne : ouverture, rappel, fermeture.
  const ouverts = await gh('/issues?state=open&labels=panne&per_page=1');
  const ticket = ouverts[0];
  const liste = pannes.map((r) => `- ${r.p.nom} (${SITE}${r.p.chemin.split('&veille=')[0]}) : ${r.detail}`).join('\n');

  if (pannes.length && !ticket) {
    const corps = `Constaté le ${heure()} depuis l'extérieur (GitHub Actions), après deux tentatives à une minute d'intervalle :\n\n${liste}`;
    await gh('/issues', { method: 'POST', body: JSON.stringify({ title: `Panne : ${pannes.map((r) => r.p.nom).join(', ')}`, body: corps, labels: ['panne'] }) });
    await envoyer('ALERTE chateausaintlouis.fr : site en panne', `${corps}\n\nUn rappel partira toutes les ${RAPPEL_H} h tant que la panne dure, puis un message au rétablissement.\n\nVérifier vous-même : ${SITE}/`);
  } else if (pannes.length && ticket) {
    const depuis = (Date.now() - new Date(ticket.updated_at)) / 36e5;
    if (depuis >= RAPPEL_H) {
      await gh(`/issues/${ticket.number}/comments`, { method: 'POST', body: JSON.stringify({ body: `Toujours en panne le ${heure()} :\n\n${liste}` }) });
      await envoyer('RAPPEL chateausaintlouis.fr : toujours en panne', `Toujours en panne le ${heure()} (panne ouverte le ${new Date(ticket.created_at).toLocaleString('fr-FR', { timeZone: 'Europe/Paris' })}) :\n\n${liste}`);
    }
  } else if (!pannes.length && ticket) {
    const duree = Math.round((Date.now() - new Date(ticket.created_at)) / 6e4);
    await gh(`/issues/${ticket.number}/comments`, { method: 'POST', body: JSON.stringify({ body: `Rétabli le ${heure()}, après environ ${duree} min.` }) });
    await gh(`/issues/${ticket.number}`, { method: 'PATCH', body: JSON.stringify({ state: 'closed' }) });
    await envoyer('RETABLI chateausaintlouis.fr : le site répond de nouveau', `Le site répond de nouveau normalement (${heure()}), après environ ${duree} min de panne.\n\n${resultats.map((r) => `- ${r.p.nom} : ${r.detail}`).join('\n')}`);
  }

  // 4. Avertissements : au plus un e-mail par semaine.
  if (avertissements.length) {
    const av = await gh('/issues?state=open&labels=avertissement&per_page=1');
    if (!av[0] || (Date.now() - new Date(av[0].updated_at)) / 864e5 >= 7) {
      if (av[0]) await gh(`/issues/${av[0].number}/comments`, { method: 'POST', body: JSON.stringify({ body: avertissements.join('\n') }) });
      else await gh('/issues', { method: 'POST', body: JSON.stringify({ title: 'Échéance proche', body: avertissements.join('\n'), labels: ['avertissement'] }) });
      await envoyer('AVERTISSEMENT chateausaintlouis.fr : échéance proche', avertissements.join('\n') + '\n\nÀ renouveler avant la date pour éviter une coupure du site.');
    }
  }

  // 5. Bilan du lundi matin (planification dédiée, BILAN=1) : la preuve que
  //    la surveillance externe tourne toujours.
  if (process.env.BILAN === '1') {
    const fermes = await gh('/issues?state=closed&labels=panne&per_page=20&since=' + new Date(Date.now() - 7 * 864e5).toISOString());
    await envoyer('Veille externe chateausaintlouis.fr : bilan de la semaine',
      `La surveillance externe fonctionne (contrôle toutes les 5 minutes depuis GitHub).\n\n` +
      `Pannes ces 7 derniers jours : ${fermes.length}${fermes.length ? '\n' + fermes.map((t) => `- ${t.title} (${new Date(t.created_at).toLocaleString('fr-FR', { timeZone: 'Europe/Paris' })})`).join('\n') : ''}\n` +
      `Panne en cours : ${pannes.length ? 'OUI' : 'non'}\n` +
      `Certificat HTTPS : ${cert ?? '?'} jours restants\nNom de domaine : ${dom ?? '?'} jours restants\n\n` +
      `Si ce bilan n'arrive pas un lundi, c'est que la surveillance externe s'est arrêtée.`);
  }

  // Une panne du SITE ne fait pas échouer le passage : GitHub enverrait sinon
  // son propre e-mail toutes les 5 minutes. Seul un plantage du script échoue.
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
