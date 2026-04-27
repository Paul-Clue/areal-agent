'use client';

import { useEffect } from 'react';
import Link from 'next/link';

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  useEffect(() => {
    void fetch('/api/agent/sync', { method: 'POST' });
  }, []);

  return (
    <div className="min-h-full flex-1 bg-zinc-50 text-zinc-900">
      <div className="border-b border-zinc-200 bg-white">
        <div className="mx-auto flex max-w-4xl items-center justify-between gap-4 px-4 py-3">
          <span className="font-semibold text-zinc-800">Dashboard</span>
          <nav className="flex flex-wrap gap-4 text-sm">
            <Link href="/dashboard" className="text-emerald-700 hover:underline">
              Home
            </Link>
            <Link href="/dashboard/generate" className="text-emerald-700 hover:underline">
              Generate
            </Link>
            <Link href="/dashboard/profile" className="text-zinc-700 hover:underline">
              Profile
            </Link>
            <Link href="/dashboard/billing" className="text-zinc-700 hover:underline">
              Billing
            </Link>
            <Link href="/" className="text-zinc-600 hover:underline">
              Site
            </Link>
          </nav>
        </div>
      </div>
      <div className="mx-auto max-w-4xl px-4 py-8">{children}</div>
    </div>
  );
}
