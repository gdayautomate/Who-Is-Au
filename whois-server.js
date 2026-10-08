const http = require('http');
const url = require('url');
const { getWhoisDetails } = require('./whoisau');

const PORT = process.env.PORT || 3000;

/**
 * Lightweight HTTP server exposing getWhoisDetails for n8n workflows
 * Usage: node whois-server.js
 * Endpoint: http://localhost:3000/whois?domain=example.com.au
 */
const server = http.createServer(async (req, res) => {
  const parsedUrl = url.parse(req.url, true);

  // Enable CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Content-Type', 'application/json');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  if (parsedUrl.pathname === '/whois') {
    const domain = parsedUrl.query.domain;
    if (!domain) {
      res.writeHead(400);
      res.end(JSON.stringify({ error: 'Missing domain parameter (e.g. /whois?domain=example.com.au)' }));
      return;
    }

    try {
      console.log(`[WHOIS Server] Incoming request for: ${domain}`);
      const result = await getWhoisDetails(domain, { silent: true });
      const regContactName = result.details['Registrant Contact Name'];
      const registrant = result.details['Registrant'];
      const name = (Array.isArray(regContactName) ? regContactName[0] : regContactName) ||
                   (Array.isArray(registrant) ? registrant[0] : registrant) || '';

      const regContactEmail = result.details['Registrant Contact Email'];
      const techContactEmail = result.details['Tech Contact Email'];
      const email = (Array.isArray(regContactEmail) ? regContactEmail[0] : regContactEmail) ||
                    (Array.isArray(techContactEmail) ? techContactEmail[0] : techContactEmail) || '';

      res.writeHead(200);
      res.end(JSON.stringify({
        domain: result.domain,
        source: result.source,
        ...result.details,
        Name: name,
        Email: email,
        Registrant_ID: result.details['Registrant ID'] || result.details['Eligibility ID'] || '',
        Eligibility_Type: result.details['Eligibility Type'] || '',
        Eligibility_Name: result.details['Eligibility Name'] || '',
        WHOIS_Source: result.source || 'web'
      }));
    } catch (err) {
      res.writeHead(500);
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  res.writeHead(404);
  res.end(JSON.stringify({ error: 'Endpoint not found. Use /whois?domain=...' }));
});

server.listen(PORT, () => {
  console.log(`[WHOIS Server] Running on http://localhost:${PORT}`);
  console.log(`[WHOIS Server] Example: http://localhost:${PORT}/whois?domain=pbengineering.com.au`);
});
