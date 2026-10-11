# Page notes

One entry per page: what the reference product does, what we took, what we
deliberately did differently, and what each control calls. Written as each page
is built, not afterwards.

---

## Foundations

**Reference:** AWS Cloudscape design tokens (the AWS Console's own published
token set), Cloudscape table view and content density patterns.

**What we took**

| Decision | Evidence |
|---|---|
| Page and container are both white; separation is a border | `background-layout-main`, `container-content` and `layout-panel` are all `#ffffff` |
| `shadow-card: none` on static surfaces | The token is literally `none`. Shadow is reserved for surfaces that overlap others |
| Two divider strengths | `divider-default #c6c6cd` for a container edge, `divider-secondary #ebebf0` for lines inside one |
| Form controls get a real border | `border-input-default #8c8c94`, not a hairline |
| Headings are 700 | every `font-weight-heading-*` token is 700 |
| Page title 24px / 30px / -0.02em | `font-size-heading-xl` |
| Body 14px / 20px | `font-size-body-m` |
| Container radius 16px, control radius 8px | `border-radius-container` vs `border-radius-input` |
| Accent `#006ce0`, and it goes **darker** on hover (`#002b66`) | `color-text-link-default` / `-hover` |
| Secondary buttons carry blue text | `color-text-button-normal-default` is the link blue |
| Density is one global persisted setting, comfortable by default | Cloudscape content density: "compact can hinder readability" |

**What we did differently**

- **The top bar is dark in both themes.** Cloudscape's own bar is white, but
  its page is white too and it relies on a heavier top border. With our
  sidebar also light, a white bar had nothing to separate it from the content.
  AWS Console, the Azure Portal and Salesforce all anchor with a dark or
  saturated product bar, so we follow the products rather than the token file.
- **Rows are 44px, not 32px.** Our own approved mockup used 32px. That is
  below the measured band (condensed 40 / regular 48 / relaxed 56) and reads
  as a spreadsheet. 44px sits inside the band and shows about fifteen rows.
- **Column headers are 13px semibold sentence case,** not 11px uppercase with
  wide tracking. The mockup had the uppercase version; AWS moved label
  prominence onto weight and colour instead, and uppercase micro type is the
  loudest admin-template tell in a grid.
- **Breadcrumbs sit above the page title, not in the top bar.** They describe
  where you are in your data, not in the product. Moving them out is also what
  let the bar drop from 64px to 48px.

---

## 1. Resources

**Reference:** AWS Console resource lists (EC2 instances, RDS databases),
Cloudscape table view pattern.

**Anatomy, in the order the reference uses:** breadcrumb, title with a live
count, command bar, filter row, one container holding the grid and its pager.

**What changed from the previous build**

| Before | After | Why |
|---|---|---|
| Filter card, 16px gap, table card | One container | A gap between two bordered surfaces says they are unrelated, so the filters read as a widget that happened to sit above a table |
| 63px rows, name over host on two lines | 44px rows, one line | Nine rows per screen became fifteen |
| Five select dropdowns on their own row | Two selects plus three facet chips with live counts | Type has ten values and Group is deployment specific, so those stay selects. JIT, recorded and no-credential are yes or no questions an operator reaches for constantly |
| Separate Host and Port columns | `host:port` in one cell, Port optional in preferences | The two columns cost 320px and left the resource name truncating at 240px. Nobody reads a port without its host |
| Trailing chevron on every row | Named action plus a `⋯` menu | A chevron is a phone list disclosure: same glyph on every row, carries no information |
| Filled blue button per row | Blue text link per row | Nine filled buttons down the right edge is a blue stripe, and a stripe means nothing when every row has one. Corrected after seeing it rendered |
| Uneven row heights when "Request access" wrapped | `whitespace-nowrap` | Uneven row height is the named cause of jerky scrolling |
| Three dot-and-text status columns | One (Credential); JIT and recording share a Controls cell as labelled glyphs | Three populated status columns is 27 dots per screen competing with the data |

**Controls, and what each one calls**

| Control | Request |
|---|---|
| The grid | `GET /pam/resources/groups` |
| Connect | `GET /pam/resources/:id/connect-info`, then `POST /pam/resources/:id/sessions` to start a tracked session |
| Request access | `POST /pam/jit/requests` through the JIT dialog |
| Register resource | `POST /pam/admin/resources` |
| Replace or store credential | `POST /pam/admin/resources/:id/credential` |
| Delete resource | `DELETE /pam/admin/resources/:id` |
| Export | client side, over the rows already loaded. No server export route exists and the menu says so |
| Refresh | refetches the grid query and shows the "as of" time |

**A real bug this pass found and fixed:** Connect opened a read only summary
drawer and made no request at all. A control labelled Connect that does not
connect is precisely the failure mode this pass exists to remove. It now opens
`ConnectPanel`, which fetches connect-info, surfaces the 403 when the resource
is JIT gated and the caller has no grant, and owns the session lifecycle.

**Verified:** 9 of 9 interactions drive a real request or open the real
surface, asserted against the mock server's request log. Zero page errors.
