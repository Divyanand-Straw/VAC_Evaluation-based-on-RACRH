import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PORT = process.env.PORT || 3000;

function loadEnv() {
  ['.env.local', '.env'].forEach(file => {
    const p = path.join(__dirname, file);
    if (fs.existsSync(p)) {
      const lines = fs.readFileSync(p, 'utf8').split(/\r?\n/);
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const eqIdx = trimmed.indexOf('=');
        if (eqIdx > 0) {
          const key = trimmed.slice(0, eqIdx).trim();
          let val = trimmed.slice(eqIdx + 1).trim().replace(/^["']|["']$/g, '');
          process.env[key] = val;
        }
      }
    }
  });
}

function getHfToken() {
  loadEnv();
  const token = process.env.HF_TOKEN || process.env.HUGGINGFACE_API_KEY || '';
  const clean = token.trim().replace(/^["']|["']$/g, '');
  return clean;
}

const MIME_TYPES = {
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'text/javascript',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml'
};

const server = http.createServer(async (req, res) => {
  const url = req.url.split('?')[0];

  // Enable CORS & JSON headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    return res.end();
  }

  // --- API Endpoint: Test Connection ---
  if (req.method === 'POST' && url === '/api/test-connection') {
    let bodyText = '';
    req.on('data', chunk => bodyText += chunk);
    req.on('end', async () => {
      const token = getHfToken();
      if (!token || token === 'hf_your_api_key_here') {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({
          connected: false,
          message: 'Add your Hugging Face API token to connect and run inference with Hugging Face models.'
        }));
      }

      let payload = {};
      try { payload = JSON.parse(bodyText || '{}'); } catch(e) {}
      const testModel = payload.model || 'meta-llama/Llama-3.3-70B-Instruct';

      try {
        const hfRes = await fetch('https://router.huggingface.co/v1/chat/completions', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            model: testModel,
            messages: [{ role: 'user', content: 'Ping' }],
            max_tokens: 5
          })
        });

        if (hfRes.status === 401) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({
            connected: false,
            message: 'Invalid Hugging Face API Token (401 Unauthorized).'
          }));
        }

        if (hfRes.ok || hfRes.status === 503) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({
            connected: true,
            message: `● Connected successfully to Hugging Face Inference API (${testModel}).`
          }));
        }

        const errTxt = await hfRes.text();
        res.writeHead(hfRes.status, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({
          connected: false,
          message: `Hugging Face API Notice (${hfRes.status}): ${errTxt.substring(0, 150)}`
        }));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({
          connected: false,
          message: `Network/Server Error: ${err.message}`
        }));
      }
    });
    return;
  }

  // --- API Endpoint: Secure Server Inference ---
  if (req.method === 'POST' && url === '/api/inference') {
    let bodyText = '';
    req.on('data', chunk => bodyText += chunk);
    req.on('end', async () => {
      let body = {};
      try { body = JSON.parse(bodyText || '{}'); } catch(e) {}
      const { model, prompt } = body;

      if (!model || !prompt) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ success: false, error: 'Missing model or prompt parameter.' }));
      }

      const token = getHfToken();
      if (!token || token === 'hf_your_api_key_here') {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({
          success: false,
          error: 'Add your Hugging Face API token to connect and run inference with Hugging Face models.'
        }));
      }

      console.log(`🤖 [Server Inference Request] Model: ${model}`);

      try {
        // 1. Primary Call: HF Router v1 Chat Completions Endpoint
        const hfRes = await fetch('https://router.huggingface.co/v1/chat/completions', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            model: model,
            messages: [{ role: 'user', content: prompt }],
            max_tokens: 150,
            temperature: 0.1
          })
        });

        if (hfRes.ok) {
          const data = await hfRes.json();
          let generatedText = data.choices?.[0]?.message?.content || "";
          if (generatedText) {
            if (generatedText.startsWith("Answer:")) {
              generatedText = generatedText.replace(/^Answer:\s*/i, '');
            }
            console.log(`✅ [HF Router Success] ${model} -> Received ${generatedText.length} chars`);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({
              success: true,
              model,
              answer: generatedText,
              source: "Hugging Face Live Serverless API"
            }));
          }
        }

        // 2. Legacy Endpoint Fallback
        const legacyRes = await fetch(`https://api-inference.huggingface.co/models/${model}`, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            inputs: prompt,
            parameters: { max_new_tokens: 150, temperature: 0.1, return_full_text: false }
          })
        });

        if (legacyRes.ok) {
          const result = await legacyRes.json();
          let generatedText = Array.isArray(result) ? result[0]?.generated_text : result?.generated_text;
          if (generatedText) {
            console.log(`✅ [HF Legacy Success] ${model} -> Received output`);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({
              success: true,
              model,
              answer: generatedText.trim(),
              source: "Hugging Face Server Inference API"
            }));
          }
        }

        const errText = await hfRes.text();
        res.writeHead(hfRes.status, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ success: false, error: `HF API (${hfRes.status}): ${errText.substring(0, 150)}` }));

      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ success: false, error: `Server exception: ${err.message}` }));
      }
    });
    return;
  }

  // --- API Endpoint: Save Token to .env.local ---
  if (req.method === 'POST' && url === '/api/save-token') {
    let bodyText = '';
    req.on('data', chunk => bodyText += chunk);
    req.on('end', () => {
      let body = {};
      try { body = JSON.parse(bodyText || '{}'); } catch(e) {}
      const { token } = body;

      if (!token || !token.trim()) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ success: false, message: 'Token cannot be empty.' }));
      }

      const cleanToken = token.trim().replace(/^["']|["']$/g, '');
      const envContent = `# Hugging Face API Key for RAG LLM Inference Evaluation\nHUGGINGFACE_API_KEY=${cleanToken}\nHF_TOKEN=${cleanToken}\n`;

      try {
        fs.writeFileSync(path.join(__dirname, '.env.local'), envContent, 'utf8');
        process.env.HUGGINGFACE_API_KEY = cleanToken;
        process.env.HF_TOKEN = cleanToken;
        console.log("💾 Saved token to .env.local");
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ success: true, message: 'API token saved securely to .env.local' }));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ success: false, message: 'Failed to write .env.local file.' }));
      }
    });
    return;
  }

  // --- Serve Static Files ---
  let filePath = path.join(__dirname, url === '/' ? 'index.html' : url);
  const ext = path.extname(filePath).toLowerCase();
  const contentType = MIME_TYPES[ext] || 'application/octet-stream';

  fs.readFile(filePath, (err, content) => {
    if (err) {
      if (err.code === 'ENOENT') {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('404 Not Found');
      } else {
        res.writeHead(500);
        res.end(`Server Error: ${err.code}`);
      }
    } else {
      res.writeHead(200, { 'Content-Type': contentType });
      res.end(content, 'utf-8');
    }
  });
});

server.listen(PORT, () => {
  const token = getHfToken();
  console.log(`🚀 AI Evaluation Server running at http://localhost:${PORT}`);
  console.log(`🔒 Active Token Status: ${token ? `LOADED from .env.local (${token.substring(0, 7)}...)` : 'NOT SET'}`);
});
