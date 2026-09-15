import type { Metadata } from 'next';
import { Inter } from 'next/font/google';
import type { ReactNode } from 'react';
import './globals.css';

/**
 * DESIGN.md sets everything in one family. Its reference face is proprietary; the doc
 * itself says to substitute Inter. next/font downloads it at BUILD time and serves it
 * from this app, so the browser never requests Google Fonts at runtime.
 */
const inter = Inter({ subsets: ['latin'], variable: '--font-inter', display: 'swap' });

export const metadata: Metadata = {
  title: 'Rule #1 Watchlist',
  description: 'Live prices against Payback Time buy prices and manual safe prices.',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={inter.variable}>
      <body className="min-h-screen bg-canvas font-sans text-body-md text-ink antialiased">{children}</body>
    </html>
  );
}
