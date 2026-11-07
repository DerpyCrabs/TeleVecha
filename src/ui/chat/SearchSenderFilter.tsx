import { component, view } from 'effectweb';
import { GroupSenderPicker } from './GroupSenderPicker';
import { ForwardMessageDialog } from '../conversation/ForwardMessageDialog';
import type { SearchPanelProps } from './searchProgram';
import type { TelegramPeer } from '../../telegram/types';

export const SearchSenderFilter = component(
  {
    init: (_props: {
      host: SearchPanelProps;
      selected?: TelegramPeer | undefined;
      change: (peer?: TelegramPeer) => void;
    }) => ({ open: false, selectedTitle: '' }),
  },
  view((model, patch) => (
    <div class="search-sender-filter">
      <button type="button" onClick={() => patch({ open: true })} title="Filter by sender">
        {model.props.selected
          ? `From: ${model.props.host.dialogs.find((d) => d.peer.id === model.props.selected?.id)?.title ?? model.selectedTitle}`
          : 'From anyone'}
      </button>
      {model.props.selected ? (
        <button
          type="button"
          aria-label="Clear sender filter"
          title="Clear sender filter"
          onClick={() => model.props.change()}
        >
          ×
        </button>
      ) : null}
      {model.open &&
      model.props.host.media &&
      model.props.host.searchMembers &&
      model.props.host.dialogs.some(
        (dialog) =>
          dialog.peer.id === model.props.host.activePeerId &&
          (dialog.peer.kind === 'group' || dialog.permissions?.canViewMembers),
      ) ? (
        <GroupSenderPicker
          peerId={model.props.host.activePeerId}
          media={model.props.host.media}
          online={model.props.host.online ?? true}
          search={(query, offset) =>
            model.props.host.searchMembers!(model.props.host.activePeerId, query, offset)
          }
          close={() => patch({ open: false })}
          select={(member) => {
            patch({ open: false, selectedTitle: member.isSelf ? 'You' : member.title });
            model.props.change(member.peer);
          }}
        />
      ) : model.open && model.props.host.media ? (
        <ForwardMessageDialog
          overlayLayer={90}
          searchLabel="Search people by name or username"
          title="Choose sender"
          label="Choose sender"
          cancelLabel="Close sender picker"
          chats={model.props.host.dialogs
            .filter((d) => d.peer.kind === 'user')
            .map((d) => ({
              id: d.peer.id,
              title: d.title,
              initials: d.initials,
              color: d.color,
              preview: '',
              time: '',
              unread: 0,
              username: d.username,
            }))}
          media={model.props.host.media}
          online={model.props.host.online ?? true}
          search={model.props.host.searchPeople}
          close={() => patch({ open: false })}
          forward={(peerId, result) => {
            const dialog = model.props.host.dialogs.find((d) => d.peer.id === peerId);
            const peer = result?.peer ?? dialog?.peer;
            if (!peer) return;
            patch({ open: false, selectedTitle: result?.title ?? dialog?.title ?? peer.id });
            model.props.change(peer);
          }}
        />
      ) : null}
    </div>
  )),
);
