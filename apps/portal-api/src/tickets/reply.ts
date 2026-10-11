/**
 * What a Reply may say before the Ticket closes with it.
 *
 * CONTEXT.md gives a `fix_proposed` Ticket a customer Reply that says the bug is confirmed and
 * a fix is underway, and puts the pull request link on an internal note instead. The Resolver's
 * prompt says so too, but every other claim a Verdict makes is checked here rather than trusted
 * — a Reply that reached the Reporter with a link to ShopLite's repository in it could not be
 * taken back, and it is the kind of thing a model does once in fifty runs.
 *
 * Only customer Replies are cleaned. A tester's or Sentinel's Reply is an internal note that is
 * never sent anywhere, and CONTEXT.md lets it name ids, tables, and trace ids; a link there is
 * useful rather than a leak.
 */

/** Any GitHub pull request url, with the brackets a Reply might have wrapped it in. */
const PULL_REQUEST_LINK = /[([<]?https:\/\/github\.com\/[^\s()<>[\]"']+\/pull\/\d+[)\]>]?/g;

export type CleanedReply = { text: string; removed: boolean };

/** The Reply with any pull request link taken out, and whether one was there. */
export function withoutPullRequestLinks(reply: string): CleanedReply {
  // Replacing rather than testing first: `test` on a global regex carries `lastIndex` from one
  // call to the next, and this one is shared by every Ticket the portal closes.
  const stripped = reply.replace(PULL_REQUEST_LINK, "");
  if (stripped === reply) return { text: reply, removed: false };
  const text = stripped
    // A link taken out of the middle of a sentence leaves the space on either side of it, and
    // one taken from before a full stop leaves the space in front of that.
    .replace(/[ \t]{2,}/g, " ")
    .replace(/[ \t]+([.,;:!?])/g, "$1")
    .trim();
  return { text, removed: true };
}
