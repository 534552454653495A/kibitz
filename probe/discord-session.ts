/**
 * Logs the probe's throwaway account in by seeding Discord's token BEFORE the app boots.
 *
 * Discord's web client deletes `window.localStorage`'s accessor shortly after its first
 * script runs (an anti-token-grabber measure), so there is no reliable moment to set the
 * token from a later `page.evaluate`. `evaluateOnNewDocument` is the document_start
 * equivalent: it runs in every new document before any page script, which is the only
 * dependable window. Discord stores the token JSON-quoted (`"abc"`), hence the stringify.
 *
 * The token is never logged, echoed or written to an artefact — treat this module as the
 * one place it exists outside the environment variable.
 */
import type { Page } from "puppeteer";

const TOKEN_KEY = "token";

export async function installDiscordToken(page: Page, token: string): Promise<void> {
  await page.evaluateOnNewDocument(
    (key: string, value: string) => {
      window.localStorage.setItem(key, JSON.stringify(value));
    },
    TOKEN_KEY,
    token,
  );
}
