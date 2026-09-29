/** Application projections retain structurally equal domain values. */
export function projectionPublication<Model>(options: {
  invalidate: () => void;
  refresh: () => void;
  project: () => Model;
  afterPublish?: () => void;
}) {
  return projectionSource<Model>({ ...options, reconcile: shareValue });
}
import { projectionSource, shareValue } from 'effectweb/advanced';
