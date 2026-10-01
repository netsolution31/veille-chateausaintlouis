# Veille externe de chateausaintlouis.fr

Contrôle le site toutes les 5 minutes depuis GitHub Actions, donc hors de
l'hébergement : pages principales, API de la boutique (PHP et base de données),
certificat HTTPS et expiration du nom de domaine.

- Panne confirmée (deux échecs à une minute d'intervalle) : ticket « panne »
  ouvert et e-mail d'alerte ; rappel toutes les 6 heures ; e-mail au rétablissement.
- Certificat ou domaine proche de l'échéance : e-mail d'avertissement, au plus
  un par semaine.
- Lundi matin : bilan de la semaine. S'il n'arrive pas, la veille s'est arrêtée.

Secrets requis : `GMAIL_USER` et `GMAIL_APP_PASSWORD` (mot de passe
d'application Google). Aucun identifiant du site n'est stocké ici.

Complète la surveillance interne du site (sonde horaire, alertes de commande).
