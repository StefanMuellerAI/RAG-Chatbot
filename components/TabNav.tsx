"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useState } from "react";
import type { Role } from "@/lib/auth";

type Reiter = { href: string; label: string; nur?: Role };

const REITER: Reiter[] = [
  { href: "/", label: "Chat" },
  { href: "/sammlungen", label: "Sammlungen" },
  { href: "/admin", label: "Admin", nur: "admin" },
];

export default function TabNav({ rolle }: { rolle: Role | null }) {
  const pathname = usePathname();
  const router = useRouter();
  const [meldetAb, setMeldetAb] = useState(false);

  async function abmelden() {
    setMeldetAb(true);
    try {
      await fetch("/api/auth", { method: "DELETE" });
    } finally {
      setMeldetAb(false);
      router.push("/login");
      router.refresh();
    }
  }

  const sichtbar = REITER.filter((reiter) => !reiter.nur || reiter.nur === rolle);

  return (
    <nav className="reiter" aria-label="Bereiche">
      <div className="reiter-inner">
        {sichtbar.map((reiter) => {
          const aktiv =
            reiter.href === "/" ? pathname === "/" : pathname.startsWith(reiter.href);
          return (
            <Link key={reiter.href} href={reiter.href} aria-current={aktiv ? "page" : undefined}>
              {reiter.label}
            </Link>
          );
        })}

        {rolle && (
          <button
            className="reiter-abmelden"
            type="button"
            onClick={() => void abmelden()}
            disabled={meldetAb}
          >
            {rolle === "admin" ? "Abmelden (Admin)" : "Abmelden"}
          </button>
        )}
      </div>
    </nav>
  );
}
