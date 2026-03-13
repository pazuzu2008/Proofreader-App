export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // Теперь сервер принимает и текст (prompt), и язык (lang)
  const { prompt, lang } = req.body; 
  const geminiKey = process.env.GEMINI_API_KEY;
  const groqKey = process.env.GROQ_API_KEY;

  if (!geminiKey && !groqKey) {
    return res.status(500).json({ error: 'No API keys configured on the server' });
  }

  // Логика запроса к Gemini
  async function fetchGemini() {
    if (!geminiKey) throw new Error("Gemini key missing");
    const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${geminiKey}`;
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.4 }
      })
    });
    const data = await response.json();
    if (!response.ok || data.error) throw new Error(data.error?.message || 'Gemini error');
    return data.candidates[0].content.parts[0].text.trim();
  }

  // Логика запроса к Groq
  async function fetchGroq() {
    if (!groqKey) throw new Error("Groq key missing");
    const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${groqKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: "llama3-70b-8192", 
        messages: [{ role: "user", content: prompt }],
        temperature: 0.4
      })
    });
    const data = await response.json();
    if (!response.ok || data.error) throw new Error(data.error?.message || 'Groq error');
    return data.choices[0].message.content.trim();
  }

  // ИНТЕЛЛЕКТУАЛЬНЫЙ РОУТИНГ
  try {
    let result;

    if (lang === 'en' && groqKey) {
      // Если английский -> пробуем быстрый Groq
      try {
        result = await fetchGroq();
      } catch (e) {
        console.log("Groq failed for English, fallback to Gemini", e.message);
        result = await fetchGemini(); // Страховка
      }
    } else {
      // Если русский/украинский -> пробуем умный Gemini
      try {
        result = await fetchGemini();
      } catch (e) {
        console.log("Gemini failed for RU/UK, fallback to Groq", e.message);
        result = await fetchGroq(); // Страховка
      }
    }

    return res.status(200).json({ result: result });

  } catch (finalError) {
    return res.status(500).json({ error: "All AI services failed: " + finalError.message });
  }
}
