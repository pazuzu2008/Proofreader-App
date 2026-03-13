<!DOCTYPE html PUBLIC "-//W3C//DTD HTML 4.01//EN" "http://www.w3.org/TR/html4/strict.dtd">
<html>
<head>
  <meta http-equiv="Content-Type" content="text/html; charset=utf-8">
  <meta http-equiv="Content-Style-Type" content="text/css">
  <title></title>
  <meta name="Generator" content="Cocoa HTML Writer">
  <meta name="CocoaVersion" content="2685.4">
  <style type="text/css">
    p.p1 {margin: 0.0px 0.0px 0.0px 0.0px; font: 12.0px Helvetica; -webkit-text-stroke: #000000}
    p.p2 {margin: 0.0px 0.0px 0.0px 0.0px; font: 12.0px Helvetica; -webkit-text-stroke: #000000; min-height: 14.0px}
    span.s1 {font-kerning: none}
  </style>
</head>
<body>
<p class="p1"><span class="s1">export default async function handler(req, res) {</span></p>
<p class="p1"><span class="s1"><span class="Apple-converted-space">  </span>// Разрешаем только POST-запросы</span></p>
<p class="p1"><span class="s1"><span class="Apple-converted-space">  </span>if (req.method !== 'POST') {</span></p>
<p class="p1"><span class="s1"><span class="Apple-converted-space">    </span>return res.status(405).json({ error: 'Method not allowed' });</span></p>
<p class="p1"><span class="s1"><span class="Apple-converted-space">  </span>}</span></p>
<p class="p2"><span class="s1"></span><br></p>
<p class="p1"><span class="s1"><span class="Apple-converted-space">  </span>const { prompt } = req.body;</span></p>
<p class="p1"><span class="s1"><span class="Apple-converted-space">  </span>// Достаем ключ из секретных переменных Vercel</span></p>
<p class="p1"><span class="s1"><span class="Apple-converted-space">  </span>const apiKey = process.env.GEMINI_API_KEY;</span></p>
<p class="p2"><span class="s1"></span><br></p>
<p class="p1"><span class="s1"><span class="Apple-converted-space">  </span>if (!apiKey) {</span></p>
<p class="p1"><span class="s1"><span class="Apple-converted-space">    </span>return res.status(500).json({ error: 'API key is missing on the server' });</span></p>
<p class="p1"><span class="s1"><span class="Apple-converted-space">  </span>}</span></p>
<p class="p2"><span class="s1"></span><br></p>
<p class="p1"><span class="s1"><span class="Apple-converted-space">  </span>try {</span></p>
<p class="p1"><span class="s1"><span class="Apple-converted-space">    </span>const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`;</span></p>
<p class="p2"><span class="s1"><span class="Apple-converted-space">    </span></span></p>
<p class="p1"><span class="s1"><span class="Apple-converted-space">    </span>const geminiRes = await fetch(endpoint, {</span></p>
<p class="p1"><span class="s1"><span class="Apple-converted-space">      </span>method: 'POST',</span></p>
<p class="p1"><span class="s1"><span class="Apple-converted-space">      </span>headers: { 'Content-Type': 'application/json' },</span></p>
<p class="p1"><span class="s1"><span class="Apple-converted-space">      </span>body: JSON.stringify({</span></p>
<p class="p1"><span class="s1"><span class="Apple-converted-space">        </span>contents: [{ parts: [{ text: prompt }] }],</span></p>
<p class="p1"><span class="s1"><span class="Apple-converted-space">        </span>generationConfig: { temperature: 0.4 }</span></p>
<p class="p1"><span class="s1"><span class="Apple-converted-space">      </span>})</span></p>
<p class="p1"><span class="s1"><span class="Apple-converted-space">    </span>});</span></p>
<p class="p2"><span class="s1"></span><br></p>
<p class="p1"><span class="s1"><span class="Apple-converted-space">    </span>const data = await geminiRes.json();</span></p>
<p class="p2"><span class="s1"></span><br></p>
<p class="p1"><span class="s1"><span class="Apple-converted-space">    </span>if (data.error) {</span></p>
<p class="p1"><span class="s1"><span class="Apple-converted-space">      </span>return res.status(500).json({ error: data.error.message });</span></p>
<p class="p1"><span class="s1"><span class="Apple-converted-space">    </span>}</span></p>
<p class="p2"><span class="s1"></span><br></p>
<p class="p1"><span class="s1"><span class="Apple-converted-space">    </span>const resultText = data.candidates[0].content.parts[0].text.trim();</span></p>
<p class="p1"><span class="s1"><span class="Apple-converted-space">    </span>res.status(200).json({ result: resultText });</span></p>
<p class="p2"><span class="s1"><span class="Apple-converted-space">    </span></span></p>
<p class="p1"><span class="s1"><span class="Apple-converted-space">  </span>} catch (error) {</span></p>
<p class="p1"><span class="s1"><span class="Apple-converted-space">    </span>res.status(500).json({ error: error.message });</span></p>
<p class="p1"><span class="s1"><span class="Apple-converted-space">  </span>}</span></p>
<p class="p1"><span class="s1">}</span></p>
</body>
</html>
