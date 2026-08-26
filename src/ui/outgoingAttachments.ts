import type { OutgoingAttachmentMode } from '../telegram/types';

export interface StagedAttachment {
  id: string;
  file: File;
  sendAs: OutgoingAttachmentMode;
}

export function defaultAttachmentMode(file: File): OutgoingAttachmentMode {
  return file.type.startsWith('image/') || file.type.startsWith('video/') ? 'media' : 'file';
}

export function stageAttachment(file: File): StagedAttachment {
  return {
    id: crypto.randomUUID(),
    file,
    sendAs: defaultAttachmentMode(file),
  };
}

export function canTransformImage(file: File) {
  return (
    file.type.startsWith('image/') && file.type !== 'image/gif' && file.type !== 'image/svg+xml'
  );
}
