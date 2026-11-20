'use client';

import Link from 'next/link';
import { Moon, ScanLine, Sun } from 'lucide-react';
import { useTheme } from 'next-themes';

export function Navbar() {
  const { resolvedTheme, setTheme } = useTheme();

  return (
    <header className="border-b border-neutral-200 bg-white dark:border-neutral-800 dark:bg-black">
      <nav aria-label="Main navigation" className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-3 px-4 py-3 sm:px-6">
        <Link href="/" className="flex items-center gap-2 font-semibold">
          <ScanLine aria-hidden="true" className="h-5 w-5" />
          SynthID Remover
        </Link>
        <div className="flex items-center gap-4 text-sm">
          <Link href="/#workspace" className="hover:underline">Workspace</Link>
          <Link href="/dashboard" className="hover:underline">History</Link>
          <button
            type="button"
            aria-label="Toggle color theme"
            className="rounded-lg border border-neutral-300 p-2 dark:border-neutral-700"
            onClick={() => setTheme(resolvedTheme === 'dark' ? 'light' : 'dark')}
          >
            <Moon aria-hidden="true" className="h-4 w-4 dark:hidden" />
            <Sun aria-hidden="true" className="hidden h-4 w-4 dark:block" />
          </button>
        </div>
      </nav>
    </header>
  );
}
