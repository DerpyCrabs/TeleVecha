import { describe, expect, it } from 'vitest';
import { contactName, contactVcard } from './contact';

describe('contact vCard export', () => {
  it('escapes names and prevents injected vCard properties', () => {
    const contact = {
      firstName: 'Ada; A, B',
      lastName: 'Lovelace\nTEL:evil',
      phoneNumber: '+123',
      vcard: '',
    };
    expect(contactVcard(contact)).toContain('N:Lovelace\\nTEL:evil;Ada\\; A\\, B;;;\r\n');
    expect(contactVcard(contact).split('\r\n')).toHaveLength(7);
  });
  it('preserves a supplied vCard with additional contact details', () => {
    const contact = {
      firstName: '',
      lastName: '',
      phoneNumber: '+123',
      vcard: 'BEGIN:VCARD\r\nVERSION:3.0\r\nEND:VCARD\r\n',
    };
    expect(contactVcard(contact)).toBe(contact.vcard);
    expect(contactName(contact)).toBe('+123');
  });
});
