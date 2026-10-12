// scrape-leads — calls Google Places Text Search + Place Details, persists results.
import { corsHeaders } from '../_shared/cors.ts';
import { adminClient, getUser, PLAN_LIMITS } from '../_shared/auth.ts';
import { readBoundedJson, errorResponse, fromHttpError, clientIp } from '../_shared/guards.ts';
import { scrapeLeadsSchema } from '../_shared/validation.ts';
import { enforce } from '../_shared/ratelimit.ts';

// Every Place Details call costs money, also for businesses the website filter drops.
// A search therefore uses at least one lead of the monthly quota per EXAMINED_PER_LEAD
// places examined, so the quota also caps the Places spend per account.
const EXAMINED_PER_LEAD = 5;

const RADIUS_METERS: Record<string, number> = {
  '1mi': 1609,
  '5mi': 8047,
  '10mi': 16093,
  '25mi': 40234,
};

interface PlaceResult {
  place_id?: string;
  name?: string;
  formatted_address?: string;
  rating?: number;
  user_ratings_total?: number;
}

interface PlaceDetails {
  result?: {
    name?: string;
    formatted_address?: string;
    formatted_phone_number?: string;
    international_phone_number?: string;
    rating?: number;
    user_ratings_total?: number;
    website?: string;
  };
}

// Gives back the part of a quota reservation a search did not use.
async function releaseLeads(userId: string, amount: number): Promise<void> {
  if (amount <= 0) return;
  const { error } = await adminClient().rpc('release_leads', { p_user_id: userId, p_amount: amount });
  if (error) console.error('[scrape-leads] release_leads failed:', userId, amount, error.message);
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  // Quota reserved for this search; whatever is not used is released on every exit path.
  let reservedFor: string | null = null;
  let reserved = 0;

  try {
    const user = await getUser(req);
    if (!user) return errorResponse(401, 'Unauthorized');

    const ipBlocked = await enforce('scrape', clientIp(req));
    if (ipBlocked) return ipBlocked;
    const userBlocked = await enforce('scrape', user.id);
    if (userBlocked) return userBlocked;

    const raw = await readBoundedJson(req);
    const parsed = scrapeLeadsSchema.safeParse(raw);
    if (!parsed.success) return errorResponse(400, 'invalid_input', parsed.error.flatten());
    const { businessType, city, radius, maxResults, websiteFilter } = parsed.data;
    // 'without' (default) = website-less only; 'both' = keep all.
    const includeWithWebsite = websiteFilter === 'both';
    const cap = Math.min(Math.max(maxResults ?? 20, 1), 100);
    const radiusM = RADIUS_METERS[radius ?? '5mi'] ?? RADIUS_METERS['5mi'];

    const apiKey = Deno.env.get('GOOGLE_PLACES_API_KEY');
    if (!apiKey) return errorResponse(500, 'GOOGLE_PLACES_API_KEY not configured');

    const supabase = adminClient();
    const { data: profile } = await supabase
      .from('profiles')
      .select('plan, pro_until')
      .eq('id', user.id)
      .single();
    if (!profile) {
      return new Response(JSON.stringify({ error: 'Profile not found' }), {
        status: 404,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }
    // Same rule as the DB function effective_plan(): Pro via Stripe/manual (plan) or via
    // referral reward (pro_until in the future).
    const plan: 'free' | 'pro' =
      profile.plan === 'pro' || (profile.pro_until && new Date(profile.pro_until) > new Date())
        ? 'pro' : 'free';
    const limit = PLAN_LIMITS[plan].leads;
    // Take the quota atomically before any Google call, so parallel searches cannot all
    // see the same remaining quota (reserve_leads locks the profile row).
    const { data: granted, error: reserveErr } = await supabase.rpc('reserve_leads', {
      p_user_id: user.id, p_amount: cap, p_limit: limit,
    });
    if (reserveErr) throw new Error(`reserve_leads: ${reserveErr.message}`);
    if (!granted) {
      return new Response(
        JSON.stringify({ error: 'limit_reached', plan, limit }),
        { status: 402, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      );
    }
    reservedFor = user.id;
    reserved = granted as number;
    const fetchTarget = reserved;
    // Hard ceiling on places examined per search to bound Places API spend.
    // Never examine more places than the remaining quota can pay for (see EXAMINED_PER_LEAD).
    const examineCap = Math.min(fetchTarget * EXAMINED_PER_LEAD, 200);

    // Text Search w/ pagination (each page = up to 20 results), bounded by examineCap.
    const collected: PlaceResult[] = [];
    let pageToken: string | undefined;
    const queryBase =
      `https://maps.googleapis.com/maps/api/place/textsearch/json?query=${encodeURIComponent(`${businessType} in ${city}`)}` +
      `&radius=${radiusM}&key=${apiKey}`;
    while (collected.length < examineCap) {
      // Follow-up pages must repeat the original query parameters next to pagetoken;
      // pagetoken alone is answered with INVALID_REQUEST (verified 2026-10-11).
      const url = pageToken
        ? `${queryBase}&pagetoken=${encodeURIComponent(pageToken)}`
        : queryBase;
      const res = await fetch(url);
      const json = await res.json();
      // Google answers 200 with a status field; anything but OK / ZERO_RESULTS is an
      // error (e.g. REQUEST_DENIED when billing is off) and must not look like "0 leads".
      if (json.status !== 'OK' && json.status !== 'ZERO_RESULTS') {
        console.error('[scrape-leads] Places Text Search failed:', pageToken ? 'next page' : 'first page', json.status, json.error_message);
        // A later page failing should not throw away the results already collected.
        if (pageToken && collected.length) break;
        await releaseLeads(user.id, reserved);
        return errorResponse(502, 'places_api_error', {
          status: json.status,
          message: json.error_message ?? null,
        });
      }
      const items: PlaceResult[] = Array.isArray(json.results) ? json.results : [];
      for (const item of items) {
        if (collected.length >= examineCap) break;
        collected.push(item);
      }
      pageToken = json.next_page_token;
      if (!pageToken) break;
      // Google requires a brief delay before next_page_token becomes valid.
      await new Promise((r) => setTimeout(r, 2200));
    }

    // Details for each. Filter to website-less businesses only.
    const detailFields = 'name,formatted_address,formatted_phone_number,international_phone_number,rating,user_ratings_total,website';
    const enriched = [] as Array<{
      place_id: string;
      business_name: string;
      phone: string | null;
      address: string | null;
      rating: number | null;
      review_count: number | null;
      has_website: boolean;
      website_url: string | null;
      business_type: string;
    }>;
    let examined = 0;
    let skippedHasWebsite = 0;

    // Places the user already has as leads: skipped before the Details call, so a repeated
    // or overlapping search neither saves duplicates nor costs quota or Details requests.
    const known = new Set<string>();
    const placeIds = collected.map((p) => p.place_id).filter((id): id is string => !!id);
    if (placeIds.length) {
      const { data: existing, error: existingErr } = await supabase
        .from('leads')
        .select('place_id')
        .eq('user_id', user.id)
        .in('place_id', placeIds);
      if (existingErr) throw new Error(`known leads: ${existingErr.message}`);
      for (const row of existing ?? []) if (row.place_id) known.add(row.place_id);
    }
    let skippedKnown = 0;

    for (const place of collected) {
      if (enriched.length >= fetchTarget) break;
      if (!place.place_id) continue;
      if (known.has(place.place_id)) {
        skippedKnown++;
        continue;
      }
      known.add(place.place_id); // Text Search pages can repeat a place
      examined++;
      const detailsUrl = `https://maps.googleapis.com/maps/api/place/details/json?place_id=${place.place_id}&fields=${detailFields}&key=${apiKey}`;
      let details: PlaceDetails['result'] | undefined;
      try {
        const dRes = await fetch(detailsUrl);
        const dJson: PlaceDetails = await dRes.json();
        details = dJson.result;
      } catch (_e) {
        details = undefined;
      }
      const website = details?.website ?? null;
      if (website && !includeWithWebsite) {
        skippedHasWebsite++;
        continue;
      }
      enriched.push({
        place_id: place.place_id,
        business_name: details?.name ?? place.name ?? 'Unknown',
        phone: details?.formatted_phone_number ?? details?.international_phone_number ?? null,
        address: details?.formatted_address ?? place.formatted_address ?? null,
        rating: details?.rating ?? place.rating ?? null,
        review_count: details?.user_ratings_total ?? place.user_ratings_total ?? null,
        has_website: Boolean(website),
        website_url: website,
        business_type: String(businessType),
      });
    }

    const rows = enriched.map((r) => ({ ...r, user_id: user.id, status: 'new' }));
    let inserted: any[] = [];
    if (rows.length) {
      // ON CONFLICT DO NOTHING: a concurrent search may have saved the same place meanwhile.
      const { data, error } = await supabase
        .from('leads')
        .upsert(rows, { onConflict: 'user_id,place_id', ignoreDuplicates: true })
        .select();
      if (error) {
        await releaseLeads(user.id, reserved);
        return new Response(JSON.stringify({ error: error.message }), {
          status: 500,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }
      inserted = data ?? [];
    }

    // examined <= fetchTarget * EXAMINED_PER_LEAD, so quotaUsed never exceeds the reservation.
    const quotaUsed = Math.min(reserved, Math.max(inserted.length, Math.ceil(examined / EXAMINED_PER_LEAD)));
    await releaseLeads(user.id, reserved - quotaUsed);
    reservedFor = null;

    return new Response(
      JSON.stringify({
        leads: inserted,
        count: inserted.length,
        examined,
        skippedHasWebsite,
        skippedKnown,
        quotaUsed,
      }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    );
  } catch (err) {
    if (reservedFor) await releaseLeads(reservedFor, reserved);
    return fromHttpError(err);
  }
});
