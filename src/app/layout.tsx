import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "NBA Player Performance",
  description: "Independent NBA player stat projections and model tracking."
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en"><body>{children}</body></html>;
}