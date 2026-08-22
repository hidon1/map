export async function onRequestGet(context) {
  const { env, request } = context;

  if (!env.OPENAI_API_KEY) {
    return json({ error: 'OPENAI_API_KEY is not configured' }, 500);
  }

  const cache = caches.default;
  const cacheKey = new Request(new URL('/api/news-cache', request.url).toString(), request);
  const cached = await cache.match(cacheKey);
  if (cached) return cached;

  const prompt = `
אתה עורך חדשות ישראלי. אסוף באמצעות חיפוש אינטרנט חדשות עדכניות מהשעות האחרונות ממגוון מקורות ישראליים, כולל ככל שניתן:
וואלה, ynet, N12, מעריב, ישראל היום, כאן 11, ערוץ 7, כיכר השבת, בחדרי חרדים, JDN ומקורות חדשות ישראליים רלוונטיים נוספים.

החזר JSON בלבד, בלי Markdown, במבנה הבא:
{
  "updatedAt": "ISO-8601",
  "articles": [
    {
      "id": "string",
      "title": "כותרת קצרה בעברית",
      "subtitle": "תקציר של 1-2 משפטים בעברית",
      "category": "חרדים|בארץ|פוליטי|ביטחוני|כלכלה|עולם|טכנולוגיה|ספורט|אחר",
      "source": "שם המקור",
      "publishedAt": "ISO-8601 אם ידוע, אחרת מחרוזת ריקה",
      "url": "קישור ישיר לכתבה",
      "image": "קישור ישיר לתמונה אם נמצא, אחרת מחרוזת ריקה",
      "breaking": true או false
    }
  ]
}

כללים:
- החזר 18 עד 30 כתבות.
- אל תמציא אירועים, מקורות, קישורים או תמונות.
- אם אותו אירוע מופיע בכמה מקורות, העדף מקור אחד ברור או הצג זוויות שונות באמת.
- העדף חדשות טריות ומגוונות.
- אל תעתיק טקסט ארוך מאתרי המקור; כתוב תקציר מקורי וקצר.
- שמור על עברית תקינה וניטרלית.
`;

  const response = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${env.OPENAI_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: env.OPENAI_MODEL || 'gpt-5.6',
      tools: [{ type: 'web_search_preview' }],
      input: prompt,
      temperature: 0.2,
      max_output_tokens: 7000
    })
  });

  if (!response.ok) {
    const detail = await response.text();
    return json({ error: 'OpenAI request failed', detail }, response.status);
  }

  const data = await response.json();
  const outputText = extractOutputText(data);

  let parsed;
  try {
    parsed = JSON.parse(stripCodeFences(outputText));
  } catch (error) {
    return json({ error: 'Could not parse model JSON', raw: outputText }, 502);
  }

  const payload = normalizePayload(parsed);
  const result = json(payload, 200, {
    'Cache-Control': 'public, max-age=300',
    'Access-Control-Allow-Origin': '*'
  });

  context.waitUntil(cache.put(cacheKey, result.clone()));
  return result;
}

export async function onRequestOptions() {
  return new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type'
    }
  });
}

function extractOutputText(data) {
  if (typeof data.output_text === 'string') return data.output_text;
  for (const item of data.output || []) {
    if (item.type !== 'message') continue;
    for (const part of item.content || []) {
      if (part.type === 'output_text' && typeof part.text === 'string') return part.text;
    }
  }
  return '';
}

function stripCodeFences(text) {
  return String(text || '')
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '')
    .trim();
}

function normalizePayload(input) {
  const articles = Array.isArray(input?.articles) ? input.articles : [];
  const cleaned = articles
    .filter(a => a && a.title && a.source)
    .slice(0, 30)
    .map((a, i) => ({
      id: String(a.id || `${Date.now()}-${i}`),
      title: String(a.title || '').trim(),
      subtitle: String(a.subtitle || '').trim(),
      category: String(a.category || 'אחר').trim(),
      source: String(a.source || '').trim(),
      publishedAt: String(a.publishedAt || ''),
      url: String(a.url || ''),
      image: String(a.image || ''),
      breaking: Boolean(a.breaking)
    }));

  return {
    updatedAt: input?.updatedAt || new Date().toISOString(),
    articles: cleaned
  };
}

function json(body, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      ...extraHeaders
    }
  });
}
