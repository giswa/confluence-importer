const fs = require('fs');
const path = require('path');
const axios = require('axios');
const cheerio = require('cheerio');
const FormData = require('form-data');

require('dotenv').config();

// === VALIDATION DES VARIABLES D'ENVIRONNEMENT ===
const {
  CONFLUENCE_BASE_URL,
  AUTH_EMAIL,
  API_TOKEN,
  SPACE_KEY,
  HTML_FOLDER_PATH,
  PARENT_PAGE_ID
} = process.env;

if (!CONFLUENCE_BASE_URL || !AUTH_EMAIL || !API_TOKEN || !SPACE_KEY) {
  console.error('❌ Variables d\'environnement manquantes. Vérifiez votre fichier .env');
  console.error('Requis: CONFLUENCE_BASE_URL, AUTH_EMAIL, API_TOKEN, SPACE_KEY');
  process.exit(1);
}

if (!HTML_FOLDER_PATH || !fs.existsSync(HTML_FOLDER_PATH)) {
  console.error('❌ Dossier HTML_FOLDER_PATH introuvable:', HTML_FOLDER_PATH);
  process.exit(1);
}

const API_ENDPOINT = `${CONFLUENCE_BASE_URL}/rest/api/content`;

// SUPPRIMÉ: console.log(API_TOKEN) - SÉCURITÉ !
console.log('✅ Configuration validée');

// === CLI OPTIONS ===
const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const LIMIT = parseInt((args.find(arg => arg.startsWith('--limit=')) || '').split('=')[1]) || Infinity;
const LOG_PATH = (args.find(arg => arg.startsWith('--log=')) || '').split('=')[1] || null;

const downloadableExtensions = ['.pdf', '.docx', '.xlsx', '.zip', '.pptx', '.txt', '.csv'];

// === UTILITAIRES ===
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

// === LOGGING ===
const logs = [];
function logEvent(page, action, detail = '', pageUrl = '') {
  logs.push({ page, action, detail, pageUrl });
  console.log(`📝 ${page}: ${action} ${detail ? '- ' + detail : ''}`);
}

// === GESTION D'ERREURS AXIOS ===
async function safeAxiosCall(axiosCall, retries = 3) {
  for (let i = 0; i < retries; i++) {
    try {
      return await axiosCall();
    } catch (error) {
      if (error.response?.status === 429) {
        const waitTime = Math.pow(2, i) * 1000; // Backoff exponentiel
        console.log(`⏸️ Rate limit atteint, attente ${waitTime}ms...`);
        await delay(waitTime);
        continue;
      }
      
      if (i === retries - 1) {
        throw error; // Dernière tentative, on lance l'erreur
      }
      
      console.log(`⚠️ Tentative ${i + 1}/${retries} échouée, retry...`);
      await delay(1000);
    }
  }
}

// === HTML REPORT ===
function generateReportHtml(logs) {
  const rows = logs.map(({ page, action, detail, pageUrl }) => `
    <tr>
      <td>${pageUrl ? `<a href="${pageUrl}">${page}</a>` : page}</td>
      <td>${action}</td>
      <td>${detail}</td>
    </tr>
  `).join('');
  return `
    <p>Généré le ${new Date().toLocaleString()}</p>
    <table border="1" style="border-collapse: collapse; width: 100%;">
      <tr style="background-color: #f5f5f5;"><th>Page</th><th>Action</th><th>Détail</th></tr>
      ${rows}
    </table>
  `;
}

// === INDEX PAGE ===
function generateIndexHtml(logs) {
  const uniquePages = logs
    .filter(l => l.pageUrl && l.action === 'Créée')
    .reduce((acc, curr) => {
      if (!acc.find(p => p.page === curr.page)) acc.push(curr);
      return acc;
    }, []);

  const listItems = uniquePages.map(({ page, pageUrl }) =>
    `<li><a href="${pageUrl}">${page}</a></li>`
  ).join('\n');

  return `
    <p>Généré le ${new Date().toLocaleString()}</p>
    <ul>
      ${listItems}
    </ul>
  `;
}

// === GET PAGE BY TITLE ===
async function getPageByTitle(title) {
  const searchUrl = `${API_ENDPOINT}?title=${encodeURIComponent(title)}&spaceKey=${SPACE_KEY}&expand=version`;
  
  try {
    const response = await safeAxiosCall(() => 
      axios.get(searchUrl, {
        auth: { username: AUTH_EMAIL, password: API_TOKEN }
      })
    );
    
    return response.data.results[0] || null;
  } catch (error) {
    console.error(`❌ Erreur recherche page "${title}":`, error.response?.data || error.message);
    return null;
  }
}

// === CREATE OR UPDATE PAGE (CORRIGÉE) ===
async function createOrUpdatePage({ title, htmlContent, parentId }) {
  if (DRY_RUN) {
    logEvent(title, 'Simulée (dry-run)', '');
    return `dry-${title}`;
  }

  try {
    const existingPage = await getPageByTitle(title);
    
    if (existingPage) {
      // Mise à jour de la page existante
      const newVersion = existingPage.version.number + 1;
      
      const response = await safeAxiosCall(() =>
        axios.put(`${API_ENDPOINT}/${existingPage.id}`, {
          id: existingPage.id,
          type: 'page',
          title,
          version: { number: newVersion },
          body: {
            storage: {
              value: htmlContent,
              representation: 'storage',
            },
          },
        }, {
          auth: { username: AUTH_EMAIL, password: API_TOKEN },
          headers: { 'Content-Type': 'application/json' },
        })
      );
      
      const pageUrl = `${CONFLUENCE_BASE_URL}/pages/${existingPage.id}`;
      logEvent(title, 'Mise à jour', `Version ${newVersion}`, pageUrl);
      return existingPage.id;
      
    } else {
      // Création d'une nouvelle page
      const response = await safeAxiosCall(() =>
        axios.post(API_ENDPOINT, {
          type: 'page',
          title,
          space: { key: SPACE_KEY },
          ancestors: parentId ? [{ id: parentId }] : undefined,
          body: {
            storage: {
              value: htmlContent,
              representation: 'storage',
            },
          },
        }, {
          auth: { username: AUTH_EMAIL, password: API_TOKEN },
          headers: { 'Content-Type': 'application/json' },
        })
      );
      
      const pageId = response.data.id;
      const pageUrl = `${CONFLUENCE_BASE_URL}/pages/${pageId}`;
      logEvent(title, 'Créée', `ID ${pageId}`, pageUrl);
      return pageId;
    }
    
  } catch (error) {
    console.error(`❌ Erreur création/mise à jour "${title}":`, error.response?.data || error.message);
    logEvent(title, 'Erreur', error.message);
    return null;
  }
}

// === GET ATTACHMENT BY ID ===
async function getAttachmentById(attachmentId) {
  const url = `${CONFLUENCE_BASE_URL}/rest/api/content/${attachmentId}?expand=_links`;
  
  try {
    const response = await safeAxiosCall(() =>
      axios.get(url, {
        auth: { username: AUTH_EMAIL, password: API_TOKEN }
      })
    );
    
    return response.data;
  } catch (error) {
    console.error(`❌ Erreur récupération attachement ${attachmentId}:`, error.message);
    return null;
  }
}

// === CHECK IF ATTACHMENT EXISTS ===
async function getExistingAttachment(pageId, fileName) {
  const url = `${CONFLUENCE_BASE_URL}/rest/api/content/${pageId}/child/attachment`;
  
  try {
    const response = await safeAxiosCall(() =>
      axios.get(url, {
        auth: { username: AUTH_EMAIL, password: API_TOKEN },
        params: { filename: fileName }
      })
    );
    
    return response.data.results.find(att => att.title === fileName);
  } catch (error) {
    return null;
  }
}

// === UPDATE EXISTING ATTACHMENT ===
async function updateAttachment(pageId, attachmentId, filePath, fileName) {
  const url = `${CONFLUENCE_BASE_URL}/rest/api/content/${pageId}/child/attachment/${attachmentId}/data`;
  const form = new FormData();
  form.append('file', fs.createReadStream(filePath), fileName);

  try {
    const response = await safeAxiosCall(() =>
      axios.post(url, form, {
        auth: { username: AUTH_EMAIL, password: API_TOKEN },
        headers: {
          ...form.getHeaders(),
          'X-Atlassian-Token': 'no-check',
        },
      })
    );
    
    // La structure de réponse pour mise à jour est différente
    let downloadLink;
    if (response.data.results && response.data.results[0]) {
      downloadLink = response.data.results[0]._links.download;
    } else if (response.data._links && response.data._links.download) {
      downloadLink = response.data._links.download;
    } else {
      // Fallback : récupérer l'attachement mis à jour
      const updatedAttachment = await getAttachmentById(attachmentId);
      downloadLink = updatedAttachment?._links?.download;
    }
    
    if (downloadLink) {
      return downloadLink.startsWith('http') ? downloadLink : `${CONFLUENCE_BASE_URL}${downloadLink}`;
    } else {
      console.error(`❌ Impossible de récupérer le lien de téléchargement pour ${fileName}`);
      return null;
    }
    
  } catch (error) {
    console.error(`❌ Erreur mise à jour ${fileName}:`, error.response?.data || error.message);
    return null;
  }
}

// === UPLOAD FILE (CORRIGÉE POUR GESTION DOUBLONS) ===
async function uploadAttachment(pageId, filePath, fileName) {
  if (DRY_RUN) {
    return `https://dummy.url/${fileName}`;
  }

  if (!pageId || pageId.startsWith('dry-')) {
    console.error(`❌ ID de page invalide pour upload ${fileName}`);
    return null;
  }

  try {
    // Vérifier si le fichier existe déjà
    const existingAttachment = await getExistingAttachment(pageId, fileName);
    
    if (existingAttachment) {
      console.log(`🔄 Mise à jour de l'attachement existant: ${fileName}`);
      return await updateAttachment(pageId, existingAttachment.id, filePath, fileName);
    } else {
      // Créer un nouvel attachement
      const url = `${CONFLUENCE_BASE_URL}/rest/api/content/${pageId}/child/attachment`;
      const form = new FormData();
      form.append('file', fs.createReadStream(filePath), fileName);

      const response = await safeAxiosCall(() =>
        axios.post(url, form, {
          auth: { username: AUTH_EMAIL, password: API_TOKEN },
          headers: {
            ...form.getHeaders(),
            'X-Atlassian-Token': 'no-check',
          },
        })
      );
      
      const downloadLink = response.data.results[0]._links.download;
      console.log(`✅ Nouvel attachement créé: ${fileName}`);
      return `${CONFLUENCE_BASE_URL}${downloadLink}`;
    }
    
  } catch (error) {
    console.error(`❌ Erreur upload ${fileName}:`, error.response?.data || error.message);
    return null;
  }
}

// === CLEAN HTML ===
function cleanHtml($) {
  $('*').contents().each(function () {
    if (this.type === 'comment') $(this).remove();
  });
  $('script, style, meta, link, head').remove();
  $('*').each((_, el) => {
    $(el).removeAttr('style class id');
  });
  return $;
}

// === PROCESS IMAGES AND LINKS ===
async function processImagesAndLinks($, title, basePath, pageId) {
  // Traitement des images
  const imgTags = $('img');
  for (const img of imgTags.toArray()) {
    const src = $(img).attr('src');
    if (!src) continue;
    
    const fullPath = path.resolve(basePath, src);
    const fileName = path.basename(src);
    
    if (!fs.existsSync(fullPath)) {
      logEvent(title, 'Image manquante', src);
      continue;
    }
    
    const uploadedUrl = await uploadAttachment(pageId, fullPath, fileName);
    if (uploadedUrl) {
      $(img).attr('src', uploadedUrl);
      logEvent(title, 'Image uploadée', fileName);
    }
  }

  // Traitement des liens
  const anchorTags = $('a');
  const pageMap = getPageMap(); // Fonction helper pour récupérer la map des pages
  
  for (const el of anchorTags.toArray()) {
    const href = $(el).attr('href');
    const linkText = $(el).text();
    if (!href) continue;

    const ext = path.extname(href).toLowerCase();
    
    if (pageMap[href]) {
      // Lien vers une autre page
      const linkedTitle = pageMap[href];
      const confluenceLink = `
        <ac:link>
          <ri:page ri:content-title="${linkedTitle}" />
          <ac:plain-text-link-body><![CDATA[${linkText}]]></ac:plain-text-link-body>
        </ac:link>
      `;
      $(el).replaceWith(confluenceLink);
      logEvent(title, 'Lien page modifié', linkedTitle);
      
    } else if (downloadableExtensions.includes(ext)) {
      // Fichier téléchargeable
      const filePath = path.resolve(basePath, href);
      if (fs.existsSync(filePath)) {
        const uploadedUrl = await uploadAttachment(pageId, filePath, path.basename(href));
        if (uploadedUrl) {
          $(el).attr('href', uploadedUrl);
          logEvent(title, 'Fichier uploadé', href);
        }
      } else {
        logEvent(title, 'Fichier manquant', href);
      }
    }
  }
}

// === HELPER FUNCTION ===
function getPageMap() {
  const allFiles = fs.readdirSync(HTML_FOLDER_PATH).filter(f => f.endsWith('.html'));
  const pageMap = {};
  allFiles.forEach(file => {
    pageMap[file] = path.basename(file, '.html');
  });
  return pageMap;
}

// === MAIN FUNCTION (REFACTORISÉE) ===
async function importHtmlFiles() {
  console.log('🚀 Début de l\'import...');
  
  const allFiles = fs.readdirSync(HTML_FOLDER_PATH)
    .filter(f => f.endsWith('.html'))
    .slice(0, LIMIT);
    
  console.log(`📊 ${allFiles.length} fichiers à traiter`);
  
  if (DRY_RUN) {
    console.log('🔍 Mode DRY RUN activé - aucune modification ne sera effectuée');
  }

  let counter = 0;
  for (const file of allFiles) {
    counter++;
    const title = path.basename(file, '.html');
    const filePath = path.join(HTML_FOLDER_PATH, file);
    
    console.log(`\n📄 (${counter}/${allFiles.length}) Traitement: ${title}`);
    
    try {
      // Lecture et nettoyage du HTML
      const html = fs.readFileSync(filePath, 'utf-8');
      const $ = cleanHtml(cheerio.load(html));
      
      // Création/mise à jour de la page
      const pageId = await createOrUpdatePage({
        title,
        htmlContent: $.html(),
        parentId: PARENT_PAGE_ID
      });
      
      if (!pageId) {
        console.error(`❌ Échec création page ${title}, passage au suivant`);
        continue;
      }
      
      // Traitement des images et liens
      await processImagesAndLinks($, title, HTML_FOLDER_PATH, pageId);
      
      // Mise à jour finale avec le contenu modifié (images/liens)
      if (!DRY_RUN && pageId && !pageId.startsWith('dry-')) {
        await createOrUpdatePage({
          title,
          htmlContent: $.html(),
          parentId: PARENT_PAGE_ID
        });
      }
      
      console.log(`✅ ${title} terminé`);
      
    } catch (error) {
      console.error(`❌ Erreur traitement ${title}:`, error.message);
      logEvent(title, 'Erreur fatale', error.message);
    }
    
    // Rate limiting - pause entre chaque page
    await delay(200);
  }

  // === GÉNÉRATION DES RAPPORTS ===
  console.log('\n📋 Génération des rapports...');
  
  // Écriture du log CSV
  if (LOG_PATH) {
    const csv = 'Page,Action,Détail,URL\n' +
      logs.map(l => `"${l.page}","${l.action}","${l.detail}","${l.pageUrl}"`).join('\n');
    fs.writeFileSync(LOG_PATH, csv);
    console.log(`🧾 Journal CSV écrit: ${LOG_PATH}`);
  }

  // Rapport HTML dans Confluence
  if (!DRY_RUN) {
    await createOrUpdatePage({
      title: `Rapport d'import du ${new Date().toLocaleDateString()}`,
      htmlContent: generateReportHtml(logs),
      parentId: PARENT_PAGE_ID,
    });

    await createOrUpdatePage({
      title: `Index des pages importées du ${new Date().toLocaleDateString()}`,
      htmlContent: generateIndexHtml(logs),
      parentId: PARENT_PAGE_ID,
    });
  }
  
  console.log('\n🎉 Import terminé !');
  console.log(`📊 Résumé: ${logs.filter(l => l.action === 'Créée').length} créées, ${logs.filter(l => l.action === 'Mise à jour').length} mises à jour`);
}

// === GESTION D'ERREURS GLOBALES ===
process.on('unhandledRejection', (reason, promise) => {
  console.error('❌ Erreur non gérée:', reason);
  process.exit(1);
});

// === EXECUTION ===
importHtmlFiles().catch(err => {
  console.error('💥 Erreur fatale:', err.message);
  process.exit(1);
});