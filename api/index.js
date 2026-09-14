import fs from 'fs';
import path from 'path';

function loadEnv() {
  ['.env.local', '.env'].forEach(file => {
    try {
      const p = path.join(process.cwd(), file);
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
    } catch(e) {}
  });
}

function getHfToken() {
  loadEnv();
  const token = process.env.HF_TOKEN || process.env.HUGGINGFACE_API_KEY || '';
  return token.trim().replace(/^["']|["']$/g, '');
}

export default async function handler(req, res) {
  // Set CORS Headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }

  const url = req.url || '';

  // Parse Body if needed
  let bodyText = req.body;
  if (typeof bodyText === 'object' && bodyText !== null) {
    // Body already parsed by Vercel
  } else if (typeof bodyText === 'string') {
    try { bodyText = JSON.parse(bodyText); } catch(e) { bodyText = {}; }
  } else {
    bodyText = {};
  }

  // --- 1. Route: /api/test-connection ---
  if (url.includes('/test-connection')) {
    const token = getHfToken();
    if (!token || token === 'hf_your_api_key_here') {
      return res.status(400).json({
        connected: false,
        message: 'Add your Hugging Face API token to connect and run inference with Hugging Face models.'
      });
    }

    const testModel = bodyText.model || 'meta-llama/Llama-3.3-70B-Instruct';

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

  // --- 2. Route: /api/inference ---
  if (url.includes('/inference')) {
    const { model, prompt } = bodyText;

    if (!model || !prompt) {
      return res.status(400).json({ success: false, error: 'Missing model or prompt parameter.' });
    }

    const token = getHfToken();
    if (!token || token === 'hf_your_api_key_here') {
      return res.status(400).json({
        success: false,
        error: 'Add your Hugging Face API token to connect and run inference with Hugging Face models.'
      });
    }

    try {
      // Primary Call: HF Router OpenAI-compatible Endpoint
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
          return res.status(200).json({
            success: true,
            model,
            answer: generatedText,
            source: "Hugging Face Live Serverless API"
          });
        }
      }

      // Legacy Endpoint Fallback
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
          return res.status(200).json({
            success: true,
            model,
            answer: generatedText.trim(),
            source: "Hugging Face Server Inference API"
          });
        }
      }

      const errText = await hfRes.text();
      return res.status(hfRes.status).json({ success: false, error: `HF API (${hfRes.status}): ${errText.substring(0, 150)}` });
    } catch (err) {
      return res.status(500).json({ success: false, error: `Server exception: ${err.message}` });
    }
  }

  // --- 3. Route: /api/save-token ---
  if (url.includes('/save-token')) {
    const { token } = bodyText;

    if (!token || !token.trim()) {
      return res.status(400).json({ success: false, message: 'Token cannot be empty.' });
    }

    const cleanToken = token.trim().replace(/^["']|["']$/g, '');
    process.env.HUGGINGFACE_API_KEY = cleanToken;
    process.env.HF_TOKEN = cleanToken;

    try {
      const envPath = path.join(process.cwd(), '.env.local');
      const envContent = `# Hugging Face API Key for RAG LLM Inference Evaluation\nHUGGINGFACE_API_KEY=${cleanToken}\nHF_TOKEN=${cleanToken}\n`;
      fs.writeFileSync(envPath, envContent, 'utf8');
    } catch (e) {}

    return res.status(200).json({ success: true, message: 'API token saved to session environment.' });
  }

  return res.status(404).json({ error: 'Endpoint not found' });
}
