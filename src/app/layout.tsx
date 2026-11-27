import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "COURTSIDE | NBA Player Performance",
  description: "Independent NBA player performance forecasts and model results.",
  manifest: "/manifest.json",
  themeColor: "#090d12",
  appleWebApp: { capable: true, statusBarStyle: "black-translucent", title: "COURTSIDE" },
  icons: { icon: "/icon.svg", shortcut: "/icon.svg", apple: "/icon.svg" }
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en"><body>{children}</body></html>;
}