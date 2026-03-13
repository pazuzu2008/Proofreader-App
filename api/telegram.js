// api/telegram.js — Proofreader bot with IN/OUT language settings per user
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(200).json({ ok: true });

  const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
  const GROQ_KEY       = process.env.GROQ_API_KEY;
  const GEMINI_KEY     = process.env.GEMINI_API_KEY;

  // ── Per-user settings (in-memory, persists while function is warm) ──────────
  // { chatId: { inLang: 'auto'|'en'|'ru'|'uk', outLang: 'same'|'en'|'ru'|'uk' } }
  if (!global._prUserSettings) global._prUserSettings = {};
  const userSettings = global._prUserSettings;

  function getSettings(chatId) {
    return userSettings[chatId] || { inLang: 'auto', outLang: 'same' };
  }
  function saveSettings(chatId, patch) {
    userSettings[chatId] = { ...getSettings(chatId), ...patch };
  }

  // ── Telegram API helpers ────────────────────────────────────────────────────
  async function tg(method, body) {
    const r = await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return r.json();
  }

  // ── Persistent bottom keyboard ──────────────────────────────────────────────
  const MAIN_KEYBOARD = {
    keyboard: [[{ text: '🌐 Language' }]],
    resize_keyboard: true,
    is_persistent: true,
  };

  function sendMsg(chatId, text, extra = {}) {
    return tg('sendMessage', {
      chat_id: chatId, text, parse_mode: 'HTML',
      reply_markup: MAIN_KEYBOARD,
      ...extra,
    });
  }
  function editMsg(chatId, msgId, text, extra = {}) {
    return tg('editMessageText', { chat_id: chatId, message_id: msgId, text, parse_mode: 'HTML', ...extra });
  }
  function editMarkup(chatId, msgId, reply_markup) {
    return tg('editMessageReplyMarkup', { chat_id: chatId, message_id: msgId, reply_markup });
  }
  function answerCallback(callbackQueryId, text = '') {
    return tg('answerCallbackQuery', { callback_query_id: callbackQueryId, text });
  }


  // ── Language helpers ────────────────────────────────────────────────────────
  const LANG_NAME  = { en: 'English', ru: 'Russian', uk: 'Ukrainian' };
  const IN_OPTS    = [
    { v: 'auto', l: '✨ Auto' },
    { v: 'en',   l: '🇬🇧 EN'  },
    { v: 'ru',   l: '🇷🇺 RU'  },
    { v: 'uk',   l: '🇺🇦 UK'  },
  ];
  const OUT_OPTS   = [
    { v: 'same', l: '↩ Same' },
    { v: 'en',   l: '🇬🇧 EN'  },
    { v: 'ru',   l: '🇷🇺 RU'  },
    { v: 'uk',   l: '🇺🇦 UK'  },
  ];

  function detectLang(text) {
    const uk = (text.match(/[іїєґ]/gi) || []).length;
    if (uk > 0) return 'uk';
    const cyr = (text.match(/[а-яёА-ЯЁ]/g) || []).length;
    if (cyr > text.length * 0.25) return 'ru';
    return 'en';
  }

  function resolveEffectiveLangs(inputText, settings) {
    const effIn  = settings.inLang  === 'auto' ? detectLang(inputText) : settings.inLang;
    const effOut = settings.outLang === 'same' ? effIn : settings.outLang;
    return { effIn, effOut };
  }

  function langSettingsText(chatId) {
    const s = getSettings(chatId);
    const inLabel  = IN_OPTS.find(o => o.v === s.inLang)?.l  || s.inLang;
    const outLabel = OUT_OPTS.find(o => o.v === s.outLang)?.l || s.outLang;
    return `🌐 <b>Language settings</b>\n\n<b>Input:</b>  ${inLabel}\n<b>Output:</b> ${outLabel}`;
  }

  function langKeyboard(chatId) {
    const s = getSettings(chatId);
    const inRow  = IN_OPTS.map(o  => ({ text: s.inLang  === o.v ? `✓ ${o.l}` : o.l,  callback_data: `in:${o.v}`  }));
    const outRow = OUT_OPTS.map(o => ({ text: s.outLang === o.v ? `✓ ${o.l}` : o.l, callback_data: `out:${o.v}` }));
    return {
      inline_keyboard: [
        [{ text: '── Input language ──────', callback_data: 'noop' }],
        inRow,
        [{ text: '── Output language ─────', callback_data: 'noop' }],
        outRow,
        [{ text: '✅ Done', callback_data: 'lang:done' }],
      ],
    };
  }

  // ── Proofreading / translation ──────────────────────────────────────────────
  function buildPrompt(text, effIn, effOut) {
    const translate = effIn !== effOut;
    const outName   = LANG_NAME[effOut] || 'English';
    const inName    = LANG_NAME[effIn]  || 'the source language';
    const instr = translate
      ? `You are a professional translator and editor. Translate the text from ${inName} to ${outName}, then proofread and polish it.`
      : `You are a professional proofreader. Proofread and correct the ${outName} text.`;
    return `${instr}\nApply minimal structure only where it genuinely improves clarity.\nReturn ONLY the final corrected text in ${outName}. No explanations, no labels.\n\nOriginal text:\n${text}`;
  }

  async function proofread(text, effIn, effOut) {
    const prompt = buildPrompt(text, effIn, effOut);
    const useGroqFirst = (effOut === 'en');

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

  // ── Voice transcription ─────────────────────────────────────────────────────
  async function transcribeVoice(fileId, langHint) {
    const fileInfo = await (await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/getFile?file_id=${fileId}`)).json();
    if (!fileInfo.ok) throw new Error('Could not get file info');
    const filePath = fileInfo.result.file_path;
    const audioRes = await fetch(`https://api.telegram.org/file/bot${TELEGRAM_TOKEN}/${filePath}`);
    const audioBuffer = await audioRes.arrayBuffer();
    const form = new FormData();
    const rawExt = (filePath.split('.').pop() || 'ogg').toLowerCase();
    const ext    = rawExt === 'oga' ? 'ogg' : rawExt;
    const mime   = ext === 'mp4' ? 'audio/mp4' : ext === 'wav' ? 'audio/wav' : 'audio/ogg';
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

  // ── Main handler ────────────────────────────────────────────────────────────
  try {
    const update = req.body;

    // ── Callback query (inline keyboard) ────────────────────────────────────
    if (update.callback_query) {
      const cq     = update.callback_query;
      const chatId = cq.message.chat.id;
      const msgId  = cq.message.message_id;
      const data   = cq.data;

      if (data.startsWith('copy:')) {
        // copy feature removed — just ack
        await answerCallback(cq.id);
        return res.status(200).json({ ok: true });
      }
      if (data === 'lang:done') {
        await answerCallback(cq.id, '✅ Saved');
        await editMarkup(chatId, msgId, { inline_keyboard: [] });
        return res.status(200).json({ ok: true });
      }
      if (data.startsWith('in:')) {
        saveSettings(chatId, { inLang: data.slice(3) });
        await answerCallback(cq.id);
        await editMsg(chatId, msgId, langSettingsText(chatId), { reply_markup: langKeyboard(chatId) });
        return res.status(200).json({ ok: true });
      }
      if (data.startsWith('out:')) {
        saveSettings(chatId, { outLang: data.slice(4) });
        await answerCallback(cq.id);
        await editMsg(chatId, msgId, langSettingsText(chatId), { reply_markup: langKeyboard(chatId) });
        return res.status(200).json({ ok: true });
      }
      await answerCallback(cq.id);
      return res.status(200).json({ ok: true });
    }

    // ── Regular message ──────────────────────────────────────────────────────
    const message = update.message || update.edited_message;
    if (!message) return res.status(200).json({ ok: true });

    const chatId   = message.chat.id;
    const msgId    = message.message_id;
    const text     = message.text || '';
    const settings = getSettings(chatId);

    // Commands
    if (text === '/start') {
      // Register bot command menu + set menu button (idempotent)
      tg('setMyCommands', {
        commands: [
          { command: 'lang',  description: '🌐 Set input & output language' },
          { command: 'start', description: '👋 Welcome & help' },
          { command: 'help',  description: '📖 How to use' },
        ]
      }).catch(() => {});
      tg('setChatMenuButton', {
        chat_id: chatId,
        menu_button: { type: 'commands' },
      }).catch(() => {});

      await sendMsg(chatId,
        '✏️ <b>Proofreader Bot</b>\n\n' +
        'Send any text or voice message — I\'ll correct and polish it.\n\n' +
        '🌐 Tap <b>Language</b> button below (or /lang) to choose input &amp; output language.\n' +
        'Example: input RU → output EN will take your Russian voice note and return polished English.\n\n' +
        'Supports 🇬🇧 English · 🇷🇺 Russian · 🇺🇦 Ukrainian'
      );
      return res.status(200).json({ ok: true });
    }

    // "🌐 Language" button tap (same as /lang)
    if (text === '🌐 Language' || text === '/lang' || text === '/language') {
      await sendMsg(chatId, langSettingsText(chatId), { reply_markup: langKeyboard(chatId) });
      return res.status(200).json({ ok: true });
    }
    if (text === '/help') {
      await sendMsg(chatId,
        '✏️ <b>Commands</b>\n\n' +
        '/lang — set input & output language\n' +
        '/start — welcome message\n\n' +
        'Send text or voice — get it proofread/translated.'
      );
      return res.status(200).json({ ok: true });
    }

    // ── Voice message ────────────────────────────────────────────────────────
    if (message.voice || message.audio) {
      const fileId   = (message.voice || message.audio).file_id;
      const statusMsg = await sendMsg(chatId, '🎙 Transcribing…', { reply_to_message_id: msgId });
      const statusId  = statusMsg.result.message_id;
      try {
        const transcript = await transcribeVoice(fileId, settings.inLang);
        if (!transcript?.trim()) {
          await editMsg(chatId, statusId, '⚠️ Could not recognize speech. Try again.');
          return res.status(200).json({ ok: true });
        }
        // Step 1: show transcript
        const { effIn, effOut } = resolveEffectiveLangs(transcript, settings);
        const flagIn  = effIn  === 'ru' ? '🇷🇺' : effIn  === 'uk' ? '🇺🇦' : '🇬🇧';
        const flagOut = effOut === 'ru' ? '🇷🇺' : effOut === 'uk' ? '🇺🇦' : '🇬🇧';
        const langNote = effIn !== effOut
          ? `\n<i>${flagIn} → ${flagOut}</i>`
          : `\n<i>${flagIn}</i>`;
        await editMsg(chatId, statusId, `🎙 <i>${transcript}</i>${langNote}`);

        // Step 2: proofread/translate — new message
        const proofMsg = await sendMsg(chatId, '⏳ Proofreading…');
        const proofId  = proofMsg.result.message_id;
        try {
          const result = await proofread(transcript, effIn, effOut);
          await editMsg(chatId, proofId, result);
        } catch (err) {
          await editMsg(chatId, proofId, `❌ Error: ${err.message}`);
        }
      } catch (err) {
        await editMsg(chatId, statusId, `❌ Error: ${err.message}`);
      }
      return res.status(200).json({ ok: true });
    }

    // ── Text message ─────────────────────────────────────────────────────────
    if (!text || text.startsWith('/')) return res.status(200).json({ ok: true });

    const waitMsg = await sendMsg(chatId, '⏳ Proofreading…', { reply_to_message_id: msgId });
    try {
      const { effIn, effOut } = resolveEffectiveLangs(text, settings);
      const result = await proofread(text, effIn, effOut);
      await editMsg(chatId, waitMsg.result.message_id, result);
    } catch (err) {
      await editMsg(chatId, waitMsg.result.message_id, `❌ Error: ${err.message}`);
    }

    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error('Telegram handler error:', err);
    return res.status(200).json({ ok: true });
  }
}
