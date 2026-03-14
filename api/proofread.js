export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { systemPrompt, userPrompt, lang, imageBase64, imageMime, outLang, formality, lengthIdx, customCtx, extractOnly } = req.body;

  const geminiKey = process.env.GEMINI_API_KEY;
  const groqKey   = process.env.GROQ_API_KEY;

  const LANG_NAME = { en: 'English', ru: 'Russian', uk: 'Ukrainian', auto: '' };
  const FORMALITY_MAP = ['Formal — professional, polished.', 'Neutral — clear and natural.', 'Casual — friendly and conversational.'];
  const LENGTH_MAP    = ['Concise — trim redundancy.', 'Balanced — preserve original length.', 'Detailed — expand where useful.'];

  // ── Extract only: OCR without proofreading ───────────────────────────────────
  async function fetchGeminiExtract() {
    if (!geminiKey) throw new Error('Gemini key missing');
    const r = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${geminiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          system_instruction: { parts: [{ text: 'Extract ALL text from the image exactly as written, preserving line breaks and structure. Output ONLY the extracted text, nothing else.' }] },
          contents: [{ parts: [
            { inline_data: { mime_type: imageMime || 'image/png', data: imageBase64 } },
            { text: 'Extract all text from this image.' },
          ]}],
          generationConfig: { temperature: 0.1, thinkingConfig: { thinkingBudget: 0 } },
        }),
      }
    );
    const d = await r.json();
    if (!r.ok || d.error) throw new Error(d.error?.message || 'Gemini extract error');
    return d.candidates[0].content.parts[0].text.trim();
  }

  // ── Image mode: Gemini Vision OCR + proofread in one shot ────────────────────
  async function fetchGeminiVision() {
    if (!geminiKey) throw new Error('Gemini key missing');
    const outName = LANG_NAME[outLang] || '';
    const fStr = FORMALITY_MAP[formality ?? 1] || FORMALITY_MAP[1];
    const lStr = LENGTH_MAP[lengthIdx ?? 1]    || LENGTH_MAP[1];
    const ctxLine = customCtx ? `\nContext: ${customCtx}` : '';
    const langInstr = outName
      ? `Extract all text from the image, then translate it to ${outName} and proofread it.`
      : `Extract all text from the image, then proofread and correct it.`;
    const sysPrompt = `You are a text extraction and proofreading tool.
${langInstr}
- Tone: ${fStr}
- Length: ${lStr}
- Preserve the original structure (paragraphs, line breaks)${ctxLine}
Output ONLY the final corrected text. No explanations, no labels.`;

    const r = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${geminiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          system_instruction: { parts: [{ text: sysPrompt }] },
          contents: [{ parts: [
            { inline_data: { mime_type: imageMime || 'image/png', data: imageBase64 } },
            { text: 'Extract and process the text from this image.' },
          ]}],
          generationConfig: { temperature: 0.2, thinkingConfig: { thinkingBudget: 0 } },
        }),
      }
    );
    const d = await r.json();
    if (!r.ok || d.error) throw new Error(d.error?.message || 'Gemini Vision error');
    return d.candidates[0].content.parts[0].text.trim();
  }

  // ── Text mode ────────────────────────────────────────────────────────────────
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
          generationConfig: { temperature: 0.3, thinkingConfig: { thinkingBudget: 0 } },
        }),
      }
    );
    const d = await r.json();
    if (!r.ok || d.error) throw new Error(d.error?.message || 'Gemini error');
    return d.candidates[0].content.parts[0].text.trim();
  }

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
    // Image mode — Gemini Vision only (Groq doesn't support vision)
    if (imageBase64) {
      // extractOnly: just OCR, no proofread (frontend handles step 2 separately)
      const result = extractOnly
        ? await fetchGeminiExtract()
        : await fetchGeminiVision();
      return res.status(200).json({ result });
    }
    // Text mode — Gemini primary, Groq fallback
    if (!systemPrompt || !userPrompt) return res.status(400).json({ error: 'Missing prompt' });
    try {
      const result = await fetchGemini();
      return res.status(200).json({ result });
    } catch (e) {
      console.warn('Gemini failed, falling back to Groq:', e.message);
      const result = await fetchGroq();
      return res.status(200).json({ result });
    }
  } catch (err) {
    return res.status(500).json({ error: 'Failed: ' + err.message });
  }
}
