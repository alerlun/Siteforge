// generate-site — single Claude build call (or Edit for follow-up chat messages)
// Streams an SSE response so mobile carrier proxies don't kill idle connections.
import { corsHeaders } from '../_shared/cors.ts';
import { adminClient, getUser, PLAN_LIMITS } from '../_shared/auth.ts';
import { readBoundedJson, errorResponse, fromHttpError, clientIp } from '../_shared/guards.ts';
import { generateSiteSchema } from '../_shared/validation.ts';
import { enforce } from '../_shared/ratelimit.ts';
import { checkReferralActivation } from '../_shared/referral.ts';

const MAX_BODY_BYTES = 640 * 1024; // currentHtml can be large in edit mode

const MODEL = Deno.env.get('ANTHROPIC_MODEL') ?? 'claude-sonnet-4-6';
const CLASSIFY_MODEL = Deno.env.get('ANTHROPIC_CLASSIFY_MODEL') ?? 'claude-haiku-4-5-20251001';
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

// Reserved before the AI call (reserve_credits) and corrected to the real cost afterwards
// (settle_credits), so the estimate only needs to be close, not exact. Builds observed in
// June 2026 cost 47k–69k credits (8–12k output tokens + system-prompt cache write), so the
// build estimate includes a cache write and 10k output tokens.
// Chat edits send the whole current site and get back only SEARCH/REPLACE blocks.
// Generated HTML runs ~2.5 characters per token (measured on June–October 2026 sites),
// plus ~1.5k tokens for the edit prompt and the change request.
// Builds also send the chat history the client supplies (up to 40 messages), so its size
// is part of the build estimate (~3 characters per token for chat text); a fixed estimate
// let a large history cost several times what was reserved.
// Keep in sync with estimateCredits() in src/lib/credits.js.
const EDIT_MAX_OUTPUT_TOKENS = 8000;
const EDIT_OUTPUT_ESTIMATE = 3000;
const HTML_CHARS_PER_TOKEN = 2.5;
const EDIT_PROMPT_OVERHEAD_TOKENS = 1500;
const BUILD_BASE_INPUT_TOKENS = 1200;
const TEXT_CHARS_PER_TOKEN = 3;

function estimateCredits(rates: CreditRates, isEdit: boolean, historyChars: number, htmlChars = 0): number {
  if (isEdit) {
    return computeCredits({
      input_tokens: Math.ceil(htmlChars / HTML_CHARS_PER_TOKEN) + EDIT_PROMPT_OVERHEAD_TOKENS,
      output_tokens: EDIT_OUTPUT_ESTIMATE,
    }, rates);
  }
  return computeCredits({
    input_tokens: BUILD_BASE_INPUT_TOKENS + Math.ceil(historyChars / TEXT_CHARS_PER_TOKEN),
    cache_creation_input_tokens: 2000,
    output_tokens: 10000,
  }, rates);
}

function addUsage(total: TokenUsage, u: TokenUsage): void {
  total.input_tokens                += u.input_tokens ?? 0;
  total.output_tokens               += u.output_tokens ?? 0;
  total.cache_read_input_tokens      = (total.cache_read_input_tokens     ?? 0) + (u.cache_read_input_tokens     ?? 0);
  total.cache_creation_input_tokens  = (total.cache_creation_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
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
- MUST include <meta name="viewport" content="width=device-width, initial-scale=1"> in <head>.
- Mobile-first CSS: all layouts default to single-column, widen at min-width breakpoints (600px, 900px).
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

// Edits are returned as SEARCH/REPLACE blocks instead of a full rewritten document:
// the output is a few hundred to a few thousand tokens instead of ~11k, which makes a
// chat edit ~3x cheaper and avoids truncating large sites at max_tokens.
function editSystemPrompt(lang: LangInfo): string {
  return `You are an expert web developer refining an existing single-page business website. You receive the COMPLETE current HTML document and a change request from the site owner. Apply the requested change precisely.

RULES:
- Apply ONLY what the change request asks. Do not redesign, do not touch unrelated sections, do not "improve" things that were not mentioned.
- Preserve the existing design style, color palette, fonts, layout structure, and all other content exactly — unless the change request explicitly asks to change them.
- Keep all visible copy in ${lang.name} (${lang.nativeName}). Only HTML/CSS/JS code is excepted.
- Keep the document valid — all CSS in <style>, all JS in <script>, no broken tags.
- Do NOT introduce emojis anywhere, even if the change request seems to suggest them.
- If the request is vague, make the smallest reasonable change that satisfies it.

OUTPUT FORMAT — do NOT return the whole document. Return only one or more edit blocks:

<<<<<<< SEARCH
(an exact, contiguous excerpt of the current HTML, copied character for character)
=======
(the text that replaces that excerpt)
>>>>>>> REPLACE

- Each SEARCH excerpt must appear EXACTLY ONCE in the current HTML. Include enough surrounding lines to make it unique, but keep it short.
- To add something, SEARCH for the line next to where it goes and REPLACE it with that line plus the new content.
- To delete something, leave the REPLACE part empty.
- Use as many blocks as needed, in document order, and never let two blocks overlap.
- Nothing before, between or after the blocks: no explanation, no markdown, no code fences.`;
}

const EDIT_BLOCK_RE = /<<<<<<< SEARCH\r?\n([\s\S]*?)\r?\n=======\r?\n([\s\S]*?)\r?\n?>>>>>>> REPLACE/g;

function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0; // an empty needle would match everywhere and never advance
  let count = 0;
  for (let i = haystack.indexOf(needle); i !== -1; i = haystack.indexOf(needle, i + needle.length)) count++;
  return count;
}

// Applies SEARCH/REPLACE blocks to the document. Every block must match exactly once;
// otherwise the whole edit is rejected (the caller refunds the reserved credits) rather
// than saving a half-applied or wrongly applied change.
function applyEditBlocks(html: string, modelText: string): string {
  const blocks = [...modelText.matchAll(EDIT_BLOCK_RE)].map((m) => ({ search: m[1], replace: m[2] }));
  if (!blocks.length) throw editFailed('The model returned no edit blocks.');
  let out = html;
  for (const [i, b] of blocks.entries()) {
    if (!b.search.trim()) throw editFailed(`Edit block ${i + 1} of ${blocks.length} has an empty SEARCH part.`);
    let search = b.search;
    let n = countOccurrences(out, search);
    if (n === 0 && search.trim() && search.trim() !== search) {
      // Tolerate leading/trailing whitespace differences around the excerpt.
      search = search.trim();
      n = countOccurrences(out, search);
    }
    if (n !== 1) {
      throw editFailed(`Edit block ${i + 1} of ${blocks.length} ${n === 0 ? 'did not match the current site' : `matched ${n} places`}.`);
    }
    out = out.replace(search, () => b.replace);
  }
  return out;
}

function editFailed(detail: string): Error {
  // deno-lint-ignore no-explicit-any
  const e: any = new Error('edit_failed');
  e.detail = detail;
  e.status = 502;
  return e;
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
  ], 0, 8, undefined, CLASSIFY_MODEL);
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
  model = MODEL,
): Promise<{ text: string; usage: TokenUsage }> {
  const systemParts: string[] = [];
  const convo: Array<{ role: 'user' | 'assistant'; content: string }> = [];
  for (const m of messages) {
    if (m.role === 'system') systemParts.push(m.content);
    else if (m.role === 'user' || m.role === 'assistant') convo.push({ role: m.role, content: m.content });
  }
  const body: Record<string, unknown> = {
    model,
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

    // Edit-vs-new: if a site already exists in this chat, a small model decides per
    // message. Done before the reservation so the right action is reserved (an edit costs
    // ~1/3 of a new build). Its tokens are added to the settled total below.
    const totalUsage: TokenUsage = { input_tokens: 0, output_tokens: 0 };
    let isEditMode = false;
    if (hasExistingSite) {
      try {
        const result = await classifyEditRequest(apiKey, prompt);
        isEditMode = result.isEdit;
        addUsage(totalUsage, result.usage);
      } catch { isEditMode = false; }
    }

    // Atomically withhold the estimate before the main AI call. NULL = balance too low.
    // Settled to the real cost on success, refunded on failure (see the stream below).
    const historyChars = (history ?? []).reduce((n, m) => n + m.content.length, 0);
    const estimate = estimateCredits(
      rates, isEditMode, historyChars,
      isEditMode ? (currentHtml as string).length : 0,
    );
    const { data: reservationId, error: reserveErr } = await supabase.rpc('reserve_credits', {
      p_user_id: user.id, p_amount: estimate, p_action: isEditMode ? 'edit' : 'generation',
    });
    if (reserveErr) throw new Error(`reserve_credits: ${reserveErr.message}`);
    if (!reservationId) {
      return new Response(
        JSON.stringify({ error: 'insufficient_credits', balance: Number(profile.credit_balance ?? 0), estimate }),
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

    const hb = setInterval(() => { sse({ type: 'heartbeat' }); }, 5_000);

    (async () => {
      let settled = false;
      try {
        let html = '';
        let retried = false;
        let edited = false;

        if (isEditMode) {
          // ── EDIT MODE: refine the existing site from a chat instruction ────
          const { text: editRaw, usage: editUsage } = await callClaude(apiKey, [
            { role: 'system', content: editSystemPrompt(lang) },
            { role: 'user', content: `CURRENT HTML:\n${currentHtml}\n\nCHANGE REQUEST:\n${prompt}` },
          ], 0.2, EDIT_MAX_OUTPUT_TOKENS);
          addUsage(totalUsage, editUsage);
          if (editUsage.output_tokens >= EDIT_MAX_OUTPUT_TOKENS) {
            throw editFailed('The change was too large to apply in one step. Try splitting it into smaller requests.');
          }
          const editedHtml = applyEditBlocks(currentHtml as string, editRaw);
          if (!/<!DOCTYPE\s+html/i.test(editedHtml) || !/<\/html>/i.test(editedHtml)) {
            throw editFailed('The edit would have broken the document structure.');
          }
          html = editedHtml;
          edited = true;
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
          addUsage(totalUsage, buildUsage);
          html = extractHtml(raw);

          if (isSkeletalOutput(html)) {
            retried = true;
            const retryMessages = [
              ...buildMessages,
              { role: 'assistant', content: html },
              { role: 'user', content: 'That output was incomplete or broken. Rebuild the website as one complete, valid HTML document, starting with <!DOCTYPE html> and ending with </html>. Raw HTML only — no markdown, no code fences.' },
            ];
            const { text: retryRaw, usage: retryUsage } = await callClaude(apiKey, retryMessages, 1.0, 12000, sysBlocks);
            addUsage(totalUsage, retryUsage);
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

        // Settle the reservation to the real cost (balance + ledger in one transaction).
        // The site exists at this point, so a settle failure is logged rather than
        // turned into a user-facing error; the reservation then stays 'reserved' and
        // the user has paid the estimate.
        const creditsUsed = computeCredits(totalUsage, rates);
        const { error: settleErr } = await supabase.rpc('settle_credits', {
          p_ledger_id: reservationId,
          p_credits: creditsUsed,
          p_input_tokens: totalUsage.input_tokens,
          p_output_tokens: totalUsage.output_tokens,
          p_cache_write_tokens: totalUsage.cache_creation_input_tokens ?? 0,
          p_cache_read_tokens: totalUsage.cache_read_input_tokens ?? 0,
          p_site_id: site.id,
        });
        if (settleErr) console.error('[generate-site] settle_credits failed:', reservationId, settleErr.message);
        else settled = true;

        // Legacy counter, kept for stats only.
        await supabase.from('profiles').update({ generations_used: (profile.generations_used ?? 0) + 1 }).eq('id', user.id);

        // Fire-and-forget referral check — never block the SSE result.
        void checkReferralActivation(supabase, user.id).catch(() => {});

        console.log('[generate-site] sending result, html_len:', html.length, 'credits:', creditsUsed);
        const { html_output: _dropped, ...siteForClient } = site;
        await sse({ type: 'result', site: siteForClient, html, sessionId: resolvedSessionId, retried, edited, detectedLanguage: lang, creditsUsed });
        console.log('[generate-site] result sent');
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error('[generate-site] IIFE error:', msg);
        // The AI call or saving failed: give the reserved estimate back.
        if (!settled) {
          const { error: refundErr } = await supabase.rpc('refund_credits', { p_ledger_id: reservationId });
          if (refundErr) console.error('[generate-site] refund_credits failed:', reservationId, refundErr.message);
        }
        // deno-lint-ignore no-explicit-any
        const e = err as any;
        // edit_failed carries a user-facing detail; anything else (Anthropic's response
        // body, DB errors) stays in the log (AUDIT-APP.md L9).
        if (e?.detail) {
          await sse({ type: 'error', error: msg, detail: e.detail, status: e.status ?? 502 });
        } else {
          await sse({ type: 'error', error: 'Generation failed. Please try again.', status: e?.status ?? 502 });
        }
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
