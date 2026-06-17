// generate-site — single Claude build call (or Edit for follow-up chat messages)
// Streams an SSE response so mobile carrier proxies don't kill idle connections.
import { corsHeaders } from '../_shared/cors.ts';
import { adminClient, getUser, PLAN_LIMITS } from '../_shared/auth.ts';
import { readBoundedJson, errorResponse, fromHttpError, clientIp } from '../_shared/guards.ts';
import { generateSiteSchema } from '../_shared/validation.ts';
import { enforce } from '../_shared/ratelimit.ts';

const MAX_BODY_BYTES = 640 * 1024; // currentHtml can be large in edit mode

const MODEL = Deno.env.get('ANTHROPIC_MODEL') ?? 'claude-sonnet-4-6';
const ANTHROPIC_VERSION = '2023-06-01';

// ─────────────────────────────────────────────────────────────────────────────
// CREDIT RATES (mirrors config table; fetched fresh each request)
// ─────────────────────────────────────────────────────────────────────────────

// Credits stay well within Number.MAX_SAFE_INTEGER — no BigInt needed.
interface CreditRates {
  inRate: number;
  outRate: number;
  margin: number;
  monthlyFree: number;
  monthlyPro: number;
}

// deno-lint-ignore no-explicit-any
async function getCreditRates(supabase: any): Promise<CreditRates> {
  const { data } = await supabase.from('config').select('key, value').in('key', [
    'credit_in_rate', 'credit_out_rate', 'credit_margin',
    'credit_monthly_free', 'credit_monthly_pro',
  ]);
  const m = new Map((data ?? []).map((r: { key: string; value: string }) => [r.key, r.value]));
  return {
    inRate:      parseFloat(m.get('credit_in_rate')   ?? '1'),
    outRate:     parseFloat(m.get('credit_out_rate')  ?? '5'),
    margin:      parseFloat(m.get('credit_margin')    ?? '1.1'),
    monthlyFree: parseInt(m.get('credit_monthly_free') ?? '68000', 10),
    monthlyPro:  parseInt(m.get('credit_monthly_pro')  ?? '680000', 10),
  };
}

interface SystemBlock {
  type: 'text';
  text: string;
  cache_control?: { type: 'ephemeral' };
}

interface TokenUsage {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

function computeCredits(usage: TokenUsage, rates: CreditRates): number {
  // Cache writes cost 2× input rate (1h TTL); cache reads cost 0.1× input rate.
  const uncached   = usage.input_tokens * rates.inRate;
  const cacheWrite = (usage.cache_creation_input_tokens ?? 0) * rates.inRate * 2;
  const cacheRead  = (usage.cache_read_input_tokens    ?? 0) * rates.inRate * 0.1;
  return Math.ceil((uncached + cacheWrite + cacheRead + usage.output_tokens * rates.outRate) * rates.margin);
}

function estimateCredits(rates: CreditRates, isEdit: boolean, hasHistory: boolean): number {
  const inputEst  = isEdit ? 15000 : (hasHistory ? 3000 : 1200);
  const outputEst = isEdit ? 10000 : 8000;
  return computeCredits({ input_tokens: inputEst, output_tokens: outputEst }, rates);
}

// deno-lint-ignore no-explicit-any
async function deductCredits(
  supabase: any,
  userId: string,
  totalUsage: TokenUsage,
  actionType: string,
  rates: CreditRates,
  siteId: string | null,
): Promise<void> {
  const credits = computeCredits(totalUsage, rates);
  // Both calls are best-effort: they silently no-op before the migration runs.
  await supabase.rpc('deduct_credits', { p_user_id: userId, p_credits: credits }).then(null, () => {});
  await supabase.from('credit_ledger').insert({
    user_id: userId,
    action_type: actionType,
    input_tokens: totalUsage.input_tokens,
    output_tokens: totalUsage.output_tokens,
    credits_charged: credits,
    site_id: siteId ?? null,
  }).then(null, () => {});
}

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
// STYLE PRESETS — injected randomly so every generation has a distinct aesthetic
// ─────────────────────────────────────────────────────────────────────────────

const STYLE_PRESETS = [
  {
    name: 'Dark Luxury',
    palette: 'Near-black bg (#111), off-white text (#f5f5f0), warm gold accent (#c9a84c).',
    typography: 'Cormorant Garamond display + DM Sans body. Hero: clamp(3rem,6vw,5rem) weight 300.',
    layout: 'Full-bleed dark hero, editorial centered type, generous section padding, thin horizontal rules.',
  },
  {
    name: 'Light Editorial',
    palette: 'Warm cream bg (#fafaf7), near-black text (#1a1a1a), one muted accent (sage #7a9e7e or dusty rose #c4857a).',
    typography: 'Playfair Display + Inter. Section labels in small-caps with letter-spacing.',
    layout: 'Magazine asymmetric grid. Pull-quote testimonials. Services in refined grid. Strong negative space.',
  },
  {
    name: 'Scandinavian Minimal',
    palette: 'White or light gray bg (#f8f8f8), charcoal text (#2d2d2d), single nature accent (forest #3d6b52 or slate #5c7a8a).',
    typography: 'DM Serif Display + Outfit. Restrained scale, whitespace does the work.',
    layout: 'Symmetric grid, thin 1px borders, minimal decoration, services as clean list.',
  },
  {
    name: 'Bold Type-Driven',
    palette: 'White bg + one vivid accent (electric blue #2563eb, deep red #c0392b, or emerald #065f46). High contrast only.',
    typography: 'Fraunces or Syne weight 900 + Inter. Hero headline: clamp(4rem,9vw,8rem).',
    layout: 'Type IS the design. Color-block section dividers. Oversized stat numbers. Large full-width CTA.',
  },
  {
    name: 'Warm Artisanal',
    palette: 'Warm linen bg (#f2ece3), espresso text (#2c1a10), earth accents (terracotta #c4724a or olive #6b7c3d).',
    typography: 'Lora italic display + Karla body. Warm, crafted, personal.',
    layout: 'Story-driven hero, rounded cards (8px), soft shadows, organic feel.',
  },
  {
    name: 'Contemporary Studio',
    palette: 'Warm gray bg (#e8e5e0), dark slate text (#1c2333), bold accent (cobalt #1e40af or plum #5b21b6).',
    typography: 'Space Grotesk headlines + Inter body. Geometric, confident.',
    layout: 'Architectural grid, color-blocked service cards, stats row with large numerals.',
  },
  {
    name: 'Deep Navy Prestige',
    palette: 'Rich navy bg (#0a1628), white text, silver/teal accent (#64b5a8).',
    typography: 'Libre Baskerville display + Lato body. All-caps subheadings with letter-spacing.',
    layout: 'Authority-first hero, trust/stats row, named testimonials, clear contact section.',
  },
  {
    name: 'Fresh Modern',
    palette: 'White bg (#ffffff), near-black text (#111827), one vivid accent chosen for this specific business.',
    typography: 'Sora or Nunito + Inter. Friendly, approachable, energetic.',
    layout: 'Hero with gradient accent band, icon-free feature blocks (bold numbers/labels), mobile-first flow.',
  },
  {
    name: 'Brutalist Editorial',
    palette: 'Pure white bg (#ffffff), jet black text (#000000), single high-contrast accent (red #e63329 or yellow #f5c400).',
    typography: 'Anton or Bebas Neue for headlines (weight 900, all-caps) + Barlow body. Extreme type scale contrast.',
    layout: 'Oversized asymmetric hero with raw grid lines, bold ruled dividers, services as stark numbered list, maximum whitespace.',
  },
  {
    name: 'Soft Luxury Rose',
    palette: 'Blush bg (#fdf6f0), deep espresso text (#1f1008), rose-gold accent (#c9846a). Warm and feminine but premium.',
    typography: 'Cormorant Garamond italic display + Lato body. Thin weights, generous tracking.',
    layout: 'Full-bleed soft hero, circular or organic shapes for imagery placeholders, testimonials in soft-bordered cards, CTA in rose-gold.',
  },
  {
    name: 'Midnight Indigo',
    palette: 'Deep indigo bg (#0d0d2b), lavender-white text (#ede9f6), vivid violet accent (#7c3aed). Bold and nocturnal.',
    typography: 'Syne weight 800 display + Inter body. Gradient text on key headline words.',
    layout: 'Dark hero with subtle radial gradient glow, services in bordered indigo cards, stats section with large glowing numerals.',
  },
  {
    name: 'Coastal Premium',
    palette: 'Soft ocean blue bg (#eef5f9), near-black text (#0f1f2e), deep teal accent (#0a7ea4). Clean, trustworthy, premium.',
    typography: 'Libre Baskerville display + Source Sans 3 body. Confident but approachable.',
    layout: 'Airy full-width hero, trust row with key stats, services in teal-accented grid cards, testimonials in clean quote blocks.',
  },
  {
    name: 'Industrial Loft',
    palette: 'Warm concrete bg (#e8e4de), dark charcoal text (#1a1714), burnt orange accent (#c0542a). Raw, authentic, bold.',
    typography: 'Space Grotesk weight 700 + IBM Plex Mono for labels. Industrial feel with tight letter-spacing.',
    layout: 'Textured hero with thick ruled borders, services as bold grid with left-rule accent bars, footer as dense info block.',
  },
  {
    name: 'Japanese Minimalist',
    palette: 'Off-white washi bg (#f7f4ef), deep ink text (#1a1a1a), single muted accent (rust #b85c38 or ink blue #2a3d5c).',
    typography: 'Noto Serif Display + Noto Sans. Generous line-height. Restrained weight.',
    layout: 'Centered, meditative layout. Hero is text-only, no visual clutter. Wide breathing margins. Services as vertical list with thin rules. No decorative elements.',
  },
  {
    name: 'Forest & Craft',
    palette: 'Deep forest bg (#1a2e1a), warm cream text (#f2ead8), moss green accent (#4a7c59). Earthy, premium, outdoor.',
    typography: 'Playfair Display italic + Karla. Crafted warmth.',
    layout: 'Dark nature-tone hero with cream headline, services as cream-on-dark bordered cards, pull-quote testimonial, warm CTA band.',
  },
  {
    name: 'Swiss Corporate',
    palette: 'Light gray bg (#f4f4f4), deep gray text (#1c1c1c), single corporate accent (blue #1a56db or red #c81e1e).',
    typography: 'DM Sans or Inter weight 600 + 400. Precise grid, no decorative type. All labels in uppercase.',
    layout: 'Structured Swiss-grid hero, info in tight horizontal bands, services as clean bordered table layout, maximum legibility.',
  },
  {
    name: 'Cinema Noir',
    palette: 'Near-black bg (#0c0c0c), silver-white text (#d4d4d4), warm amber accent (#e8a030). Cinematic and authoritative.',
    typography: 'Libre Baskerville + DM Mono for labels. Italic accent on hero subheadline.',
    layout: 'Full-bleed dark hero, horizontal silver rule dividers, services as sparse list, testimonial in centered italic block, amber CTA stands alone.',
  },
  {
    name: 'Pastel Tech',
    palette: 'Very light lavender bg (#f5f3ff), dark slate text (#1e1b4b), medium purple accent (#6d28d9). Modern SaaS aesthetic.',
    typography: 'Plus Jakarta Sans weight 700 + 400. Rounded feel, energetic without being aggressive.',
    layout: 'Gradient hero band (lavender to white), features in three-column icon-free cards with purple top-border, clean FAQ strip, bold CTA.',
  },
] as const;

// ─────────────────────────────────────────────────────────────────────────────
// HTML BUILD — open prompt; the model designs freely, like a direct Claude chat
// ─────────────────────────────────────────────────────────────────────────────

// Static content: all style preset definitions + rules/technical. This block
// never changes between calls, so it's safe to mark for prompt caching.
function buildStaticSystemBlock(): string {
  const catalog = STYLE_PRESETS.map(
    (p) => `• ${p.name}\n  Colors: ${p.palette}\n  Type: ${p.typography}\n  Layout: ${p.layout}`,
  ).join('\n\n');

  return `You are an award-winning web designer. Build a luxurious, high-converting single-page marketing website for the business described.

STYLE CATALOG — one preset will be selected per generation:
${catalog}

RULES:
- NO emojis anywhere. NO icon libraries (Font Awesome etc.).
- Unique to THIS business — derive palette voice and copy from the name, type, and location. Do not use generic industry defaults.
- Section order: hero (bold value prop) → trust/stats → services → testimonial → CTA → footer.
- Write real, specific marketing copy. Not "We are committed to excellence." Write like a copywriter who studied this business.
- Fully responsive (320px–1440px). CSS transitions on hover. scroll-behavior: smooth.

TECHNICAL:
- Single self-contained HTML file. All CSS in <style>, minimal JS in <script> before </body>.
- Google Fonts via <link> only. No other external resources.
- Output raw HTML starting with <!DOCTYPE html>. No markdown, no fences, no commentary.`;
}

// Dynamic content: randomly selected style + language. Lives in a second block
// placed AFTER the cached prefix so the prefix remains an exact match.
function buildSystemBlocks(lang: LangInfo): [SystemBlock, SystemBlock] {
  const preset = STYLE_PRESETS[Math.floor(Math.random() * STYLE_PRESETS.length)];
  return [
    {
      type: 'text',
      text: buildStaticSystemBlock(),
      cache_control: { type: 'ephemeral' },
    },
    {
      type: 'text',
      text: `SELECTED STYLE: ${preset.name}\n- Colors: ${preset.palette}\n- Type: ${preset.typography}\n- Layout: ${preset.layout}\n\nLANGUAGE: Write every visible word in ${lang.name} (${lang.nativeName}). Code excepted.`,
    },
  ];
}

// ─────────────────────────────────────────────────────────────────────────────
// EDIT MODE — refine an existing site from a chat-style instruction
// ─────────────────────────────────────────────────────────────────────────────

function editSystemPrompt(lang: LangInfo): string {
  return `You are an expert web developer refining an existing single-page business website. You receive the COMPLETE current HTML document and a change request from the site owner. Apply the requested change precisely.

RULES:
- Apply ONLY what the change request asks. Do not redesign, do not touch unrelated sections, do not "improve" things that were not mentioned.
- Preserve the existing design style, color palette, fonts, layout structure, and all other content exactly — unless the change request explicitly asks to change them.
- Keep all visible copy in ${lang.name} (${lang.nativeName}). Only HTML/CSS/JS code is excepted.
- Keep the document complete and valid — all CSS in <style>, all JS in <script>, no broken tags.
- Do NOT introduce emojis anywhere, even if the change request seems to suggest them.
- If the request is vague, make the smallest reasonable change that satisfies it.

Return the COMPLETE updated HTML document, starting with <!DOCTYPE html>. No markdown, no code fences, no explanation before or after.`;
}

// Decide whether a chat message is an edit to the current site or a request for a new one.
// Returns { isEdit, usage } so classify tokens can be counted toward the total.
async function classifyEditRequest(apiKey: string, prompt: string): Promise<{ isEdit: boolean; usage: TokenUsage }> {
  const { text, usage } = await callClaude(apiKey, [
    {
      role: 'system',
      content:
        'You classify one message from a user who already has a website generated and visible on screen. Reply with EXACTLY one word and nothing else: "EDIT" if the message asks to change, fix, adjust, tweak, restyle, add to, remove from, or refine the current website; "NEW" if it asks to build a completely different website for a different business.',
    },
    { role: 'user', content: prompt },
  ], 0, 8);
  return { isEdit: /edit/i.test(text), usage };
}

// ─────────────────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────────────────

// Only flags genuinely broken or truncated output — not design choices.
function isSkeletalOutput(html: string): boolean {
  // Missing closing tag alone means truncation — always retry.
  if (!/<\/html>/i.test(html)) return true;
  const failures = [
    !/<!DOCTYPE\s+html/i.test(html),
    !html.includes('<style'),
    html.length < 4000,
  ];
  return failures.filter(Boolean).length >= 1;
}

function extractHtml(text: string): string {
  const trimmed = text.trim();
  const fenceMatch = trimmed.match(/```(?:html)?\s*([\s\S]*?)```/i);
  const candidate = fenceMatch ? fenceMatch[1] : trimmed;
  const docIdx = candidate.search(/<!DOCTYPE\s+html/i);
  return docIdx >= 0 ? candidate.slice(docIdx).trim() : candidate.trim();
}

// Anthropic Messages API: system prompt is top-level, messages are user/assistant only.
// Returns both the text content and the token usage reported by the API.
// Pass systemBlocks to use prompt caching; otherwise system is extracted from messages[].
async function callClaude(
  apiKey: string,
  messages: Array<{ role: string; content: string }>,
  temperature = 0.85,
  maxTokens = 12000,
  systemBlocks?: SystemBlock[],
): Promise<{ text: string; usage: TokenUsage }> {
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
    stream: true,
  };
  if (systemBlocks) {
    body.system = systemBlocks;
  } else if (systemParts.length) {
    body.system = systemParts.join('\n\n');
  }

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': ANTHROPIC_VERSION,
      'anthropic-beta': 'prompt-caching-2024-07-31',
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) { const d = await res.text(); throw new Error(`anthropic_error: ${res.status} ${d}`); }

  // Stream the response so the Deno worker receives data continuously — prevents
  // the 90-second QUIC timeout that fires when awaiting the full non-streaming response.
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  let streamBuf = '';
  let fullText = '';
  const usage: TokenUsage = { input_tokens: 0, output_tokens: 0 };

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    streamBuf += dec.decode(value, { stream: true });
    const lines = streamBuf.split('\n');
    streamBuf = lines.pop() ?? '';
    for (const line of lines) {
      if (!line.startsWith('data: ')) continue;
      const data = line.slice(6).trim();
      if (data === '[DONE]') continue;
      let ev: Record<string, unknown>;
      try { ev = JSON.parse(data); } catch { continue; }
      if (ev.type === 'message_start') {
        const u = (ev.message as Record<string, unknown>)?.usage as Record<string, number> | undefined;
        if (u) {
          usage.input_tokens                = u.input_tokens                ?? 0;
          usage.cache_creation_input_tokens = u.cache_creation_input_tokens ?? 0;
          usage.cache_read_input_tokens     = u.cache_read_input_tokens     ?? 0;
        }
      } else if (ev.type === 'content_block_delta') {
        const d = ev.delta as Record<string, unknown> | undefined;
        if (d?.type === 'text_delta') fullText += (d.text as string) ?? '';
      } else if (ev.type === 'message_delta') {
        const u = ev.usage as Record<string, number> | undefined;
        if (u) usage.output_tokens = u.output_tokens ?? 0;
      }
    }
  }

  if (usage.cache_read_input_tokens || usage.cache_creation_input_tokens) {
    console.log(
      `[cache] read=${usage.cache_read_input_tokens} created=${usage.cache_creation_input_tokens} uncached_in=${usage.input_tokens}`,
    );
  }
  return { text: fullText, usage };
}

// ─────────────────────────────────────────────────────────────────────────────
// HANDLER — SSE streaming so mobile proxies don't drop idle connections
// ─────────────────────────────────────────────────────────────────────────────

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  try {
    // ── Pre-flight checks (fast; return early JSON errors before streaming) ──
    const user = await getUser(req);
    if (!user) return errorResponse(401, 'Unauthorized');

    const ipBlocked = await enforce('generate', clientIp(req));
    if (ipBlocked) return ipBlocked;
    const userBlocked = await enforce('generate', user.id);
    if (userBlocked) return userBlocked;

    const raw = await readBoundedJson(req, MAX_BODY_BYTES);
    const parsed = generateSiteSchema.safeParse(raw);
    if (!parsed.success) return errorResponse(400, 'invalid_input', parsed.error.flatten());
    const { prompt, businessName, businessType, clientLocation, history, sessionId, leadId, currentHtml } = parsed.data;

    const supabase = adminClient();
    // Select * so missing columns (e.g. credit_balance before migration) don't crash the query.
    const { data: profile, error: profileErr } = await supabase.from('profiles').select('*').eq('id', user.id).single();
    if (profileErr || !profile) return errorResponse(404, 'profile_not_found');

    const rates = await getCreditRates(supabase);

    const apiKey = Deno.env.get('ANTHROPIC_API_KEY');
    if (!apiKey) return errorResponse(500, 'api_key_missing');

    const briefLines = [
      businessName ? `Business name: ${businessName}` : null,
      businessType ? `Business type: ${businessType}` : null,
      clientLocation ? `Location: ${clientLocation}` : null,
    ].filter(Boolean) as string[];
    const businessInfoBlock = briefLines.length ? briefLines.join('\n') : `Business context: ${prompt.slice(0, 300)}`;
    const lang = detectLanguage(clientLocation ?? '', businessName ?? '', prompt);

    const hasExistingSite = typeof currentHtml === 'string'
      && /<!DOCTYPE\s+html/i.test(currentHtml)
      && currentHtml.length > 1000;

    const fallbackBalance = profile.plan === 'pro' ? rates.monthlyPro : rates.monthlyFree;
    const estimate = estimateCredits(rates, hasExistingSite, Array.isArray(history) && history.length > 0);
    const currentBalance: number = (profile.credit_balance != null) ? Number(profile.credit_balance) : fallbackBalance;
    if (currentBalance < estimate) {
      return new Response(
        JSON.stringify({ error: 'insufficient_credits', balance: currentBalance, estimate }),
        { status: 402, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      );
    }

    // ── SSE streaming — heartbeat every 10 s keeps mobile proxies alive ──────
    const enc = new TextEncoder();
    const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
    const writer = writable.getWriter();
    const sse = async (obj: unknown) => {
      try { await writer.write(enc.encode(`data: ${JSON.stringify(obj)}\n\n`)); } catch (e) { console.error('[sse] write failed:', e); }
    };

    const hb = setInterval(() => { sse({ type: 'heartbeat' }); }, 10_000);

    (async () => {
      try {
        const totalUsage: TokenUsage = { input_tokens: 0, output_tokens: 0 };
        let isEditMode = false;
        let html = '';
        let retried = false;
        let edited = false;

        // Edit-vs-new: if a site already exists in this chat, the AI decides per message.
        if (hasExistingSite) {
          try {
            const result = await classifyEditRequest(apiKey, prompt);
            isEditMode = result.isEdit;
            totalUsage.input_tokens  += result.usage.input_tokens;
            totalUsage.output_tokens += result.usage.output_tokens;
          } catch { isEditMode = false; }
        }

        if (isEditMode) {
          // ── EDIT MODE: refine the existing site from a chat instruction ────
          const { text: editRaw, usage: editUsage } = await callClaude(apiKey, [
            { role: 'system', content: editSystemPrompt(lang) },
            { role: 'user', content: `CURRENT HTML:\n${currentHtml}\n\nCHANGE REQUEST:\n${prompt}` },
          ], 0.4, 10000);
          totalUsage.input_tokens  += editUsage.input_tokens;
          totalUsage.output_tokens += editUsage.output_tokens;
          const editedHtml = extractHtml(editRaw);
          if (editedHtml && /<!DOCTYPE\s+html/i.test(editedHtml) && editedHtml.length > 5000) {
            html = editedHtml;
            edited = true;
          } else {
            // deno-lint-ignore no-explicit-any
            const e: any = new Error('edit_failed');
            e.detail = 'Model returned an incomplete document.';
            e.status = 502;
            throw e;
          }
        } else {
          // ── BUILD: generate the website directly from the business info ────
          const buildUserMessage = `${businessInfoBlock}\n\n${prompt}`;
          const sysBlocks = buildSystemBlocks(lang);
          const buildMessages: Array<{ role: string; content: string }> = [];
          if (Array.isArray(history)) {
            for (const m of history) {
              if (m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string') buildMessages.push({ role: m.role, content: m.content });
            }
          }
          buildMessages.push({ role: 'user', content: buildUserMessage });

          const { text: raw, usage: buildUsage } = await callClaude(apiKey, buildMessages, 1.0, 12000, sysBlocks);
          totalUsage.input_tokens                  += buildUsage.input_tokens;
          totalUsage.output_tokens                 += buildUsage.output_tokens;
          totalUsage.cache_read_input_tokens        = (totalUsage.cache_read_input_tokens    ?? 0) + (buildUsage.cache_read_input_tokens    ?? 0);
          totalUsage.cache_creation_input_tokens    = (totalUsage.cache_creation_input_tokens ?? 0) + (buildUsage.cache_creation_input_tokens ?? 0);
          html = extractHtml(raw);

          if (isSkeletalOutput(html)) {
            retried = true;
            const retryMessages = [
              ...buildMessages,
              { role: 'assistant', content: html },
              { role: 'user', content: 'That output was incomplete or broken. Rebuild the website as one complete, valid HTML document, starting with <!DOCTYPE html> and ending with </html>. Raw HTML only — no markdown, no code fences.' },
            ];
            const { text: retryRaw, usage: retryUsage } = await callClaude(apiKey, retryMessages, 1.0, 12000, sysBlocks);
            totalUsage.input_tokens                += retryUsage.input_tokens;
            totalUsage.output_tokens               += retryUsage.output_tokens;
            totalUsage.cache_read_input_tokens      = (totalUsage.cache_read_input_tokens    ?? 0) + (retryUsage.cache_read_input_tokens    ?? 0);
            totalUsage.cache_creation_input_tokens  = (totalUsage.cache_creation_input_tokens ?? 0) + (retryUsage.cache_creation_input_tokens ?? 0);
            const retryHtml = extractHtml(retryRaw);
            if (retryHtml && /<!DOCTYPE\s+html/i.test(retryHtml) && retryHtml.length > 4000) html = retryHtml;
          }
        }

        // ── Session ──────────────────────────────────────────────────────────
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
        if (siteErr) throw new Error(siteErr.message);

        // Increment the legacy counter (kept for stats) and deduct credits.
        await supabase.from('profiles').update({ generations_used: (profile.generations_used ?? 0) + 1 }).eq('id', user.id);
        const actionType = isEditMode ? 'edit' : 'generation';
        await deductCredits(supabase, user.id, totalUsage, actionType, rates, site.id);
        const creditsUsed = Number(computeCredits(totalUsage, rates));

        console.log('[generate-site] sending result, html_len:', html.length, 'credits:', creditsUsed);
        await sse({ type: 'result', site, html, sessionId: resolvedSessionId, retried, edited, detectedLanguage: lang, creditsUsed });
        console.log('[generate-site] result sent');
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error('[generate-site] IIFE error:', msg);
        // deno-lint-ignore no-explicit-any
        const e = err as any;
        await sse({ type: 'error', error: msg, detail: e.detail, status: e.status ?? 502 });
      } finally {
        clearInterval(hb);
        try { await writer.close(); } catch { /* already closed */ }
      }
    })();

    return new Response(readable, {
      headers: {
        ...corsHeaders,
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'X-Accel-Buffering': 'no',
      },
    });
  } catch (err) {
    return fromHttpError(err);
  }
});
