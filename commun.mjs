// Code commun aux deux robots (veille.mjs, e2e.mjs) : API GitHub, e-mails.
import nodemailer from 'nodemailer';

const DESTINATAIRE = process.env.ALERTE_A || 'fcastellani31@gmail.com';
const DEPOT = process.env.GITHUB_REPOSITORY;
const JETON = process.env.GITHUB_TOKEN;

export async function gh(chemin, options = {}) {
  const r = await fetch(`https://api.github.com/repos/${DEPOT}${chemin}`, {
    ...options,
    headers: { Authorization: `Bearer ${JETON}`, Accept: 'application/vnd.github+json', 'Content-Type': 'application/json' },
  });
  if (!r.ok) throw new Error(`GitHub ${chemin} : HTTP ${r.status}`);
  return r.status === 204 ? null : r.json();
}

// Deux canaux, dans cet ordre :
//  1. Gmail (GMAIL_USER, GMAIL_APP_PASSWORD) : indépendant de l'hébergement,
//     le seul qui part quand le serveur du site est entièrement à l'arrêt ;
//  2. le serveur d'envoi du site (SITE_SMTP_*) : même machine que le site
//     (185.22.110.69), donc muet en panne totale, mais suffisant pour une
//     panne partielle et pour le rétablissement.
export async function envoyer(sujet, texte) {
  const canaux = [];
  if (process.env.GMAIL_USER && process.env.GMAIL_APP_PASSWORD) {
    canaux.push({ nom: 'Gmail', de: process.env.GMAIL_USER, t: { host: 'smtp.gmail.com', port: 465, secure: true, auth: { user: process.env.GMAIL_USER, pass: process.env.GMAIL_APP_PASSWORD } } });
  }
  if (process.env.SITE_SMTP_HOST && process.env.SITE_SMTP_USER && process.env.SITE_SMTP_PASS) {
    const port = Number(process.env.SITE_SMTP_PORT || 587);
    canaux.push({ nom: 'serveur du site', de: process.env.SITE_SMTP_USER, t: { host: process.env.SITE_SMTP_HOST, port, secure: port === 465, requireTLS: port !== 465, auth: { user: process.env.SITE_SMTP_USER, pass: process.env.SITE_SMTP_PASS }, connectionTimeout: 20000 } });
  }
  if (!canaux.length) {
    console.log("::warning::aucun canal d'envoi configuré : e-mail NON envoyé :", sujet);
    return false;
  }
  for (const c of canaux) {
    try {
      await nodemailer.createTransport(c.t).sendMail({ from: `Veille externe Saint Louis <${c.de}>`, to: DESTINATAIRE, subject: sujet, text: texte });
      console.log(`e-mail envoyé par ${c.nom} :`, sujet);
      return true;
    } catch (e) {
      console.log(`::warning::envoi par ${c.nom} impossible (${e.code || ''} ${e.message}), canal suivant`);
    }
  }
  console.log("::error::aucun canal n'a pu envoyer :", sujet);
  return false;
}

export const heure = () => new Date().toLocaleString('fr-FR', { timeZone: 'Europe/Paris' });

