// Cloudflare Worker — DeepL translation proxy
// Deploy: npx wrangler deploy
// Set secret: npx wrangler secret put DEEPL_API_KEY

export default {
  async fetch(request, env) {
    // CORS headers
    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    };

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    if (request.method !== 'POST') {
      return new Response('Method not allowed', { status: 405, headers: corsHeaders });
    }

    try {
      const { text, source_lang, target_lang } = await request.json();

      if (!text) {
        return Response.json({ error: 'Missing text' }, { status: 400, headers: corsHeaders });
      }

      const deeplRes = await fetch('https://api-free.deepl.com/v2/translate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `DeepL-Auth-Key ${env.DEEPL_API_KEY}` },
        body: JSON.stringify({
          text: [text],
          source_lang: source_lang || 'JA',
          target_lang: target_lang || 'EN',
        }),
      });

      if (!deeplRes.ok) {
        const errText = await deeplRes.text();
        return Response.json({ error: `DeepL error: ${deeplRes.status}`, details: errText }, { status: 502, headers: corsHeaders });
      }

      const data = await deeplRes.json();
      const translation = data.translations?.[0]?.text || '';

      return Response.json({ translation }, { headers: corsHeaders });
    } catch (err) {
      return Response.json({ error: err.message }, { status: 500, headers: corsHeaders });
    }
  },
};
