# Bite & Sip — Setup & Deployment

Contents: environment variables, local development, Supabase production setup, Vercel deployment, operations, troubleshooting, and the security checklist.

## 1. Environment variables
| Variable | Where | Secret? | Purpose |
|---|---|---|---|
| `VITE_SUPABASE_URL` | Vercel + `.env.local` | No (public) | Supabase project URL |
| `VITE_SUPABASE_PUBLISHABLE_KEY` | Vercel + `.env.local` | No (public, protected by RLS) | Browser key (`sb_publishable_…`, or the legacy anon key via `VITE_SUPABASE_ANON_KEY`) |
| `VITE_PUBLIC_SITE_URL` | Vercel (optional) | No | Address printed on QR codes (defaults to the current site) |
| `VITE_DEMO_MODE` | optional | No | `true` forces the in-browser demo backend |
| `SUPABASE_URL`, `SUPABASE_SECRET_KEY` | **your terminal only** | **Yes** | Used only by `scripts/create-staff.mjs`. Never prefix with `VITE_`, never put in Vercel or git |

`.env.example` lists them with placeholders. `.env*` files are git-ignored.

## 2. Local development
```bash
cd bite-and-sip
npm install
npm run dev:demo                  # UI with the in-browser demo backend (no accounts needed)

# Full stack with a local Supabase (needs Docker):
npx supabase start                # Postgres, Auth, Realtime, Storage; applies migrations + seed
npx supabase status               # copy API URL + publishable key into .env.local
SUPABASE_URL=http://127.0.0.1:54321 SUPABASE_SECRET_KEY=<local secret> \
  node scripts/create-staff.mjs --email owner@bitesip.test --name Asha --role owner --password 'choose-a-password'
npm run dev
```

## 3. Supabase (production)
1. Create a project at supabase.com. Pick the **Mumbai (ap-south-1)** region for Indian students.
2. Apply the schema from this folder:
   ```bash
   npx supabase login
   npx supabase link --project-ref <your-project-ref>
   npx supabase db push            # runs supabase/migrations/*.sql
   ```
   This creates the tables, RLS policies, grants, triggers, functions, the `menu-images` storage bucket with owner-only write policies, and adds `orders` to the realtime publication.
3. **Optional starter menu:** open SQL Editor and run `supabase/seed.sql` (sample menu + tables T1–T12). Then set your real UPI ID in the app's Settings, because the seed's `demo.bitesip@exampleupi` is fake.
4. **Auth settings** (Dashboard → Authentication):
   - Sign In / Providers → **turn OFF "Allow new users to sign up"**. Staff are created only by the script.
   - Email provider stays enabled (staff use email + password). Optionally turn off "Confirm email", since the script confirms accounts.
   - URL Configuration → Site URL = your Vercel URL.
   - Password policy: minimum 8 characters.
5. **API keys** (Dashboard → Project Settings → API Keys): copy the **publishable** key for Vercel. Keep the **secret** key private.
6. Create staff accounts from a trusted computer:
   ```bash
   SUPABASE_URL=https://<ref>.supabase.co SUPABASE_SECRET_KEY=<secret> \
     node scripts/create-staff.mjs --email owner@yourcollege.edu --name "Owner name" --role owner
   SUPABASE_URL=… SUPABASE_SECRET_KEY=… \
     node scripts/create-staff.mjs --email kitchen1@yourcollege.edu --name "Ravi" --role kitchen
   ```
   The script prints a generated password if you don't pass one. Re-running it for an existing email updates the role and name (and the password, if given). The owner can deactivate staff or change roles in **Settings → Staff**.

## 4. Vercel
1. vercel.com → **Add New → Project → Import** the GitHub repo `saipranav2004/Free`.
2. **Root Directory: `bite-and-sip`**. The framework is detected as Vite, and `vercel.json` sets the build, SPA rewrites, the CSP and other security headers.
3. Environment variables (Production + Preview): `VITE_SUPABASE_URL`, `VITE_SUPABASE_PUBLISHABLE_KEY`, optionally `VITE_PUBLIC_SITE_URL`.
4. Deploy. Open `/staff/login`, sign in as the owner, then:
   - Settings → set the UPI ID → **Test with ₹1** using your own phone (it should show the café name and ₹1.00).
   - Settings → Tables → **Print table QR codes**. Print them **after** the final domain is set: each QR contains the URL.
5. Without the Supabase variables the deployment runs in **demo mode** (clearly labelled). That's useful for a preview, but it is not a working café.

CLI alternative: `npx vercel --cwd bite-and-sip` (needs `vercel login` or `VERCEL_TOKEN`), then `npx vercel --prod`.

## 5. Daily operations
- **Opening:** owner (or anyone with owner access) switches **Open** in Settings. Kitchen staff sign in on the counter device and tap **Sound off → Sound on** once (browsers require a tap before playing sound).
- **During service:** keep the board open. If the pill shows "Reconnecting…", the board still refreshes every 10 s. The refresh button forces it.
- **UPI:** only confirm money you can see in the café's UPI/bank app. Screenshots can be faked.
- **Closing:** switch to **Closed**. In Reports → Today, check that "UPI not yet confirmed" and "Cash not yet collected" are ₹0 (or explained), and settle any **Refunds due**.
- **Holidays:** Supabase Free pauses projects after about 7 days without activity. Restore it from the dashboard before reopening, or use a paid plan.

## 6. Troubleshooting
| Symptom | Likely cause / fix |
|---|---|
| Yellow "Demo mode" banner in production | `VITE_SUPABASE_*` not set for that Vercel environment. Add them and redeploy (Vite bakes env vars in at build time) |
| "This account doesn't have staff access" | The auth user exists but has no active `staff` row. Re-run `create-staff`, or reactivate them in Settings |
| Login says email logins are disabled (local) | Keep `[auth.email] enable_signup = true` in `supabase/config.toml` (the CLI uses it to enable the email provider). Public sign-up stays off via `[auth] enable_signup = false` |
| Board says "Reconnecting…" constantly | Realtime blocked by a network/firewall, or the project is paused. Polling keeps working. Check the Supabase status page |
| Students don't see live status | Same as above. Their page also polls (every 8 s when disconnected, 30 s when connected) and refreshes when reopened |
| UPI app shows "limit exceeded" or "risk" warning | Some apps restrict link payments to personal UPI IDs. Use a merchant/business UPI ID. Students can always scan the QR or pay at the counter |
| Image upload fails | Owner role required. Max 2 MB after on-device resizing. JPG/PNG/WebP only |
| QR codes point to the wrong site | Set `VITE_PUBLIC_SITE_URL` (or print from the final domain) and reprint |
| Paused project / 5xx errors | Restore the project in the Supabase dashboard |

## 7. Security checklist (before going live)
- [ ] Only the **publishable** key is in Vercel. No `sb_secret_…` or `service_role` value anywhere in the repo, Vercel or the browser.
- [ ] Auth → "Allow new users to sign up" is **off**.
- [ ] Migrations applied with `db push` (RLS on every table, column grants, triggers). Run `npm run test:db` against a local stack to re-verify.
- [ ] Only real staff have rows in `staff`. Former staff are deactivated.
- [ ] Owner and kitchen accounts use unique passwords of 8+ characters.
- [ ] Real UPI ID set, and the ₹1 test checked on a real phone.
- [ ] QR codes printed from the production domain.
- [ ] `vercel.json` headers active (check the response headers for `Content-Security-Policy`).
- [ ] Decide on retention: periodically delete or anonymise old phone numbers (`IMPLEMENTATION_PLAN.md`).

Details of the security model: `SECURITY.md`.
