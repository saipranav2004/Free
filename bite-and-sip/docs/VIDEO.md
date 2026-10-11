# Walkthrough video

[`media/walkthrough.mp4`](media/walkthrough.mp4) is 1 min 55 s, 1920×1080, H.264, about 6.5 MB.

It was recorded **against a real local Supabase stack** (Auth, Postgres, Realtime), not the demo backend:

1. **Title card**
2. **Live demo (side by side).** A student on a phone (390×844) and the kitchen on a counter screen (1280×800), driven at the same time:
   - QR entry with the brand intro
   - menu, search and add-ons
   - fly-to-cart and checkout
   - the order appearing on the kitchen board instantly
   - UPI instructions and "I've paid"
   - preparing, then ready, both updating live on the phone
   - staff verifying the UPI payment, then handover and "Collected"
   - My orders
3. **Owner tools:**
   - sign in
   - menu availability and add-on editing
   - café open/closed
   - UPI ₹1 test QR
   - tables and printable QR cards
   - reports over a week of sample history
4. **End card**

Captions, device frames and cards are rendered from HTML in the app's own font. Taps and the cursor are shown as yellow rings.

## Re-recording
```bash
npx supabase db reset                     # fresh local data
SUPABASE_URL=http://127.0.0.1:54321 SUPABASE_SECRET_KEY=<local secret> \
  node scripts/create-staff.mjs --email owner@bitesip.test --name Asha --role owner --password owner-pass-123
SUPABASE_URL=… SUPABASE_SECRET_KEY=… \
  node scripts/create-staff.mjs --email kitchen@bitesip.test --name Ravi --role kitchen --password kitchen-pass-123
npm run seed:sample-history               # LOCAL ONLY: a week of past orders for the reports
cp .env.e2e-supabase.local .env.video.local && npx vite build --mode video --outDir /tmp/dist-video
npx vite preview --outDir /tmp/dist-video --port 4175 &
PLAYWRIGHT_CHROMIUM_PATH=/path/to/chromium npm run video:record
```
Scripts: `scripts/video/record.mjs` (drives the browsers and captures frames with the DevTools screencast), `overlays.mjs` (captions, frames, cards) and `compose.py` (ffmpeg composition).
