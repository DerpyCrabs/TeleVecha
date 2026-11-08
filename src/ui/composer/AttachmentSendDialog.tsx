import { component, list, Portal, view } from 'effectweb';
import Pencil from '@effectweb/lucide/icons/pencil';
import X from '@effectweb/lucide/icons/x';
import Plus from '@effectweb/lucide/icons/plus';
import { idRows } from '../collections';
import { modalMount } from '../shared/modalMount';
import { formatMediaSize } from '../media/mediaPresentation';
import { AttachmentThumbnail } from './AttachmentThumbnail';
import { ImageAttachmentEditor } from './ImageAttachmentEditor';
import { canTransformImage } from './outgoingAttachments';
import type { ComposerSession } from './composerSession';

const visual = (file: File) => /^(image|video)\//.test(file.type);
export const AttachmentSendDialog = component(
  {
    init: (_props: { composer: ComposerSession; enabled: boolean; canSendMedia: boolean }) => ({
      editingId: '',
    }),
  },
  view((model, patch) => {
    const { composer, enabled, canSendMedia } = model.props;
    const attachments = composer.attachments;
    const media = attachments.filter(({ file }) => visual(file));
    const asFiles = media.length > 0 && media.every(({ sendAs }) => sendAs === 'file');
    const edit = attachments.find(({ id }) => id === model.editingId);
    const cancel = () => {
      for (const item of attachments) composer.removeAttachment(item.id);
    };
    const send = () => {
      if (enabled && canSendMedia) composer.send();
    };
    const title = composer.editing
      ? 'Replace media'
      : attachments.length === 1
        ? visual(attachments[0]!.file) && attachments[0]!.sendAs === 'media'
          ? 'Send media'
          : 'Send file'
        : `Send ${attachments.length} attachments`;
    return (
      <>
        <Portal>
          <div
            class="attachment-send-overlay"
            use={modalMount(cancel)}
            role="presentation"
            tabIndex={-1}
            onPointerDown={(event) => event.target === event.currentTarget && cancel()}
          >
            <section
              class="attachment-send-dialog"
              role="dialog"
              aria-modal="true"
              aria-label={title}
              onDragOver={(event) => {
                if (canSendMedia && event.dataTransfer?.types.includes('Files'))
                  event.preventDefault();
              }}
              onDrop={(event) => {
                if (canSendMedia && event.dataTransfer?.files.length) {
                  event.preventDefault();
                  composer.attach([...event.dataTransfer.files]);
                }
              }}
            >
              <header>
                <strong>{title}</strong>
                <button
                  type="button"
                  onClick={cancel}
                  aria-label="Cancel attachments"
                  title="Cancel"
                >
                  <X size={20} />
                </button>
              </header>
              <div
                class="attachment-send-previews"
                aria-label="Staged attachments"
                data-single={attachments.length === 1 || undefined}
              >
                {list(idRows(attachments), (attachment) => {
                  const isMedia = visual(attachment.file) && attachment.sendAs === 'media';
                  return (
                    <div
                      class={`attachment-send-item ${isMedia ? 'is-media' : 'is-file'}`}
                      data-testid="composer-attachment"
                      data-attachment-id={attachment.id}
                    >
                      <div class="attachment-send-thumbnail">
                        <AttachmentThumbnail file={attachment.file} />
                      </div>
                      {!isMedia ? (
                        <div class="attachment-send-file-info">
                          <strong title={attachment.file.name}>{attachment.file.name}</strong>
                          <small>{formatMediaSize(attachment.file.size) || '0 B'}</small>
                        </div>
                      ) : null}
                      <div class="attachment-send-item-actions">
                        {canTransformImage(attachment.file) ? (
                          <button
                            type="button"
                            title="Edit image"
                            aria-label={`Edit image ${attachment.file.name}`}
                            onClick={() => patch({ editingId: attachment.id })}
                          >
                            <Pencil size={17} />
                          </button>
                        ) : null}
                        <button
                          type="button"
                          title="Remove"
                          aria-label={`Remove attachment ${attachment.file.name}`}
                          onClick={() => composer.removeAttachment(attachment.id)}
                        >
                          <X size={18} />
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
              <div class="attachment-send-options">
                {media.length ? (
                  <label>
                    <input
                      type="checkbox"
                      checked={asFiles}
                      onChange={(event) => {
                        for (const item of media)
                          composer.updateAttachment(item.id, {
                            sendAs: event.currentTarget.checked ? 'file' : 'media',
                          });
                      }}
                    />
                    Send as files
                  </label>
                ) : null}
                {!composer.editing ? (
                  <label class="attachment-send-add" title="Add files">
                    <Plus size={18} />
                    <span>Add</span>
                    <input
                      type="file"
                      multiple
                      aria-label="Add attachments"
                      disabled={!canSendMedia}
                      onChange={(event) => {
                        if (canSendMedia && event.currentTarget.files?.length)
                          composer.attach([...event.currentTarget.files]);
                        event.currentTarget.value = '';
                      }}
                    />
                  </label>
                ) : null}
              </div>
              {composer.reply ? (
                <div class="attachment-send-reply">
                  <strong>Reply</strong>
                  <span>{composer.reply.preview}</span>
                </div>
              ) : null}
              <textarea
                class="attachment-send-caption"
                autofocus
                rows={1}
                aria-label="Attachment caption"
                placeholder="Add a caption…"
                value={composer.draft}
                onInput={(event) => composer.changeDraft(event.currentTarget.value)}
                onKeyDown={(event) => {
                  if (
                    event.key === 'Enter' &&
                    !event.shiftKey &&
                    !event.isComposing &&
                    event.keyCode !== 229
                  ) {
                    event.preventDefault();
                    send();
                  }
                }}
                onPaste={(event) => {
                  if (canSendMedia && event.clipboardData?.files.length) {
                    event.preventDefault();
                    composer.attach([...event.clipboardData.files]);
                  }
                }}
              />
              <footer>
                <button type="button" onClick={cancel}>
                  Cancel
                </button>
                <button
                  type="button"
                  class="primary"
                  disabled={!enabled || !canSendMedia}
                  onClick={send}
                >
                  {composer.editing ? 'Save' : 'Send'}
                </button>
              </footer>
            </section>
          </div>
        </Portal>
        {edit ? (
          <ImageAttachmentEditor
            attachment={edit}
            close={() => patch({ editingId: '' })}
            apply={(file) => composer.updateAttachment(edit.id, { file })}
          />
        ) : null}
      </>
    );
  }),
);
