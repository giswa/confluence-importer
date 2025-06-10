const fs = require('fs');
const path = require('path');
const axios = require('axios');
const cheerio = require('cheerio');
const FormData = require('form-data');

require('dotenv').config();

// === ENVIRONMENT VARIABLES VALIDATION ===
const {
  CONFLUENCE_BASE_URL,
  AUTH_EMAIL,
  API_TOKEN,
  SPACE_KEY,
  HTML_FOLDER_PATH,
  PARENT_PAGE_ID
} = process.env;

if (!CONFLUENCE_BASE_URL || !AUTH_EMAIL || !API_TOKEN || !SPACE_KEY) {
  console.error('❌ Missing environment variables. Check your .env file');
  console.error('Required: CONFLUENCE_BASE_URL, AUTH_EMAIL, API_TOKEN, SPACE_KEY');
  process.exit(1);
}

if (!HTML_FOLDER_PATH || !fs.existsSync(HTML_FOLDER_PATH)) {
  console.error('❌ HTML_FOLDER_PATH folder not found:', HTML_FOLDER_PATH);
  process.exit(1);
}

const API_ENDPOINT = `${CONFLUENCE_BASE_URL}/rest/api/content`;

// REMOVED: console.log(API_TOKEN) - SECURITY!
console.log('✅ Configuration validated');

// === CLI OPTIONS ===
const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const LIMIT = parseInt((args.find(arg => arg.startsWith('--limit=')) || '').split('=')[1]) || Infinity;
const LOG_PATH = (args.find(arg => arg.startsWith('--log=')) || '').split('=')[1] || null;

const downloadableExtensions = ['.pdf', '.docx', '.xlsx', '.zip', '.pptx', '.txt', '.csv'];

// === UTILITIES ===
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

// === LOGGING ===
const logs = [];
function logEvent(page, action, detail = '', pageUrl = '') {
  logs.push({ page, action, detail, pageUrl });
  console.log(`📝 ${page}: ${action} ${detail ? '- ' + detail : ''}`);
}

// === AXIOS ERROR HANDLING ===
async function safeAxiosCall(axiosCall, retries = 3) {
  for (let i = 0; i < retries; i++) {
    try {
      return await axiosCall();
    } catch (error) {
      if (error.response?.status === 429) {
        const waitTime = Math.pow(2, i) * 1000; // Exponential backoff
        console.log(`⏸️ Rate limit reached, waiting ${waitTime}ms...`);
        await delay(waitTime);
        continue;
      }
      
      if (i === retries - 1) {
        throw error; // Last attempt, throw error
      }
      
      console.log(`⚠️ Attempt ${i + 1}/${retries} failed, retrying...`);
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
    <p>Generated on ${new Date().toLocaleString()}</p>
    <table border="1" style="border-collapse: collapse; width: 100%;">
      <tr style="background-color: #f5f5f5;"><th>Page</th><th>Action</th><th>Detail</th></tr>
      ${rows}
    </table>
  `;
}

// === INDEX PAGE ===
function generateIndexHtml(logs) {
  const uniquePages = logs
    .filter(l => l.pageUrl && l.action === 'Created')
    .reduce((acc, curr) => {
      if (!acc.find(p => p.page === curr.page)) acc.push(curr);
      return acc;
    }, []);

  const listItems = uniquePages.map(({ page, pageUrl }) =>
    `<li><a href="${pageUrl}">${page}</a></li>`
  ).join('\n');

  return `
    <p>Generated on ${new Date().toLocaleString()}</p>
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
    console.error(`❌ Error searching page "${title}":`, error.response?.data || error.message);
    return null;
  }
}

// === CREATE OR UPDATE PAGE (FIXED) ===
async function createOrUpdatePage({ title, htmlContent, parentId }) {
  if (DRY_RUN) {
    logEvent(title, 'Simulated (dry-run)', '');
    return `dry-${title}`;
  }

  try {
    const existingPage = await getPageByTitle(title);
    
    if (existingPage) {
      // Update existing page
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
      logEvent(title, 'Updated', `Version ${newVersion}`, pageUrl);
      return existingPage.id;
      
    } else {
      // Create new page
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
      logEvent(title, 'Created', `ID ${pageId}`, pageUrl);
      return pageId;
    }
    
  } catch (error) {
    console.error(`❌ Error creating/updating "${title}":`, error.response?.data || error.message);
    logEvent(title, 'Error', error.message);
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
    console.error(`❌ Error fetching attachment ${attachmentId}:`, error.message);
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
    
    // Response structure for update is different
    let downloadLink;
    if (response.data.results && response.data.results[0]) {
      downloadLink = response.data.results[0]._links.download;
    } else if (response.data._links && response.data._links.download) {
      downloadLink = response.data._links.download;
    } else {
      // Fallback: fetch updated attachment
      const updatedAttachment = await getAttachmentById(attachmentId);
      downloadLink = updatedAttachment?._links?.download;
    }
    
    if (downloadLink) {
      return downloadLink.startsWith('http') ? downloadLink : `${CONFLUENCE_BASE_URL}${downloadLink}`;
    } else {
      console.error(`❌ Unable to retrieve download link for ${fileName}`);
      return null;
    }
    
  } catch (error) {
    console.error(`❌ Error updating ${fileName}:`, error.response?.data || error.message);
    return null;
  }
}

// === UPLOAD FILE (FIXED FOR DUPLICATE HANDLING) ===
async function uploadAttachment(pageId, filePath, fileName) {
  if (DRY_RUN) {
    return `https://dummy.url/${fileName}`;
  }

  if (!pageId || pageId.startsWith('dry-')) {
    console.error(`❌ Invalid page ID for upload ${fileName}`);
    return null;
  }

  try {
    // Check if file already exists
    const existingAttachment = await getExistingAttachment(pageId, fileName);
    
    if (existingAttachment) {
      console.log(`🔄 Updating existing attachment: ${fileName}`);
      return await updateAttachment(pageId, existingAttachment.id, filePath, fileName);
    } else {
      // Create new attachment
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
      console.log(`✅ New attachment created: ${fileName}`);
      return `${CONFLUENCE_BASE_URL}${downloadLink}`;
    }
    
  } catch (error) {
    console.error(`❌ Error uploading ${fileName}:`, error.response?.data || error.message);
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
  // Process images
  const imgTags = $('img');
  for (const img of imgTags.toArray()) {
    const src = $(img).attr('src');
    if (!src) continue;
    
    const fullPath = path.resolve(basePath, src);
    const fileName = path.basename(src);
    
    if (!fs.existsSync(fullPath)) {
      logEvent(title, 'Missing image', src);
      continue;
    }
    
    const uploadedUrl = await uploadAttachment(pageId, fullPath, fileName);
    if (uploadedUrl) {
      $(img).attr('src', uploadedUrl);
      logEvent(title, 'Image uploaded', fileName);
    }

    // change img tag to confluence format
    const confluenceImg = `
      <ac:image>
        <ri:attachment ri:filename="${fileName}" />
        <ac:plain-text-body><![CDATA[${fileName}]]></ac:plain-text-body>
      </ac:image>
    `;
    $(img).replaceWith(confluenceImg);
    logEvent(title, 'Image tag modified', fileName);

  }

  // Process links
  const anchorTags = $('a');
  const pageMap = getPageMap(); // Helper function to get page map
  
  for (const el of anchorTags.toArray()) {
    const href = $(el).attr('href');
    const linkText = $(el).text();
    if (!href) continue;

    const ext = path.extname(href).toLowerCase();
    
    if (pageMap[href]) {
      // Link to another page
      const linkedTitle = pageMap[href];
      const confluenceLink = `
        <ac:link>
          <ri:page ri:content-title="${linkedTitle}" />
          <ac:plain-text-link-body><![CDATA[${linkText}]]></ac:plain-text-link-body>
        </ac:link>
      `;
      $(el).replaceWith(confluenceLink);
      logEvent(title, 'Page link modified', linkedTitle);
      
    } else if (downloadableExtensions.includes(ext)) {
      // Downloadable file
      const filePath = path.resolve(basePath, href);
      if (fs.existsSync(filePath)) {
        const uploadedUrl = await uploadAttachment(pageId, filePath, path.basename(href));
        if (uploadedUrl) {
          $(el).attr('href', uploadedUrl);
          logEvent(title, 'File uploaded', href);
        }
      } else {
        logEvent(title, 'Missing file', href);
      }
    }
  }
}

// === HELPER FUNCTION ===
function getPageMap() {
  const indexPath = path.join(HTML_FOLDER_PATH, 'index.html');
  
  if (!fs.existsSync(indexPath)) {
    console.error('❌ Fichier index.html introuvable dans:', HTML_FOLDER_PATH);
    return {};
  }
  
  try {
    const indexHtml = fs.readFileSync(indexPath, 'utf-8');
    const $ = cheerio.load(indexHtml);
    const pageMap = {};
    
    $('a').each((_, element) => {
      const href = $(element).attr('href');
      const linkText = $(element).text().trim();
      
      if (href && href.endsWith('.html')) {
        // Utilise le texte du lien comme titre, avec fallback au nom du fichier
        pageMap[href] = linkText || path.basename(href, '.html');
      }
    });
    
    return pageMap;
  } catch (error) {
    console.error('❌ Erreur lecture index.html:', error.message);
    return {};
  }
}

// === EXTRACT FILES FROM INDEX.HTML ===
function getHtmlFilesFromIndex() {
  const indexPath = path.join(HTML_FOLDER_PATH, 'index.html');
  
  if (!fs.existsSync(indexPath)) {
    console.error('❌ Cannot find index.html in folder:', HTML_FOLDER_PATH);
    console.error('💡 Please create index.html with a links to your HTML pages');
    return [];
  }
  
  try {
    const indexHtml = fs.readFileSync(indexPath, 'utf-8');
    const $ = cheerio.load(indexHtml);
    const htmlFiles = [];
    
    console.log('🔍 Analysing index.html...');
    
    $('a').each((_, element) => {
      const href = $(element).attr('href');
      const linkText = $(element).text().trim();
      
      if (href && href.endsWith('.html')) {
        const fullPath = path.join(HTML_FOLDER_PATH, href);
        
        if (fs.existsSync(fullPath)) {
          // Return objet containing file and title
          htmlFiles.push({ 
            file: href, 
            title: linkText || path.basename(href, '.html') // Fallback to file name if no title was found
          });
          console.log(`✅ File found: ${href} → "${linkText}"`);
        } else {
          console.warn(`⚠️ Cannot find file: ${href} (${linkText})`);
        }
      }
    });
    
    if (htmlFiles.length === 0) {
      console.warn('⚠️ No linked html found in file index.html');
      console.log('💡 Please ensure index.html contains links: <a href="page.html">My Page</a>');
    }
    
    return htmlFiles;
    
  } catch (error) {
    console.error('❌ Error while reading index.html:', error.message);
    return [];
  }
}

// === MAIN FUNCTION ===
async function importHtmlFiles() {
  console.log('🚀 Starting import...');
 
  // CHANGEMENT PRINCIPAL: utiliser getHtmlFilesFromIndex() au lieu de fs.readdirSync()
  const allFilesData = getHtmlFilesFromIndex().slice(0, LIMIT);
    
  if (allFilesData.length === 0) {
    console.error('❌ Aucun fichier HTML à traiter. Vérifiez votre fichier index.html');
    process.exit(1);
  }
  
  console.log(`📊 ${allFilesData.length} files to process`);
  
  if (DRY_RUN) {
    console.log('🔍 DRY RUN mode enabled - no modifications will be made');
  }

  let counter = 0;
  for (const fileData of allFilesData) {
    counter++;
    const { file, title } = fileData;
    const filePath = path.join(HTML_FOLDER_PATH, file);
    
    console.log(`\n📄 (${counter}/${allFilesData.length}) Traitement: "${title}" (${file})`);
    
    try {
      // Read and clean HTML
      const html = fs.readFileSync(filePath, 'utf-8');
      const $ = cleanHtml(cheerio.load(html));
      
      // Create/update page
      const pageId = await createOrUpdatePage({
        title,
        htmlContent: $.html(),
        parentId: PARENT_PAGE_ID
      });
      
      if (!pageId) {
        console.error(`❌ Failed to create page ${title}, skipping`);
        continue;
      }
      
      // Process images and links
      await processImagesAndLinks($, title, HTML_FOLDER_PATH, pageId);
      
      // Final update with modified content (images/links)
      if (!DRY_RUN && pageId && !pageId.startsWith('dry-')) {
        await createOrUpdatePage({
          title,
          htmlContent: $.html(),
          parentId: PARENT_PAGE_ID
        });
      }
      
      console.log(`✅ ${title} completed`);
      
    } catch (error) {
      console.error(`❌ Error processing ${title}:`, error.message);
      logEvent(title, 'Fatal error', error.message);
    }
    
    // Rate limiting - pause between each page
    await delay(200);
  }

  // === REPORT GENERATION ===
  console.log('\n📋 Generating reports...');
  
  // Write CSV log
  if (LOG_PATH) {
    const csv = 'Page,Action,Detail,URL\n' +
      logs.map(l => `"${l.page}","${l.action}","${l.detail}","${l.pageUrl}"`).join('\n');
    fs.writeFileSync(LOG_PATH, csv);
    console.log(`🧾 CSV log written: ${LOG_PATH}`);
  }

  // HTML report in Confluence
  if (!DRY_RUN) {
    await createOrUpdatePage({
      title: `Import Report ${new Date().toLocaleDateString()}`,
      htmlContent: generateReportHtml(logs),
      parentId: PARENT_PAGE_ID,
    });

    await createOrUpdatePage({
      title: `Imported Pages Index ${new Date().toLocaleDateString()}`,
      htmlContent: generateIndexHtml(logs),
      parentId: PARENT_PAGE_ID,
    });
  }
  
  console.log('\n🎉 Import completed!');
  console.log(`📊 Summary: ${logs.filter(l => l.action === 'Created').length} created, ${logs.filter(l => l.action === 'Updated').length} updated`);
}

// === GLOBAL ERROR HANDLING ===
process.on('unhandledRejection', (reason, promise) => {
  console.error('❌ Unhandled error:', reason);
  process.exit(1);
});

// === EXECUTION ===
importHtmlFiles().catch(err => {
  console.error('💥 Fatal error:', err.message);
  process.exit(1);
});