# Why enterprise tables look good, and what we were getting wrong

Research pass triggered by the note that our lists still read as "table and card"
rather than as an enterprise console. Sources are primary where possible: AWS
Console's design system is public (Cloudscape), so the AWS rules below are the
actual rules, not an inference from screenshots.

## Sources

- [Cloudscape, Table view pattern](https://cloudscape.design/patterns/resource-management/view/table-view/) - the AWS Console list page anatomy
- [Cloudscape, Content density](https://cloudscape.design/foundation/visual-foundation/content-density/) - comfortable vs compact
- [Cloudscape, Density settings](https://cloudscape.design/patterns/general/density-settings/)
- [AWS, Visual update to the Management Console](https://aws.amazon.com/blogs/aws/announcing-a-visual-update-to-the-aws-management-console-preview/) - what Amazon changed and why
- [Pencil & Paper, Enterprise data tables](https://www.pencilandpaper.io/articles/ux-pattern-analysis-enterprise-data-tables) - measured visual craft rules
- [Christie Lenneville, How white space killed an enterprise app](https://uxdesign.cc/how-white-space-killed-an-enterprise-app-and-why-data-density-matters-b3afad6a5f2a)

## The findings, and the verdict on our build

### 1. Shadows are the tell

Amazon's own console update **replaced drop shadows with thinner strokes on
cards, panels and containers**, and reserved shadow for "specific interactive
and transient elements only", stated reason: it "reduces visual noise and
optimizes the space inside the layout".

Our build put `shadow-card` on every panel, every card, every toolbar. A page
of soft-shadowed rounded rectangles floating on grey is the single most
recognisable signature of a template. **Verdict: remove elevation from every
static surface. Shadow survives only on menus, dialogs, drawers and toasts.**

### 2. Cell padding, not row padding, is what makes a table breathe

Pencil & Paper's measured rule: **minimum 16px padding left and right of each
column**, so the gutter between two columns totals at least 32px.

We were at 12px, so 24px between columns. That reads as cramped horizontally
while being loose vertically, which is exactly backwards. **Verdict: 16px
horizontal cell padding.**

### 3. Row height: 40 to 48px, and our own mockup was wrong

The measured band is **condensed 40px, regular 48px, relaxed 56px**, and
Cloudscape requires comfortable as the default because compact "can hinder
readability for users with vision impairment".

- The shipped build was at **58 to 63px**: nine rows on a 1440x900 screen.
- The mockup I had approved was at **32px**, which is below every cited
  standard. Denser is not automatically better, and 32px rows with 12px
  padding is a spreadsheet, not a console.

**Verdict: 44px comfortable, 36px compact, both user selectable and
persisted.** 44px sits inside the cited band, shows about fifteen rows per
screen instead of nine, and keeps a 24px click target with real padding.

### 4. Column headers are sentence case with weight, not uppercase micro type

AWS's update called out "improved label prominence in form fields and
key-value pairs through refined text weight and colour", to help readers
"differentiate key pieces of information faster". Cloudscape sets headers at
body size in bold sentence case.

An 11px uppercase header with wide letter tracking is the 2014 admin-template
signature: it shouts a label nobody reads twice and costs legibility at the
size where legibility is thinnest. **Verdict: 13px, weight 600, sentence case,
secondary colour.** My mockup used uppercase micro type. That was wrong.

### 5. Header alignment must match its column's content

"Column names should always align according to their column content."
Mismatched alignment "creates off putting whitespaces and brings unnecessary
visual noise". **Verdict: numeric columns right aligned, header included.**

### 6. Numbers are tabular and right aligned. Dates are not numbers

Right align quantitative values and set them in tabular figures so
`$1,111.11` cannot look smaller than `$999.99`. **Dates, IDs, ports and phone
numbers are qualitative and stay left aligned.**

We were right-aligning timestamps. **Verdict: timestamps go back to the left.**

### 7. One row state at a time, and no zebra

Zebra striping plus hover plus selected plus disabled is "three swatches of
grey" that "break visual continuity". Row separation is a **1px divider that
melts into the background**. Vertical rules are optional and sparing.

We already do this. The one vertical rule we keep is the frozen column edge,
which is carrying information: it says why those columns stopped moving.

### 8. The table is the page, not a card on the page

Cloudscape is explicit: on a list page, "don't use the content layout
component, use the full-page variant of the table component". The toolbar,
filter row, table and pager are **one container**. Our build had a floating
filter card, a 16px gap, then a separate table card, which says the filters
are unrelated to the table they filter.

Fixed this pass with `ListPanel`.

### 9. Not everything is a table or a card

This is the deeper half of the complaint. An enterprise console reaches for
different instruments:

| Data | Instrument | Not |
|---|---|---|
| A collection of like objects | full-bleed table | cards |
| One object's properties | **key-value grid**, label over value, 2 to 4 per row | a wall of cards |
| A single headline number | one value, one label, inside an existing container | a KPI card |
| A queue you act on | table with a real per-row action button | a list with a chevron |
| Free-form or unequal objects | cards, and only here | table |

Our detail pages are card walls: ten `<Card>`s on Identity detail, ten on the
Dashboard, nine on Settings. **Verdict: detail pages move to key-value grids
under plain section rules.**

### 10. Colour: blue harder, not softer

AWS moved to "a more vibrant palette" with "secondary buttons, links, and
interactive elements now consistently blue" to improve task efficiency. The
lesson is not "use less colour", it is **use colour consistently for
interactivity, and reserve every other hue for state**.

## The resulting spec

| Token | Value | Source |
|---|---|---|
| Row height, comfortable | 44px | P&P 40-48 band |
| Row height, compact | 36px | Cloudscape compact, reduced in 4s |
| Header row height | 40px | matches comfortable minus padding |
| Cell padding, horizontal | 16px | P&P minimum |
| Header type | 13px / 600 / sentence case | AWS visual update |
| Body type | 14px | AWS scale |
| Row divider | 1px, melts into ground | P&P |
| Elevation, static surfaces | none, 1px stroke | AWS visual update |
| Elevation, transient surfaces | shadow | AWS visual update |
| Numeric columns | right aligned, tabular | P&P |
| Date columns | left aligned | P&P |
| Zebra striping | never | P&P |
