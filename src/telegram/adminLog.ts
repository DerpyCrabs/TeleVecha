import type { TelegramPeer } from './types';
export const adminLogFilters = {
  all: 'All actions',
  members: 'Members',
  admins: 'Administrators',
  settings: 'Chat settings',
  messages: 'Messages',
  invites: 'Invitation links',
  calls: 'Video chats',
  topics: 'Topics',
} as const;
export type AdminLogFilter = keyof typeof adminLogFilters;
export interface AdminLogRequest {
  query?: string;
  filter?: AdminLogFilter;
  actor?: TelegramPeer;
  beforeId?: string;
}
export interface AdminLogActor {
  peer: TelegramPeer;
  title: string;
  initials: string;
  color: string;
  hasAvatar: boolean;
  avatarId?: string | undefined;
}
export interface AdminLogEntry {
  id: string;
  date: number;
  actor: AdminLogActor;
  action: string;
  details: { label: string; text: string }[];
}
export interface AdminLogPage {
  events: AdminLogEntry[];
  nextId?: string | undefined;
}
