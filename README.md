# WikiMasters · Cotes

Application web statique pour rechercher des cartes et consulter leurs cotes et leur historique d'enchères.

## État des accès

La recherche dans le catalogue public fonctionne depuis GitHub Pages. Les enchères exigent un jeton de session WikiMasters. Le navigateur ne peut pas lire la session ouverte sur `www.wiki-masters.com` depuis `sfire2.github.io` : les deux sites sont sur des origines différentes et l'API des ventes ne renvoie pas les en-têtes CORS requis pour partager cette session.

Pour activer la vérification automatique, le propriétaire de WikiMasters doit exposer un endpoint inter-site qui vérifie la session et fournit les ventes. Il doit autoriser explicitement `https://sfire2.github.io` avec les requêtes authentifiées (`Access-Control-Allow-Origin` précis et `Access-Control-Allow-Credentials: true`). Ce réglage ne peut pas être fait depuis ce dépôt GitHub Pages.

## Lancer en local

Avec Python installé :

```bash
npm run build
npm start
```

Ouvre ensuite <http://localhost:4173>. La compilation récupère la clé publique du catalogue ; le fichier généré est ignoré par Git.

## GitHub Pages

Le workflow `.github/workflows/pages.yml` publie le site à chaque push sur `main`. La source de déploiement du dépôt doit être réglée sur **Settings → Pages → GitHub Actions**.

L'application est communautaire et non officielle. Les anciennes sources de l'extension Chrome restent dans `legacy-extension/` et le lanceur Electron précédent dans `legacy-desktop/`.
