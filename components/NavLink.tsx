"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { ListChecks, Plus, SlidersHorizontal } from "lucide-react";

/** Icons are resolved inside this client component by name: the layout is a
 * server component and can't hand components across the boundary. */
const ICONS = {
  tasks: ListChecks,
  new: Plus,
  settings: SlidersHorizontal,
};

export function NavLink({
  href,
  label,
  icon,
}: {
  href: string;
  label: string;
  icon?: keyof typeof ICONS;
}) {
  const pathname = usePathname();
  const isActive = href === "/" ? pathname === "/" : pathname.startsWith(href);
  const Icon = icon ? ICONS[icon] : null;

  return (
    <Link href={href} className={`nav-link${isActive ? " active" : ""}`}>
      {Icon && <Icon size={14} strokeWidth={2} />}
      {label}
    </Link>
  );
}
