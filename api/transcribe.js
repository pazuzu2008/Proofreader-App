// api/transcribe.js — Groq Whisper transcription endpoint
export const config = { api: { bodyParser: false } };

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const groqKey = process.env.GROQ_API_KEY;
  if (!groqKey) return res.status(500).json({ error: 'GROQ_API_KEY not configured' });

  try {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const bodyBuffer = Buffer.concat(chunks);
    const contentType = req.headers['content-type'];

    // Parse language from multipart if present, then rebuild form for Groq
    // We pass through the entire body as-is — language field is already in the FormData
    const groqRes = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${groqKey}`,
        'Content-Type': contentType,
      },
      body: bodyBuffer,
    });

    const data = await groqRes.json();
    if (!groqRes.ok) throw new Error(data.error?.message || 'Groq Whisper error');

    return res.status(200).json({ text: data.text });
  } catch (err) {
    console.error('Transcribe error:', err);
    return res.status(500).json({ error: err.message });
  }
}
