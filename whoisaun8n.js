// ==============================================================================
// WhoIsAU n8n Code Node & CLI Lookup Tool
// Queries registration details directly from https://whois.auda.org.au/
// ==============================================================================
// USAGE MODES:
//
// 1. In CLI (Terminal):
//    node whoisaun8n.js <domain>
//    Example: node whoisaun8n.js suntechsynergy.com.au
//    Directly automates https://whois.auda.org.au/ and outputs clean JSON.
//
// 2. In n8n (Code Node):
//    - Language: JavaScript | Mode: "Run Once for All Items"
//    - Paste this entire file into your n8n Code node.
//    - Set WHOIS_BRIDGE_URL to your whois-server.js address (e.g. 'http://localhost:3000')
//      or your tunnel URL (e.g. 'https://your-tunnel.loca.lt').
// ==============================================================================

const WHOIS_BRIDGE_URL = process.env.WHOIS_BRIDGE_URL || 'http://localhost:3000';

// Attempt to load the core WHOIS library if running in local Node.js environment
let localWhois = null;
try {
  localWhois = require('./whoisau');
} catch (_) {}

// ------------------------------------------------------------------------------
// Helper: Clean domain name input
// ------------------------------------------------------------------------------
const extractCleanDomain = (input) => {
  if (!input || typeof input !== 'string') return '';
  let d = input.trim().toLowerCase();
  d = d.replace(/^https?:\/\//i, '');
  d = d.replace(/^[^\/@]+@/, '');
  d = d.split('/')[0].split('?')[0].split('#')[0].split(':')[0].trim();
  d = d.replace(/^www\./i, '');
  return d;
};

// ------------------------------------------------------------------------------
// Helper: Format Bridge URL
// ------------------------------------------------------------------------------
const formatBridgeUrl = (baseUrl, domain) => {
  let base = (baseUrl || 'http://localhost:3000').trim();
  if (base.includes('?domain=')) {
    return base + encodeURIComponent(domain);
  }
  if (base.includes('?')) {
    return base + '&domain=' + encodeURIComponent(domain);
  }
  base = base.replace(/\/+$/, '');
  if (base.endsWith('/whois')) {
    return base + '?domain=' + encodeURIComponent(domain);
  }
  return base + '/whois?domain=' + encodeURIComponent(domain);
};

// ------------------------------------------------------------------------------
// Helper: Universal HTTP Request for n8n / Fallback
// ------------------------------------------------------------------------------
const fetchBridgeJson = async (url, timeoutMs = 45000) => {
  // 1. n8n native httpRequest
  if (typeof this !== 'undefined' && this && this.helpers && typeof this.helpers.httpRequest === 'function') {
    return await this.helpers.httpRequest({
      url,
      method: 'GET',
      json: true,
      timeout: timeoutMs,
      skipSslCertificateValidation: true,
      ignoreHttpStatusErrors: true
    });
  }

  // 2. Global fetch fallback
  if (typeof fetch === 'function') {
    let timer = null;
    let signal = undefined;
    if (typeof AbortController !== 'undefined') {
      const controller = new AbortController();
      timer = setTimeout(() => controller.abort(), timeoutMs);
      signal = controller.signal;
    }

    try {
      const res = await fetch(url, { method: 'GET', signal });
      if (timer) clearTimeout(timer);
      if (res.ok) {
        return await res.json();
      }
      return null;
    } catch (_) {
      return null;
    }
  }

  return null;
};

// ------------------------------------------------------------------------------
// Core Lookup Function for https://whois.auda.org.au/
// ------------------------------------------------------------------------------
const lookupAudaWhois = async (domain) => {
  // If running locally in Node.js with Puppeteer available, query directly
  if (localWhois && typeof localWhois.getWhoisDetails === 'function') {
    const res = await localWhois.getWhoisDetails(domain, { silent: true });
    return {
      domain: res.domain,
      source: res.source,
      ...res.details
    };
  }

  // Otherwise (e.g. inside n8n Code node), query the whois-server.js bridge
  const bridgeUrl = formatBridgeUrl(WHOIS_BRIDGE_URL, domain);
  const bridgeData = await fetchBridgeJson(bridgeUrl, 45000);

  if (bridgeData && !bridgeData.error) {
    return bridgeData;
  }

  throw new Error(
    bridgeData?.error ||
    `Unable to reach whois.auda.org.au via Bridge Server (${WHOIS_BRIDGE_URL}). Ensure 'node whois-server.js' is running.`
  );
};

// ==============================================================================
// Main Pipeline Execution
// ==============================================================================
const runPipeline = async () => {
  let items = [];

  // Detect execution environment (n8n vs CLI)
  if (typeof $input !== 'undefined' && typeof $input.all === 'function') {
    items = $input.all();
  } else if (typeof $input !== 'undefined' && $input.item) {
    items = [$input.item];
  } else if (typeof items !== 'undefined' && Array.isArray(items) && items.length > 0) {
    // Legacy n8n environment
  } else if (typeof process !== 'undefined' && process.argv && process.argv[2]) {
    // CLI execution
    items = [{ json: { domain: process.argv[2] } }];
  } else {
    items = [];
  }

  if (items.length === 0) {
    return [];
  }

  for (const item of items) {
    if (!item || !item.json) continue;

    const rawTarget = item.json.Website || item.json.website ||
                      item.json.Domain || item.json.domain ||
                      item.json.URL || item.json.url ||
                      item.json['Domain Name'] || item.json['domain_name'] ||
                      item.json['Company Domain'] || item.json['Site'] ||
                      (typeof item.json === 'string' ? item.json : '');

    const domain = extractCleanDomain(rawTarget);
    if (!domain) continue;

    try {
      // Query https://whois.auda.org.au/ directly
      const whoisData = await lookupAudaWhois(domain);

      // Merge all raw WHOIS fields from whois.auda.org.au
      Object.assign(item.json, whoisData);

      // Set standard normalized convenience fields
      const regContactName = whoisData['Registrant Contact Name'];
      const registrant = whoisData['Registrant'];
      item.json.Name = (Array.isArray(regContactName) ? regContactName[0] : regContactName) ||
                       (Array.isArray(registrant) ? registrant[0] : registrant) || '';

      const regContactEmail = whoisData['Registrant Contact Email'];
      const techContactEmail = whoisData['Tech Contact Email'];
      item.json.Email = (Array.isArray(regContactEmail) ? regContactEmail[0] : regContactEmail) ||
                        (Array.isArray(techContactEmail) ? techContactEmail[0] : techContactEmail) || '';

      item.json.Registrant_ID = whoisData['Registrant ID'] || whoisData['Eligibility ID'] || '';
      item.json.Eligibility_Type = whoisData['Eligibility Type'] || '';
      item.json.Eligibility_Name = whoisData['Eligibility Name'] || '';
      item.json.WHOIS_Source = whoisData.source || 'web';
    } catch (err) {
      item.json.error = err.message;
      item.json.Domain = domain;
    }
  }

  return items;
};

// ------------------------------------------------------------------------------
// Unified Entrypoint: Node.js CLI vs n8n Code Node
// ------------------------------------------------------------------------------
if (typeof require !== 'undefined' && require.main === module) {
  // CLI Execution: node whoisaun8n.js <domain>
  if (!process.argv[2]) {
    console.error('Usage: node whoisaun8n.js <domain>');
    console.error('Example: node whoisaun8n.js suntechsynergy.com.au');
    process.exit(1);
  }

  runPipeline()
    .then(items => {
      if (items.length === 1) {
        console.log(JSON.stringify(items[0].json, null, 2));
      } else {
        console.log(JSON.stringify(items.map(i => i.json), null, 2));
      }
    })
    .catch(err => {
      console.error(JSON.stringify({ error: err.message }, null, 2));
      process.exit(1);
    });
} else {
  // n8n Code Node Execution
  return runPipeline();
}
