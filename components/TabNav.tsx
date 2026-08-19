"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const REITER = [
  { href: "/", label: "Chat" },
  { href: "/admin", label: "Admin" },
];

export default function TabNav() {
  const pathname = usePathname();

  return (
    <nav className="reiter" aria-label="Bereiche">
      <div className="reiter-inner">
        {REITER.map((reiter) => {
          const aktiv =
            reiter.href === "/" ? pathname === "/" : pathname.startsWith(reiter.href);
          return (
            <Link key={reiter.href} href={reiter.href} aria-current={aktiv ? "page" : undefined}>
              {reiter.label}
            </Link>
          );
        })}
      </div>
    </nav>
  );
}
