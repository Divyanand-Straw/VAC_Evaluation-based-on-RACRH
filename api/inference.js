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

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch(e) { body = {}; }
  }
  if (!body) body = {};

  const { model, prompt } = body;

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
