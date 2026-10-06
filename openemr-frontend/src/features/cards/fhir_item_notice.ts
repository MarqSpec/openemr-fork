// reference: REQUIREMENTS.md FR-CARD-3

/**
 * Words a non-ok FHIR item the way {@link CardItems} does, so a card that draws its own rows
 * does not call a partial result a parse failure.
 */
export function fhirItemNoticeText(
  kind: 'could-not-display' | 'more-not-shown',
  subject: string,
): string {
  switch (kind) {
    case 'could-not-display':
      return 'Could not display this item';
    case 'more-not-shown':
      return `More ${subject} not shown`;
    default: {
      const unexpected: never = kind;
      return unexpected;
    }
  }
}
