import type { Metadata } from 'next';
import { Geist_Mono, Mona_Sans } from 'next/font/google';
import './globals.css';

const sans = Mona_Sans({ variable: '--font-sans', subsets: ['latin'], display: 'swap' });
const mono = Geist_Mono({ variable: '--font-mono', subsets: ['latin'], display: 'swap' });

export const metadata: Metadata = {
  title: 'Q8nten · Office memory',
  description: 'One Qdrant point per office, kept current by n8n: documents, versions, duplicates, and budgets.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${sans.variable} ${mono.variable}`}>
      {/* Browser extensions (Grammarly, password managers) add attributes to body before React hydrates. */}
      <body suppressHydrationWarning>{children}</body>
    </html>
  );
}
