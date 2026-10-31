"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

export function NavLink({ href, label }: { href: string; label: string }) {
  const pathname = usePathname();
  const isActive = href === "/" ? pathname === "/" : pathname.startsWith(href);
  return (
    <Link
      href={href}
      className={`nav-link${isActive ? " active" : ""}`}
      style={{
        display: "block",
        padding: "8px 18px",
        textDecoration: "none",
        fontSize: 13,
        borderLeft: "2px solid transparent",
      }}
    >
      {label}
    </Link>
  );
}
