import type { Entity, RichText } from './types.js';

/**
 * Tiny formatting language for headers/footers written in the dashboard:
 *   **bold**   __italic__   `code`   [label](https://url)
 * No nesting — intentionally simple and predictable.
 */
export function parseMiniMarkdown(source: string): RichText {
  const tokenizer =
    /\*\*(.+?)\*\*|__(.+?)__|`([^`\n]+?)`|\[([^\]\n]+?)\]\((https?:\/\/[^)\s]+?)\)/gs;

  let text = '';
  const entities: Entity[] = [];
  let cursor = 0;

  let m = tokenizer.exec(source);
  while (m !== null) {
    text += source.slice(cursor, m.index);

    const [, bold, italic, code, label, url] = m;
    const content = bold ?? italic ?? code ?? label ?? '';
    const offset = text.length;

    if (bold !== undefined) entities.push({ type: 'bold', offset, length: content.length });
    else if (italic !== undefined) entities.push({ type: 'italic', offset, length: content.length });
    else if (code !== undefined) entities.push({ type: 'code', offset, length: content.length });
    else if (label !== undefined && url !== undefined)
      entities.push({ type: 'text_link', offset, length: content.length, url });

    text += content;
    cursor = m.index + m[0].length;
    m = tokenizer.exec(source);
  }
  text += source.slice(cursor);

  return { text, entities };
}

const pad = (n: number) => String(n).padStart(2, '0');

/**
 * Expand {master} {master_username} {date} {time} {link} variables.
 * Runs BEFORE mini-markdown parsing so variables can sit inside formatting.
 */
export function expandVariables(
  template: string,
  vars: {
    masterTitle: string;
    masterUsername?: string;
    messageLink?: string;
    now: Date;
    tz?: string;
  },
): string {
  let date: string;
  let time: string;
  try {
    const fmt = new Intl.DateTimeFormat('en-GB', {
      timeZone: vars.tz ?? 'UTC',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    });
    const parts = Object.fromEntries(fmt.formatToParts(vars.now).map((p) => [p.type, p.value]));
    date = `${parts['year']}-${parts['month']}-${parts['day']}`;
    time = `${parts['hour']}:${parts['minute']}`;
  } catch {
    date = `${vars.now.getUTCFullYear()}-${pad(vars.now.getUTCMonth() + 1)}-${pad(vars.now.getUTCDate())}`;
    time = `${pad(vars.now.getUTCHours())}:${pad(vars.now.getUTCMinutes())}`;
  }

  return template
    .replaceAll('{master}', vars.masterTitle)
    .replaceAll('{master_username}', vars.masterUsername ? `@${vars.masterUsername}` : '')
    .replaceAll('{date}', date)
    .replaceAll('{time}', time)
    .replaceAll('{link}', vars.messageLink ?? '');
}
