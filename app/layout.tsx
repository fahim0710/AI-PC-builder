import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "NexRig — Build your perfect PC",
  description: "An AI-guided, compatibility-first PC builder for Bangladesh.",
  icons: { icon: "/favicon.svg" },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en"><body>{children}</body></html>;
}
