import { describe, expect, it } from 'vitest';

import { shouldOfferFreshCapture } from '../src/components/attendance/attendance-submission-model.js';

describe('fresh capture recovery after a definitive attempt error', () => {
  it('offers a new capture after upload released the photo and a definitive error cleared the draft', () => {
    expect(
      shouldOfferFreshCapture({
        hasReceipt: false,
        hasDraft: false,
        hasPhoto: false,
        requiresFreshCapture: true,
        busy: false,
      }),
    ).toBe(true);
  });

  it('keeps an ambiguous attempt on its identical replay draft instead of allowing recapture', () => {
    expect(
      shouldOfferFreshCapture({
        hasReceipt: false,
        hasDraft: true,
        hasPhoto: false,
        requiresFreshCapture: true,
        busy: false,
      }),
    ).toBe(false);
  });
});
