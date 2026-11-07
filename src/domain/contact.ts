import type { TelegramContact } from '../telegram/types';

const escapeVcard = (value: string) =>
  value
    .replace(/\\/gu, '\\\\')
    .replace(/\r\n|\r|\n/gu, '\\n')
    .replace(/;/gu, '\\;')
    .replace(/,/gu, '\\,');
export const contactName = (contact: TelegramContact) =>
  [contact.firstName, contact.lastName].filter(Boolean).join(' ') || contact.phoneNumber;
export function contactVcard(contact: TelegramContact) {
  return (
    contact.vcard ||
    [
      'BEGIN:VCARD',
      'VERSION:3.0',
      `FN:${escapeVcard(contactName(contact))}`,
      `N:${escapeVcard(contact.lastName)};${escapeVcard(contact.firstName)};;;`,
      `TEL;TYPE=CELL:${escapeVcard(contact.phoneNumber)}`,
      'END:VCARD',
      '',
    ].join('\r\n')
  );
}
