import type { Metadata, Viewport } from "next";
import { Anybody, Hanken_Grotesk, Spline_Sans_Mono } from "next/font/google";
import "./globals.css";

const display = Anybody({ subsets: ["latin"], axes: ["wdth"], variable: "--font-anybody", display: "swap" });
const sans = Hanken_Grotesk({ subsets: ["latin"], variable: "--font-hanken", display: "swap" });
const mono = Spline_Sans_Mono({ subsets: ["latin"], variable: "--font-spline-mono", display: "swap" });

export const metadata: Metadata = {
  title: "Claim! · the live-sale desk for boutiques",
  description: "Talk on air, let buyers type like people, and charge every buyer once when the show ends.",
};

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f3f1f7" },
    { media: "(prefers-color-scheme: dark)", color: "#100c16" },
  ],
};

const themeScript = `try{var q=new URLSearchParams(location.search).get("theme");var t=q||localStorage.getItem("claim-theme");if(t==="dark"||t==="light")document.documentElement.dataset.theme=t;}catch(e){}`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${display.variable} ${sans.variable} ${mono.variable}`} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
      </head>
      <body className="min-h-dvh bg-paper text-ink antialiased">{children}</body>
    </html>
  );
}
