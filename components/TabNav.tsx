"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const GRUNDREITER = [
  { href: "/", label: "Chat" },
  { href: "/sammlungen", label: "Sammlungen" },
];

export default function TabNav({ istAdmin }: { istAdmin: boolean }) {
  const pathname = usePathname();

  // Der Reiter erscheint nur mit Rolle. Das ist Bequemlichkeit, kein Schutz —
  // die Berechtigung selbst prueft jede Admin-Route eigenstaendig.
  const reiter = istAdmin
    ? [...GRUNDREITER, { href: "/admin", label: "Administration" }]
    : GRUNDREITER;

  return (
    <nav className="reiter" aria-label="Bereiche">
      <div className="reiter-inner">
        {reiter.map((eintrag) => {
          const aktiv =
            eintrag.href === "/" ? pathname === "/" : pathname.startsWith(eintrag.href);
          return (
            <Link
              key={eintrag.href}
              href={eintrag.href}
              aria-current={aktiv ? "page" : undefined}
            >
              {eintrag.label}
            </Link>
          );
        })}
      </div>
    </nav>
  );
}
