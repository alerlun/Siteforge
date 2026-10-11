// deno-lint-ignore-file no-explicit-any

const TWENTY_FOUR_HOURS_MS = 24 * 60 * 60 * 1000;

/**
 * Called after a user generates their first (or any) site.
 * Marks first_generation_at on their pending referral activation.
 * If the account is already >24h old, confirms the referral immediately;
 * otherwise leaves it for the hourly process_referrals() cron.
 */
export async function checkReferralActivation(
  supabase: any,
  userId: string,
): Promise<void> {
  const { data: activation, error } = await supabase
    .from('referral_activations')
    .select('id, created_at, first_generation_at')
    .eq('referred_id', userId)
    .eq('status', 'pending')
    .maybeSingle();
  if (error) {
    console.error('[referral] activation lookup failed:', userId, error.message);
    return;
  }

  if (!activation) return;
  if (activation.first_generation_at) return; // already marked on a previous generation

  const now = new Date();

  const { error: markErr } = await supabase
    .from('referral_activations')
    .update({ first_generation_at: now.toISOString() })
    .eq('id', activation.id);
  if (markErr) {
    console.error('[referral] marking first generation failed:', activation.id, markErr.message);
    return;
  }

  const accountAge = now.getTime() - new Date(activation.created_at).getTime();
  if (accountAge >= TWENTY_FOUR_HOURS_MS) {
    // Same atomic DB function the cron uses: confirms once, enforces the daily cap,
    // and grants the milestone reward via grant_credits (with a ledger row).
    const { error: confirmErr } = await supabase.rpc('confirm_referral', { p_activation_id: activation.id });
    if (confirmErr) console.error('[referral] confirm_referral failed:', activation.id, confirmErr.message);
  }
  // else: cron will confirm it once 24h has elapsed
}
