const fs = require('fs');
const path = require('path');
const axios = require('axios');
const cheerio = require('cheerio');
const FormData = require('form-data');

require('dotenv').config();
const {
  CONFLUENCE_BASE_URL,
  AUTH_EMAIL,
  API_TOKEN,
  SPACE_KEY,
  HTML_FOLDER_PATH,
  PARENT_PAGE_ID
} = process.env;

const API_ENDPOINT = `${CONFLUENCE_BASE_URL}/rest/api/content`;

console.log(API_TOKEN)

// === CLI OPTIONS ===
const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const LIMIT = parseInt((args.find(arg => arg.startsWith('--limit=')) || '').split('=')[1]) || Infinity;
const LOG_PATH = (args.find(arg => arg.startsWith('--log=')) || '').split('=')[1] || null;

const downloadableExtensions = ['.pdf', '.docx', '.xlsx', '.zip', '.pptx', '.txt', '.csv'];

// === LOGGING ===
const logs = [];
function logEvent(page, action, detail = '', pageUrl = '') {
  logs.push({ page, action, detail, pageUrl });
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
    <h1>Rapport d'import</h1>
    <p>Généré le ${new Date().toLocaleString()}</p>
    <table>
      <tr><th>Page</th><th>Action</th><th>Détail</th></tr>
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
    <h1>Index des pages importées</h1>
    <p>Généré automatiquement le ${new Date().toLocaleString()}</p>
    <ul>
      ${listItems}
    </ul>
  `;
}

// === CREATE OR UPDATE PAGE ===
async function createOrUpdatePage({ title, htmlContent, parentId }) {
  const searchUrl = `${API_ENDPOINT}?title=${encodeURIComponent(title)}&spaceKey=${SPACE_KEY}&expand=version`;
  try {
    const res = await axios.get(searchUrl, {
      auth: { username: AUTH_EMAIL, password: API_TOKEN }
    });

    const existingPage = res.data.results[0];
    if (existingPage) {
      const version = existingPage.version.number + 1;
      await axios.put(`${API_ENDPOINT}/${existingPage.id}`, {
        id: existingPage.id,
        type: 'page',
        title,
        version: { number: version },
        body: {
          storage: {
            value: htmlContent,
            representation: 'storage',
          },
        },
      }, {
        auth: { username: AUTH_EMAIL, password: API_TOKEN },
        headers: { 'Content-Type': 'application/json' },
      });
      console.log(`🔁 Page mise à jour : ${title}`);
    } else {
      await axios.post(API_ENDPOINT, {
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
      });
      console.log(`🆕 Page créée : ${title}`);
    }
  } catch (err) {
    console.error(`❌ Erreur création/mise à jour "${title}":`, err.response?.data || err.message);
  }
}

// === UPLOAD FILE ===
async function uploadAttachment(pageId, filePath, fileName) {
  if (DRY_RUN) {
    return `https://dummy.url/${fileName}`;
  }

  const url = `${CONFLUENCE_BASE_URL}/rest/api/content/${pageId}/child/attachment`;
  const form = new FormData();
  form.append('file', fs.createReadStream(filePath), fileName);

  try {
    const res = await axios.post(url, form, {
      auth: { username: AUTH_EMAIL, password: API_TOKEN },
      headers: {
        ...form.getHeaders(),
        'X-Atlassian-Token': 'no-check',
      },
    });
    const downloadLink = res.data.results[0]._links.download;
    return `${CONFLUENCE_BASE_URL}${downloadLink}`;
  } catch (err) {
    console.error(`❌ Erreur upload ${fileName}:`, err.response?.data || err.message);
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

// === MAIN ===
async function importHtmlFiles() {
  const allFiles = fs.readdirSync(HTML_FOLDER_PATH).filter(f => f.endsWith('.html')).slice(0, LIMIT);
  const pageMap = {};
  allFiles.forEach(file => {
    pageMap[file] = path.basename(file, '.html');
  });

  let counter = 0;
  for (const file of allFiles) {
    counter++;
    const title = pageMap[file];
    const filePath = path.join(HTML_FOLDER_PATH, file);
    const html = fs.readFileSync(filePath, 'utf-8');
    const $ = cleanHtml(cheerio.load(html));
    console.log(`📄 (${counter}/${allFiles.length}) ${title}`);

    let pageId = `dry-${title}`;
    let pageUrl = '';

    if (!DRY_RUN) {
      try {
        const res = await axios.post(API_ENDPOINT, {
          type: 'page',
          title,
          space: { key: SPACE_KEY },
          ancestors: PARENT_PAGE_ID ? [{ id: PARENT_PAGE_ID }] : undefined,
          body: {
            storage: {
              value: $.html(),
              representation: 'storage',
            },
          },
        }, {
          auth: { username: AUTH_EMAIL, password: API_TOKEN },
          headers: { 'Content-Type': 'application/json' },
        });
        pageId = res.data.id;
        pageUrl = `${CONFLUENCE_BASE_URL}/pages/${pageId}`;
        logEvent(title, 'Créée', `ID ${pageId}`, pageUrl);
      } catch (err) {
        console.error(`❌ Erreur création page :`, err.response?.data || err.message);
        logEvent(title, 'Erreur création', err.message);
        continue;
      }
    } else {
      logEvent(title, 'Simulée', '', '');
    }

    const imgTags = $('img');
    for (const img of imgTags.toArray()) {
      const src = $(img).attr('src');
      if (!src) continue;
      const fullPath = path.resolve(HTML_FOLDER_PATH, src);
      const fileName = path.basename(src);
      if (!fs.existsSync(fullPath)) {
        logEvent(title, 'Image manquante', src);
        continue;
      }
      const uploadedUrl = await uploadAttachment(pageId, fullPath, fileName);
      if (uploadedUrl) {
        $(img).attr('src', uploadedUrl);
        logEvent(title, 'Image uploadée', fileName, pageUrl);
      }
    }

    const anchorTags = $('a');
    for (const el of anchorTags.toArray()) {
      const href = $(el).attr('href');
      const linkText = $(el).text();
      if (!href) continue;

      const ext = path.extname(href).toLowerCase();
      if (pageMap[href]) {
        const linkedTitle = pageMap[href];
        const confluenceLink = `
          <ac:link>
            <ri:page ri:content-title="${linkedTitle}" />
            <ac:plain-text-link-body><![CDATA[${linkText}]]></ac:plain-text-link-body>
          </ac:link>
        `;
        $(el).replaceWith(confluenceLink);
        logEvent(title, 'Lien page modifié', linkedTitle, pageUrl);
      } else if (downloadableExtensions.includes(ext)) {
        // Upload fichier attaché
        const filePath = path.resolve(HTML_FOLDER_PATH, href);
        if (fs.existsSync(filePath)) {
          const uploadedUrl = await uploadAttachment(pageId, filePath, path.basename(href));
          if (uploadedUrl) {
            $(el).attr('href', uploadedUrl);
            logEvent(title, 'Fichier uploadé', href, pageUrl);
          }
        } else {
          logEvent(title, 'Fichier manquant', href);
        }
      }
    }

    // Mise à jour page avec contenu modifié (liens et images)
    if (!DRY_RUN) {
      try {
        await axios.put(`${API_ENDPOINT}/${pageId}`, {
          id: pageId,
          type: 'page',
          title,
          version: { number: 2 },
          body: {
            storage: {
              value: $.html(),
              representation: 'storage',
            },
          },
        }, {
          auth: { username: AUTH_EMAIL, password: API_TOKEN },
          headers: { 'Content-Type': 'application/json' },
        });
        logEvent(title, 'Page mise à jour', '', pageUrl);
      } catch (err) {
        console.error(`❌ Erreur mise à jour page :`, err.response?.data || err.message);
        logEvent(title, 'Erreur mise à jour', err.message);
      }
    }

    console.log(`✅ Terminé ${title}`);
  }

  // === Écrire log CSV ===
  if (LOG_PATH) {
    const csv = 'Page,Action,Détail,URL\n' +
      logs.map(l => `"${l.page}","${l.action}","${l.detail}","${l.pageUrl}"`).join('\n');
    fs.writeFileSync(LOG_PATH, csv);
    console.log(`🧾 Journal CSV écrit : ${LOG_PATH}`);
  }

  // === Rapport final ===
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
  } else {
    console.log(`📄 [DRY RUN] Rapport généré :`);
    console.log(generateReportHtml(logs));
    console.log(`📄 [DRY RUN] Index généré :`);
    console.log(generateIndexHtml(logs));
  }
}

// === RUN ===
importHtmlFiles().catch(err => {
  console.error('Erreur fatale:', err);
});
