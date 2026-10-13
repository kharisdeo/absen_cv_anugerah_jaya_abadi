import { useCallback, useEffect, useState } from 'react';

import {
  LocationCaptureController,
  type LocationCaptureOptions,
  type LocationCaptureSnapshot,
} from './location-capture.js';

export type UseLocationCaptureResult = Readonly<{
  snapshot: LocationCaptureSnapshot;
  captureLocation: () => void;
  cancelCapture: () => void;
  resetCapture: () => void;
}>;

/**
 * A foreground-only location capture hook. Call `captureLocation` directly from
 * the user's attendance action; this hook never requests location from render/effects.
 */
export function useLocationCapture(options?: LocationCaptureOptions): UseLocationCaptureResult {
  const [controller] = useState(() => new LocationCaptureController(options));
  const [snapshot, setSnapshot] = useState(() => controller.getSnapshot());

  useEffect(() => {
    const unsubscribe = controller.subscribe(setSnapshot);
    setSnapshot(controller.getSnapshot());
    return () => {
      unsubscribe();
      controller.dispose();
    };
  }, [controller]);

  const captureLocation = useCallback(() => controller.start(), [controller]);
  const cancelCapture = useCallback(() => controller.cancel(), [controller]);
  const resetCapture = useCallback(() => controller.reset(), [controller]);

  return { snapshot, captureLocation, cancelCapture, resetCapture };
}
