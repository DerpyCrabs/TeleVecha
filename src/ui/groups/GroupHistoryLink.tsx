import { Effect } from 'effect';
import { component, view } from 'effectweb';
import History from '@effectweb/lucide/icons/history';
import ArrowRight from '@effectweb/lucide/icons/arrow-right';
import type { TelegramPeer } from '../../telegram/types';
import type { ChatManagementSettings } from '../../telegram/chatManagement';
import type { EffectMessagingClient } from '../../telegram/core/client';
import { groupResourceSubscription } from './groupResourceSubscription';
interface Props {
  api: EffectMessagingClient;
  peer: TelegramPeer;
  online: boolean;
  open: (peer: TelegramPeer, earlier: boolean) => void;
}
type Message =
  | { type: 'Load' }
  | { type: 'Loaded'; settings: ChatManagementSettings }
  | { type: 'Failed' };
export const GroupHistoryLink = component<
  Props,
  { settings: ChatManagementSettings | undefined },
  Message
>(
  {
    identity: (props) => props.peer.id,
    init: () => ({ settings: undefined }),
    update: (model, message) => {
      if (message.type === 'Loaded') return { model: { ...model, settings: message.settings } };
      if (message.type === 'Failed' || !model.props.online) return { model };
      return {
        model,
        commands: [
          {
            key: ['group-history', model.props.peer.id],
            policy: 'replace',
            effect: model.props.api
              .getChatManagement(model.props.peer)
              .pipe(
                Effect.match({
                  onSuccess: (settings): Message => ({ type: 'Loaded', settings }),
                  onFailure: (): Message => ({ type: 'Failed' }),
                }),
              ),
          },
        ],
      };
    },
  },
  view((model, send) => (
    <>
      <span
        hidden
        use={groupResourceSubscription({
          api: model.props.api,
          peerId: model.props.peer.id,
          kind: 'chat-management',
          online: model.props.online,
          reload: () => send({ type: 'Load' }),
        })}
      />
      {model.settings?.migratedFrom ? (
        <button
          class="group-history-link"
          onClick={() => model.props.open(model.settings!.migratedFrom!, true)}
        >
          <History size={18} />
          <span>
            Earlier group history<small>Messages before the group was upgraded</small>
          </span>
        </button>
      ) : null}
      {model.settings?.migratedTo ? (
        <button
          class="group-history-link"
          onClick={() => model.props.open(model.settings!.migratedTo!, false)}
        >
          <ArrowRight size={18} />
          <span>
            Open current group<small>Continue the conversation</small>
          </span>
        </button>
      ) : null}
    </>
  )),
);
