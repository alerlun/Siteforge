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
  const { data: activation } = await supabase
    .from('referral_activations')
    .select('id, created_at, referrer_id, first_generation_at')
    .eq('referred_id', userId)
    .eq('status', 'pending')
    .maybeSingle();

  if (!activation) return;
  if (activation.first_generation_at) return; // already marked on a previous generation

  const now = new Date();

  await supabase
    .from('referral_activations')
    .update({ first_generation_at: now.toISOString() })
    .eq('id', activation.id);

  const accountAge = now.getTime() - new Date(activation.created_at).getTime();
  if (accountAge >= TWENTY_FOUR_HOURS_MS) {
    await confirmReferral(supabase, activation.id, activation.referrer_id);
  }
  // else: cron will confirm it once 24h has elapsed
}

/**
 * Marks an activation as confirmed and updates the referrer's count + milestone.
 * Grants pro_until extension and credit top-up if a 5-referral milestone is hit.
 */
export async function confirmReferral(
  supabase: any,
  activationId: string,
  referrerId: string,
): Promise<void> {
  await supabase
    .from('referral_activations')
    .update({ status: 'confirmed', confirmed_at: new Date().toISOString() })
    .eq('id', activationId);

  const { data: profile } = await supabase
    .from('profiles')
    .select('referral_count, referral_milestone, pro_until')
    .eq('id', referrerId)
    .single();

  if (!profile) return;

  const newCount = (profile.referral_count ?? 0) + 1;
  const lastMilestone = profile.referral_milestone ?? 0;
  const earnedMilestone = Math.floor(newCount / 5) * 5;

  const update: Record<string, unknown> = { referral_count: newCount };

  if (earnedMilestone > lastMilestone) {
    update.referral_milestone = earnedMilestone;
    const base =
      profile.pro_until && new Date(profile.pro_until) > new Date()
        ? new Date(profile.pro_until)
        : new Date();
    base.setMonth(base.getMonth() + 1);
    update.pro_until = base.toISOString();

    // Top up credits to Pro level immediately when milestone is earned.
    const { data: cfg } = await supabase
      .from('config')
      .select('value')
      .eq('key', 'credit_monthly_pro')
      .single();
    const proCredits = parseInt(cfg?.value ?? '680000', 10);
    update.credit_balance = proCredits;
  }

  await supabase.from('profiles').update(update).eq('id', referrerId);
}
