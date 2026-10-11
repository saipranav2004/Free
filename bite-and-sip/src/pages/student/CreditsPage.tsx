import credits from '../../data/photoCredits.json'
import { DemoRibbon, StudentHeader } from '../../components/StudentShell'

export function CreditsPage() {
  return (
    <div className="min-h-dvh pb-12">
      <DemoRibbon />
      <StudentHeader back="/" title="Photo credits" right={<span />} />
      <main className="mx-auto max-w-3xl px-4 pt-5">
        <p className="text-[15px] text-ink-2">
          Our menu photos are openly licensed images, cropped and resized for this site. Thank you to the photographers below.
        </p>
        <ul className="mt-4 divide-y divide-line rounded-2xl bg-surface ring-1 ring-line">
          {credits.map((c) => (
            <li key={c.item} className="px-4 py-3 text-sm">
              <p className="font-bold">{c.item}</p>
              <p className="text-muted">
                <a href={c.source} target="_blank" rel="noopener noreferrer" className="underline underline-offset-2 hover:text-ink">
                  {c.title || 'Original photo'}
                </a>{' '}
                by {c.creator} ·{' '}
                <a href={c.license_url} target="_blank" rel="noopener noreferrer" className="underline underline-offset-2 hover:text-ink">
                  {c.license}
                </a>
              </p>
            </li>
          ))}
        </ul>
      </main>
    </div>
  )
}
