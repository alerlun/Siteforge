import { useEffect } from 'react';
import { Outlet } from 'react-router-dom';
import Sidebar from '../components/Sidebar.jsx';
import { useAuth } from '../lib/auth.jsx';
import { getPendingReferral, claimReferral } from '../lib/referral.js';

export default function AppLayout() {
  const { profile } = useAuth();

  useEffect(() => {
    if (!profile) return;
    if (profile.referred_by) {
      // Already attributed — clear stale localStorage entry if present.
      import('../lib/referral.js').then(({ clearPendingReferral }) => clearPendingReferral());
      return;
    }
    const code = getPendingReferral();
    if (!code) return;
    claimReferral(code); // fire-and-forget; clears localStorage in finally
  }, [profile?.id]); // re-run only when user identity changes, not on every profile refresh

  return (
    <div className="min-h-screen flex bg-bg">
      <Sidebar />
      {/* pb-14 reserves space for mobile bottom nav */}
      <main className="flex-1 min-w-0 flex flex-col pb-14 md:pb-0">
        <Outlet />
      </main>
    </div>
  );
}
