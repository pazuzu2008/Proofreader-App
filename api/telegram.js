// api/telegram.js
export const config = { maxDuration: 60 };

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(200).json({ ok: true });

  const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
  const GROQ_KEY       = process.env.GROQ_API_KEY;
  const GEMINI_KEY     = process.env.GEMINI_API_KEY;
  const KV_URL         = process.env.KV_REST_API_URL;
  const KV_TOKEN       = process.env.KV_REST_API_TOKEN;

  // ── Settings: Upstash KV with in-memory cache ────────────────────────────────
  if (!global._prCache) global._prCache = {};

  async function kvGet(key) {
    try {
      const r = await fetch(`${KV_URL}/get/${key}`, {
        headers: { Authorization: `Bearer ${KV_TOKEN}` },
      });
      const d = await r.json();
      return d.result ? JSON.parse(d.result) : null;
    } catch { return null; }
  }

  async function kvSet(key, value) {
    try {
      // Upstash REST: POST /set/key with raw string body
      await fetch(`${KV_URL}/set/${key}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${KV_TOKEN}`, 'Content-Type': 'text/plain' },
        body: JSON.stringify(value),
      });
    } catch {}
  }

  async function getSettings(chatId) {
    if (global._prCache[chatId]) return global._prCache[chatId];
    const s = KV_URL ? await kvGet(`pr_${chatId}`) : null;
    const result = s || { inLang: 'auto', outLang: 'same' };
    global._prCache[chatId] = result;
    return result;
  }

  async function saveSettings(chatId, patch) {
    const cur = await getSettings(chatId);
    const next = { ...cur, ...patch };
    global._prCache[chatId] = next;
    if (KV_URL) kvSet(`pr_${chatId}`, next); // fire-and-forget
  }

  // ── Telegram helpers ─────────────────────────────────────────────────────────
  async function tg(method, body) {
    const r = await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return r.json();
  }

  const MAIN_KB = {
    keyboard: [[{ text: '🌐 Language IN/OUT' }]],
    resize_keyboard: true,
    is_persistent: true,
  };

  function sendHtml(chatId, html, extra = {}) {
    return tg('sendMessage', { chat_id: chatId, text: html, parse_mode: 'HTML', reply_markup: MAIN_KB, ...extra });
  }
  function sendPlain(chatId, text) {
    return tg('sendMessage', { chat_id: chatId, text, reply_markup: MAIN_KB });
  }
  function editHtml(chatId, msgId, html, extra = {}) {
    return tg('editMessageText', { chat_id: chatId, message_id: msgId, text: html, parse_mode: 'HTML', ...extra });
  }
  function deleteMsg(chatId, msgId) {
    return tg('deleteMessage', { chat_id: chatId, message_id: msgId }).catch(() => {});
  }
  function editMarkup(chatId, msgId, reply_markup) {
    return tg('editMessageReplyMarkup', { chat_id: chatId, message_id: msgId, reply_markup });
  }
  function answerCb(id, text = '') {
    return tg('answerCallbackQuery', { callback_query_id: id, text });
  }
  function esc(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  // ── Language config ───────────────────────────────────────────────────────────
  const LANG_NAME = { en: 'English', ru: 'Russian', uk: 'Ukrainian' };
  const IN_OPTS = [
    { v: 'auto', l: '✨ Auto' }, { v: 'en', l: '🇬🇧 EN' },
    { v: 'ru',   l: '🇷🇺 RU'  }, { v: 'uk', l: '🇺🇦 UK' },
  ];
  const OUT_OPTS = [
    { v: 'same', l: '↩ Same' }, { v: 'en', l: '🇬🇧 EN' },
    { v: 'ru',   l: '🇷🇺 RU'  }, { v: 'uk', l: '🇺🇦 UK' },
  ];

  function detectLang(text) {
    if ((text.match(/[іїєґ]/gi) || []).length > 0) return 'uk';
    if ((text.match(/[а-яёА-ЯЁ]/g) || []).length > text.length * 0.25) return 'ru';
    return 'en';
  }
  function resolveLangs(text, s) {
    const effIn  = s.inLang  === 'auto' ? detectLang(text) : s.inLang;
    const effOut = s.outLang === 'same' ? effIn : s.outLang;
    return { effIn, effOut };
  }

  async function langText(chatId) {
    const s = await getSettings(chatId);
    const inL  = IN_OPTS.find(o => o.v === s.inLang)?.l  || s.inLang;
    const outL = OUT_OPTS.find(o => o.v === s.outLang)?.l || s.outLang;
    return `🌐 <b>Language settings</b>\n\n<b>Input:</b>  ${inL}\n<b>Output:</b> ${outL}`;
  }
  async function langKb(chatId) {
    const s = await getSettings(chatId);
    return {
      inline_keyboard: [
        [{ text: '── Input ───────────────', callback_data: 'noop' }],
        IN_OPTS.map(o => ({ text: s.inLang === o.v ? `✓ ${o.l}` : o.l, callback_data: `in:${o.v}` })),
        [{ text: '── Output ──────────────', callback_data: 'noop' }],
        OUT_OPTS.map(o => ({ text: s.outLang === o.v ? `✓ ${o.l}` : o.l, callback_data: `out:${o.v}` })),
        [{ text: '✅ Done', callback_data: 'lang:done' }],
      ],
    };
  }

  // ── AI ───────────────────────────────────────────────────────────────────────
  function buildPrompt(text, effIn, effOut) {
    const outName = LANG_NAME[effOut] || 'English';
    const inName  = LANG_NAME[effIn]  || 'the source language';
    const instr   = effIn !== effOut
      ? `You are a professional translator and editor. Translate from ${inName} to ${outName}, then proofread and polish.`
      : `You are a professional proofreader. Proofread and correct the ${outName} text.`;
    return `${instr}\nReturn ONLY the final corrected text in ${outName}. No explanations.\n\nText:\n${text}`;
  }

  async function proofread(text, effIn, effOut) {
    const prompt = buildPrompt(text, effIn, effOut);
    const useGroqFirst = effOut === 'en';
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

  async function transcribeVoice(fileId, langHint) {
    const info = await (await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/getFile?file_id=${fileId}`)).json();
    if (!info.ok) throw new Error('Could not get file info');
    const filePath    = info.result.file_path;
    const audioBuffer = await (await fetch(`https://api.telegram.org/file/bot${TELEGRAM_TOKEN}/${filePath}`)).arrayBuffer();
    const rawExt = (filePath.split('.').pop() || 'ogg').toLowerCase();
    const ext    = rawExt === 'oga' ? 'ogg' : rawExt;
    const mime   = ext === 'mp4' ? 'audio/mp4' : ext === 'wav' ? 'audio/wav' : 'audio/ogg';
    const form   = new FormData();
    form.append('file', new Blob([audioBuffer], { type: mime }), `voice.${ext}`);
    form.append('model', 'whisper-large-v3');
    if (langHint && langHint !== 'auto') form.append('language', langHint);
    const r = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${GROQ_KEY}` },
      body: form,
    });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error?.message || 'Whisper error');
    return d.text;
  }

  // ── Main ─────────────────────────────────────────────────────────────────────
  try {
    const update = req.body;

    // Callback query
    if (update.callback_query) {
      const cq     = update.callback_query;
      const chatId = cq.message.chat.id;
      const msgId  = cq.message.message_id;
      const data   = cq.data;
      if (data === 'noop')       { await answerCb(cq.id); return res.status(200).json({ ok: true }); }
      if (data === 'lang:done')  { await answerCb(cq.id, '✅ Saved'); await editMarkup(chatId, msgId, { inline_keyboard: [] }); return res.status(200).json({ ok: true }); }
      if (data.startsWith('in:'))  { await saveSettings(chatId, { inLang:  data.slice(3) }); await answerCb(cq.id); await editHtml(chatId, msgId, await langText(chatId), { reply_markup: await langKb(chatId) }); return res.status(200).json({ ok: true }); }
      if (data.startsWith('out:')) { await saveSettings(chatId, { outLang: data.slice(4) }); await answerCb(cq.id); await editHtml(chatId, msgId, await langText(chatId), { reply_markup: await langKb(chatId) }); return res.status(200).json({ ok: true }); }
      await answerCb(cq.id);
      return res.status(200).json({ ok: true });
    }

    const message = update.message || update.edited_message;
    if (!message) return res.status(200).json({ ok: true });

    const chatId   = message.chat.id;
    const msgId    = message.message_id;
    const text     = message.text || '';
    const settings = await getSettings(chatId);

    // /start
    if (text === '/start') {
      tg('setMyCommands', { commands: [
        { command: 'lang',  description: '🌐 Input & output language' },
        { command: 'start', description: '👋 Welcome' },
        { command: 'help',  description: '📖 Help' },
      ]}).catch(() => {});
      await sendHtml(chatId,
        '✏️ <b>Proofreader Bot</b>\n\n' +
        'Send any text or voice message — I\'ll correct and polish it.\n\n' +
        '🌐 Tap <b>Language IN/OUT</b> below to set input &amp; output language.\n' +
        'Example: RU → EN — send Russian voice, get polished English.\n\n' +
        '🇬🇧 English · 🇷🇺 Russian · 🇺🇦 Ukrainian'
      );
      return res.status(200).json({ ok: true });
    }

    // Language button / /lang
    if (text === '🌐 Language IN/OUT' || text === '/lang' || text === '/language') {
      await sendHtml(chatId, await langText(chatId), { reply_markup: await langKb(chatId) });
      return res.status(200).json({ ok: true });
    }

    // /help
    if (text === '/help') {
      await sendHtml(chatId, '✏️ <b>Commands</b>\n\n/lang — language settings\n/start — welcome\n\nSend text or voice → get it proofread/translated.');
      return res.status(200).json({ ok: true });
    }

    // Voice
    if (message.voice || message.audio) {
      const fileId    = (message.voice || message.audio).file_id;
      const statusMsg = await sendHtml(chatId, '🎙 Transcribing…', { reply_to_message_id: msgId });
      const statusId  = statusMsg.result?.message_id;
      try {
        const transcript = await transcribeVoice(fileId, settings.inLang);
        if (!transcript?.trim()) {
          if (statusId) await editHtml(chatId, statusId, '⚠️ Could not recognize speech. Try again.');
          return res.status(200).json({ ok: true });
        }
        const { effIn, effOut } = resolveLangs(transcript, settings);
        const flagIn  = effIn  === 'ru' ? '🇷🇺' : effIn  === 'uk' ? '🇺🇦' : '🇬🇧';
        const flagOut = effOut === 'ru' ? '🇷🇺' : effOut === 'uk' ? '🇺🇦' : '🇬🇧';
        const arrow   = effIn !== effOut ? ` ${flagIn} → ${flagOut}` : ` ${flagIn}`;
        // Delete status, send transcript as msg 1
        if (statusId) await deleteMsg(chatId, statusId);
        await sendHtml(chatId, `🎙 <i>${esc(transcript)}</i>${arrow}`);
        // Send result as msg 2
        const result = await proofread(transcript, effIn, effOut);
        await sendPlain(chatId, result);
      } catch (err) {
        if (statusId) await editHtml(chatId, statusId, `❌ ${esc(err.message)}`);
        else await sendHtml(chatId, `❌ ${esc(err.message)}`);
      }
      return res.status(200).json({ ok: true });
    }

    // Text
    if (!text || text.startsWith('/')) return res.status(200).json({ ok: true });
    try {
      const { effIn, effOut } = resolveLangs(text, settings);
      const result = await proofread(text, effIn, effOut);
      await sendPlain(chatId, result);
    } catch (err) {
      await sendHtml(chatId, `❌ ${esc(err.message)}`);
    }

    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error('Telegram handler error:', err);
    return res.status(200).json({ ok: true });
  }
}
