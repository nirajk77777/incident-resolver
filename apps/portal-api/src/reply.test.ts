import { describe, expect, it } from "vitest";
import { withoutPullRequestLinks } from "./reply";

const link = "https://github.com/nirajk77777/shoplite/pull/9";

describe("withoutPullRequestLinks", () => {
  it("leaves a Reply that never mentioned one alone", () => {
    const reply = "Thanks for reporting this. The bug is confirmed and a fix is underway.";

    expect(withoutPullRequestLinks(reply)).toEqual({ text: reply, removed: false });
  });

  it("takes the link out of the end of a sentence", () => {
    const { text, removed } = withoutPullRequestLinks(`A fix is underway: ${link}`);

    expect(removed).toBe(true);
    expect(text).toBe("A fix is underway:");
  });

  it("takes it out of the middle without leaving the gap or the bracket behind", () => {
    const { text } = withoutPullRequestLinks(
      `The bug is confirmed (${link}) and a fix is underway.`,
    );

    expect(text).toBe("The bug is confirmed and a fix is underway.");
  });

  it("takes out every link, not only the first", () => {
    const { text } = withoutPullRequestLinks(`See ${link} and ${link}.`);

    expect(text).not.toContain("github.com");
    expect(text).toBe("See and.");
  });

  it("leaves a link that is not a pull request alone", () => {
    const reply = "The article is at https://github.com/nirajk77777/shoplite/issues/4";

    expect(withoutPullRequestLinks(reply).removed).toBe(false);
  });
});
