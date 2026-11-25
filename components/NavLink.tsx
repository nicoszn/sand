"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { BookOpen, ListChecks, Plus, SlidersHorizontal } from "lucide-react";

/** Icons are resolved inside this client component by name: the layout is a
 * server component and can't hand components across the boundary. */
const ICONS = {
  tasks: ListChecks,
  new: Plus,
  memory: BookOpen,
  settings: SlidersHorizontal,
};

export function NavLink({
  href,
  label,
  icon,
  variant = "rail",
}: {
  href: string;
  label: string;
  icon?: keyof typeof ICONS;
  variant?: "rail" | "top";
}) {
  const pathname = usePathname();
  const isActive = href === "/" ? pathname === "/" : pathname.startsWith(href);
  const Icon = icon ? ICONS[icon] : null;

  if (variant === "top") {
    return (
      <Link href={href} className={`nav-link${isActive ? " active" : ""}`} aria-current={isActive ? "page" : undefined}>
        {Icon && <Icon size={14} strokeWidth={2} />}
        {label}
      </Link>
    );
  }

  return (
    <Link href={href} className={`rail-link${isActive ? " active" : ""}`} aria-current={isActive ? "page" : undefined}>
      {Icon && (
        <span className="rail-icon">
          <Icon size={14} strokeWidth={2} />
        </span>
      )}
      <span className="rail-label">{label}</span>
    </Link>
  );
}
