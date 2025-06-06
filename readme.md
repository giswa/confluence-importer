# Import HTML vers Confluence

Ce script Node.js permet d’importer un dossier de fichiers HTML dans Confluence, en créant ou mettant à jour des pages, en uploadant les images et fichiers joints, et en recréant les liens internes entre pages.

---

## Table des matières

- [Prérequis](#prérequis)  
- [Installation](#installation)  
- [Configuration](#configuration)  
- [Utilisation](#utilisation)  
- [Options disponibles](#options-disponibles)  
- [Fonctionnalités](#fonctionnalités)  
- [Limitations et recommandations](#limitations-et-recommandations)  
- [Journal des actions](#journal-des-actions)  
- [Support](#support)  

---

## Prérequis

- Node.js (version 14 ou supérieure recommandée)  
- Un token API Confluence Cloud valide  
- Un espace Confluence avec droits d’édition suffisants  
- Un dossier local contenant les fichiers HTML à importer, ainsi que les images et documents liés  

---

## Installation

1. Cloner le dépôt ou copier le fichier `import-confluence.js` dans un dossier de travail.  
2. Placer les fichiers HTML et ressources dans un dossier, par défaut `./html-files`.  
3. Installer les dépendances nécessaires :

```bash
npm install axios cheerio form-data
```
