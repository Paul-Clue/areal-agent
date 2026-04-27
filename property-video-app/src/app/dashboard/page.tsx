'use client';

import Link from 'next/link';
import useSWR from 'swr';

const fetcher = (u: string) => fetch(u).then((r) => r.json());

type Job = {
  id: string;
  valuation_number: string;
  status: string;
  renderer: string | null;
  created_at: string;
  completed_at: string | null;
  error_message: string | null;
};

export default function DashboardHome() {
  const { data, error, isLoading } = useSWR('/api/jobs', fetcher);

  const jobs: Job[] = (data as { jobs?: Job[] } | undefined)?.jobs ?? [];

  return (
    <div>
      <h1 className="text-2xl font-semibold text-zinc-900">Welcome</h1>
      <p className="mt-2 text-zinc-600">
        Look up a valuation or folio, preview the map, and generate a video. For jobs to run, start Redis and the
        worker: <code className="text-sm">npm run worker</code> in a second terminal.
      </p>
      <Link
        href="/dashboard/generate"
        className="mt-6 inline-block rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-500"
      >
        Go to generate
      </Link>

      <section className="mt-10">
        <h2 className="text-lg font-medium text-zinc-900">Recent videos</h2>
        {isLoading && <p className="mt-2 text-sm text-zinc-500">Loading jobs…</p>}
        {error && <p className="mt-2 text-sm text-red-600">Could not load jobs.</p>}
        {!isLoading && !error && jobs.length === 0 && (
          <p className="mt-2 text-sm text-zinc-500">No jobs yet. Generate one from the generate page.</p>
        )}
        {jobs.length > 0 && (
          <ul className="mt-3 divide-y divide-zinc-200 rounded-md border border-zinc-200 bg-white text-sm">
            {jobs.map((j) => (
              <li key={j.id} className="flex flex-wrap items-baseline justify-between gap-2 px-3 py-2">
                <span className="font-mono text-zinc-800">{j.valuation_number}</span>
                <span
                  className={
                    j.status === 'complete'
                      ? 'text-emerald-700'
                      : j.status === 'failed'
                        ? 'text-red-600'
                        : 'text-amber-700'
                  }
                >
                  {j.status}
                </span>
                {j.status === 'complete' && (
                  <Link href={`/api/download/${j.id}`} className="text-emerald-700 underline" download>
                    Download
                  </Link>
                )}
                {j.error_message && <span className="w-full text-xs text-red-500">{j.error_message}</span>}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
