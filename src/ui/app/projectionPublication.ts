import { projectionSource } from 'effectweb';
import { shareValue } from 'effectweb/share';

/** Application projections retain structurally equal domain values. */
export function projectionPublication<Model>(options: {
  invalidate: () => void;
  refresh: () => void;
  project: () => Model;
  afterPublish?: () => void;
}) {
  return projectionSource<Model>({ ...options, reconcile: shareValue });
}
