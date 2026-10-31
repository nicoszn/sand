import type { Metadata } from "next";
import "./globals.css";
import { NavLink } from "@/components/NavLink";

export const metadata: Metadata = {
  title: "agent sandbox",
  description: "Run and monitor autonomous agent tasks",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <div style={{ display: "flex", minHeight: "100vh" }}>
          <aside
            style={{
              width: 200,
              flexShrink: 0,
              borderRight: "1px solid var(--line)",
              background: "var(--bg-1)",
              padding: "20px 0",
              position: "sticky",
              top: 0,
              height: "100vh",
            }}
          >
            <div style={{ padding: "0 18px 20px", borderBottom: "1px solid var(--line-soft)", marginBottom: 14 }}>
              <div style={{ fontSize: 14, color: "var(--text-0)" }}>agent sandbox</div>
              <div style={{ fontSize: 11, color: "var(--text-2)", marginTop: 2 }}>local orchestrator</div>
            </div>
            <nav style={{ display: "flex", flexDirection: "column" }}>
              <NavLink href="/" label="tasks" />
              <NavLink href="/new" label="new task" />
              <NavLink href="/keys" label="keys & limits" />
              <NavLink href="/settings" label="settings" />
            </nav>
          </aside>
          <main style={{ flex: 1, minWidth: 0 }}>{children}</main>
        </div>
      </body>
    </html>
  );
}
