# Grid Recipe

Grid Recipe transforme un arbre de préparation en tableau de recette au format
Michael Chu. Le moteur Python produit du Typst, puis Typst génère une image PNG
à hauteur automatique.

Le dépôt contient :

- une interface web en français avec éditeur de graphe et JSON synchronisé ;
- une API HTTP de rendu ;
- un CLI Python autonome ;
- une image Docker avec Typst et la police Alegreya.

## Démarrer l’application web

Docker Compose installe toutes les dépendances dans l’image. Aucun fichier de
police ni compilateur Typst n’est requis sur l’hôte.

```sh
docker compose up --build -d
```

Ouvrir <http://localhost:8000>, puis vérifier le moteur :

```sh
curl --fail http://localhost:8000/api/health
```

La réponse saine contient `"status":"ok"`, la version de Typst et
`"alegreya":true`.

L’application ne sauvegarde aucune recette sur le serveur. L’import et le
téléchargement JSON permettent de conserver le travail. Les sources Typst et
les PNG intermédiaires sont créés dans `/tmp`, renvoyés au navigateur, puis
supprimés.

### Utiliser l’éditeur de graphe

Les ingrédients se placent à gauche et alimentent les étapes à droite. Chaque
nœud possède une sortie ronde ; les étapes ont aussi une entrée. Tirer un câble
jusqu’à une entrée relie les deux nœuds. Tirer un câble puis le relâcher dans le
vide ouvre un menu qui crée directement un ingrédient ou une étape raccordée.

Un ingrédient ou une étape intermédiaire ne peut alimenter qu’une seule étape.
Raccorder sa sortie ailleurs déplace donc sa connexion. La position verticale
des entrées fixe leur ordre dans le JSON et dans la grille. Le bouton
`Réorganiser` restaure une disposition automatique de gauche à droite.

Le graphe peut rester incomplet pendant l’édition. Dans ce cas, le panneau JSON
conserve la dernière version valide et le bouton de rendu est désactivé jusqu’à
ce que tous les nœuds rejoignent une unique étape finale.

### Installation de Typst et Alegreya dans l’image

Le `Dockerfile` télécharge les deux composants avec `curl` depuis leurs sources
officielles. Les versions sont épinglées dans `docker-compose.yml`.

Le principe d’installation de Typst pour Linux `amd64` est :

```sh
TYPST_VERSION=0.15.1
TYPST_TARGET=x86_64-unknown-linux-musl

curl --fail --location --retry 3 \
  "https://github.com/typst/typst/releases/download/v${TYPST_VERSION}/typst-${TYPST_TARGET}.tar.xz" \
  --output /tmp/typst.tar.xz
mkdir -p /tmp/typst
tar --extract --xz --file /tmp/typst.tar.xz \
  --directory /tmp/typst --strip-components=1
install /tmp/typst/typst /usr/local/bin/typst
typst --version
```

Pour `arm64`, remplacer la cible par `aarch64-unknown-linux-musl`. Docker la
sélectionne automatiquement à partir de `TARGETARCH`.

Alegreya est installée depuis une révision déterminée de Google Fonts :

```sh
ALEGREYA_REVISION=40478177239cbf3bac07908ef0738afee0f72be7
mkdir -p /usr/local/share/fonts/alegreya

curl --fail --location --retry 3 \
  "https://raw.githubusercontent.com/google/fonts/${ALEGREYA_REVISION}/ofl/alegreya/Alegreya%5Bwght%5D.ttf" \
  --output '/usr/local/share/fonts/alegreya/Alegreya[wght].ttf'
curl --fail --location --retry 3 \
  "https://raw.githubusercontent.com/google/fonts/${ALEGREYA_REVISION}/ofl/alegreya/OFL.txt" \
  --output /usr/local/share/fonts/alegreya/OFL.txt

fc-cache --force
typst fonts | grep --fixed-strings --line-regexp Alegreya
```

Ces commandes sont documentées pour rendre la construction vérifiable. Le
déploiement prévu reste `docker compose up --build`.

### Mise derrière un proxy privé

Le conteneur n’intègre ni authentification ni terminaison TLS. Il doit rester
derrière un proxy privé chargé de ces fonctions. Exemple Nginx minimal :

```nginx
location / {
    proxy_pass http://127.0.0.1:8000;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    client_max_body_size 256k;
}
```

## API

`POST /api/render` reçoit la recette et les options de rendu :

```json
{
  "recipe": {
    "title": "Soupe simple",
    "pre_cooking": ["Sortir une casserole"],
    "flow": {
      "step": "Servir",
      "inputs": [
        {
          "step": "Mijoter 10 minutes",
          "inputs": [
            {"amount": "500 ml", "name": "bouillon"},
            {"amount": "1", "name": "carotte"}
          ]
        }
      ]
    }
  },
  "width_mm": 280,
  "ppi": 144
}
```

La réponse valide est une image `image/png`. Les erreurs sont renvoyées sous la
forme `{"error":"…"}`. La largeur autorisée va de 80 à 500 mm et la résolution
de 72 à 300 PPI.

Les requêtes sont limitées à 256 Kio, 500 nœuds, 40 niveaux et 30 secondes de
compilation.

## Utiliser le CLI

Le CLI nécessite Python 3.10 ou plus récent, `typst` dans le `PATH` et Alegreya
visible dans `typst fonts`.

```sh
python3 grid_recipe.py example_recipe.json
```

Cette commande écrit `example_recipe.typ` et `example_recipe.png`. Les options
de taille restent disponibles :

```sh
python3 grid_recipe.py recipe.json \
  --output build/recipe.png \
  --width-mm 240 \
  --ppi 192
```

## Format JSON

Une recette contient un titre, une liste facultative d’instructions préalables
et une étape racine. Deux types de nœuds sont acceptés :

- un ingrédient avec `name` obligatoire et `amount` facultatif ;
- une étape avec `step` et un tableau `inputs` non vide.

À chaque fusion, la branche la plus profonde est placée en premier. L’ordre JSON
est conservé entre les branches de même profondeur, ce qui produit l’escalier
caractéristique. Une occurrence d’ingrédient ne peut alimenter qu’une branche ;
les portions utilisées séparément doivent être décrites séparément.

## Développement et tests

Créer un environnement Python et installer le serveur :

```sh
python3 -m venv .venv
. .venv/bin/activate
python -m pip install --requirement requirements.txt
python -m unittest -v
```

Typst est requis pour les tests d’intégration. Sans lui, ces tests sont ignorés.
Le frontend utilise React, Vite et React Flow. Pour travailler localement,
lancer l’API et Vite dans deux terminaux :

```sh
# Terminal 1, depuis la racine
python web_app.py

# Terminal 2
cd web
npm install
npm run dev
```

Ouvrir <http://localhost:5173>. Vite transmet automatiquement les requêtes
`/api` au serveur Flask sur le port 8000.

Pour reproduire le service de production sans Docker :

```sh
cd web
npm install
npm run build
cd ..
python web_app.py
```

Ouvrir alors <http://localhost:8000>. Les vérifications du frontend se lancent
avec `npm test` et `npm run build` depuis le dossier `web`.
