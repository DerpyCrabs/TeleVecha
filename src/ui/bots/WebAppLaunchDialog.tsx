import { panelClass } from '../shared/panelStyles';
import { component, view } from 'effectweb';
import { Dialog } from '../shared/Dialog';
import type { PendingWebAppLaunch } from './botSession';
export const WebAppLaunchDialog = component(
  {
    init: (_props: {
      pending: PendingWebAppLaunch;
      busy: boolean;
      close: () => void;
      confirm: (writeAllowed: boolean) => void;
    }) => ({ writeAllowed: false }),
    identity: (props) => props.pending,
  },
  view((model, patch) => (
    <Dialog
      class={`${panelClass} max-w-[26rem]`}
      title={`Open ${model.props.pending.title}?`}
      closeLabel="Cancel opening Mini App"
      onClose={model.props.close}
    >
      <div class="min-h-0 overflow-y-auto p-5">
        {model.props.pending.description ? (
          <p class="mb-3">{model.props.pending.description}</p>
        ) : null}
        <p class="text-sm text-muted">
          This Mini App will receive your public Telegram profile information.
        </p>
        {model.props.pending.requestWriteAccess ? (
          <label class="mt-4 flex gap-3 items-start">
            <input
              type="checkbox"
              checked={model.writeAllowed}
              disabled={model.props.busy}
              onChange={(event) => patch({ writeAllowed: event.currentTarget.checked })}
            />
            <span>Allow this bot to send me messages</span>
          </label>
        ) : null}
      </div>
      <div class="mini-app-actions">
        <button disabled={model.props.busy} onClick={model.props.close}>
          Cancel
        </button>
        <button disabled={model.props.busy} onClick={() => model.props.confirm(model.writeAllowed)}>
          {model.props.busy ? 'Opening…' : 'Open'}
        </button>
      </div>
    </Dialog>
  )),
);
