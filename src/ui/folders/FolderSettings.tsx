import { idRows, peerRows } from '../collections';
import { component, collection, list, view } from 'effectweb';
import { Effect } from 'effect';
import Folder from '@effectweb/lucide/icons/folder';
import Plus from '@effectweb/lucide/icons/plus';
import ArrowLeft from '@effectweb/lucide/icons/arrow-left';
import ArrowUp from '@effectweb/lucide/icons/arrow-up';
import ChevronRight from '@effectweb/lucide/icons/chevron-right';
import Link from '@effectweb/lucide/icons/link';
import {
  folderCategories,
  folderExclusions,
  folderInviteSlug,
  type ChatFoldersApi,
  type TelegramChatFolder,
  type TelegramFolderLink,
  type TelegramFolderInvite,
} from '../../telegram/chatFolders';
import type { TelegramDialog, TelegramPeer, TelegramPeerSearchResult } from '../../telegram/types';
import type { MediaAssets } from '../media/mediaAssets';
import { Avatar } from '../shared/Avatar';
import { folderSubscription } from './folderSubscription';

type Page =
  | 'list'
  | 'edit'
  | 'include'
  | 'exclude'
  | 'links'
  | 'share'
  | 'join'
  | 'preview'
  | 'delete';
interface Props {
  initialInvite?: string;
  onJoined?: () => void;
  api: ChatFoldersApi;
  online: boolean;
  dialogs: readonly TelegramDialog[];
  media: MediaAssets;
}
interface State {
  folders: TelegramChatFolder[];
  page: Page;
  draft: TelegramChatFolder | undefined;
  busy: boolean;
  error: string;
  query: string;
  links: TelegramFolderLink[];
  invite: TelegramFolderInvite | undefined;
  updates: TelegramFolderInvite | undefined;
  selected: TelegramPeer[];
  linkInput: string;
  linkTitle: string;
  notice: string;
}
type Message =
  | { type: 'Load' }
  | { type: 'Loaded'; folders: TelegramChatFolder[] }
  | { type: 'Open'; folder?: TelegramChatFolder }
  | { type: 'Page'; page: Page }
  | { type: 'Title'; value: string }
  | { type: 'Query'; value: string }
  | { type: 'ToggleFlag'; key: string }
  | { type: 'TogglePeer'; peer: TelegramPeer }
  | { type: 'Save' }
  | { type: 'Delete' }
  | { type: 'Order'; index: number }
  | { type: 'Links' }
  | { type: 'Linked'; links: TelegramFolderLink[] }
  | { type: 'Export' }
  | { type: 'Revoke'; url: string }
  | { type: 'Input'; value: string }
  | { type: 'LinkTitle'; value: string }
  | { type: 'CheckInvite' }
  | { type: 'Invite'; invite: TelegramFolderInvite }
  | { type: 'Updates'; invite: TelegramFolderInvite }
  | { type: 'Join' }
  | { type: 'Done'; page: Page; notice?: string }
  | { type: 'Failed'; error: string };
const labels: Record<string, string> = {
  contacts: 'Contacts',
  nonContacts: 'Non-contacts',
  groups: 'Groups',
  broadcasts: 'Channels',
  bots: 'Bots',
  excludeMuted: 'Muted',
  excludeRead: 'Read',
  excludeArchived: 'Archived',
};
const linkRows = collection<TelegramFolderLink>((link) => link.url).from;
const toggle = <T,>(values: T[], value: T) =>
  values.includes(value) ? values.filter((item) => item !== value) : [...values, value];
const togglePeer = (values: TelegramPeer[], peer: TelegramPeer) =>
  values.some((item) => item.id === peer.id)
    ? values.filter((item) => item.id !== peer.id)
    : [...values, peer];
export const FolderSettings = component<Props, State, Message>(
  {
    init: (props) => ({
      folders: [],
      page: props.initialInvite ? 'join' : 'list',
      draft: undefined,
      busy: false,
      error: '',
      query: '',
      links: [],
      invite: undefined,
      updates: undefined,
      selected: [],
      linkInput: props.initialInvite ?? '',
      linkTitle: '',
      notice: '',
    }),
    update: (model, message) => {
      const run = (effect: Effect.Effect<Message, unknown>, name = 'mutation') => ({
        model: { ...model, busy: true, error: '' },
        commands: [
          {
            key: ['folders', name],
            policy: 'replace' as const,
            effect: effect.pipe(
              Effect.catch((error) =>
                Effect.succeed({
                  type: 'Failed',
                  error: error instanceof Error ? error.message : 'Could not update folders.',
                } as Message),
              ),
            ),
          },
        ],
      });
      switch (message.type) {
        case 'Load':
          if (model.props.initialInvite && model.page === 'join' && !model.invite)
            return run(
              model.props.api
                .checkFolderInvite(model.props.initialInvite)
                .pipe(Effect.map((invite) => ({ type: 'Invite', invite }))),
            );
          return run(
            model.props.api
              .getChatFolders()
              .pipe(Effect.map((folders) => ({ type: 'Loaded', folders }))),
            'load',
          );
        case 'Loaded':
          return { model: { ...model, folders: message.folders, busy: false } };
        case 'Failed':
          return { model: { ...model, busy: false, error: message.error } };
        case 'Done':
          return {
            model: { ...model, busy: false, page: message.page, notice: message.notice ?? '' },
          };
        case 'Page':
          return {
            model: {
              ...model,
              page: message.page,
              query: '',
              error: '',
              selected:
                message.page === 'share'
                  ? (model.draft?.included.filter((peer) => peer.kind !== 'user') ?? [])
                  : model.selected,
            },
          };
        case 'Open':
          return {
            model: {
              ...model,
              page: 'edit',
              updates: undefined,
              error: '',
              notice: '',
              draft: message.folder
                ? structuredClone(message.folder)
                : {
                    id: Math.max(1, ...model.folders.map((folder) => folder.id)) + 1,
                    title: '',
                    shared: false,
                    categories: [],
                    exclusions: [],
                    pinned: [],
                    included: [],
                    excluded: [],
                  },
            },
            commands:
              message.folder?.shared && model.props.online
                ? [
                    {
                      key: ['folders', 'updates'],
                      policy: 'replace' as const,
                      effect: model.props.api.getFolderUpdates(message.folder.id).pipe(
                        Effect.map((invite): Message => ({ type: 'Updates', invite })),
                        Effect.catch((error) =>
                          Effect.succeed({
                            type: 'Failed',
                            error:
                              error instanceof Error ? error.message : 'Could not load new chats.',
                          } as Message),
                        ),
                      ),
                    },
                  ]
                : [],
          };
        case 'Title':
          return {
            model: {
              ...model,
              draft: model.draft ? { ...model.draft, title: message.value } : undefined,
            },
          };
        case 'Query':
          return { model: { ...model, query: message.value } };
        case 'Input':
          return { model: { ...model, linkInput: message.value } };
        case 'LinkTitle':
          return { model: { ...model, linkTitle: message.value } };
        case 'ToggleFlag': {
          const draft = model.draft;
          if (!draft) return { model };
          return {
            model: {
              ...model,
              draft:
                model.page === 'include'
                  ? {
                      ...draft,
                      categories: toggle(
                        draft.categories,
                        message.key as (typeof folderCategories)[number],
                      ),
                    }
                  : {
                      ...draft,
                      exclusions: toggle(
                        draft.exclusions,
                        message.key as (typeof folderExclusions)[number],
                      ),
                    },
            },
          };
        }
        case 'TogglePeer': {
          if (model.page === 'share' || model.page === 'preview')
            return { model: { ...model, selected: togglePeer(model.selected, message.peer) } };
          if (!model.draft) return { model };
          const key = model.page === 'include' ? 'included' : 'excluded';
          const values = togglePeer(model.draft[key], message.peer);
          return {
            model: {
              ...model,
              draft: {
                ...model.draft,
                [key]: values,
                ...(key === 'included'
                  ? {
                      pinned: model.draft.pinned.filter((peer) =>
                        values.some((item) => item.id === peer.id),
                      ),
                      excluded: model.draft.excluded.filter(
                        (peer) => !values.some((item) => item.id === peer.id),
                      ),
                    }
                  : {
                      included: model.draft.included.filter(
                        (peer) => !values.some((item) => item.id === peer.id),
                      ),
                      pinned: model.draft.pinned.filter(
                        (peer) => !values.some((item) => item.id === peer.id),
                      ),
                    }),
              },
            },
          };
        }
        case 'Save':
          return model.draft
            ? run(
                model.props.api
                  .saveChatFolder(model.draft)
                  .pipe(Effect.as({ type: 'Done', page: 'list' })),
              )
            : { model };
        case 'Delete':
          return model.draft
            ? run(
                model.props.api
                  .deleteChatFolder(model.draft.id)
                  .pipe(Effect.as({ type: 'Done', page: 'list' })),
              )
            : { model };
        case 'Order': {
          const ids = model.folders.map((folder) => folder.id);
          [ids[message.index - 1], ids[message.index]] = [
            ids[message.index]!,
            ids[message.index - 1]!,
          ];
          return run(
            model.props.api.reorderChatFolders(ids).pipe(Effect.as({ type: 'Done', page: 'list' })),
          );
        }
        case 'Links':
          return model.draft
            ? run(
                model.props.api
                  .getFolderLinks(model.draft.id)
                  .pipe(Effect.map((links) => ({ type: 'Linked', links }))),
              )
            : { model };
        case 'Linked':
          return {
            model: {
              ...model,
              links: message.links,
              busy: false,
              page: 'links',
              draft:
                model.draft && message.links.length
                  ? { ...model.draft, shared: true }
                  : model.draft,
            },
          };
        case 'Export':
          return model.draft
            ? run(
                model.props.api
                  .exportFolderLink(model.draft.id, model.linkTitle, model.selected)
                  .pipe(
                    Effect.andThen(model.props.api.getFolderLinks(model.draft.id)),
                    Effect.map((links) => ({ type: 'Linked', links })),
                  ),
              )
            : { model };
        case 'Revoke': {
          const slug = folderInviteSlug(message.url);
          return model.draft && slug
            ? run(
                model.props.api.deleteFolderLink(model.draft.id, slug).pipe(
                  Effect.andThen(model.props.api.getFolderLinks(model.draft.id)),
                  Effect.map((links) => ({ type: 'Linked', links })),
                ),
              )
            : { model };
        }
        case 'CheckInvite': {
          const slug = folderInviteSlug(model.linkInput);
          return slug
            ? run(
                model.props.api
                  .checkFolderInvite(slug)
                  .pipe(Effect.map((invite) => ({ type: 'Invite', invite }))),
              )
            : { model: { ...model, error: 'Enter a Telegram folder invitation link.' } };
        }
        case 'Updates':
          return message.invite.folderId === model.draft?.id
            ? { model: { ...model, updates: message.invite } }
            : { model };
        case 'Invite':
          return {
            model: {
              ...model,
              busy: false,
              page: 'preview',
              invite: message.invite,
              selected: message.invite.peers
                .filter((person) => !message.invite.already.includes(person.peer.id))
                .map((person) => person.peer),
            },
          };
        case 'Join':
          return model.invite
            ? run(
                (model.invite.folderId !== undefined && !model.invite.slug
                  ? model.props.api.joinFolderUpdates(model.invite.folderId, model.selected)
                  : model.props.api.joinFolderInvite(model.invite.slug, model.selected)
                ).pipe(
                  Effect.tap(() => Effect.sync(() => model.props.onJoined?.())),
                  Effect.as({
                    type: 'Done',
                    page: 'list',
                    notice: model.invite.folderId !== undefined ? 'Chats added.' : 'Folder added.',
                  }),
                ),
              )
            : { model };
      }
    },
  },
  view((model, send) => {
    const draft = model.draft;
    const picking = ['include', 'exclude', 'share', 'preview'].includes(model.page);
    const people: readonly (TelegramDialog | TelegramPeerSearchResult)[] =
      model.page === 'preview'
        ? (model.invite?.peers ?? [])
        : model.page === 'share'
          ? model.props.dialogs.filter(
              (dialog) =>
                dialog.peer.kind !== 'user' &&
                draft?.included.some((peer) => peer.id === dialog.peer.id),
            )
          : model.props.dialogs;
    const selected =
      model.page === 'include'
        ? (draft?.included ?? [])
        : model.page === 'exclude'
          ? (draft?.excluded ?? [])
          : model.selected;
    return (
      <div
        class="folder-settings"
        use={folderSubscription(model.props.api, () => send({ type: 'Load' }), model.props.online)}
        aria-busy={model.busy}
      >
        {model.page !== 'list' && !model.props.initialInvite ? (
          <button
            class="folder-back"
            onClick={() =>
              send({
                type: 'Page',
                page: ['include', 'exclude', 'links', 'delete'].includes(model.page)
                  ? 'edit'
                  : model.page === 'share'
                    ? 'links'
                    : 'list',
              })
            }
          >
            <ArrowLeft size={18} />
            {model.page === 'edit' || model.page === 'join' || model.page === 'preview'
              ? 'Chat Folders'
              : 'Back'}
          </button>
        ) : null}
        {model.error ? (
          <p role="alert" class="folder-error">
            {model.error}
          </p>
        ) : null}
        {model.notice ? (
          <p role="status" class="folder-help">
            {model.notice}
          </p>
        ) : null}
        {model.page === 'list' ? (
          <>
            <p class="folder-help">
              Organize chats into folders. Each folder appears as a separate tab.
            </p>
            {list(idRows(model.folders), (folder, index) => (
              <div class="folder-row">
                <button class="folder-main" onClick={() => send({ type: 'Open', folder })}>
                  <Folder size={22} />
                  <span>
                    {folder.title}
                    <small>
                      {folder.shared
                        ? 'Shared folder'
                        : folder.categories.length
                          ? folder.categories.map((key) => labels[key]).join(', ')
                          : `${folder.included.length} selected chats`}
                    </small>
                  </span>
                  <ChevronRight size={18} />
                </button>
                {index > 0 ? (
                  <button
                    class="icon-button"
                    disabled={model.busy}
                    title={`Move ${folder.title} up`}
                    aria-label={`Move ${folder.title} up`}
                    onClick={() => send({ type: 'Order', index })}
                  >
                    <ArrowUp size={18} />
                  </button>
                ) : null}
              </div>
            ))}
            <button
              class="settings-navigation-row text-accent"
              onClick={() => send({ type: 'Open' })}
            >
              <Plus size={22} />
              Create New Folder
            </button>
            <button
              class="settings-navigation-row"
              onClick={() => send({ type: 'Page', page: 'join' })}
            >
              <Link size={22} />
              Add Folder by Link
            </button>
          </>
        ) : null}
        {model.page === 'edit' && draft ? (
          <>
            <label class="folder-field">
              Folder name
              <input
                aria-label="Folder name"
                maxlength={24}
                value={draft.title}
                onInput={(event) => send({ type: 'Title', value: event.currentTarget.value })}
              />
            </label>
            {model.updates?.peers.length ? (
              <button
                class="settings-navigation-row"
                onClick={() => send({ type: 'Invite', invite: model.updates! })}
              >
                <Plus size={20} />
                <span>
                  New Chats<small>{model.updates.peers.length} chats available to add</small>
                </span>
                <ChevronRight size={18} />
              </button>
            ) : null}
            <button
              class="settings-navigation-row"
              onClick={() => send({ type: 'Page', page: 'include' })}
            >
              <Plus size={20} />
              <span>
                Included Chats
                <small>
                  {draft.categories.map((key) => labels[key]).join(', ') ||
                    `${draft.included.length} chats`}
                </small>
              </span>
              <ChevronRight size={18} />
            </button>
            {!draft.shared ? (
              <button
                class="settings-navigation-row"
                onClick={() => send({ type: 'Page', page: 'exclude' })}
              >
                <span>
                  Excluded Chats
                  <small>
                    {draft.exclusions.map((key) => labels[key]).join(', ') ||
                      `${draft.excluded.length} chats`}
                  </small>
                </span>
                <ChevronRight size={18} />
              </button>
            ) : null}
            {model.folders.some((folder) => folder.id === draft.id) ? (
              <>
                <button
                  class="settings-navigation-row"
                  disabled={model.busy || !model.props.online}
                  onClick={() => send({ type: 'Links' })}
                >
                  <Link size={20} />
                  <span>Invite Links</span>
                  <ChevronRight size={18} />
                </button>
                <button
                  class="settings-navigation-row text-red-400"
                  onClick={() => send({ type: 'Page', page: 'delete' })}
                >
                  Delete Folder
                </button>
              </>
            ) : null}
            <div class="folder-footer">
              <button
                class="primary-button"
                disabled={model.busy || !model.props.online || !draft.title.trim()}
                onClick={() => send({ type: 'Save' })}
              >
                Save
              </button>
            </div>
          </>
        ) : null}
        {picking ? (
          <>
            <h3>
              {model.page === 'include'
                ? 'Included Chats'
                : model.page === 'exclude'
                  ? 'Excluded Chats'
                  : model.page === 'share'
                    ? 'Share Folder'
                    : model.invite?.title}
            </h3>
            {model.page === 'share' ? (
              <label class="folder-field">
                Link name
                <input
                  value={model.linkTitle}
                  onInput={(event) => send({ type: 'LinkTitle', value: event.currentTarget.value })}
                />
              </label>
            ) : null}
            <label class="folder-field">
              <input
                aria-label="Search folder chats"
                placeholder="Search chats"
                value={model.query}
                onInput={(event) => send({ type: 'Query', value: event.currentTarget.value })}
              />
            </label>
            {!model.query &&
            !draft?.shared &&
            (model.page === 'include' || model.page === 'exclude')
              ? list(model.page === 'include' ? folderCategories : folderExclusions, (key) => (
                  <label class="folder-choice">
                    <input
                      type="checkbox"
                      checked={Boolean(
                        draft?.categories.includes(key as (typeof folderCategories)[number]) ||
                        draft?.exclusions.includes(key as (typeof folderExclusions)[number]),
                      )}
                      onChange={() => send({ type: 'ToggleFlag', key })}
                    />
                    <span>{labels[key]}</span>
                  </label>
                ))
              : null}
            {list(
              peerRows(
                people.filter((person) =>
                  person.title.toLocaleLowerCase().includes(model.query.toLocaleLowerCase()),
                ),
              ),
              (person) => (
                <label class="folder-choice">
                  <input
                    type="checkbox"
                    disabled={
                      model.page === 'preview' &&
                      Boolean(model.invite?.already.includes(person.peer.id))
                    }
                    checked={
                      selected.some((peer) => peer.id === person.peer.id) ||
                      (model.page === 'preview' &&
                        Boolean(model.invite?.already.includes(person.peer.id)))
                    }
                    onChange={() => send({ type: 'TogglePeer', peer: person.peer })}
                  />
                  <Avatar
                    identity={person.peer.id}
                    initials={person.initials}
                    color={person.color}
                    size="sm"
                    loadCached={() =>
                      model.props.media.loadPeerAvatar(
                        person.peer,
                        person.hasAvatar,
                        person.avatarId,
                        true,
                      )
                    }
                    load={
                      model.props.online
                        ? () =>
                            model.props.media.loadPeerAvatar(
                              person.peer,
                              person.hasAvatar,
                              person.avatarId,
                            )
                        : undefined
                    }
                  />
                  <span>{person.title}</span>
                </label>
              ),
            )}
            <div class="folder-footer">
              <button
                class="primary-button"
                disabled={
                  model.busy ||
                  ((model.page === 'share' || model.page === 'preview') &&
                    (!model.props.online || !selected.length))
                }
                onClick={() =>
                  send(
                    model.page === 'share'
                      ? { type: 'Export' }
                      : model.page === 'preview'
                        ? { type: 'Join' }
                        : { type: 'Page', page: 'edit' },
                  )
                }
              >
                {model.page === 'share'
                  ? 'Create Link'
                  : model.page === 'preview'
                    ? model.invite?.folderId !== undefined
                      ? 'Add Chats'
                      : 'Add Folder'
                    : 'Done'}
              </button>
            </div>
          </>
        ) : null}
        {model.page === 'links' ? (
          <>
            <h3>Invite Links</h3>
            <p class="folder-help">
              Share selected groups and channels with one link. People can choose which chats to
              join.
            </p>
            {list(linkRows(model.links), (link) => (
              <div class="folder-link">
                <strong>{link.title || 'Folder link'}</strong>
                <input
                  aria-label="Folder invitation link"
                  readonly
                  value={link.url}
                  onFocus={(event) => event.currentTarget.select()}
                />
                <button
                  onClick={() => {
                    void navigator.clipboard.writeText(link.url).then(
                      () => send({ type: 'Done', page: 'links', notice: 'Link copied.' }),
                      () => send({ type: 'Failed', error: 'Select the link to copy it.' }),
                    );
                  }}
                >
                  Copy
                </button>
                <button
                  disabled={model.busy}
                  onClick={() => send({ type: 'Revoke', url: link.url })}
                >
                  Revoke
                </button>
              </div>
            ))}
            {draft?.categories.length || draft?.exclusions.length || draft?.excluded.length ? (
              <p class="folder-help">
                Sharing requires a folder with individually selected chats and no automatic filters
                or exclusions. Save those changes before creating a link.
              </p>
            ) : (
              <button
                class="settings-navigation-row"
                disabled={model.busy || !model.props.online}
                onClick={() => send({ type: 'Page', page: 'share' })}
              >
                <Plus size={20} />
                Create Invite Link
              </button>
            )}
          </>
        ) : null}
        {model.page === 'join' ? (
          <>
            <p class="folder-help">
              Paste a Telegram folder link to preview its chats before joining.
            </p>
            <label class="folder-field">
              Folder link
              <input
                value={model.linkInput}
                placeholder="https://t.me/addlist/…"
                onInput={(event) => send({ type: 'Input', value: event.currentTarget.value })}
              />
            </label>
            <div class="folder-footer">
              <button
                class="primary-button"
                disabled={model.busy || !model.props.online}
                onClick={() => send({ type: 'CheckInvite' })}
              >
                Preview Folder
              </button>
            </div>
          </>
        ) : null}
        {model.page === 'delete' ? (
          <>
            <p class="folder-help">
              Delete “{draft?.title}”? Your chats and messages will be kept.
            </p>
            <div class="folder-footer">
              <button disabled={model.busy} onClick={() => send({ type: 'Page', page: 'edit' })}>
                Cancel
              </button>
              <button
                class="text-red-400"
                disabled={model.busy || !model.props.online}
                onClick={() => send({ type: 'Delete' })}
              >
                Delete Folder
              </button>
            </div>
          </>
        ) : null}
      </div>
    );
  }),
);
