import fs from 'fs';
import path from 'path';

function getHfToken() {
  const token = process.env.HF_TOKEN || process.env.HUGGINGFACE_API_KEY || '';
  if (token && token.trim()) {
    return token.trim().replace(/^["']|["']$/g, '');
  }
  try {
    const envPath = path.join(process.cwd(), '.env.local');
    if (fs.existsSync(envPath)) {
      const lines = fs.readFileSync(envPath, 'utf8').split(/\r?\n/);
      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed.startsWith('HF_TOKEN=') || trimmed.startsWith('HUGGINGFACE_API_KEY=')) {
          return trimmed.split('=')[1].trim().replace(/^["']|["']$/g, '');
        }
      }
    }
  } catch(e) {}
  return '';
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }

  const token = getHfToken();
  if (!token || token === 'hf_your_api_key_here') {
    return res.status(400).json({
      connected: false,
      message: 'Add your Hugging Face API token to connect and run inference with Hugging Face models.'
    });
  }

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch(e) { body = {}; }
  }
  if (!body) body = {};

  const testModel = body.model || 'meta-llama/Llama-3.3-70B-Instruct';

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
      return res.status(401).json({
        connected: false,
        message: 'Invalid Hugging Face API Token (401 Unauthorized).'
      });
    }

    if (hfRes.ok || hfRes.status === 503) {
      return res.status(200).json({
        connected: true,
        message: `● Connected successfully to Hugging Face Inference API (${testModel}).`
      });
    }

    const errTxt = await hfRes.text();
    return res.status(hfRes.status).json({
      connected: false,
      message: `Hugging Face API Notice (${hfRes.status}): ${errTxt.substring(0, 150)}`
    });
  } catch (err) {
    return res.status(500).json({
      connected: false,
      message: `Network Error: ${err.message}`
    });
  }
}
