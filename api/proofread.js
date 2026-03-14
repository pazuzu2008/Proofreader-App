export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { systemPrompt, userPrompt, lang } = req.body;
  if (!systemPrompt || !userPrompt) return res.status(400).json({ error: 'Missing prompt' });

  const geminiKey = process.env.GEMINI_API_KEY;
  const groqKey   = process.env.GROQ_API_KEY;

  // Primary: Gemini 2.0 Flash — best quality for all languages
  async function fetchGemini() {
    if (!geminiKey) throw new Error('Gemini key missing');
    const r = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${geminiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          system_instruction: { parts: [{ text: systemPrompt }] },
          contents: [{ parts: [{ text: userPrompt }] }],
          generationConfig: {
            temperature: 0.3,
            thinkingConfig: { thinkingBudget: 0 }, // disable thinking — not needed for proofreading, adds latency
          },
        }),
      }
    );
    const d = await r.json();
    if (!r.ok || d.error) throw new Error(d.error?.message || 'Gemini error');
    return d.candidates[0].content.parts[0].text.trim();
  }

  // Fallback: Groq (Llama 3.3 70B) — kicks in when Gemini hits rate limits
  async function fetchGroq() {
    if (!groqKey) throw new Error('Groq key missing');
    const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${groqKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'moonshotai/kimi-k2-instruct-0905',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user',   content: userPrompt   },
        ],
        temperature: 0.3,
        max_tokens: 4096,
      }),
    });
    const d = await r.json();
    if (!r.ok || d.error) throw new Error(d.error?.message || 'Groq error');
    return d.choices[0].message.content.trim();
  }

  try {
    try {
      const result = await fetchGemini();
      return res.status(200).json({ result });
    } catch (e) {
      console.warn('Gemini failed, falling back to Groq:', e.message);
      const result = await fetchGroq();
      return res.status(200).json({ result });
    }
  } catch (err) {
    return res.status(500).json({ error: 'All AI services failed: ' + err.message });
  }
}
