# Bite & Sip — College Café Ordering

▶ **[Watch the 2-minute walkthrough](docs/media/walkthrough.mp4)**, recorded on a real Supabase backend.

Students scan a table QR, order from their phone, pay cash or UPI, and get told when to collect at the counter. Kitchen staff work a live orders board. The owner manages the menu, café status, UPI ID, table QR codes and daily reports.

**Stack:** React 19 · Vite · Tailwind CSS v4 · Supabase (Postgres, Auth, Realtime, Storage) · Vercel.

## Try it in 30 seconds (no accounts)
```bash
cd bite-and-sip
npm install
npm run dev:demo
```
- Student: <http://localhost:5173/t/T12>
- Staff: <http://localhost:5173/staff> → demo accounts are shown on the login page.

Demo mode keeps data in the browser and is labelled on every screen. Open a student tab and a staff tab side by side to see live updates.

## Run the real stack locally
See [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md) §2 (`npx supabase start`, create staff, `npm run dev`).

## Scripts
| Command | Does |
|---|---|
| `npm run dev` / `dev:demo` | Dev server (Supabase from `.env.local` / demo backend) |
| `npm run check` | Lint, typecheck, unit + component tests, build |
| `npm run test:db` | Database/security tests against local Supabase |
| `npm run test:e2e` / `test:e2e:supabase` | Playwright journeys on demo / local Supabase |
| `npm run staff:create -- --email … --name … --role owner\|kitchen` | Create or update a staff account (needs the secret key in env) |
| `npm run seed:generate` | Regenerate `supabase/seed.sql` from `src/data/catalog.json` |

## Documentation
| Doc | Contents |
|---|---|
| [PROJECT_STATE.md](PROJECT_STATE.md) | Current status, decisions, test results, what's left |
| [docs/PRODUCT_SPEC.md](docs/PRODUCT_SPEC.md) | Rules: order and payment lifecycles, permissions, limits, reporting |
| [docs/USER_FLOWS.md](docs/USER_FLOWS.md) | Information architecture, journeys, edge states |
| [docs/DESIGN_REVIEW.md](docs/DESIGN_REVIEW.md) | What was kept or changed from the supplied designs, and why |
| [docs/DESIGN_SYSTEM.md](docs/DESIGN_SYSTEM.md) | Tokens, components, accessibility |
| [docs/MOCKUP_PLAN.md](docs/MOCKUP_PLAN.md) | Interactive mockups (demo backend) |
| [docs/RESEARCH.md](docs/RESEARCH.md) | Sources, reference projects, UI/UX research |
| [docs/SECURITY.md](docs/SECURITY.md) | Security model and residual risks |
| [docs/TESTING.md](docs/TESTING.md) | Test strategy and executed results |
| [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) | Supabase + Vercel setup, operations, troubleshooting, security checklist |
| [docs/IMPLEMENTATION_PLAN.md](docs/IMPLEMENTATION_PLAN.md) | Architecture, future phases |
| [docs/IMAGE_CREDITS.md](docs/IMAGE_CREDITS.md) | Food photo sources and licences |
| [docs/VIDEO.md](docs/VIDEO.md) | What the walkthrough shows and how to re-record it |

## Project layout
```
src/
  backend/      Backend interface + Supabase and demo implementations
  components/   UI kit (buttons, dialogs, badges…), icons, food art, QR
  data/         Shared fictional dataset (menu, tables, settings)
  hooks/        Live order tracking (student) and live board (staff)
  lib/          Pure logic: pricing, order rules, UPI, validation, reports
  pages/        student/ and staff/ screens
  state/        Cart, device secrets, menu data, staff session
supabase/       config, migrations (schema + security), generated seed
scripts/        create-staff, generate-seed
tests/          db/ (security, local Supabase) and e2e/ (Playwright)
```
