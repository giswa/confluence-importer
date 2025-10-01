const cheerio = require('cheerio');
const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');

const downloadableExtensions = ['.pdf', '.docx', '.xlsx', '.zip', '.pptx', '.txt', '.csv'];


function escapeHTML (str) { 
  return str.replace(/[&<>'"]/g, 
  tag => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      "'": '&#39;',
      '"': '&quot;'
    }[tag]));
  }

// === EXTRACT FRONT MATTER FROM HTML ===
// This function extracts YAML front matter from HTML content, if any
//   frontMatter: {
//     title: "My Page",
//     date: "2023-06-01",
//     tags: ["html", "clean"]
//   },
//   content: "<div>\n  <br />\n  <img src=\"pic.jpg\" />\n</div>"
// }
function extractFrontMatter(html) {
  const frontMatterRegex = /^---\s*([\s\S]*?)\s*---\s*/;
  const match = html.match(frontMatterRegex);

  if (!match) {
    return { frontMatter: null, content: html };
  }

  let frontMatter = null;
  try {
    frontMatter = yaml.load(match[1]);
  } catch (err) {
    console.warn('Invalid YAML front matter:', err);
  }

  const content = html.slice(match[0].length);
  return { frontMatter, content };
}


// === CLEAN HTML FOR XHTML OUTPUT ===
function cleanHtml(html) {

  let { frontMatter, content } = extractFrontMatter(html);

  // Ensure the HTML is well-formed for XHTML
  // Replace self-closing tags with proper XHTML format
  // This regex will match self-closing tags and ensure they end with " />"
  const selfClosingTags = ['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr'];

  selfClosingTags.forEach(tag => {
    const regex = new RegExp(`<${tag}(\\s[^>]*)?>`, 'gi');
    content = content.replace(regex, (match, attrs = '') => {
      attrs = attrs.trim();
      // Ensure there's a space before '/' only if there are attributes
      return `<${tag}${attrs ? ' ' + attrs : ''} />`;
    });
  });

  // Load HTML into Cheerio in xml mode
  const $ = cheerio.load(content, { xmlMode: true, decodeEntities: false });
  
  // Remove comments
  $('*').contents().each(function () {
    if (this.type === 'comment') $(this).remove();
  });
  
  // Remove unwanted elements
  $('script, style, meta, link, head').remove();
  
  // Remove unwanted attributes
  $('*').each((_, el) => {
    $(el).removeAttr('style class');
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
async function processImagesAndLinks(html, title, pageMap, basePath ){ // , pageId) {
  const imagesToUpload = [];
  const filesToUpload = [];
  const $ = cheerio.load(html, { xmlMode: true, decodeEntities: false });

  // Process images
  const imgTags = $('img');
  for (const img of imgTags.toArray()) {
    const src = $(img).attr('src');
    if (!src) continue;
    
    
    // Check if the image is a local file
    const fullPath = path.resolve(basePath, src);
    const fileName = path.basename(src);
    
    if (!fs.existsSync(fullPath)) {
      console.error('Missing image: ', src);
      continue;
    }
    
    // const uploadedUrl = await uploadAttachment(pageId, fullPath, fileName);
    // if (uploadedUrl) {
    //   $(img).attr('src', uploadedUrl);
    //   logEvent(title, 'Image uploaded', fileName);
    // }
    imagesToUpload.push(src);

    // change img tag to confluence format
    const confluenceImg = `
      <ac:image>
        <ri:attachment ri:filename="${fileName}" />
        <ac:plain-text-body><![CDATA[${fileName}]]></ac:plain-text-body>
      </ac:image>
    `;
    $(img).replaceWith(confluenceImg);
    //logEvent(title, 'Image tag modified', fileName);

  }

  // Process links
  const anchorTags = $('a');
  // const pageMap = getPageMap(); // Helper function to get page map
  
  for (const el of anchorTags.toArray()) {
    const href = $(el).attr('href');
    const linkText = $(el).text();
    if (!href) continue;

    const ext = path.extname(href).toLowerCase();
    
    //  pageMap is { file: title , ... } ;
    if ( pageMap[href]  ) {
      // Link to another page
      const linkedTitle = pageMap[href];
      let confluenceLink =  $(el).html() ; 
      confluenceLink = `<ac:link>
          <ri:page ri:content-title="${escapeHTML(linkedTitle)}" />
          <ac:plain-text-link-body><![CDATA[${linkText}]]></ac:plain-text-link-body>
        </ac:link>
      `;
      $(el).replaceWith(confluenceLink);
      // logEvent(title, 'Page link modified', linkedTitle);
    } else if (href.startsWith('#')) {
      // internal link (anchor)
      const confluenceLink = `
        <ac:link ac:anchor="${href.substring(1)}"> 
          <ac:plain-text-link-body><![CDATA[${linkText}]]></ac:plain-text-link-body>
        </ac:link>
      `;

      $(el).replaceWith(confluenceLink);


      // find the target element and add macro anchor
      const targetId = href.substring(1);
      const targetEl = $(`#${targetId}`);
      if (targetEl.length > 0) {
       const confluenceTarget = `
       <ac:structured-macro ac:name="anchor" >
            <ac:parameter ac:name="">${targetId}</ac:parameter>
        </ac:structured-macro>
      `;

        $(targetEl).prepend(confluenceTarget);

      }

    
    }  
    else if (imagesToUpload.includes(href)) {
      // link to an image that will be uploaded
      let confluenceLink =  $(el).html() ;
      confluenceLink = `<ac:link><ac:link-body>${confluenceLink}</ac:link-body></ac:link>` ;

      $(el).replaceWith(confluenceLink);

    } else if (downloadableExtensions.includes(ext) ) {
      
      // Downloadable file
       const filePath = path.resolve(basePath, href);
      if (fs.existsSync(filePath)) {
          const confluenceLink = `
          <ac:link>
            <ri:attachment ri:filename="${href}" />
            <ac:plain-text-link-body>
            <![CDATA[${linkText}]]></ac:plain-text-link-body>
          </ac:link>
          `;
          $(el).replaceWith(confluenceLink);

          filesToUpload.push(href);

       } else {
         console.error('Missing file: ', href);
      }
    }
  }

  return {confluence_html: $.html() , files: [...filesToUpload, ...imagesToUpload]  };

}


module.exports = {cleanHtml,processImagesAndLinks};
