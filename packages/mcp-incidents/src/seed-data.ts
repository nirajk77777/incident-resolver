import type { NewHelpArticle, NewIncident } from "./store";

/**
 * ShopLite's history, seeded so the knowledge base is useful from day one.
 *
 * Twenty Incidents dated across six months, three authors, mixed quality: some are
 * careful write-ups, some are one-liners typed at the end of a shift. Three describe
 * the stale cart total problem so rerank has to choose between near-duplicates, and one
 * is a red herring that shares its vocabulary but is a different problem, so vector
 * search ranks it high and rerank should drop it. Ids are fixed so tests can name them.
 */

export const authors = {
  priya: "Priya Natarajan",
  marcus: "Marcus Delgado",
  resolver: "Resolver",
} as const;

const incidentId = (n: number) => `30000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const articleId = (n: number) => `40000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const ticketId = (n: number) => `20000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

/** The UPDATE that brings a cart's denormalised totals back in line with its lines. */
export const cartTotalsRecomputeSql = `UPDATE shoplite.cart_totals
SET item_count = (SELECT coalesce(sum(quantity), 0) FROM shoplite.cart_items WHERE cart_id = cart_totals.cart_id),
    subtotal_cents = (SELECT coalesce(sum(quantity * unit_price_cents), 0) FROM shoplite.cart_items WHERE cart_id = cart_totals.cart_id),
    total_cents = (SELECT coalesce(sum(quantity * unit_price_cents), 0) FROM shoplite.cart_items WHERE cart_id = cart_totals.cart_id) - discount_cents,
    updated_at = now()
WHERE cart_id = '<cart id>';`;

export const seedIncidentIds = {
  /** The canonical stale cart total Incident, with the documented UPDATE. */
  staleCartTotal: incidentId(1),
  /** Near-duplicates of it, one agent-written and one terse. */
  staleCartTotalDuplicates: [incidentId(2), incidentId(3)],
  /** Shares the words "cart total wrong after removing item" but is a discount rule, not stale data. */
  redHerring: incidentId(4),
} as const;

export const seedHelpArticleIds = {
  clearCache: articleId(1),
} as const;

type SeedIncident = NewIncident & { id: string; createdAt: Date };

const at = (iso: string) => new Date(iso);

export const seedIncidents: SeedIncident[] = [
  {
    id: seedIncidentIds.staleCartTotal,
    createdAt: at("2026-04-14T15:22:00Z"),
    author: authors.priya,
    resolvedBy: "human",
    category: "data_issue",
    sourceTicketId: ticketId(101),
    title: "Cart tag shows a stale item count and total after removing an item",
    symptoms:
      "Tester removed the Stoneware Mug (MUG-01) from a cart holding two lines. The cart page listed the one remaining line correctly, but the header cart tag kept showing 2 items and $37.99. A hard refresh did not change it. Adding any product brought the tag back in line, which pointed at the totals row rather than the storefront.",
    rootCause:
      "shoplite.cart_totals is a denormalised copy of each cart's item count and totals; the comment on the table in apps/api/src/db/schema.ts explains it exists so the header tag can be read as one row without joining cart_items to products on every page. addItem and applyDiscount call refreshTotals after writing, but removeItem in apps/api/src/carts/cart-store.ts deletes the cart_items row and returns without refreshing, so the row keeps the old numbers until something else touches the cart.",
    resolution: `Recomputed the row from the cart's lines with this UPDATE, run against the affected cart id:\n\n${cartTotalsRecomputeSql}\n\nVerified GET /customers/:customerId/cart returned totals matching the lines. The code fix is to call refreshTotals at the end of removeItem; opened as a follow-up.`,
  },
  {
    id: seedIncidentIds.staleCartTotalDuplicates[0],
    createdAt: at("2026-06-02T09:48:00Z"),
    author: authors.resolver,
    resolvedBy: "agent",
    category: "data_issue",
    sourceTicketId: ticketId(144),
    title: "Header cart badge wrong after deleting a line from the cart",
    symptoms:
      "Customer report: after deleting the Canvas Tote from the cart, the badge in the header still said 3 items and the old total, while the cart page showed 2 items. Trace showed DELETE /customers/:customerId/cart/items/:productId returning 200 with no write to cart_totals in the span.",
    rootCause:
      "The cart_totals row for the cart was stale: item_count 3 and subtotal from before the removal, updated_at older than the cart_items delete. removeItem does not refresh cart_totals; only addItem and the discount route do.",
    resolution: `Proposed and, after Reviewer approval, ran the recompute UPDATE against cart_totals for the customer's cart:\n\n${cartTotalsRecomputeSql}\n\nReplied to the customer that the badge is corrected. Same defect as the April Incident; the code fix in removeItem is still open.`,
  },
  {
    id: seedIncidentIds.staleCartTotalDuplicates[1],
    createdAt: at("2026-08-19T18:05:00Z"),
    author: authors.marcus,
    resolvedBy: "human",
    category: "data_issue",
    sourceTicketId: ticketId(203),
    title: "cart_totals out of sync again after item removal",
    symptoms: "count/total in cart tag stuck after removing item. cart page fine. same as before.",
    rootCause: "removeItem still doesn't refresh cart_totals.",
    resolution:
      "Ran the recompute UPDATE on cart_totals for the cart (see the April write-up for the statement). Fixed. We should just ship the removeItem fix.",
  },
  {
    id: seedIncidentIds.redHerring,
    createdAt: at("2026-05-20T11:30:00Z"),
    author: authors.marcus,
    resolvedBy: "human",
    category: "user_error",
    sourceTicketId: ticketId(128),
    title: "Cart total wrong after removing item: went up instead of down",
    symptoms:
      "Tester reported the cart total was wrong after removing an item: the total went from $21.98 to $24.99 after removing a $5.99 line, so removing an item made the cart more expensive. Cart tag and cart page agreed with each other.",
    rootCause:
      "The cart had discount code FLAT5 applied, which takes $5 off but only once the subtotal reaches $20. Removing the line dropped the subtotal below the minimum, the discount stopped applying, and the total rose. Working as designed; see the discount code rules.",
    resolution:
      "Explained the minimum subtotal rule to the tester. No data or code change. Suggested the cart page show a note when a code stops applying.",
  },
  {
    id: incidentId(5),
    createdAt: at("2026-03-09T10:12:00Z"),
    author: authors.priya,
    resolvedBy: "human",
    category: "user_error",
    sourceTicketId: ticketId(84),
    title: "Checkout failed with no charge: card declined by the mock gateway",
    symptoms:
      "Customer wrote that checkout failed and no money was deducted. The storefront showed the generic 'Checkout failed' toast with a trace id. No order row was written.",
    rootCause:
      "The trace showed the mock payment gateway returning declined with decline_code insufficient_funds. The gateway declines any card number ending in 0002, the way processors' test modes work. The payments row recorded the decline; the storefront hides the decline reason behind the generic message.",
    resolution:
      "Replied to the customer that the card was declined by the issuer and that nothing was charged, and suggested another card. Filed a storefront improvement to show the decline reason.",
  },
  {
    id: incidentId(6),
    createdAt: at("2026-03-23T14:40:00Z"),
    author: authors.resolver,
    resolvedBy: "agent",
    category: "user_error",
    sourceTicketId: ticketId(90),
    title: "Discount code EXPIRED20 rejected at checkout",
    symptoms: "Customer could not apply EXPIRED20; the cart page said the code is not valid.",
    rootCause:
      "The discount_codes row for EXPIRED20 has active = false. The code applied during a past promotion and was deactivated when it ended.",
    resolution:
      "Told the customer the code has expired and pointed them at SALE10, which is active. No change.",
  },
  {
    id: incidentId(7),
    createdAt: at("2026-04-02T08:05:00Z"),
    author: authors.marcus,
    resolvedBy: "human",
    category: "infra",
    sourceTicketId: ticketId(97),
    title: "Every ShopLite route returned 500 after the compose stack restarted",
    symptoms:
      "All routes 500 for about four minutes. Logs: 'connect ECONNREFUSED 127.0.0.1:5432' then 'too many clients already'.",
    rootCause:
      "docker compose restarted Postgres while the API kept its pool open. The pool reconnected faster than Postgres accepted clients and hit max_connections during the traffic simulation.",
    resolution:
      "Restarted the API once Postgres was healthy. Added --wait to the infra:up script so the API starts after the healthcheck passes.",
  },
  {
    id: incidentId(8),
    createdAt: at("2026-04-28T16:55:00Z"),
    author: authors.priya,
    resolvedBy: "human",
    category: "user_error",
    sourceTicketId: ticketId(112),
    title: "Cart still shows the old price after a catalog price change",
    symptoms:
      "Tester changed the price of the Linen Tee (TEE-01) in the catalog and expected an open cart holding it to update. The cart line kept the old price.",
    rootCause:
      "cart_items.unit_price_cents captures the price at the time the line is added so a cart is stable if the catalog changes. This is intended, and the column comment says so.",
    resolution: "Explained the behaviour. Not a defect; closed as working as designed.",
  },
  {
    id: incidentId(9),
    createdAt: at("2026-05-06T13:20:00Z"),
    author: authors.resolver,
    resolvedBy: "agent",
    category: "data_issue",
    sourceTicketId: ticketId(120),
    title: "Customer had two open carts after the seed was rerun with the API running",
    symptoms:
      "GET /customers/:customerId/cart returned a different cart on alternate requests for one seeded customer; items added on the storefront vanished on the next page load.",
    rootCause:
      "pnpm db:seed was run while the API was serving requests. The seed truncated carts and recreated them, and a concurrent request created a second open cart for the same customer before the seeded one existed. Two rows in shoplite.carts had status open for one customer_id.",
    resolution:
      "Proposed deleting the newer, empty open cart: DELETE FROM shoplite.carts WHERE id = '<newer cart id>' AND status = 'open'. Reviewer approved; cart_totals and cart_items followed by cascade. Noted that the seed should only run with the API stopped.",
  },
  {
    id: incidentId(10),
    createdAt: at("2026-05-14T07:45:00Z"),
    author: authors.marcus,
    resolvedBy: "human",
    category: "infra",
    sourceTicketId: ticketId(124),
    title: "API log full of OTLP export errors",
    symptoms:
      "Hundreds of 'OTLPExporterError: connect ECONNREFUSED 127.0.0.1:4318' lines per minute in the API log. Requests themselves were fine.",
    rootCause: "The LGTM container was down. Exporters retry and log every failure.",
    resolution: "docker compose up lgtm. No product impact; the log noise stopped.",
  },
  {
    id: incidentId(11),
    createdAt: at("2026-06-11T10:10:00Z"),
    author: authors.priya,
    resolvedBy: "human",
    category: "code_bug",
    sourceTicketId: ticketId(150),
    title: "FLAT5 stayed applied at checkout after the cart dropped below its minimum",
    symptoms:
      "An order was charged $14.99 for a $19.99 subtotal with FLAT5, whose minimum subtotal is $20. The customer had applied the code, then removed a line, then checked out.",
    rootCause:
      "The minimum was checked in the discount route when the code was applied, but finalizeOrder in the domain module took carts.discount_code at face value and did not re-check the minimum against the subtotal at checkout.",
    resolution:
      "Wrote a failing unit test for finalizeOrder with a subtotal under the minimum, made applyDiscount return zero when the minimum is not met, and opened the pull request. Refunded nothing: the customer got a better price.",
  },
  {
    id: incidentId(12),
    createdAt: at("2026-06-25T15:00:00Z"),
    author: authors.resolver,
    resolvedBy: "agent",
    category: "question",
    sourceTicketId: ticketId(158),
    title: "Customer asked where to download an invoice",
    symptoms: "Ticket: 'Where do I get an invoice for my order from yesterday?'",
    rootCause: "Not a defect. The Help article on invoices covers it.",
    resolution:
      "Answered from the Help article: open My orders on the storefront, pick the order, and use Download invoice. Fast path, no investigation.",
  },
  {
    id: incidentId(13),
    createdAt: at("2026-07-03T12:35:00Z"),
    author: authors.marcus,
    resolvedBy: "human",
    category: "code_bug",
    sourceTicketId: ticketId(166),
    title: "Checkout 500 when a cart line has quantity 0",
    symptoms:
      "POST /customers/:customerId/checkout returned 500 with 'quantity must be positive' from the pricing module. The cart had a line with quantity 0 added through the API directly.",
    rootCause:
      "POST /customers/:customerId/cart/items accepted quantity 0. The pricing module rejects it later, at checkout, where the error was unhandled.",
    resolution: "Validate quantity >= 1 on add. PR merged. Removed the zero line from the cart.",
  },
  {
    id: incidentId(14),
    createdAt: at("2026-07-15T09:15:00Z"),
    author: authors.priya,
    resolvedBy: "human",
    category: "user_error",
    sourceTicketId: ticketId(171),
    title: "Payment declined with invalid_number for a card typed with a letter in it",
    symptoms:
      "Customer said their card was declined twice. The payments rows showed status declined with decline_code invalid_number.",
    rootCause:
      "The mock gateway checks the number is well formed before anything else; the customer had typed the letter O instead of a zero.",
    resolution: "Asked them to re-enter the number. Third attempt approved. No change.",
  },
  {
    id: incidentId(15),
    createdAt: at("2026-07-22T17:25:00Z"),
    author: authors.resolver,
    resolvedBy: "agent",
    category: "data_issue",
    sourceTicketId: ticketId(177),
    title: "One order's total_cents does not equal subtotal minus discount",
    symptoms:
      "Tester found an order where total_cents was $2 lower than subtotal_cents minus discount_cents. Only one order was affected.",
    rootCause:
      "The order was placed during the window when the FLAT5 minimum bug was live and a second, manual discount adjustment was made on top. The stored lines are correct; only the total column is off.",
    resolution:
      "Proposed UPDATE shoplite.orders SET total_cents = subtotal_cents - discount_cents WHERE id = '<order id>'. Reviewer approved; ran in a transaction with the row snapshot kept.",
  },
  {
    id: incidentId(16),
    createdAt: at("2026-08-01T11:05:00Z"),
    author: authors.marcus,
    resolvedBy: "human",
    category: "data_issue",
    sourceTicketId: ticketId(185),
    title: "Product illustrations 404 after the image files were renamed",
    symptoms:
      "Every product card showed the broken image placeholder. GET /images/mug.png and the other seven returned 404 from the storefront dev server.",
    rootCause:
      "The files under apps/web/public/images were renamed to include the SKU, but products.image_url in the seed still pointed at the old names.",
    resolution: "Updated the seed's imageUrl values and reran pnpm db:seed. Images back.",
  },
  {
    id: incidentId(17),
    createdAt: at("2026-08-08T14:50:00Z"),
    author: authors.priya,
    resolvedBy: "human",
    category: "code_bug",
    sourceTicketId: ticketId(190),
    title: "Cart tag says '1 items'",
    symptoms: "Pluralisation. '1 items' in the header tag.",
    rootCause: "formatItemCount in apps/web/src/lib always appended 's'.",
    resolution: "Fixed the formatter, added a unit test for 0, 1, and 2.",
  },
  {
    id: incidentId(18),
    createdAt: at("2026-08-26T10:30:00Z"),
    author: authors.resolver,
    resolvedBy: "agent",
    category: "user_error",
    sourceTicketId: ticketId(210),
    title: "Customer could not find the 'Report a problem' button",
    symptoms: "Ticket: 'The site says report a problem but there is no button anywhere.'",
    rootCause:
      "The button is on the error toast, which appears only when a request fails and disappears after a few seconds. There is no standing link.",
    resolution:
      "Explained where the button lives and that a Ticket can also be opened from the portal. Suggested a permanent link in the footer.",
  },
  {
    id: incidentId(19),
    createdAt: at("2026-09-01T08:20:00Z"),
    author: authors.marcus,
    resolvedBy: "human",
    category: "infra",
    sourceTicketId: ticketId(215),
    title: "Grafana error rate panel read zero while checkouts were failing",
    symptoms:
      "During a traffic simulation the checkout route returned 500 on a third of requests, but the ShopLite dashboard's error rate panel showed 0 for every route.",
    rootCause:
      "The panel's PromQL divided by a series that did not exist for healthy routes, so the ratio was NaN and rendered as nothing, and it counted 4xx as errors on the routes where it did render.",
    resolution:
      "Rewrote the panel query to use `or vector(0)` for the numerator and to count only 5xx. Provisioned from infra/grafana in the incident-resolver repo.",
  },
  {
    id: incidentId(20),
    createdAt: at("2026-03-30T16:10:00Z"),
    author: authors.priya,
    resolvedBy: "human",
    category: "question",
    sourceTicketId: ticketId(93),
    title: "Should removing the last item delete the cart?",
    symptoms:
      "Tester asked whether an empty cart should disappear after its last line is removed, since the cart page still shows an empty cart with a $0.00 total.",
    rootCause:
      "By design: a cart stays open with zero totals until checkout so the discount code and the customer's place survive. Not a defect.",
    resolution: "Answered the question. No change.",
  },
];

type SeedHelpArticle = NewHelpArticle & { id: string };

export const seedHelpArticles: SeedHelpArticle[] = [
  {
    id: seedHelpArticleIds.clearCache,
    title: "Product images or pages not loading: clear your cache and hard refresh",
    body: "If product images stopped loading, show as broken placeholders, or a page looks out of date, especially right after a sale or a site update, your browser is usually showing an old cached copy. First try a hard refresh: on Windows press Ctrl+Shift+R, on Mac press Cmd+Shift+R. If that does not help, clear your browser cache for shoplite and reload: in Chrome open Settings, Privacy and security, Clear browsing data, tick Cached images and files, and clear. Then open the catalog again. If images are still missing after clearing the cache, use Report a problem from the error message so we get the trace id.",
    tags: ["images", "cache", "browser", "loading", "refresh"],
  },
  {
    id: articleId(2),
    title: "Reset your password",
    body: "On the sign-in page choose Forgot password, enter the email on your ShopLite account, and follow the link in the email within one hour. If the email does not arrive, check your spam folder and confirm you entered the address the account was created with. Your cart and order history are kept when you reset your password.",
    tags: ["account", "password", "sign-in"],
  },
  {
    id: articleId(3),
    title: "Change your delivery address",
    body: "Open Account, then Addresses, to add or edit a delivery address. An order that has already been placed uses the address chosen at checkout; if it has not shipped yet, cancel it and place it again with the new address. Orders that have shipped cannot be redirected.",
    tags: ["account", "address", "delivery", "shipping"],
  },
  {
    id: articleId(4),
    title: "Cancel an order",
    body: "You can cancel an order from My orders as long as it has not shipped. Open the order and choose Cancel order. A paid order is refunded to the original card within five business days. If the Cancel button is missing, the order has already been handed to the carrier; use Returns and refunds instead once it arrives.",
    tags: ["orders", "cancel", "refund"],
  },
  {
    id: articleId(5),
    title: "Where to find your invoices",
    body: "Every paid order has an invoice. Open My orders on the storefront, pick the order, and choose Download invoice for a PDF that shows the lines, the discount applied, the total charged, and the last four digits of the card. Invoices are also emailed when the order is placed.",
    tags: ["orders", "invoices", "receipts", "billing"],
  },
  {
    id: articleId(6),
    title: "Supported payment cards",
    body: "ShopLite accepts Visa, Mastercard, and American Express debit and credit cards. Enter the number without spaces or letters. If your card is declined, nothing is charged: the message from your bank explains why, most often insufficient funds or a mistyped number. Prepaid cards and bank transfers are not supported.",
    tags: ["payments", "cards", "checkout", "declined"],
  },
  {
    id: articleId(7),
    title: "Discount code rules",
    body: "One discount code per cart. Enter it on the cart page before checkout. Percentage codes such as SALE10 take the percentage off the subtotal. Fixed codes such as FLAT5 take a fixed amount off, but only once the subtotal reaches the code's minimum, so removing items can make a code stop applying and the total rise. Expired codes are rejected. Discounts never apply to shipping.",
    tags: ["discounts", "codes", "checkout", "promotions"],
  },
  {
    id: articleId(8),
    title: "Track your order",
    body: "Open My orders and pick the order to see its status: paid, packed, shipped, or delivered. Once it ships, a tracking link from the carrier appears on the order. Delivery usually takes three to five business days.",
    tags: ["orders", "shipping", "tracking"],
  },
  {
    id: articleId(9),
    title: "Returns and refunds",
    body: "Return any unused item within 30 days of delivery. Open the order under My orders, choose Return items, and print the label. Refunds go to the original card within five business days of the return arriving. Sale items can be returned for store credit.",
    tags: ["orders", "returns", "refunds"],
  },
  {
    id: articleId(10),
    title: "Report a problem from the storefront",
    body: "When something fails on the storefront, the error message shows a trace id and a Report a problem button. The button opens a support Ticket with your email, the trace id, and what you were doing already filled in, which lets us find the exact request. You can also open a Ticket from the support portal and paste the trace id into it.",
    tags: ["support", "tickets", "trace id", "errors"],
  },
];
