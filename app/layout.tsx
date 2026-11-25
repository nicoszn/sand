import type { Metadata, Viewport } from "next";
import Link from "next/link";
import { Boxes, Sparkles } from "lucide-react";
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
        <div className="app">
          <aside className="rail">
            <Link href="/" className="brand">
              <span className="brand-mark">
                <Boxes size={16} />
              </span>
              <span className="brand-text">
                <span className="brand-word">sandbox</span>
                <span className="brand-tag">agent workspace</span>
              </span>
            </Link>

            <div>
              <div className="rail-section">Workspace</div>
              <nav className="rail-nav" style={{ marginTop: 8 }}>
                <NavLink href="/" label="Tasks" icon="tasks" />
                <NavLink href="/new" label="New task" icon="new" />
                <NavLink href="/memory" label="Memory" icon="memory" />
                <NavLink href="/settings" label="Settings" icon="settings" />
              </nav>
            </div>

            <div className="rail-foot">
              <div className="rail-note">
                <span className="rail-note-title">
                  <Sparkles size={12} /> typed memory graph
                </span>
                <span className="rail-note-body">
                  Every fact keeps a validity window, so a contradicted belief is superseded — never silently
                  overwritten.
                </span>
              </div>
              <div className="rail-version">v0.2.0 · local-first</div>
            </div>
          </aside>

          <div className="workspace">
            <header className="topbar">
              <div className="topbar-inner">
                <Link href="/" className="brand">
                  <span className="brand-mark">
                    <Boxes size={15} />
                  </span>
                  <span className="brand-word">sandbox</span>
                </Link>
                <nav className="nav">
                  <NavLink href="/" label="Tasks" icon="tasks" variant="top" />
                  <NavLink href="/new" label="New task" icon="new" variant="top" />
                  <NavLink href="/memory" label="Memory" icon="memory" variant="top" />
                  <NavLink href="/settings" label="Settings" icon="settings" variant="top" />
                </nav>
              </div>
            </header>

            <main className="shell">{children}</main>
          </div>
        </div>
      </body>
    </html>
  );
}
