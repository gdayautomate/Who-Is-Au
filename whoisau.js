const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const net = require('net');

puppeteer.use(StealthPlugin());

/**
 * Query direct auDA registry WHOIS via TCP socket (port 43)
 * @param {string} domain 
 * @returns {Promise<string>}
 */
function queryWhoisSocket(domain) {
  return new Promise((resolve, reject) => {
    const client = net.createConnection({ host: 'whois.auda.org.au', port: 43 }, () => {
      client.write(`${domain}\r\n`);
    });

    let raw = '';
    client.setEncoding('utf8');

    client.on('data', chunk => {
      raw += chunk;
    });

    client.on('end', () => {
      resolve(raw);
    });

    client.on('error', err => {
      reject(err);
    });

    client.setTimeout(12000, () => {
      client.destroy();
      reject(new Error('Socket timeout connecting to whois.auda.org.au:43'));
    });
  });
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

    // Capture Last WHOIS Database Update and detect disclaimer/footer section
    if (
      line.includes('Last update of WHOIS database:') ||
      line.includes('Identity Digital Australia Pty Ltd')
    ) {
      if (line.includes('Last update of WHOIS database:')) {
        const match = line.match(/Last update of WHOIS database:\s*([^<>\r\n]+)/i);
        if (match) {
          result['Last WHOIS Database Update'] = match[1].trim();
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
        if (result[key] !== undefined) {
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

/**
 * Execute query on whois.auda.org.au with deterministic reCAPTCHA handling
 */
async function queryWhoisWeb(page, domain, isRetry = false) {
  const inputSelector = '#Query';
  await page.waitForSelector(inputSelector, { visible: true, timeout: 20000 });

  // Focus, clear, and type query
  await page.click(inputSelector);
  await page.click(inputSelector, { clickCount: 3 });
  await page.keyboard.press('Backspace');
  await page.type(inputSelector, domain, { delay: 40 });

  const submitBtnSelector = '#btnSubmit';
  await page.waitForSelector(submitBtnSelector, { visible: true, timeout: 15000 });

  // Wait for reCAPTCHA Enterprise to initialize
  await page.waitForFunction(() => {
    return typeof grecaptcha !== 'undefined' && grecaptcha.enterprise;
  }, { timeout: 15000 });

  // Natural mouse movement over the submit button area
  try {
    const btn = await page.$(submitBtnSelector);
    if (btn) {
      const box = await btn.boundingBox();
      if (box) {
        await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 8 });
      }
    }
  } catch (_) {}

  await new Promise(r => setTimeout(r, 500));

  // Directly obtain the reCAPTCHA Enterprise token to eliminate race conditions
  const token = await page.evaluate(async () => {
    return new Promise((resolve, reject) => {
      grecaptcha.enterprise.ready(async () => {
        try {
          const t = await grecaptcha.enterprise.execute('6LeFBB4qAAAAABtvDSu4J3cLuukJ_pH9KJOuEoRY', { action: 'QUERY' });
          resolve(t);
        } catch (err) {
          reject(err);
        }
      });
    });
  });

  // Assign token to form and submit synchronously with navigation wait
  await Promise.all([
    page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 35000 }),
    page.evaluate((tok) => {
      const tokenInput = document.querySelector('input[name="CaptchaToken"]');
      if (tokenInput) tokenInput.value = tok;
      const form = document.querySelector('form');
      if (form) form.submit();
    }, token)
  ]);

  // Wait for result content to settle in the DOM
  await page.waitForFunction(() => {
    const text = document.body ? document.body.innerText : '';
    return text.includes('Domain Name:') || 
           text.includes('WHOIS Search Results') ||
           text.includes('No Data Found') ||
           text.includes('Not Found');
  }, { timeout: 15000 }).catch(() => null);

  // Extract raw text
  return await page.evaluate(() => {
    const pre = document.querySelector('pre');
    if (pre && pre.innerText.includes('Domain Name:')) {
      return pre.innerText;
    }
    const content = document.querySelector('#content');
    if (content && content.innerText.includes('Domain Name:')) {
      return content.innerText;
    }
    return document.body ? document.body.innerText : '';
  });
}

/**
 * Fetch WHOIS information for a given .au domain from https://whois.auda.org.au
 * with automatic fallback to direct registry socket (port 43).
 * @param {string} domain 
 * @param {object} [options]
 * @param {boolean} [options.headless] - Force headless mode (defaults to false on GUI environments)
 * @param {boolean} [options.silent] - Suppress console logs
 * @returns {Promise<{domain: string, source: 'web'|'socket', details: Record<string, any>, raw: string}>}
 */
async function getWhoisDetails(domain, options = {}) {
  if (!domain) {
    throw new Error('A domain name must be provided (e.g., example.com.au)');
  }

  // Clean domain name input
  domain = domain.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '');

  const silent = !!options.silent;
  const hasDisplay = process.platform === 'win32' || !!process.env.DISPLAY;
  const isHeadless = options.headless !== undefined
    ? options.headless
    : (!hasDisplay || process.env.HEADLESS === 'true');

  if (!silent) {
    console.log(`[WHOIS.au] Initiating lookup for: ${domain}...`);
  }

  let browser = null;

  try {
    browser = await puppeteer.launch({
      headless: isHeadless ? 'new' : false,
      ignoreDefaultArgs: ['--enable-automation'],
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-blink-features=AutomationControlled',
        '--window-size=1280,800',
        '--disable-features=IsolateOrigins,site-per-process'
      ],
      defaultViewport: isHeadless ? { width: 1280, height: 800 } : null
    });

    const page = await browser.newPage();
    await page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
    );

    if (!silent) {
      console.log('[WHOIS.au] Connecting to https://whois.auda.org.au...');
    }

    await page.goto('https://whois.auda.org.au', {
      waitUntil: 'networkidle2',
      timeout: 35000
    });

    if (!silent) {
      console.log(`[WHOIS.au] Submitting domain query: ${domain}`);
    }

    let rawContent = await queryWhoisWeb(page, domain, false);
    let structuredData = parseWhoisText(rawContent);

    // If initial query didn't return Domain Name, retry once
    if (!structuredData['Domain Name']) {
      if (!silent) {
        console.log('[WHOIS.au] Retrying web query verification...');
      }
      await page.goto('https://whois.auda.org.au', {
        waitUntil: 'networkidle2',
        timeout: 35000
      });
      rawContent = await queryWhoisWeb(page, domain, true);
      structuredData = parseWhoisText(rawContent);
    }

    // If web returned valid WHOIS details with emails, return them
    if (structuredData['Domain Name']) {
      return {
        domain,
        source: 'web',
        details: structuredData,
        raw: rawContent
      };
    }

    // Web challenge / reCAPTCHA blocked the request: fall back to socket
    if (!silent) {
      console.log('[WHOIS.au] Web challenge encountered. Falling back to direct registry socket...');
    }
  } catch (webError) {
    if (!silent) {
      console.log(`[WHOIS.au] Web lookup error: ${webError.message}. Falling back to direct registry socket...`);
    }
  } finally {
    if (browser) {
      await browser.close().catch(() => {});
    }
  }

  // Socket Fallback (Port 43)
  const socketRaw = await queryWhoisSocket(domain);
  const socketData = parseWhoisText(socketRaw);

  return {
    domain,
    source: 'socket',
    details: socketData,
    raw: socketRaw
  };
}

// CLI Execution
if (require.main === module) {
  const targetDomain = process.argv[2];

  if (!targetDomain) {
    console.error('Error: Please provide a domain name.');
    console.error('Usage: node whoisau.js <domain>');
    console.error('Examples:');
    console.error('  node whoisau.js pbengineering.com.au');
    console.error('  node whoisau.js sansolar.com.au');
    console.error('  node whoisau.js electricplus.com.au');
    process.exit(1);
  }

  getWhoisDetails(targetDomain)
    .then(({ domain, details, source }) => {
      console.log('\n==========================================================');
      console.log(`          WHOIS RESULTS FOR: ${domain} (Source: ${source})`);
      console.log('==========================================================\n');

      console.log(JSON.stringify(details, null, 2));

      console.log('\n==========================================================\n');
    })
    .catch(err => {
      console.error('Fatal execution error:', err);
      process.exit(1);
    });
}

module.exports = { getWhoisDetails, parseWhoisText, queryWhoisSocket };