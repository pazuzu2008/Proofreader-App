// api/telegram.js — Telegram bot with voice message support
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(200).json({ ok: true });

  const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
  const GROQ_KEY       = process.env.GROQ_API_KEY;

  async function tg(method, body) {
    const r = await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return r.json();
  }

  async function sendMsg(chatId, text, replyToId) {
    return tg('sendMessage', { chat_id: chatId, text, ...(replyToId ? { reply_to_message_id: replyToId } : {}) });
  }

  async function editMsg(chatId, msgId, text) {
    return tg('editMessageText', { chat_id: chatId, message_id: msgId, text });
  }

  function detectLang(text) {
    const uk = (text.match(/[іїєґ]/gi) || []).length;
    if (uk > 0) return 'uk';
    const cyr = (text.match(/[а-яёА-ЯЁ]/g) || []).length;
    if (cyr > text.length * 0.25) return 'ru';
    return 'en';
  }

  function buildPrompt(text, lang) {
    const LANG_NAME = { en: 'English', ru: 'Russian', uk: 'Ukrainian' };
    const name = LANG_NAME[lang] || 'the source language';
    return `You are a professional proofreader. Proofread and correct the ${name} text. Apply minimal structure only where it genuinely improves clarity. Return ONLY the corrected text in ${name}, no explanations.\n\nOriginal text:\n${text}`;
  }

  async function proofread(text, lang) {
    const prompt = buildPrompt(text, lang);
    // Try Groq first for EN, Gemini first for RU/UK — same routing as before
    const useGroqFirst = (lang === 'en');

    async function tryGroq() {
      const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${GROQ_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'llama-3.3-70b-versatile', messages: [{ role: 'user', content: prompt }], max_tokens: 4096 }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error?.message || 'Groq error');
      return d.choices[0].message.content.trim();
    }

    async function tryGemini() {
      const GEMINI_KEY = process.env.GEMINI_API_KEY;
      const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${GEMINI_KEY}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error?.message || 'Gemini error');
      return d.candidates[0].content.parts[0].text.trim();
    }

    if (useGroqFirst) {
      try { return await tryGroq(); } catch { return await tryGemini(); }
    } else {
      try { return await tryGemini(); } catch { return await tryGroq(); }
    }
  }

  async function transcribeVoice(fileId) {
    // 1. Get file path
    const fileInfo = await (await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/getFile?file_id=${fileId}`)).json();
    if (!fileInfo.ok) throw new Error('Could not get file info');
    const filePath = fileInfo.result.file_path;

    // 2. Download audio
    const audioRes = await fetch(`https://api.telegram.org/file/bot${TELEGRAM_TOKEN}/${filePath}`);
    const audioBuffer = await audioRes.arrayBuffer();

    // 3. Send to Groq Whisper
    const form = new FormData();
    // Telegram sends voice as .oga (OGG Opus) — Groq doesn't accept 'oga', remap to 'ogg'
    const rawExt = (filePath.split('.').pop() || 'ogg').toLowerCase();
    const ext    = rawExt === 'oga' ? 'ogg' : rawExt;
    const mime   = ext === 'mp4' ? 'audio/mp4' : ext === 'wav' ? 'audio/wav' : `audio/ogg`;
    form.append('file', new Blob([audioBuffer], { type: mime }), `voice.${ext}`);
    form.append('model', 'whisper-large-v3');

    const whisperRes = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${GROQ_KEY}` },
      body: form,
    });
    const whisperData = await whisperRes.json();
    if (!whisperRes.ok) throw new Error(whisperData.error?.message || 'Whisper error');
    return whisperData.text;
  }

  try {
    const update = req.body;
    const message = update.message || update.edited_message;
    if (!message) return res.status(200).json({ ok: true });

    const chatId = message.chat.id;
    const msgId  = message.message_id;
    const text   = message.text || '';

    // ── Commands ──
    if (text === '/start' || text === '/help') {
      await sendMsg(chatId, '✏️ Proofreader Bot\n\nSend any text or voice message — I\'ll correct and polish it.\n\nSupports English, Russian, Ukrainian.');
      return res.status(200).json({ ok: true });
    }

    // ── Voice message ──
    if (message.voice || message.audio) {
      const fileId  = (message.voice || message.audio).file_id;
      const waiting = await sendMsg(chatId, '🎙 Transcribing…', msgId);
      try {
        const transcript = await transcribeVoice(fileId);
        if (!transcript?.trim()) {
          await editMsg(chatId, waiting.result.message_id, '⚠️ Could not recognize speech. Try again.');
          return res.status(200).json({ ok: true });
        }
        await editMsg(chatId, waiting.result.message_id, '⏳ Proofreading…');
        const lang   = detectLang(transcript);
        const result = await proofread(transcript, lang);
        await editMsg(chatId, waiting.result.message_id, result);
      } catch (err) {
        await editMsg(chatId, waiting.result.message_id, `❌ Error: ${err.message}`);
      }
      return res.status(200).json({ ok: true });
    }

    // ── Text message ──
    if (!text || text.startsWith('/')) return res.status(200).json({ ok: true });

    const waiting = await sendMsg(chatId, '⏳ Proofreading…', msgId);
    try {
      const lang   = detectLang(text);
      const result = await proofread(text, lang);
      await editMsg(chatId, waiting.result.message_id, result);
    } catch (err) {
      await editMsg(chatId, waiting.result.message_id, `❌ Error: ${err.message}`);
    }

    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error('Telegram handler error:', err);
    return res.status(200).json({ ok: true });
  }
}
