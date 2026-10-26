# WikiMasters · Cotes

Application de cotes WikiMasters, disponible sur GitHub Pages et en application de bureau.

## Accès aux enchères

La recherche dans le catalogue public fonctionne depuis GitHub Pages. L’API des enchères refuse les requêtes anonymes, et la politique inter-site de WikiMasters ne permet pas à GitHub Pages d’utiliser la session du site. La version Pages affiche donc le catalogue, mais ne peut pas charger la courbe.

## Application de bureau avec historique

La version Electron ouvre une fenêtre de connexion WikiMasters isolée et interroge l’historique avec la session locale. La session reste sur l’ordinateur et n’est pas envoyée à GitHub Pages.

```bash
npm install
npm run desktop
```

Dans l’application, clique sur **Connecter WikiMasters**, connecte-toi sur la page officielle, puis reviens à l’application. La courbe se charge depuis la session de cette application. Le bouton en haut permet de revérifier l’état de connexion.

Cette version lit les ventes terminées des 90 derniers jours, comme la courbe d’origine. Elle ne demande ni ne stocke le mot de passe dans l’application.

## Lancer le site localement

```bash
npm run build
npm start
```

Ouvre ensuite <http://localhost:4173>. La compilation récupère la clé publique du catalogue ; le fichier généré est ignoré par Git.

## GitHub Pages

Le workflow `.github/workflows/pages.yml` publie le site à chaque push sur `main`. La source de déploiement du dépôt doit être réglée sur **Settings → Pages → GitHub Actions**.

L’application est communautaire et non officielle. Les anciennes sources de l’extension Chrome restent dans `legacy-extension/`.
