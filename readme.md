# Import HTML vers Confluence

Ce script Node.js permet d’importer un dossier de fichiers HTML dans Confluence, en créant ou mettant à jour des pages, en uploadant les images et fichiers joints, et en recréant les liens internes entre pages.

## Prérequis

- Node.js (version 14 ou supérieure recommandée)  
- Un espace Confluence avec droits d’édition suffisants 
- Un token API Confluence Cloud valide  
- Un dossier local contenant les fichiers HTML à importer, ainsi que les images et documents liés et une page index.html qui liste les pages à importer

## Installation

1. Cloner le dépôt
2. Installer les dépendances nécessaires :

```bash
npm install 
```

3. Créer un fichier de d'environnement `.env` contenant les variables suivantes: 

```bash
CONFLUENCE_BASE_URL=https://your-instance.atlassian.net/wiki/  # your target confluence instance url
AUTH_EMAIL=user@mail.com       # user
API_TOKEN=                     # confluence api token
SPACE_KEY=my_space             # confluence space to import to
HTML_FOLDER_PATH='./output'    # local source folder to import
PARENT_PAGE_ID=                # optional parent page
```