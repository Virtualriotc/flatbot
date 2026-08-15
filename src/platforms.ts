/**
 * Per-portal knowledge for the send agent. Pure data — no network, no browser.
 * `contactInstructions` is pasted verbatim into the backend's prompt, so it is written
 * as German-form guidance (the portals' UI is German) with the real button/field wording.
 * Markers are matched case-insensitively by the backends against visible page text.
 */
export type PlatformSpec = {
  id: string;
  displayName: string;
  loginUrl: string;
  matchesUrl(url: string): boolean;
  contactInstructions: string;
  paywallMarkers: string[];
  successMarkers: string[];
};

/** Host match is by registrable domain, never substring: `immowelt.de.evil.test` must not match. */
function onHosts(hosts: string[]): (url: string) => boolean {
  return (url) => {
    let host: string;
    try {
      host = new URL(url).hostname.toLowerCase();
    } catch {
      return false;
    }
    return hosts.some((h) => host === h || host.endsWith(`.${h}`));
  };
}

function spec(s: Omit<PlatformSpec, 'matchesUrl'> & { hosts: string[] }): PlatformSpec {
  const { hosts, ...rest } = s;
  return { ...rest, matchesUrl: onHosts(hosts) };
}

export const PLATFORMS: PlatformSpec[] = [
  spec({
    id: 'immoscout',
    displayName: 'ImmobilienScout24',
    loginUrl: 'https://sso.immobilienscout24.de/sso/login',
    hosts: ['immobilienscout24.de'],
    contactInstructions: [
      'Auf der Exposé-Seite den Button "Nachricht schreiben" bzw. "Kontaktieren" anklicken (rechts in der Anbieter-Box).',
      'Das Kontaktformular öffnet sich als Overlay: Anrede (Frau/Herr), Vorname, Nachname, E-Mail, Telefonnummer, Nachricht.',
      'Bereits ausgefüllte Profilfelder unverändert lassen; nur das Feld "Nachricht" mit dem Anschreiben füllen.',
      'Optionale Checkboxen (z. B. Kontaktdaten übermitteln) so lassen wie sie sind.',
      'Abschicken mit "Nachricht senden".',
    ].join(' '),
    paywallMarkers: [
      'MieterPlus',
      'Jetzt MieterPlus buchen',
      'Nur für MieterPlus',
      'Mit MieterPlus zuerst',
      'Premium-Mitgliedschaft',
    ],
    successMarkers: [
      'Nachricht gesendet',
      'Ihre Nachricht wurde versendet',
      'Deine Nachricht wurde versendet',
      'Ihre Anfrage wurde versendet',
      'Vielen Dank für Ihre Anfrage',
    ],
  }),
  spec({
    id: 'kleinanzeigen',
    displayName: 'Kleinanzeigen',
    loginUrl: 'https://www.kleinanzeigen.de/m-einloggen.html',
    hosts: ['kleinanzeigen.de', 'ebay-kleinanzeigen.de'],
    contactInstructions: [
      'Auf der Anzeigenseite den Button "Nachricht schreiben" anklicken (in der Kontaktbox unter dem Anbieternamen).',
      'Es erscheint ein Nachrichtenfeld: Nachricht, ggf. Name und Telefonnummer.',
      'Vorgeschlagene Textbausteine ignorieren und das eigene Anschreiben in das Nachrichtenfeld eintragen.',
      'Keine Anhänge hochladen.',
      'Abschicken mit "Nachricht senden".',
    ].join(' '),
    // Kleinanzeigen does not paywall replies, but it blocks them behind login/PRO walls.
    paywallMarkers: [
      'Kleinanzeigen PRO',
      'Nur für angemeldete Nutzer',
      'Bitte melde dich an',
      'kostenpflichtig',
    ],
    successMarkers: [
      'Nachricht gesendet',
      'Deine Nachricht wurde verschickt',
      'Deine Nachricht wurde gesendet',
      'Nachricht wurde verschickt',
    ],
  }),
  spec({
    id: 'wggesucht',
    displayName: 'WG-Gesucht',
    loginUrl: 'https://www.wg-gesucht.de/login.html',
    hosts: ['wg-gesucht.de'],
    contactInstructions: [
      'Auf der Angebotsseite den Button "Nachricht schreiben" bzw. "Kontakt aufnehmen" anklicken.',
      'Das Anfrageformular hat einen Betreff und ein großes Nachrichtenfeld; Vorlagen ("Vorlage verwenden") nicht benutzen.',
      'Betreff nur setzen, falls das Feld leer ist (z. B. "Anfrage zur Wohnung"), Anschreiben in das Nachrichtenfeld.',
      'Keine Bewerbungsunterlagen oder Dateien anhängen.',
      'Abschicken mit "Nachricht senden" bzw. "Anfrage senden".',
    ].join(' '),
    paywallMarkers: [
      'WG-Gesucht Premium',
      'Premium-Mitgliedschaft',
      'Jetzt Premium werden',
      'nur mit Premium',
    ],
    successMarkers: [
      'Nachricht gesendet',
      'Deine Nachricht wurde gesendet',
      'Deine Nachricht wurde erfolgreich versendet',
      'Anfrage wurde gesendet',
    ],
  }),
  spec({
    id: 'immowelt',
    displayName: 'Immowelt',
    loginUrl: 'https://www.immowelt.de/login',
    hosts: ['immowelt.de', 'immowelt.at'],
    contactInstructions: [
      'Auf der Exposé-Seite den Button "Anbieter kontaktieren" bzw. "Nachricht senden" anklicken.',
      'Das Kontaktformular enthält Anrede, Vorname, Name, E-Mail, Telefon und ein Nachrichtenfeld.',
      'Vorbefülltes Standard-Anschreiben komplett ersetzen durch das eigene Anschreiben.',
      'Keine Zusatzoptionen wie "Finanzierungsberatung" oder Newsletter aktivieren.',
      'Abschicken mit "Anfrage senden".',
    ].join(' '),
    paywallMarkers: [
      'Immowelt Plus',
      'Premium-Mitgliedschaft',
      'kostenpflichtiges Upgrade',
      'nur für Plus-Mitglieder',
    ],
    successMarkers: [
      'Ihre Anfrage wurde versendet',
      'Anfrage gesendet',
      'Ihre Nachricht wurde versendet',
      'Vielen Dank für Ihre Anfrage',
    ],
  }),
];

export function platformFor(idOrUrl: string): PlatformSpec | undefined {
  return PLATFORMS.find((p) => p.id === idOrUrl) ?? PLATFORMS.find((p) => p.matchesUrl(idOrUrl));
}
