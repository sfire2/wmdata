# WikiMasters · Cotes

Application web statique pour rechercher une carte WikiMasters et consulter les ventes conclues ainsi que leur évolution hebdomadaire sur les 90 derniers jours.

## Utiliser l'application

Le site publié est utilisable depuis un navigateur récent. Il n'y a rien à installer et aucune connexion WikiMasters n'est requise : l'application lit le catalogue public et les ventes publiques.

Pour lancer le site en local, avec Python installé :

```bash
npm run build
npm start
```

Ouvrez ensuite <http://localhost:4173>. La compilation récupère la configuration publique du catalogue ; le fichier généré n'est pas commité.

## Déploiement GitHub Pages

Le workflow `.github/workflows/pages.yml` prépare automatiquement le site à chaque push sur `main`, puis le publie sur GitHub Pages. À faire une seule fois dans le dépôt : ouvrez **Settings → Pages**, choisissez **GitHub Actions** comme source de déploiement, puis relancez le workflow depuis l'onglet **Actions**. GitHub doit avoir Pages activé pour le dépôt avant que `deploy-pages` puisse publier.

Le workflow récupère la clé publique du catalogue depuis les scripts publiquement servis par WikiMasters. Cette clé est conçue pour être utilisée dans les clients publics ; aucun mot de passe ni jeton de session n'est intégré au site.

Les pages et données appartiennent à WikiMasters. L'application est communautaire et non officielle. Les routes publiques peuvent évoluer ou refuser les requêtes depuis GitHub Pages ; dans ce cas, l'interface signale l'erreur retournée par le catalogue.

Les anciens fichiers de l'extension Chrome restent dans `legacy-extension/`. Le lanceur Electron précédent est archivé dans `legacy-desktop/` et n'est plus utilisé par le site statique.
