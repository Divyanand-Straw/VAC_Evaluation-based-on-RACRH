import fs from 'fs';
import path from 'path';

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

  const { token } = body;

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
