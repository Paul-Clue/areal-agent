'use client';

import Link from "next/link";
import { Show, SignInButton, SignUpButton, UserButton } from "@clerk/nextjs";

export default function Home() {
  return (
    <div className="flex min-h-full flex-1 flex-col bg-zinc-950 text-zinc-100">
      <header className="flex items-center justify-between border-b border-zinc-800 px-6 py-4">
        <span className="text-lg font-semibold tracking-tight">Property Video</span>
        <div className="flex items-center gap-3">
          <Show when="signed-out">
            <SignInButton mode="modal">
              <button
                type="button"
                className="rounded-md border border-zinc-600 px-3 py-1.5 text-sm text-zinc-200 hover:bg-zinc-800"
              >
                Sign in
              </button>
            </SignInButton>
            <SignUpButton mode="modal">
              <button
                type="button"
                className="rounded-md bg-emerald-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-emerald-500"
              >
                Sign up
              </button>
            </SignUpButton>
          </Show>
          <Show when="signed-in">
            <Link
              href="/dashboard"
              className="text-sm text-emerald-400 hover:text-emerald-300"
            >
              Dashboard
            </Link>
            <UserButton />
          </Show>
        </div>
      </header>
      <main className="mx-auto flex max-w-2xl flex-1 flex-col items-center justify-center gap-4 px-6 text-center">
        <h1 className="text-3xl font-semibold tracking-tight sm:text-4xl">
          Aerial property videos
        </h1>
        <p className="text-balance text-zinc-400">
          Look up a Jamaica NLA valuation or folio, preview the site on satellite, and
          generate a branded video (queue + worker in progress per planv6).
        </p>
        <Show when="signed-in">
          <Link
            href="/dashboard/generate"
            className="rounded-lg bg-emerald-600 px-5 py-2.5 text-sm font-medium text-white hover:bg-emerald-500"
          >
            Open generate
          </Link>
        </Show>
        <Show when="signed-out">
          <p className="text-sm text-zinc-500">Sign in to load properties and use the map.</p>
        </Show>
      </main>
    </div>
  );
}
