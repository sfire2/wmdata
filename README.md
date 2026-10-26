# WikiMasters · Cotes

Application web statique pour rechercher une carte WikiMasters et consulter les ventes conclues ainsi que leur évolution hebdomadaire sur les 90 derniers jours.

## Utiliser l'application

Le site publié est utilisable depuis un navigateur récent. Il n'y a rien à installer. Le catalogue des cartes est public ; un compte WikiMasters est requis pour consulter les enchères, que l'API réserve aux utilisateurs connectés.

Cliquez sur **Se connecter** et utilisez votre adresse courriel et votre mot de passe WikiMasters. Le navigateur envoie ces identifiants directement au service d'authentification Supabase utilisé par WikiMasters ; ils ne sont ni envoyés à GitHub Pages ni enregistrés par l'application. Le jeton de renouvellement de session est conservé localement dans le navigateur afin d'éviter de se reconnecter à chaque visite. **Se déconnecter** révoque la session et efface ce jeton local.

Pour lancer le site en local, avec Python installé :

```bash
npm run build
npm start
```

Ouvrez ensuite <http://localhost:4173>. La compilation récupère la configuration publique du catalogue ; le fichier généré n'est pas commité.

## Déploiement GitHub Pages

Le workflow `.github/workflows/pages.yml` prépare automatiquement le site à chaque push sur `main`, puis le publie sur GitHub Pages. À faire une seule fois dans le dépôt : ouvrez **Settings → Pages**, choisissez **GitHub Actions** comme source de déploiement, puis relancez le workflow depuis l'onglet **Actions**. GitHub doit avoir Pages activé pour le dépôt avant que `deploy-pages` puisse publier.

Le workflow récupère la clé publique du catalogue et la clé publique Turnstile depuis les scripts publiquement servis par WikiMasters. Cette configuration est destinée aux clients publics ; aucun mot de passe ni jeton de session n'est intégré au site.

Les pages et données appartiennent à WikiMasters. L'application est communautaire et non officielle. Ses appels utilisent l'API publique de WikiMasters et un jeton de session pour les enchères ; ces routes peuvent évoluer. En cas d'erreur, l'interface l'indique.

Les anciens fichiers de l'extension Chrome restent dans `legacy-extension/`. Le lanceur Electron précédent est archivé dans `legacy-desktop/` et n'est plus utilisé par le site statique.
