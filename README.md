# WikiMasters · Cotes

Application de cotes WikiMasters, disponible sur GitHub Pages et en application de bureau.

## Accès aux enchères

La recherche dans le catalogue public fonctionne depuis GitHub Pages. L’API des enchères refuse les requêtes anonymes, et la politique inter-site de WikiMasters ne permet pas à GitHub Pages d’utiliser la session du site. La version Pages affiche donc le catalogue, mais ne peut pas charger la courbe.

## GitHub Pages avec historique

Un petit compagnon Electron peut fournir les courbes au site GitHub Pages. Il tourne sur `127.0.0.1`, ouvre sa propre fenêtre de connexion WikiMasters, et garde la session sur l’ordinateur. Le site ne lui envoie que l’identifiant de la carte et sa rareté ; le compagnon renvoie les ventes correspondantes.

```bash
npm install
npm run companion
```

Laisse cette commande ouverte, ouvre le site Pages et autorise son accès au réseau local si le navigateur le demande. Clique sur le bouton de connexion en haut de page, connecte-toi à WikiMasters dans la fenêtre qui s’ouvre, puis reviens au site. La courbe se charge depuis le compagnon. Fermer le compagnon coupe cet accès.

Le compagnon n’accepte que l’origine GitHub Pages de ce projet et les origines localhost pour le développement. Il ne demande ni ne stocke le mot de passe dans l’application.

## Application de bureau autonome

Pour lancer la même interface dans une fenêtre dédiée, avec son compagnon intégré :

```bash
npm install
npm run desktop
```

Clique sur **Connecter WikiMasters** et connecte-toi dans la fenêtre officielle. Cette version lit les ventes terminées des 90 derniers jours, comme la courbe d’origine.

## Lancer le site localement

```bash
npm run build
npm start
```

Ouvre ensuite <http://localhost:4173>. La compilation récupère la clé publique du catalogue ; le fichier généré est ignoré par Git.

## GitHub Pages

Le workflow `.github/workflows/pages.yml` publie le site à chaque push sur `main`. La source de déploiement du dépôt doit être réglée sur **Settings → Pages → GitHub Actions**.

L’application est communautaire et non officielle. Les anciennes sources de l’extension Chrome restent dans `legacy-extension/`.
