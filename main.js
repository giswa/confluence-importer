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

if (!CONFLUENCE_BASE_URL || !API_TOKEN || !SPACE_KEY) {
  console.error('❌ Missing environment variables. Check your .env file');
  console.error('Required: CONFLUENCE_BASE_URL, API_TOKEN, SPACE_KEY');
  process.exit(1);
}

if (!HTML_FOLDER_PATH || !fs.existsSync(HTML_FOLDER_PATH)) {
  console.error('❌ HTML_FOLDER_PATH folder not found:', HTML_FOLDER_PATH);
  process.exit(1);
}

const API_ENDPOINT = `${CONFLUENCE_BASE_URL}/rest/api/content`;

// === STATE MANAGEMENT ===
const STATE_FILE = path.join(HTML_FOLDER_PATH, 'transfer-state.json');

console.log('✅ Configuration validated');

// === CLI OPTIONS ===
const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const DRY_RUN_LOCAL = args.includes('--dry-run-local');
const IGNORE_STATE = args.includes('--all');
const LIMIT = parseInt((args.find(arg => arg.startsWith('--limit=')) || '').split('=')[1]) || Infinity;
const LOG_PATH = (args.find(arg => arg.startsWith('--log=')) || '').split('=')[1] || null;

const downloadableExtensions = ['.pdf', '.docx', '.xlsx', '.zip', '.pptx', '.txt', '.csv'];

// === UTILITIES ===
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

// === DRY RUN LOCAL SETUP ===
const DRY_RUN_OUTPUT_DIR = path.join(process.cwd(), 'dryrun-output');

if (DRY_RUN_LOCAL) {
  // Create dry-run output directory if it doesn't exist
  if (!fs.existsSync(DRY_RUN_OUTPUT_DIR)) {
    fs.mkdirSync(DRY_RUN_OUTPUT_DIR, { recursive: true });
    console.log(`📁 Created folder for dry-run: ${DRY_RUN_OUTPUT_DIR}`);
  }
}

// === DRY RUN LOCAL FUNCTIONS ===
function saveDryRunFile(title, content, type = 'html') {
  if (!DRY_RUN_LOCAL) return null;
  
  const sanitizedTitle = title.replace(/[<>:"/\\|?*]/g, '_');
  const fileName = `${sanitizedTitle}.${type}`;
  const filePath = path.join(DRY_RUN_OUTPUT_DIR, fileName);
  
  try {
    fs.writeFileSync(filePath, content, 'utf-8');
    console.log(`💾 Saved locally: ${fileName}`);
    return filePath;
  } catch (error) {
    console.error(`❌ Saving failed for ${fileName}:`, error.message);
    return null;
  }
}

function copyDryRunAsset(srcPath, destName) {
  if (!DRY_RUN_LOCAL || !fs.existsSync(srcPath)) return null;
  
  const destPath = path.join(DRY_RUN_OUTPUT_DIR, 'assets');
  
  // folder does not exist, create it
  if (!fs.existsSync(destPath)) {
    fs.mkdirSync(destPath, { recursive: true });
  }
  
  const finalDestPath = path.join(destPath, destName);
  
  try {
    fs.copyFileSync(srcPath, finalDestPath);
    console.log(`📋 Asset saved: ${destName}`);
    return `./assets/${destName}`;
  } catch (error) {
    console.error(`❌ Asset saving failed ${destName}:`, error.message);
    return null;
  }
}

// === LOGGING ===
const logs = [];
function logEvent(page, action, detail = '', pageUrl = '') {
  logs.push({ page, action, detail, pageUrl });
  console.log(`📝 ${page}: ${action} ${detail ? '- ' + detail : ''}`);
}

// === AUTHENTICATION HEADERS HELPER ===
function getAuthHeaders(additionalHeaders = {}) {
  if (AUTH_EMAIL) {
    return {
      // Basic Auth with email and API token
      // alternate solution to: { username: AUTH_EMAIL, password: API_TOKEN },
      'Authorization': `Basic ${Buffer.from(`${AUTH_EMAIL}:${API_TOKEN}`).toString('base64')}`,
      ...additionalHeaders
    };
  }else {
    return {
      'Authorization': `Bearer ${API_TOKEN}`,
      ...additionalHeaders
    };
  }
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

// === GET PAGE BY TITLE ===
async function getPageByTitle(title) {
  const searchUrl = `${API_ENDPOINT}?title=${encodeURIComponent(title)}&spaceKey=${SPACE_KEY}&expand=version`;
  
  try {
    const response = await safeAxiosCall(() => 
      axios.get(searchUrl, {
        headers: getAuthHeaders()
      })
    );
    
    return response.data.results[0] || null;
  } catch (error) {
    console.error(`❌ Error searching page "${title}":`, error.response?.data || error.message);
    return null;
  }
}

// === CREATE OR UPDATE PAGE ===
async function createOrUpdatePage({ title, htmlContent, parentId }) {
  if (DRY_RUN) {
    logEvent(title, 'Simulated (dry-run)', '');
    return `dry-${title}`;
  }
  
  if (DRY_RUN_LOCAL) {
    // Save the HTML content to a local file
    const savedPath = saveDryRunFile(title, htmlContent, 'html');
    logEvent(title, 'Dry-run local', savedPath ? `Saved: ${path.basename(savedPath)}` : 'Saving failed');
    return `dry-local-${title}`;
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
          headers: getAuthHeaders({ 'Content-Type': 'application/json' })
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
          headers: getAuthHeaders({ 'Content-Type': 'application/json' })
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
        headers: getAuthHeaders()
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
        headers: getAuthHeaders(),
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
        headers: getAuthHeaders({
          ...form.getHeaders(),
          'X-Atlassian-Token': 'no-check'
        })
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

// === UPLOAD FILE ===
async function uploadAttachment(pageId, filePath, fileName) {
  if (DRY_RUN) {
    return `https://dummy.url/${fileName}`;
  }
  
  if (DRY_RUN_LOCAL) {
    // copy file to dry-run output directory
    const localPath = copyDryRunAsset(filePath, fileName);
    return localPath || `./assets/${fileName}`;
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
          headers: getAuthHeaders({
            ...form.getHeaders(),
            'X-Atlassian-Token': 'no-check',
          })
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


// === CLEAN HTML FOR XHTML OUTPUT ===
function cleanHtml(html) {

  // Ensure the HTML is well-formed for XHTML
  // Replace self-closing tags with proper XHTML format
  // This regex will match self-closing tags and ensure they end with " />"
  const selfClosingTags = ['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr'];

  selfClosingTags.forEach(tag => {
    const regex = new RegExp(`<${tag}(\\s[^>]*)?>`, 'gi');
    html = html.replace(regex, (match, attrs = '') => {
      attrs = attrs.trim();
      // Ensure there's a space before '/' only if there are attributes
      return `<${tag}${attrs ? ' ' + attrs : ''} />`;
    });
  });

  // Load HTML into Cheerio in xml mode
  const $ = cheerio.load(html, { xmlMode: true, decodeEntities: false });
  
  // Remove comments
  $('*').contents().each(function () {
    if (this.type === 'comment') $(this).remove();
  });
  
  // Remove unwanted elements
  $('script, style, meta, link, head').remove();
  
  // Remove unwanted attributes
  $('*').each((_, el) => {
    $(el).removeAttr('style class id');
  });
  
  // 2. Convert attributes to lowercase (XHTML requirement)
  $('*').each((_, el) => {
    const $el = $(el);
    const attributes = el.attribs || {};
    
    Object.keys(attributes).forEach(attr => {
      if (attr !== attr.toLowerCase()) {
        const value = attributes[attr];
        $el.removeAttr(attr);
        $el.attr(attr.toLowerCase(), value);
      }
    });
  });
  
  // 3. Convert tag names to lowercase (XHTML requirement)
  $('*').each((_, el) => {
    const tagName = el.tagName || el.name;
    if (tagName && tagName !== tagName.toLowerCase()) {
      const $el = $(el);
      const html = $el.html();
      const attributes = el.attribs || {};
      
      // Create new element with lowercase tag name
      const newEl = $(`<${tagName.toLowerCase()}>`);
      
      // Copy attributes
      Object.keys(attributes).forEach(attr => {
        newEl.attr(attr, attributes[attr]);
      });
      
      // Set content
      newEl.html(html);
      
      // Replace old element
      $el.replaceWith(newEl);
    }
  });
  
  // 4. Ensure boolean attributes are properly formatted for XHTML
  // In XHTML, boolean attributes must have values equal to their names
  const booleanAttributes = ['checked', 'selected', 'disabled', 'readonly', 'multiple', 'autofocus', 'autoplay', 'controls', 'defer', 'hidden', 'loop', 'open', 'required', 'reversed'];
  
  $('*').each((_, el) => {
    const $el = $(el);
    booleanAttributes.forEach(attr => {
      if ($el.attr(attr) !== undefined) {
        $el.attr(attr, attr); // Set value equal to attribute name
      }
    });
  });
  
  // 5. Ensure all attributes are quoted (handled by Cheerio by default)
  
  // 6. Add xml namespace if not present (optional, for strict XHTML)
  // This would typically be done at the document level
  
  // Only return the <body> content, or all HTML if no <body> tag exists
  if ($('body').length > 0) {
    // Return a cheerio instance containing only the body children
    return $('body').html() ;
  } else {
    // No <body> tag, return the whole document as-is
    return $.html() ;
  }
}


// === PROCESS IMAGES AND LINKS ===
async function processImagesAndLinks(html, title, basePath, pageId) {

  const $ = cheerio.load(html, { xmlMode: true, decodeEntities: false });

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
          const confluenceLink = `
          <ac:link>
            <ri:attachment ri:filename="${href}" />
            <ac:plain-text-link-body>
            <![CDATA[${linkText}]]></ac:plain-text-link-body>
          </ac:link>
          `;
          $(el).replaceWith(confluenceLink);
          logEvent(title, 'File uploaded', href);
        }
      } else {
        logEvent(title, 'Missing file', href);
      }
    }
  }

  return $.html() ;

}

// === HELPER FUNCTION ===
function getPageMap() {
  const indexPath = path.join(HTML_FOLDER_PATH, 'index.html');
  
  if (!fs.existsSync(indexPath)) {
    console.error('❌ Cannot find index.html in folder:', HTML_FOLDER_PATH);
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
    const htmlFiles = [{file: 'index.html', title: 'Index Page'}]; // Start with index.html
    
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

  const state = loadState();

  const allFilesData = getHtmlFilesFromIndex().slice(0, LIMIT);

  if (allFilesData.length === 0) {
    console.error('❌ Nothing to process. Check index.html');
    process.exit(1);
  }
  
  console.log(`📊 ${allFilesData.length} files to process`);
  
  if (DRY_RUN) {
    console.log('🔍 DRY RUN mode enabled - no modifications will be made');
  }

  let counter = 0;
  for (const fileData of allFilesData) {
    const { file, title } = fileData;
    if (state.transferred.includes(file)) {
      console.log(`⏩ Skip (already transferred): "${title}" (${file})`);
      continue;
    }
    counter++;
    const filePath = path.join(HTML_FOLDER_PATH, file);
    
    console.log(`\n📄 (${counter}/${allFilesData.length}) Treating: "${title}" (${file})`);
    
    try {
      // Read and clean HTML
      const html = fs.readFileSync(filePath, 'utf-8');
      const clean_html = cleanHtml(html);
      
      // Create/update page
      const pageId = await createOrUpdatePage({
        title,
        htmlContent: clean_html,
        parentId: PARENT_PAGE_ID
      });
      
      if (!pageId) {
        console.error(`❌ Failed to create page ${title}, skipping`);
        continue;
      }
      
      // Process images and links
      const confluence_html = await processImagesAndLinks(clean_html, title, HTML_FOLDER_PATH, pageId);
      
      // Final update with modified content (images/links)
      if ( pageId ) {
        await createOrUpdatePage({
          title,
          htmlContent: confluence_html ,
          parentId: PARENT_PAGE_ID
        });
      }

      // Add to the transfered file list
      state.transferred.push(file);
      saveState(state);

      console.log(`✅ ${title} completed`);
      
    } catch (error) {
      console.error(`❌ Error processing ${title}:`, error.message);
      logEvent(title, 'Fatal error', error.message);
    }
    
    // Rate limiting - pause between each page
    await delay(200);
  }

  // Write CSV log
  if (LOG_PATH) {
    const csv = 'Page,Action,Detail,URL\n' +
      logs.map(l => `"${l.page}","${l.action}","${l.detail}","${l.pageUrl}"`).join('\n');
    fs.writeFileSync(LOG_PATH, csv);
    console.log(`🧾 CSV log written: ${LOG_PATH}`);
  }

  console.log('\n🎉 Import completed!');
  console.log(`📊 Summary: ${logs.filter(l => l.action === 'Created').length} created, ${logs.filter(l => l.action === 'Updated').length} updated`);
}


function loadState() {
  if (!IGNORE_STATE && fs.existsSync(STATE_FILE)) {
    try {
      return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    } catch (e) {
      console.warn('⚠️ Could not read resume file, it will be reset.');
      return { transferred: [] };
    }
  }
  return { transferred: [] };
}

function saveState(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
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