import type { Metadata } from "next";
import Link from "next/link";
import { Geist, Geist_Mono } from "next/font/google";
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
  title: "Mesh · verifiable spare compute",
  description: "Run jobs on spare machines. The chain proves what ran, slashes a lie, and leaves a receipt.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}>
      <body className="flex min-h-full flex-col">
        <header className="border-b border-zinc-400/30">
          <nav className="mx-auto flex max-w-6xl items-center gap-6 px-5 py-3" aria-label="Main">
            <Link href="/" className="text-lg font-semibold tracking-tight">
              Mesh
            </Link>
            <span className="hidden text-xs text-zinc-500 sm:inline">verifiable spare compute on Hedera testnet</span>
          </nav>
        </header>
        <main className="mx-auto w-full max-w-6xl flex-1 px-5 py-8">{children}</main>
      </body>
    </html>
  );
}
