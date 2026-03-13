// api/telegram.js — Vercel Serverless Function (Telegram Webhook)
//
// Setup (one-time):
//   1. Create bot via @BotFather → get TELEGRAM_BOT_TOKEN
//   2. Add to Vercel env vars: TELEGRAM_BOT_TOKEN, GEMINI_API_KEY, GROQ_API_KEY
//   3. Set webhook:
//      curl "https://api.telegram.org/bot<TOKEN>/setWebhook?url=https://<your-vercel-url>/api/telegram"

const TONE_EN  = ["Formal", "Neutral", "Casual", "Friendly"];
const LEVEL_EN = ["Simple", "Standard", "Advanced"];

const PROMPT = {
  en: (text, tone, level, ctx) =>
    `You are a professional proofreader. Proofread and correct the following text.${ctx ? ` Document type: ${ctx}.` : ''} Tone: ${tone}. Language level: ${level}. Return ONLY the corrected English text, no explanations.\n\nText:\n${text}`,
  ru: (text, tone, level, ctx) =>
    `Ты профессиональный корректор. Проверь и исправь следующий текст.${ctx ? ` Тип документа: ${ctx}.` : ''} Тон: ${tone}. Уровень: ${level}. Верни ТОЛЬКО исправленный текст на русском, без объяснений.\n\nТекст:\n${text}`,
  uk: (text, tone, level, ctx) =>
    `Ти професійний коректор. Перевір та виправ наступний текст.${ctx ? ` Тип документа: ${ctx}.` : ''} Тон: ${tone}. Рівень: ${level}. Поверни ЛИШЕ виправлений текст українською, без пояснень.\n\nТекст:\n${text}`,
};

const HELP = {
  en: `*Proofreader Bot* ✍️\n\nSend me any text and I'll proofread it instantly.\n\nThe language is detected automatically. After proofreading, use the buttons to re-run in a specific language.\n\n*Commands:*\n/start — Welcome message\n/help — Show this message`,
  ru: `*Пруфридер Бот* ✍️\n\nОтправь мне любой текст — я его исправлю.\n\nЯзык определяется автоматически. После проверки используй кнопки для переключения языка.\n\n*Команды:*\n/start — Приветствие\n/help — Это сообщение`,
  uk: `*Пруфрідер Бот* ✍️\n\nНадішли мені будь-який текст — я його виправлю.\n\nМова визначається автоматично. Після перевірки використай кнопки для зміни мови.\n\n*Команди:*\n/start — Привітання\n/help — Це повідомлення`,
};

// ── Language detection (simple heuristic) ───────────────────
function detectLang(text) {
  const ukChars = (text.match(/[іїєґ]/gi) || []).length;
  if (ukChars > 0) return 'uk';
  const cyrillic = (text.match(/[а-яё]/gi) || []).length;
  if (cyrillic > text.length * 0.3) return 'ru';
  return 'en';
}

// ── Inline keyboard ─────────────────────────────────────────
function langKeyboard(activeLang) {
  const langs = [
    { code: 'en', label: '🇬🇧 English' },
    { code: 'ru', label: '🇷🇺 Русский' },
    { code: 'uk', label: '🇺🇦 Українська' },
  ];
  return {
    inline_keyboard: [
      langs.map(l => ({
        text: (l.code === activeLang ? '✓ ' : '') + l.label,
        callback_data: `lang:${l.code}`
      }))
    ]
  };
}

// ── AI call ──────────────────────────────────────────────────
async function proofread(text, lang, tone = 'Neutral', level = 'Standard', ctx = '') {
  const geminiKey = process.env.GEMINI_API_KEY;
  const groqKey   = process.env.GROQ_API_KEY;
  const prompt    = PROMPT[lang](text, tone, level, ctx);

  async function fetchGemini() {
    const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${geminiKey}`;
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.4 }
      })
    });
    const data = await res.json();
    if (!res.ok || data.error) throw new Error(data.error?.message || 'Gemini error');
    return data.candidates[0].content.parts[0].text.trim();
  }

  async function fetchGroq() {
    const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${groqKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'llama3-70b-8192',
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.4
      })
    });
    const data = await res.json();
    if (!res.ok || data.error) throw new Error(data.error?.message || 'Groq error');
    return data.choices[0].message.content.trim();
  }

  if (lang === 'en' && groqKey) {
    try { return await fetchGroq(); } catch { return await fetchGemini(); }
  } else {
    try { return await fetchGemini(); } catch { return await fetchGroq(); }
  }
}

// ── Telegram API helpers ──────────────────────────────────────
async function tgCall(method, body) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const res   = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  return res.json();
}

async function sendMessage(chat_id, text, extra = {}) {
  return tgCall('sendMessage', { chat_id, text, parse_mode: 'Markdown', ...extra });
}

async function editMessage(chat_id, message_id, text, extra = {}) {
  return tgCall('editMessageText', { chat_id, message_id, text, parse_mode: 'Markdown', ...extra });
}

async function answerCallback(callback_query_id, text = '') {
  return tgCall('answerCallbackQuery', { callback_query_id, text });
}

// ── Main handler ──────────────────────────────────────────────
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(200).json({ ok: true });
  if (!process.env.TELEGRAM_BOT_TOKEN) return res.status(500).json({ error: 'No bot token' });

  const update = req.body;

  try {
    // ── Callback query (user clicked a language button) ──────
    if (update.callback_query) {
      const { id, data, message } = update.callback_query;
      const [action, value]       = data.split(':');

      if (action !== 'lang') { await answerCallback(id); return res.status(200).json({ ok: true }); }

      const lang      = value;
      const chat_id   = message.chat.id;
      const msg_id    = message.message_id;
      // Original text is in the message this bot replied to
      const origText  = message.reply_to_message?.text;

      if (!origText) {
        await answerCallback(id, 'Cannot find original text');
        return res.status(200).json({ ok: true });
      }

      await answerCallback(id, '⏳ Proofreading...');
      await editMessage(chat_id, msg_id, '⏳ Proofreading...', {});

      try {
        const result = await proofread(origText, lang);
        await editMessage(chat_id, msg_id, `✅ *Result (${lang.toUpperCase()}):*\n\n${result}`, {
          reply_markup: langKeyboard(lang)
        });
      } catch (err) {
        await editMessage(chat_id, msg_id, `❌ Error: ${err.message}`);
      }

      return res.status(200).json({ ok: true });
    }

    // ── Regular message ──────────────────────────────────────
    if (update.message) {
      const { chat, text, message_id } = update.message;
      if (!text) return res.status(200).json({ ok: true });

      const chat_id = chat.id;

      // Commands
      if (text.startsWith('/start')) {
        await sendMessage(chat_id, HELP.en);
        return res.status(200).json({ ok: true });
      }
      if (text.startsWith('/help')) {
        await sendMessage(chat_id, HELP.en);
        return res.status(200).json({ ok: true });
      }

      // Skip other commands
      if (text.startsWith('/')) return res.status(200).json({ ok: true });

      // Proofread
      const lang   = detectLang(text);
      const typing = await tgCall('sendChatAction', { chat_id, action: 'typing' });

      const waitMsg = await sendMessage(chat_id, '⏳ Proofreading...', {
        reply_to_message_id: message_id
      });

      try {
        const result = await proofread(text, lang);
        await editMessage(chat_id, waitMsg.result.message_id,
          `✅ *Result (${lang.toUpperCase()}):*\n\n${result}`,
          { reply_markup: langKeyboard(lang) }
        );
      } catch (err) {
        await editMessage(chat_id, waitMsg.result.message_id, `❌ Error: ${err.message}`);
      }
    }
  } catch (err) {
    console.error('Telegram handler error:', err);
  }

  return res.status(200).json({ ok: true });
}
