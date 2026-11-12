import type { Metadata, Viewport } from "next";
import Link from "next/link";
import { Boxes } from "lucide-react";
import "./globals.css";
import { NavLink } from "@/components/NavLink";

export const metadata: Metadata = {
  title: "agent sandbox",
  description: "Run and monitor autonomous agent tasks",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <header className="topbar">
          <div className="topbar-inner">
            <Link href="/" className="brand">
              <span className="brand-mark">
                <Boxes size={14} />
              </span>
              sandbox
            </Link>
            <nav className="nav">
              <NavLink href="/" label="Tasks" icon="tasks" />
              <NavLink href="/new" label="New task" icon="new" />
              <NavLink href="/settings" label="Settings" icon="settings" />
            </nav>
          </div>
        </header>
        <main className="shell">{children}</main>
      </body>
    </html>
  );
}
