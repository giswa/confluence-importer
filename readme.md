# Confluence HTML Importer

Outil Node.js pour importer des fichiers HTML vers Confluence Cloud avec gestion des images, liens et fichiers joints.

## Prérequis

- Node.js (version 14 ou supérieure)
- Dépendances npm : `axios`, `cheerio`, `form-data`, `dotenv`

## Configuration

Créez un fichier `.env` à la racine du projet avec les variables suivantes :

```env
# Configuration Confluence (OBLIGATOIRE)
CONFLUENCE_BASE_URL=https://votre-domaine.atlassian.net
AUTH_EMAIL=votre-email@domaine.com
API_TOKEN=votre-api-token
SPACE_KEY=CLE_DE_VOTRE_ESPACE

# Configuration import (OBLIGATOIRE)
HTML_FOLDER_PATH=./chemin/vers/vos/fichiers/html

# Configuration optionnelle
PARENT_PAGE_ID=123456789  # ID de la page parent (optionnel)
```

### Comment obtenir vos identifiants Confluence :

1. **API Token** : Générez un token depuis [https://id.atlassian.com/manage-profile/security/api-tokens](https://id.atlassian.com/manage-profile/security/api-tokens)
2. **SPACE_KEY** : Visible dans l'URL de votre espace Confluence
3. **PARENT_PAGE_ID** : ID de la page sous laquelle créer les nouvelles pages (optionnel)

## Options d'exécution

### Exécution standard
```bash
node main.js
```

### Options en ligne de commande

#### `--dry-run`
Mode simulation sans modification réelle dans Confluence.
```bash
node main.js --dry-run
```
- Simule toutes les opérations
- Affiche les actions qui seraient effectuées
- Aucune page/fichier n'est créé ou modifié
- Idéal pour tester avant l'import réel

#### `--limit=N`
Limite le nombre de fichiers HTML à traiter.
```bash
node main.js --limit=5
```
- Traite seulement les N premiers fichiers HTML trouvés
- Utile pour les tests ou imports partiels
- Sans cette option, tous les fichiers .html du dossier sont traités

#### `--log=chemin/vers/fichier.csv`
Génère un fichier CSV avec le journal détaillé des opérations.
```bash
node main.js --log=import_log.csv
```
- Crée un fichier CSV avec les colonnes : Page, Action, Détail, URL
- Contient toutes les actions effectuées pendant l'import
- Pratique pour le suivi et l'audit

### Combinaison d'options
```bash
# Test avec 3 fichiers et génération d'un log
node main.js --dry-run --limit=3 --log=test_log.csv

# Import réel limité à 10 fichiers avec log
node main.js --limit=10 --log=production_log.csv
```

## Fonctionnalités du programme

### Traitement automatique
- **Pages** : Création ou mise à jour automatique selon le titre
- **Images** : Upload automatique vers Confluence et mise à jour des liens
- **Fichiers joints** : Upload des fichiers (.pdf, .docx, .xlsx, .zip, .pptx, .txt, .csv)
- **Liens internes** : Conversion automatique vers les liens Confluence
- **Nettoyage HTML** : Suppression des styles, classes et métadonnées

### Gestion des erreurs
- Retry automatique avec backoff exponentiel
- Gestion du rate limiting Confluence
- Logs détaillés pour le débogage
- Validation des variables d'environnement

### Rapports générés
Le programme génère automatiquement dans Confluence :
1. **Rapport d'import** : Détail de toutes les opérations effectuées
2. **Index des pages** : Liste des pages créées avec liens directs

## Structure attendue des fichiers

```
HTML_FOLDER_PATH/
├── index.html          # OBLIGATOIRE - Page d'accueil principale
├── page1.html
├── page2.html
├── images/
│   ├── image1.jpg
│   └── image2.png
└── documents/
    ├── doc1.pdf
    └── doc2.docx
```

**Important** : Le fichier `index.html` doit être présent dans le dossier `HTML_FOLDER_PATH`

## Exemples d'utilisation

### Test initial
```bash
# Vérifier la configuration avec 1 fichier
node main.js --dry-run --limit=1
```

### Import de test
```bash
# Import réel d'un petit échantillon
node main.js --limit=5 --log=test_import.csv
```

### Import complet
```bash
# Import de tous les fichiers avec log
node main.js --log=full_import.csv
```

## Dépannage

### Erreurs communes
- **Variables d'environnement manquantes** : Vérifiez votre fichier `.env`
- **Dossier HTML introuvable** : Vérifiez le chemin `HTML_FOLDER_PATH`
- **Fichier index.html manquant** : Assurez-vous qu'un fichier `index.html` existe dans `HTML_FOLDER_PATH`
- **Erreurs d'authentification** : Vérifiez votre `API_TOKEN` et `AUTH_EMAIL`
- **Rate limiting** : Le programme gère automatiquement avec des pauses

### Logs utiles
- Tous les événements sont affichés en temps réel dans la console
- Utilisez `--log` pour conserver un historique permanent
- Les erreurs détaillées incluent les réponses de l'API Confluence