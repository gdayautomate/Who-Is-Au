const puppeteer = require('puppeteer');

/**
 * Fetch WHOIS information for a given .au domain from https://whois.auda.org.au
 * @param {string} domain 
 * @returns {Promise<{domain: string, details: Record<string, any>, raw: string}>}
 */
async function getWhoisDetails(domain) {
  if (!domain) {
    throw new Error('A domain name must be provided (e.g., example.com.au)');
  }
  console.log(`[WHOIS.au] Initiating lookup for: ${domain}...`);

  const browser = await puppeteer.launch({
    headless: 'new',
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-blink-features=AutomationControlled'
    ]
  });

  try {
    const page = await browser.newPage();

    await page.setViewport({ width: 1280, height: 800 });
    await page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    );

    console.log('[WHOIS.au] Navigating to https://whois.auda.org.au...');
    await page.goto('https://whois.auda.org.au', {
      waitUntil: 'networkidle2',
      timeout: 60000
    });

    // Wait for the query input field
    const inputSelector = '#Query';
    await page.waitForSelector(inputSelector, { visible: true, timeout: 15000 });

    console.log(`[WHOIS.au] Entering domain query: ${domain}`);
    await page.click(inputSelector);
    await page.type(inputSelector, domain, { delay: 40 });

    // Ensure the look it up submit button is present
    const submitBtnSelector = '#btnSubmit';
    await page.waitForSelector(submitBtnSelector, { visible: true, timeout: 15000 });

    console.log('[WHOIS.au] Submitting form (reCAPTCHA Enterprise handled)...');
    await Promise.all([
      page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 60000 }),
      page.click(submitBtnSelector)
    ]);

    console.log('[WHOIS.au] Page loaded. Parsing result data...');

    // Extract text content from the results page
    const rawContent = await page.evaluate(() => {
      const content = document.querySelector('#content') || document.body;
      return content ? content.innerText : '';
    });

    // Parse key-value pairs from the raw WHOIS text
    const structuredData = parseWhoisText(rawContent);

    return {
      domain,
      details: structuredData,
      raw: rawContent
    };
  } catch (error) {
    console.error(`[WHOIS.au] Lookup error: ${error.message}`);
    throw error;
  } finally {
    await browser.close();
  }
}

/**
 * Parse WHOIS raw text into structured object with arrays for multi-value keys
 * @param {string} text 
 * @returns {Record<string, string | string[]>}
 */
function parseWhoisText(text) {
  const result = {};
  if (!text) return result;

  const lines = text.split('\n');
  let recording = false;

  for (const rawLine of lines) {
    const line = rawLine.trim();

    // Detect start of WHOIS record
    if (line.toLowerCase().startsWith('domain name:')) {
      recording = true;
    }

    // Stop at disclaimer/footer section
    if (line.includes('Identity Digital Australia Pty Ltd') || line.includes('Last update of WHOIS database:')) {
      if (line.includes('Last update of WHOIS database:')) {
        const match = line.match(/Last update of WHOIS database:\s*([^\s<]+)/i);
        if (match) {
          result['Last WHOIS Database Update'] = match[1];
        }
      }
      if (line.includes('Identity Digital Australia Pty Ltd')) {
        recording = false;
      }
      continue;
    }

    if (!recording) continue;

    const colonIndex = line.indexOf(':');
    if (colonIndex > 0) {
      const key = line.substring(0, colonIndex).trim();
      const val = line.substring(colonIndex + 1).trim();

      if (key) {
        if (result[key]) {
          if (Array.isArray(result[key])) {
            result[key].push(val);
          } else {
            result[key] = [result[key], val];
          }
        } else {
          result[key] = val;
        }
      }
    }
  }

  return result;
}

// CLI Execution
if (require.main === module) {
  const targetDomain = process.argv[2];

  if (!targetDomain) {
    console.error('Error: Please provide a domain name.');
    console.error('Usage: node whoisau.js <domain>');
    console.error('Example: node whoisau.js example.com.au');
    process.exit(1);
  }

  getWhoisDetails(targetDomain)
    .then(({ domain, details }) => {
      console.log('\n==========================================================');
      console.log(`          WHOIS RESULTS FOR: ${domain}`);
      console.log('==========================================================\n');

      console.log(JSON.stringify(details, null, 2));

      console.log('\n==========================================================\n');
    })
    .catch(err => {
      console.error('Fatal execution error:', err);
      process.exit(1);
    });
}

module.exports = { getWhoisDetails, parseWhoisText };
