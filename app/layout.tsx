import type { Metadata, Viewport } from "next";
import { DM_Sans, Lora } from "next/font/google";
import "./globals.css";
import "./mobile.css";

const sans = DM_Sans({ variable: "--font-sans", subsets: ["latin"] });
const serif = Lora({ variable: "--font-serif", subsets: ["latin"] });

export const metadata: Metadata = {
  title: "Keepsake — Remember the people who matter",
  description: "A private place for the stories, details, and memories that make your people special.",
  manifest: "/manifest.webmanifest",
  applicationName: "Keepsake",
  appleWebApp: {
    capable: true,
    statusBarStyle: "default",
    title: "Keepsake",
  },
  icons: {
    icon: [{ url: "/keepsake-favicon.png", type: "image/png" }],
    shortcut: "/keepsake-favicon.png",
    apple: "/keepsake-favicon.png",
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 5,
  viewportFit: "cover",
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#fbf7f1" },
    { media: "(prefers-color-scheme: dark)", color: "#181816" },
  ],
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en"><body className={`${sans.variable} ${serif.variable}`}>{children}</body></html>;
}
