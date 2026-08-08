import { describe, expect, it } from 'vitest';
import { insertTextAtRange } from '../src/app/chat/Composer';

describe('insertTextAtRange — 右键粘贴文本插入', () => {
  it('在光标处插入', () => {
    expect(insertTextAtRange('hello world', 5, 5, ',')).toBe('hello, world');
  });

  it('替换选区', () => {
    expect(insertTextAtRange('hello world', 6, 11, 'there')).toBe('hello there');
  });

  it('空文本原样返回', () => {
    expect(insertTextAtRange('abc', 1, 1, '')).toBe('abc');
  });

  it('在末尾插入', () => {
    expect(insertTextAtRange('abc', 3, 3, '!')).toBe('abc!');
  });
});
