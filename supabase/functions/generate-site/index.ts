// generate-site — single Claude build call (or Edit for follow-up chat messages)
import { corsHeaders } from '../_shared/cors.ts';
import { adminClient, getUser, PLAN_LIMITS } from '../_shared/auth.ts';

const MODEL = Deno.env.get('ANTHROPIC_MODEL') ?? 'claude-sonnet-4-5';
const ANTHROPIC_VERSION = '2023-06-01';

// ─────────────────────────────────────────────────────────────────────────────
// LANGUAGE DETECTION
// ─────────────────────────────────────────────────────────────────────────────

interface LangInfo { code: string; name: string; nativeName: string; }

function detectLanguage(location: string, businessName: string, prompt: string): LangInfo {
  const t = `${location} ${businessName} ${prompt}`.toLowerCase();
  if (/\b(sweden|sverige|stockholm|göteborg|gothenburg|malmö|karlstad|uppsala|linköping|västerås|örebro|helsingborg|norrköping|jönköping|umeå|lund|borås|sundsvall|gävle|eskilstuna|södertälje|huddinge|nacka|täby|solna|sundbyberg|kista|järfälla|lidingö|botkyrka|haninge|sollentuna|tyresö|upplands|sigtuna|vallentuna|norrtälje|nyköping|värnamo|skövde|trollhättan|halmstad|kalmar|växjö|kristianstad|falun|borlänge|östersund|luleå|gällivare|kiruna)\b/.test(t)) return { code: 'sv', name: 'Swedish', nativeName: 'Svenska' };
  if (/\b(norway|norge|oslo|bergen|trondheim|stavanger|tromsø|drammen|fredrikstad|kristiansand|sandnes|ålesund|tønsberg|moss|porsgrunn|skien|bodø|arendal|haugesund|sandefjord|larvik|sarpsborg|lillehammer|gjøvik)\b/.test(t)) return { code: 'no', name: 'Norwegian', nativeName: 'Norsk' };
  if (/\b(denmark|danmark|copenhagen|københavn|aarhus|odense|aalborg|esbjerg|randers|kolding|horsens|vejle|roskilde|helsingør|silkeborg|herning|næstved|fredericia|viborg|køge|holstebro|taastrup|slagelse|holbæk|sønderborg|hvidovre|ballerup|gladsaxe|hillerød|frederiksberg)\b/.test(t)) return { code: 'da', name: 'Danish', nativeName: 'Dansk' };
  if (/\b(finland|suomi|helsinki|tampere|turku|oulu|jyväskylä|lahti|espoo|vantaa|kuopio|joensuu|lappeenranta|hämeenlinna|vaasa|seinäjoki|rovaniemi|mikkeli|kotka|salo|porvoo|kouvola|pori|hyvinkää)\b/.test(t)) return { code: 'fi', name: 'Finnish', nativeName: 'Suomi' };
  if (/\b(germany|deutschland|berlin|munich|münchen|hamburg|frankfurt|cologne|köln|düsseldorf|stuttgart|dortmund|essen|leipzig|bremen|dresden|hannover|nuremberg|nürnberg|duisburg|bochum|wuppertal|bielefeld|bonn|mannheim|karlsruhe|augsburg|wiesbaden|gelsenkirchen|mönchengladbach|braunschweig|kiel|chemnitz|aachen|halle|magdeburg|freiburg|krefeld|lübeck|oberhausen|erfurt|mainz|rostock|kassel|hagen|saarbrücken|hamm|osnabrück|solingen|ludwigshafen|leverkusen|oldenburg|neuss|paderborn|heidelberg|darmstadt|regensburg|ingolstadt|würzburg|fürth|wolfsburg|ulm|heilbronn|göttingen|recklinghausen|reutlingen)\b/.test(t)) return { code: 'de', name: 'German', nativeName: 'Deutsch' };
  if (/\b(austria|österreich|vienna|wien|graz|linz|salzburg|innsbruck|klagenfurt|wels|st\.?\s*pölten|dornbirn|steyr|wiener neustadt|feldkirch|bregenz|leonding|klosterneuburg|leoben|traun|amstetten)\b/.test(t)) return { code: 'de', name: 'German', nativeName: 'Deutsch' };
  if (/\b(switzerland|schweiz|zurich|zürich|geneva|genf|genève|basel|bern|lausanne|winterthur|lucerne|luzern|st\.?\s*gallen|lugano|biel|thun|köniz|la chaux-de-fonds|schaffhausen|fribourg|vernier|chur|neuchâtel|uster|sion)\b/.test(t)) return { code: 'de', name: 'German', nativeName: 'Deutsch' };
  if (/\b(france|paris|lyon|marseille|toulouse|nice|nantes|strasbourg|montpellier|bordeaux|lille|rennes|reims|toulon|grenoble|dijon|angers|nîmes|villeurbanne|saint-denis|clermont-ferrand|le havre|amiens|limoges|tours|metz|besançon|perpignan|brest|rouen|argenteuil|montreuil|caen|nancy|roubaix|tourcoing|nanterre|avignon|créteil|poitiers|cannes|colombes|courbevoie|mulhouse|pau|la rochelle|rueil-malmaison|saint-nazaire|mérignac|orléans|calais|antibes)\b/.test(t)) return { code: 'fr', name: 'French', nativeName: 'Français' };
  if (/\b(spain|españa|madrid|barcelona|valencia|seville|sevilla|zaragoza|málaga|murcia|palma|las palmas|bilbao|alicante|córdoba|valladolid|vigo|gijón|vitoria|granada|a coruña|elche|oviedo|badalona|cartagena|terrassa|jerez|sabadell|santa cruz de tenerife|pamplona|almería|leganés|fuenlabrada|san sebastián|getafe|burgos|albacete|castellón|alcalá de henares|alcorcón|logroño|badajoz|huelva|mataró|santa coloma|reus|dos hermanas|torrejón)\b/.test(t)) return { code: 'es', name: 'Spanish', nativeName: 'Español' };
  if (/\b(italy|italia|rome|roma|milan|milano|naples|napoli|turin|torino|palermo|genoa|genova|bologna|florence|firenze|bari|catania|venice|venezia|verona|messina|padua|padova|trieste|taranto|brescia|reggio calabria|modena|prato|parma|livorno|cagliari|foggia|salerno|rimini|perugia|ferrara|bergamo|trento|vicenza|bolzano|ravenna|novara|ancona|reggio emilia|lecce|pescara|siracusa|udine|sassari|monza|andria|giugliano|schio|como|la spezia|arezzo|pisa|pistoia|terni|brindisi|pesaro|alessandria)\b/.test(t)) return { code: 'it', name: 'Italian', nativeName: 'Italiano' };
  if (/\b(portugal|lisboa|lisbon|porto|amadora|braga|setúbal|coimbra|funchal|almada|aveiro|guimarães|póvoa de varzim|barreiro|loures|maia|leiria|montijo|matosinhos|gondomar|sintra|cascais|oeiras|vila nova de gaia|odivelas|queluz|agualva|cacém)\b/.test(t)) return { code: 'pt', name: 'Portuguese', nativeName: 'Português' };
  if (/\b(brazil|brasil|são paulo|rio de janeiro|brasília|salvador|fortaleza|belo horizonte|manaus|curitiba|recife|porto alegre|belém|goiânia|guarulhos|campinas|são luís|maceió|natal|teresina|campo grande|joão pessoa|santo andré|osasco|jaboatão|são bernardo|duque de caxias|uberlândia|aparecida de goiânia|sorocaba|niterói)\b/.test(t)) return { code: 'pt', name: 'Portuguese', nativeName: 'Português' };
  if (/\b(netherlands|nederland|amsterdam|rotterdam|the hague|den haag|utrecht|eindhoven|tilburg|groningen|almere|breda|nijmegen|enschede|apeldoorn|haarlem|arnhem|zaanstad|amersfoort|haarlemmermeer|'s-hertogenbosch|zwolle|zoetermeer|leiden|maastricht|dordrecht|ede|middelburg|delft|deventer|helmond|alkmaar|venlo|leeuwarden|emmen|westland|sittard|oss|roosendaal|heerlen|capelle aan den ijssel|spijkenisse|purmerend|schiedam|leidschendam|voorburg|hoorn|alphen aan den rijn|delft|hilversum|hengelo|velsen|vlaardingen|zaandam|gouda)\b/.test(t)) return { code: 'nl', name: 'Dutch', nativeName: 'Nederlands' };
  if (/\b(poland|polska|warsaw|warszawa|kraków|krakow|łódź|wrocław|wroclaw|poznań|poznan|gdańsk|gdansk|szczecin|bydgoszcz|lublin|białystok|katowice|gdynia|częstochowa|radom|sosnowiec|toruń|torun|kielce|rzeszów|gliwice|zabrze|bytom|olsztyn|bielsko-biała|zielona góra|rybnik|ruda śląska|opole|tychy|płock|elbląg|wałbrzych|włocławek|chorzów|tarnów|koszalin|kalisz|legnica)\b/.test(t)) return { code: 'pl', name: 'Polish', nativeName: 'Polski' };
  return { code: 'en', name: 'English', nativeName: 'English' };
}

// ─────────────────────────────────────────────────────────────────────────────
// HTML BUILD — open prompt; the model designs freely, like a direct Claude chat
// ─────────────────────────────────────────────────────────────────────────────

function buildSystemPrompt(lang: LangInfo): string {
  return `You are an expert web designer and developer. Build a complete, polished, single-page marketing website for the business described by the user.

Recognise the business type and design something genuinely appropriate and distinctive for it. A coffee shop, a law firm, a tattoo studio, a dentist, and a gym should each get a clearly different result — different layout, section order, color palette, typography, and mood. Use your own taste and judgement. Never reuse the same template or structure twice. If the user gave design instructions, follow them.

Make it genuinely good: a strong hero, thoughtful visual hierarchy, real sections with realistic invented content (services, pricing, testimonials, opening hours, contact, etc. — whatever fits this business), a smooth responsive layout on mobile, and tasteful colour. Aim for something you would be proud to ship — clean, modern, and aesthetic.

LANGUAGE: Every visible word must be in ${lang.name} (${lang.nativeName}) — navigation, headings, body text, buttons, forms, footer. Only HTML/CSS/JS code is excepted.

TECHNICAL:
- One self-contained HTML file: all CSS in a <style> in <head>, all JS in a <script> before </body>.
- Google Fonts are allowed via <link> in <head>. No other external libraries or frameworks.
- Output raw HTML only, starting with <!DOCTYPE html>. No markdown, no code fences, no commentary before or after.`;
}

// ─────────────────────────────────────────────────────────────────────────────
// EDIT MODE — refine an existing site from a chat-style instruction
// ─────────────────────────────────────────────────────────────────────────────

function editSystemPrompt(lang: LangInfo): string {
  return `You are an expert web developer refining an existing single-page business website. You receive the COMPLETE current HTML document and a change request from the site owner. Apply the requested change precisely.

RULES:
- Apply ONLY what the change request asks. Do not redesign, do not touch unrelated sections, do not "improve" things that were not mentioned.
- Preserve the existing design style, color palette, fonts, gradient, layout structure, and all other content exactly — unless the change request explicitly asks to change them.
- Keep all visible copy in ${lang.name} (${lang.nativeName}). Only HTML/CSS/JS code is excepted.
- Keep the document complete and valid — all CSS in <style>, all JS in <script>, no broken tags.
- If the request is vague, make the smallest reasonable change that satisfies it.

Return the COMPLETE updated HTML document, starting with <!DOCTYPE html>. No markdown, no code fences, no explanation before or after.`;
}

// Decide whether a chat message is an edit to the current site or a request for a new one.
async function classifyEditRequest(apiKey: string, prompt: string): Promise<boolean> {
  const raw = await callClaude(apiKey, [
    {
      role: 'system',
      content:
        'You classify one message from a user who already has a website generated and visible on screen. Reply with EXACTLY one word and nothing else: "EDIT" if the message asks to change, fix, adjust, tweak, restyle, add to, remove from, or refine the current website; "NEW" if it asks to build a completely different website for a different business.',
    },
    { role: 'user', content: prompt },
  ], 0, 8);
  return /edit/i.test(raw);
}

// ─────────────────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────────────────

// Only flags genuinely broken or truncated output — not design choices.
function isSkeletalOutput(html: string): boolean {
  const failures = [
    !/<!DOCTYPE\s+html/i.test(html),
    !/<\/html>/i.test(html),
    !html.includes('<style'),
    html.length < 4000,
  ];
  return failures.filter(Boolean).length >= 2;
}

function extractHtml(text: string): string {
  const trimmed = text.trim();
  const fenceMatch = trimmed.match(/```(?:html)?\s*([\s\S]*?)```/i);
  const candidate = fenceMatch ? fenceMatch[1] : trimmed;
  const docIdx = candidate.search(/<!DOCTYPE\s+html/i);
  return docIdx >= 0 ? candidate.slice(docIdx).trim() : candidate.trim();
}

// Anthropic Messages API: system prompt is top-level, messages are user/assistant only.
async function callClaude(
  apiKey: string,
  messages: Array<{ role: string; content: string }>,
  temperature = 0.85,
  maxTokens = 16000,
): Promise<string> {
  const systemParts: string[] = [];
  const convo: Array<{ role: 'user' | 'assistant'; content: string }> = [];
  for (const m of messages) {
    if (m.role === 'system') systemParts.push(m.content);
    else if (m.role === 'user' || m.role === 'assistant') convo.push({ role: m.role, content: m.content });
  }
  const body: Record<string, unknown> = {
    model: MODEL,
    max_tokens: maxTokens,
    temperature,
    messages: convo,
  };
  if (systemParts.length) body.system = systemParts.join('\n\n');

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': ANTHROPIC_VERSION,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) { const d = await res.text(); throw new Error(`anthropic_error: ${res.status} ${d}`); }
  const payload = await res.json();
  const blocks = (payload?.content as Array<{ type: string; text?: string }>) ?? [];
  return blocks.filter((b) => b.type === 'text').map((b) => b.text ?? '').join('');
}

// ─────────────────────────────────────────────────────────────────────────────
// HANDLER
// ─────────────────────────────────────────────────────────────────────────────

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  try {
    const user = await getUser(req);
    if (!user) return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

    const body = await req.json();
    const { prompt, businessName, businessType, clientLocation, history, sessionId, leadId, currentHtml } = body ?? {};

    if (!prompt || typeof prompt !== 'string') return new Response(JSON.stringify({ error: 'prompt required' }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

    const supabase = adminClient();
    const { data: profile, error: profileErr } = await supabase.from('profiles').select('plan, generations_used').eq('id', user.id).single();
    if (profileErr || !profile) return new Response(JSON.stringify({ error: 'Profile not found' }), { status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

    const limit = PLAN_LIMITS[(profile.plan as 'free' | 'pro') ?? 'free'].generations;
    if (profile.generations_used >= limit) return new Response(JSON.stringify({ error: 'limit_reached', plan: profile.plan, limit }), { status: 402, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

    const apiKey = Deno.env.get('ANTHROPIC_API_KEY');
    if (!apiKey) return new Response(JSON.stringify({ error: 'ANTHROPIC_API_KEY not configured' }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

    const briefLines = [
      businessName ? `Business name: ${businessName}` : null,
      businessType ? `Business type: ${businessType}` : null,
      clientLocation ? `Location: ${clientLocation}` : null,
    ].filter(Boolean) as string[];
    const businessInfoBlock = briefLines.length ? briefLines.join('\n') : `Business context: ${prompt.slice(0, 300)}`;
    const lang = detectLanguage(clientLocation ?? '', businessName ?? '', prompt);

    // Edit-vs-new: if a site already exists in this chat, the AI decides per message.
    const hasExistingSite = typeof currentHtml === 'string'
      && /<!DOCTYPE\s+html/i.test(currentHtml)
      && currentHtml.length > 1000;
    let isEditMode = false;
    if (hasExistingSite) {
      try { isEditMode = await classifyEditRequest(apiKey, prompt); }
      catch { isEditMode = false; }
    }

    let html = '';
    let retried = false;
    let edited = false;

    if (isEditMode) {
      // ── EDIT MODE: refine the existing site from a chat instruction ──────────
      try {
        const editRaw = await callClaude(apiKey, [
          { role: 'system', content: editSystemPrompt(lang) },
          { role: 'user', content: `CURRENT HTML:\n${currentHtml}\n\nCHANGE REQUEST:\n${prompt}` },
        ], 0.4, 20000);
        const editedHtml = extractHtml(editRaw);
        if (editedHtml && /<!DOCTYPE\s+html/i.test(editedHtml) && editedHtml.length > 5000) {
          html = editedHtml;
          edited = true;
        } else {
          return new Response(JSON.stringify({ error: 'edit_failed', detail: 'Model returned an incomplete document.' }), { status: 502, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
        }
      } catch (err) {
        return new Response(JSON.stringify({ error: 'anthropic_error', detail: err instanceof Error ? err.message : String(err) }), { status: 502, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
      }
    } else {
      // ── BUILD: generate the website directly from the business info ─────────
      const buildUserMessage = `${businessInfoBlock}

${prompt}`;

      const buildMessages: Array<{ role: string; content: string }> = [{ role: 'system', content: buildSystemPrompt(lang) }];
      if (Array.isArray(history)) {
        for (const m of history) {
          if (m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string') buildMessages.push({ role: m.role, content: m.content });
        }
      }
      buildMessages.push({ role: 'user', content: buildUserMessage });

      try {
        const raw = await callClaude(apiKey, buildMessages, 1.0, 20000);
        html = extractHtml(raw);

        if (isSkeletalOutput(html)) {
          retried = true;
          const retryMessages = [
            ...buildMessages,
            { role: 'assistant', content: html },
            { role: 'user', content: 'That output was incomplete or broken. Rebuild the website as one complete, valid HTML document, starting with <!DOCTYPE html> and ending with </html>. Raw HTML only — no markdown, no code fences.' },
          ];
          const retryRaw = await callClaude(apiKey, retryMessages, 1.0, 20000);
          const retryHtml = extractHtml(retryRaw);
          if (retryHtml && /<!DOCTYPE\s+html/i.test(retryHtml) && retryHtml.length > 4000) html = retryHtml;
        }
      } catch (err) {
        return new Response(JSON.stringify({ error: 'anthropic_error', detail: err instanceof Error ? err.message : String(err) }), { status: 502, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
      }
    }

    // ── Session ───────────────────────────────────────────────────────────────
    let resolvedSessionId: string | null = null;
    if (sessionId) {
      const { data: ex } = await supabase.from('chat_sessions').select('id').eq('id', sessionId).eq('user_id', user.id).maybeSingle();
      if (ex) resolvedSessionId = ex.id;
    }
    if (!resolvedSessionId && leadId) {
      const { data: ex } = await supabase.from('chat_sessions').select('id').eq('lead_id', leadId).eq('user_id', user.id).maybeSingle();
      if (ex) resolvedSessionId = ex.id;
    }
    if (!resolvedSessionId) {
      const title = (businessName ?? prompt).toString().slice(0, 60);
      const { data: created } = await supabase.from('chat_sessions').insert({ user_id: user.id, title, lead_id: leadId ?? null }).select('id').single();
      resolvedSessionId = created?.id ?? null;
    } else {
      await supabase.from('chat_sessions').update({ updated_at: new Date().toISOString() }).eq('id', resolvedSessionId);
    }

    const { data: site, error: siteErr } = await supabase.from('generated_sites').insert({
      user_id: user.id, session_id: resolvedSessionId,
      business_name: businessName ?? null, business_type: businessType ?? null,
      client_location: clientLocation ?? null, html_output: html, status: 'pending',
    }).select().single();
    if (siteErr) return new Response(JSON.stringify({ error: siteErr.message }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

    await supabase.from('profiles').update({ generations_used: (profile.generations_used ?? 0) + 1 }).eq('id', user.id);

    return new Response(JSON.stringify({ site, html, sessionId: resolvedSessionId, retried, edited, detectedLanguage: lang }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

  } catch (err) {
    return new Response(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  }
});