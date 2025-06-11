# Confluence HTML Importer

Node.js tool to import HTML files to Confluence Cloud with automatic handling of images, links, and file attachments.

## Prerequisites

- Node.js (version 14 or higher)
- npm dependencies: `axios`, `cheerio`, `form-data`, `dotenv`

## Configuration

Create a `.env` file at the project root with the following variables:

```env
# Confluence Configuration (REQUIRED)
# Note that cloud version required /wiki suffix
CONFLUENCE_BASE_URL=https://your-domain.atlassian.net/wiki
AUTH_EMAIL=your-email@domain.com
API_TOKEN=your-api-token
SPACE_KEY=YOUR_SPACE_KEY

# Import Configuration (REQUIRED)
HTML_FOLDER_PATH=./path/to/your/html/files

# Optional Configuration
PARENT_PAGE_ID=123456789  # Parent page ID (optional)
```

### How to obtain your Confluence credentials:

1. **API Token**: Generate a token from [https://id.atlassian.com/manage-profile/security/api-tokens](https://id.atlassian.com/manage-profile/security/api-tokens)
2. **SPACE_KEY**: Visible in your Confluence space URL
3. **PARENT_PAGE_ID**: ID of the page under which to create new pages (optional)

## Execution Options

### Standard execution
```bash
node main.js
```

### Command-line options

#### `--dry-run`
Simulation mode without posting to Confluence.
```bash
node main.js --dry-run
```
- Simulates all operations
- Shows what actions would be performed
- No pages/files are created or modified
- Ideal for testing before actual import

#### `--dry-run-local`
Simulation mode without posting to Confluence, but export to local folder
```bash
node main.js --dry-run-local
```
- Simulates all operations
- Shows what actions would be performed
- Export output results to file system
- Ideal for testing before actual import

#### `--limit=N`
Limits the number of HTML files to process.
```bash
node main.js --limit=5
```
- Processes only the first N HTML files found
- Useful for testing or partial imports
- Without this option, all .html files in the folder are processed

#### `--log=path/to/file.csv`
Generates a CSV file with detailed operation log.
```bash
node main.js --log=import_log.csv
```
- Creates a CSV file with columns: Page, Action, Detail, URL
- Contains all actions performed during import
- Useful for tracking and auditing

### Combining options
```bash
# Test with 3 files and log generation
node main.js --dry-run --limit=3 --log=test_log.csv

# Real import limited to 10 files with log
node main.js --limit=10 --log=production_log.csv
```

## Program Features

### Automatic Processing
- **Pages**: Automatic creation or update based on title
- **Images**: Automatic upload to Confluence and link updates
- **File attachments**: Upload of files (.pdf, .docx, .xlsx, .zip, .pptx, .txt, .csv)
- **Internal links**: Automatic conversion to Confluence links
- **HTML cleanup**: Removal of styles, classes, and metadata

### Error Handling
- Automatic retry with exponential backoff
- Confluence rate limiting management
- Detailed logs for debugging
- Environment variable validation

### Generated Reports
The program automatically generates in Confluence:
1. **Import Report**: Details of all operations performed
2. **Page Index**: List of created pages with direct links

## Expected File Structure

```
HTML_FOLDER_PATH/
├── index.html          # REQUIRED - Main landing page
├── page1.html
├── page2.html
├── images/
│   ├── image1.jpg
│   └── image2.png
└── documents/
    ├── doc1.pdf
    └── doc2.docx
```

**Important**: The `index.html` file must be present in the `HTML_FOLDER_PATH` folder

## Usage Examples

### Initial test
```bash
# Check configuration with 1 file
node main.js --dry-run --limit=1
```

### Test import
```bash
# Real import of a small sample
node main.js --limit=5 --log=test_import.csv
```

### Full import
```bash
# Import all files with log
node main.js --log=full_import.csv
```

## Troubleshooting

### Common errors
- **Missing environment variables**: Check your `.env` file
- **HTML folder not found**: Check the `HTML_FOLDER_PATH` path
- **Missing index.html file**: Make sure an `index.html` file exists in `HTML_FOLDER_PATH`
- **Authentication errors**: Check your `API_TOKEN` and `AUTH_EMAIL`
- **Rate limiting**: The program handles this automatically with pauses

### Useful logs
- All events are displayed in real-time in the console
- Use `--log` to maintain a permanent history
- Detailed errors include Confluence API responses