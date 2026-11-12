import type { Metadata, Viewport } from "next";
import "./globals.css";
import { NavLink } from "@/components/NavLink";

export const metadata: Metadata = {
  title: "agent sandbox",
  description: "Run and monitor autonomous agent tasks",
};

// Without this, mobile browsers render the page at a desktop width and
// zoom out - the single most common cause of a page "not being mobile
// friendly" even when every element below is otherwise responsive.
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <div className="app-shell">
          <aside className="sidebar">
            <div className="sidebar-header">
              <div style={{ fontSize: 14, color: "var(--text-0)" }}>agent sandbox</div>
              <div className="sidebar-subtitle" style={{ fontSize: 11, color: "var(--text-2)", marginTop: 2 }}>
                local orchestrator
              </div>
            </div>
            <nav className="nav-links">
              <NavLink href="/" label="tasks" />
              <NavLink href="/new" label="new task" />
              <NavLink href="/keys" label="keys & limits" />
              <NavLink href="/settings" label="settings" />
            </nav>
          </aside>
          <main className="main-content">{children}</main>
        </div>
      </body>
    </html>
  );
}
