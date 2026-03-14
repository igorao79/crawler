import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import Link from "next/link";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Web Crawler",
  description: "Universal web crawler with BFS traversal and caching proxy",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className="dark">
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased min-h-screen bg-grid bg-noise`}
      >
        <header className="sticky top-0 z-40 glass-card border-0 border-b border-white/[0.06]">
          <div className="absolute inset-x-0 bottom-0 h-px bg-gradient-to-r from-transparent via-[#c1ff00]/30 to-transparent" />
          <nav className="container mx-auto flex items-center gap-8 px-6 py-4">
            <Link href="/" className="flex items-center gap-2 group">
              <div className="w-2 h-2 rounded-full bg-[#c1ff00] shadow-[0_0_8px_#c1ff00] group-hover:shadow-[0_0_16px_#c1ff00] transition-shadow" />
              <span className="text-lg font-bold tracking-tight text-foreground">
                LUSION
              </span>
              <span className="text-lg font-light tracking-tight text-muted-foreground">
                CRAWLER
              </span>
            </Link>
          </nav>
        </header>
        <main className="container mx-auto px-6 py-8">
          {children}
        </main>
      </body>
    </html>
  );
}
