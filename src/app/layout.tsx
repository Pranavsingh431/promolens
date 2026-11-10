import type { Metadata } from "next";
import { Instrument_Sans, Instrument_Serif, JetBrains_Mono } from "next/font/google";
import type { ReactNode } from "react";

import { SiteFooter } from "@/components/layout/site-footer";
import { SiteHeader } from "@/components/layout/site-header";

import "./globals.css";

const sans = Instrument_Sans({
  subsets: ["latin"],
  variable: "--font-instrument-sans",
  display: "swap",
});

const serif = Instrument_Serif({
  subsets: ["latin"],
  weight: "400",
  style: ["normal", "italic"],
  variable: "--font-instrument-serif",
  display: "swap",
});

const mono = JetBrains_Mono({
  subsets: ["latin"],
  variable: "--font-jetbrains-mono",
  display: "swap",
});

export const metadata: Metadata = {
  title: { default: "PromoLens", template: "%s · PromoLens" },
  description: "Find promo-ready moments in timestamped microdrama screenplays.",
  applicationName: "PromoLens",
  icons: { icon: [{ url: "/brand/promolens-mark.svg", type: "image/svg+xml" }] },
};

export default function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="en" className={`${sans.variable} ${serif.variable} ${mono.variable}`}>
      <body className="flex min-h-dvh flex-col bg-canvas font-sans text-ink antialiased">
        <a
          href="#main"
          className="sr-only rounded-sm bg-accent px-3 py-2 text-sm font-medium text-on-accent focus:not-sr-only focus:absolute focus:top-3 focus:left-3"
        >
          Skip to main content
        </a>
        <SiteHeader />
        <div className="flex-1">{children}</div>
        <SiteFooter />
      </body>
    </html>
  );
}
