import Link from 'next/link';

/** Simulation and real positions are separate data, shown as two tabs of one place. */
export function TradeTabs({ active, labels }: { active: 'sim' | 'real'; labels: { sim: string; real: string } }) {
  const tab = (key: 'sim' | 'real', href: string, label: string) => (
    <Link
      href={href}
      aria-current={active === key ? 'page' : undefined}
      className={`inline-flex min-h-[36px] items-center rounded px-3 text-xs ${
        active === key ? 'bg-accent-dim font-semibold text-accent' : 'text-ink-muted hover:bg-bg-inset hover:text-ink'
      }`}
    >
      {label}
    </Link>
  );
  return (
    <nav aria-label={`${labels.sim} / ${labels.real}`} className="flex gap-1 rounded-lg border border-line bg-bg-raised p-1">
      {tab('sim', '/simulations', labels.sim)}
      {tab('real', '/portfolio', labels.real)}
    </nav>
  );
}
