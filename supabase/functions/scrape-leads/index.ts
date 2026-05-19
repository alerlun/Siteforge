// scrape-leads — calls Google Places Text Search + Place Details, persists results.
import { corsHeaders } from '../_shared/cors.ts';
import { adminClient, getUser, PLAN_LIMITS } from '../_shared/auth.ts';

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

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  try {
    const user = await getUser(req);
    if (!user) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), {
        status: 401,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const { businessType, city, radius, maxResults, websiteFilter } = await req.json();
    // 'without' (default) = website-less only; 'both' = keep all.
    const includeWithWebsite = websiteFilter === 'both';
    if (!businessType || !city) {
      return new Response(JSON.stringify({ error: 'businessType and city required' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }
    const cap = Math.min(Math.max(parseInt(maxResults ?? '20', 10) || 20, 1), 100);
    const radiusM = RADIUS_METERS[radius] ?? RADIUS_METERS['5mi'];

    const apiKey = Deno.env.get('GOOGLE_PLACES_API_KEY');
    if (!apiKey) {
      return new Response(JSON.stringify({ error: 'GOOGLE_PLACES_API_KEY not configured' }), {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const supabase = adminClient();
    const { data: profile } = await supabase
      .from('profiles')
      .select('plan, leads_used')
      .eq('id', user.id)
      .single();
    if (!profile) {
      return new Response(JSON.stringify({ error: 'Profile not found' }), {
        status: 404,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }
    const limit = PLAN_LIMITS[(profile.plan as 'free' | 'pro') ?? 'free'].leads;
    const remaining = Math.max(0, limit - (profile.leads_used ?? 0));
    if (remaining <= 0) {
      return new Response(
        JSON.stringify({ error: 'limit_reached', plan: profile.plan, limit }),
        { status: 402, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      );
    }
    const fetchTarget = Math.min(cap, remaining);
    // Hard ceiling on places examined per search to bound Places API spend.
    const examineCap = Math.min(fetchTarget * 5, 200);

    // Text Search w/ pagination (each page = up to 20 results), bounded by examineCap.
    const collected: PlaceResult[] = [];
    let pageToken: string | undefined;
    const queryBase =
      `https://maps.googleapis.com/maps/api/place/textsearch/json?query=${encodeURIComponent(`${businessType} in ${city}`)}` +
      `&radius=${radiusM}&key=${apiKey}`;
    while (collected.length < examineCap) {
      const url = pageToken
        ? `https://maps.googleapis.com/maps/api/place/textsearch/json?pagetoken=${pageToken}&key=${apiKey}`
        : queryBase;
      const res = await fetch(url);
      const json = await res.json();
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
    for (const place of collected) {
      if (enriched.length >= fetchTarget) break;
      if (!place.place_id) continue;
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
      const { data, error } = await supabase.from('leads').insert(rows).select();
      if (error) {
        return new Response(JSON.stringify({ error: error.message }), {
          status: 500,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }
      inserted = data ?? [];
    }

    await supabase
      .from('profiles')
      .update({ leads_used: (profile.leads_used ?? 0) + inserted.length })
      .eq('id', user.id);

    return new Response(
      JSON.stringify({
        leads: inserted,
        count: inserted.length,
        examined,
        skippedHasWebsite,
      }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    );
  } catch (err) {
    return new Response(JSON.stringify({ error: String(err?.message ?? err) }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
