import { describe, expect, it } from 'vitest';
import { parseTopicRef } from '../src/topics';

describe('parseTopicRef — every way people paste a forum topic', () => {
  it.each([
    ['https://t.me/c/4396952075/5', { chatId: '-1004396952075', topicId: 5 }], // topic → Copy link
    ['t.me/c/4396952075/5', { chatId: '-1004396952075', topicId: 5 }],
    ['https://t.me/c/4396952075/5/812', { chatId: '-1004396952075', topicId: 5 }], // a message inside the topic
    ['https://t.me/c/4396952075/812?thread=5', { chatId: '-1004396952075', topicId: 5 }], // older message link
    ['https://t.me/iceberg_trading/5', { username: 'iceberg_trading', topicId: 5 }], // public group
    ['https://t.me/iceberg_trading/5/812', { username: 'iceberg_trading', topicId: 5 }],
    ['  https://t.me/c/4396952075/5/  ', { chatId: '-1004396952075', topicId: 5 }],
    ['5', { topicId: 5 }], // bare id
  ])('%s', (input, expected) => {
    expect(parseTopicRef(input)).toEqual(expected);
  });

  it.each(['https://t.me/+pupW9jQoK1AxYzE0', 'https://t.me/iceberg_trading', 'GOLD Scalp', '0', '-5', 'https://t.me/c/123'])(
    'refuses %s with a hint about Copy link',
    (input) => {
      expect(() => parseTopicRef(input)).toThrow(/Copy link/);
    },
  );
});
