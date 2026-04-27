'use client';

import { useState } from 'react';
import useSWR from 'swr';

async function fetchAgent(u: string): Promise<Agent> {
  const r = await fetch(u);
  const j = (await r.json()) as Agent & { error?: string };
  if (!r.ok) {
    throw new Error(j.error || 'Request failed');
  }
  return j;
}

type Agent = {
  id: string;
  name: string | null;
  company: string | null;
  brokerage: string | null;
  phone: string | null;
  email: string | null;
  license_number: string | null;
  tagline: string | null;
  website: string | null;
  brand_color: string | null;
  logo_url: string | null;
  headshot_url: string | null;
};

function imageSrc(which: 'logo' | 'headshot', url: string | null): string | null {
  if (!url) return null;
  if (url.startsWith('file:')) {
    return `/api/agent/image/${which}`;
  }
  return url;
}

type FormState = {
  name: string;
  company: string;
  brokerage: string;
  phone: string;
  email: string;
  license_number: string;
  tagline: string;
  website: string;
  brand_color: string;
};

function toFormState(a: Agent): FormState {
  return {
    name: a.name || '',
    company: a.company || '',
    brokerage: a.brokerage || '',
    phone: a.phone || '',
    email: a.email || '',
    license_number: a.license_number || '',
    tagline: a.tagline || '',
    website: a.website || '',
    brand_color: a.brand_color || '#00FF00',
  };
}

function ProfileForm({ initial, onSaved }: { initial: Agent; onSaved: () => void }) {
  const [form, setForm] = useState<FormState>(() => toFormState(initial));
  const [agent, setAgent] = useState<Agent>(initial);
  const [logoFile, setLogoFile] = useState<File | null>(null);
  const [headshotFile, setHeadshotFile] = useState<File | null>(null);
  const [saveMsg, setSaveMsg] = useState('');

  async function save() {
    setSaveMsg('');
    const data = new FormData();
    Object.entries(form).forEach(([k, v]) => data.append(k, v));
    if (logoFile) data.append('logo', logoFile);
    if (headshotFile) data.append('headshot', headshotFile);
    const r = await fetch('/api/agent/update', { method: 'POST', body: data });
    if (!r.ok) {
      const j = (await r.json().catch(() => ({}))) as { error?: string };
      setSaveMsg(j.error || 'Save failed');
      return;
    }
    setSaveMsg('Profile saved.');
    setLogoFile(null);
    setHeadshotFile(null);
    const me = await fetch('/api/agent/me').then((x) => x.json() as Promise<Agent>);
    setAgent(me);
    setForm(toFormState(me));
    onSaved();
  }

  return (
    <>
      <div className="mt-6 grid max-w-xl gap-3">
        {(['name', 'company', 'brokerage', 'phone', 'email', 'license_number', 'tagline', 'website'] as const).map(
          (f) => (
            <div key={f}>
              <label className="block text-sm font-medium text-zinc-700" htmlFor={f}>
                {f.replace(/_/g, ' ')}
              </label>
              <input
                id={f}
                className="mt-1 w-full rounded-md border border-zinc-300 px-3 py-2 text-zinc-900"
                value={form[f]}
                onChange={(e) => setForm({ ...form, [f]: e.target.value })}
              />
            </div>
          )
        )}
        <div>
          <label className="block text-sm font-medium text-zinc-700" htmlFor="bc">
            Brand color
          </label>
          <input
            id="bc"
            type="color"
            className="mt-1 h-10 w-20 rounded border border-zinc-300"
            value={form.brand_color}
            onChange={(e) => setForm({ ...form, brand_color: e.target.value })}
          />
        </div>
        <div className="flex flex-wrap gap-6">
          <div>
            <span className="text-sm font-medium text-zinc-700">Logo</span>
            <input
              type="file"
              accept="image/png,image/jpeg,image/webp"
              className="mt-1 block text-sm"
              onChange={(e) => setLogoFile(e.target.files?.[0] || null)}
            />
          </div>
          <div>
            <span className="text-sm font-medium text-zinc-700">Headshot</span>
            <input
              type="file"
              accept="image/png,image/jpeg,image/webp"
              className="mt-1 block text-sm"
              onChange={(e) => setHeadshotFile(e.target.files?.[0] || null)}
            />
          </div>
        </div>
        <button
          type="button"
          onClick={() => void save()}
          className="mt-2 w-fit rounded-md bg-zinc-900 px-4 py-2 text-sm font-medium text-white"
        >
          Save profile
        </button>
        {saveMsg && <p className="text-sm text-emerald-700">{saveMsg}</p>}
      </div>

      {(agent.logo_url || agent.headshot_url) && (
        <div className="mt-8 border-t border-zinc-200 pt-6">
          <p className="text-sm font-medium text-zinc-800">Saved images</p>
          <div className="mt-2 flex flex-wrap gap-4">
            {agent.logo_url && (
              <div>
                <p className="text-xs text-zinc-500">Logo</p>
                {/* eslint-disable-next-line @next/next/no-img-element -- dynamic user asset URL */}
                <img
                  key={agent.logo_url}
                  src={imageSrc('logo', agent.logo_url) || undefined}
                  alt="Logo"
                  className="mt-1 max-h-24 rounded border border-zinc-200 bg-white p-1"
                />
              </div>
            )}
            {agent.headshot_url && (
              <div>
                <p className="text-xs text-zinc-500">Headshot</p>
                {/* eslint-disable-next-line @next/next/no-img-element -- dynamic user asset URL */}
                <img
                  key={agent.headshot_url}
                  src={imageSrc('headshot', agent.headshot_url) || undefined}
                  alt="Headshot"
                  className="mt-1 max-h-24 rounded border border-zinc-200 bg-white p-1"
                />
              </div>
            )}
          </div>
        </div>
      )}
    </>
  );
}

export default function ProfilePage() {
  const { data, error, isLoading, mutate } = useSWR<Agent>('/api/agent/me', fetchAgent);
  if (isLoading) {
    return <p className="text-zinc-600">Loading…</p>;
  }
  if (error || !data) {
    return <p className="text-red-600">{(error as Error)?.message || 'Could not load profile'}</p>;
  }
  return (
    <div>
      <h1 className="text-2xl font-semibold text-zinc-900">Profile</h1>
      <p className="mt-2 text-zinc-600">
        Branding is used in generated videos (intro, outro, and optional corner watermark). Local uploads are stored
        under <code className="text-sm">.data/agent-assets/</code> unless DigitalOcean Spaces is configured.
      </p>
      <ProfileForm key={data.id} initial={data} onSaved={() => void mutate()} />
    </div>
  );
}
