import { describe, expect, it } from 'vitest';
import { TITLE_MAX_LENGTH, validateTitle } from './title';

const fail = (reason: string) => ({ ok: false, reason });
const pass = (value: string) => ({ ok: true, value });

describe('validateTitle', () => {
  it('exposes the limit as 200', () => {
    expect(TITLE_MAX_LENGTH).toBe(200);
  });

  describe('empty after trim', () => {
    it.each([
      ['empty string', ''],
      ['spaces', '   '],
      ['tab', '\t'],
      ['no-break space', ' '],
      ['em space', ' '],
      ['mixed whitespace', ' \t\n   '],
    ])('rejects %s as empty', (_name, input) => {
      expect(validateTitle(input)).toEqual(fail('empty'));
    });
  });

  describe('length limits in code points', () => {
    it('accepts 1 code point', () => {
      expect(validateTitle('a')).toEqual(pass('a'));
    });

    it('accepts exactly 200 and rejects 201', () => {
      expect(validateTitle('a'.repeat(200))).toEqual(pass('a'.repeat(200)));
      expect(validateTitle('a'.repeat(201))).toEqual(fail('too_long'));
    });

    it('counts code points, not UTF-16 units: 200 emoji pass, 201 fail', () => {
      const emoji = '\u{1F600}';
      expect(emoji.length).toBe(2);
      expect(validateTitle(emoji.repeat(200))).toEqual(pass(emoji.repeat(200)));
      expect(validateTitle(emoji.repeat(201))).toEqual(fail('too_long'));
    });

    it('counts one emoji as one', () => {
      expect(validateTitle('\u{1F600}')).toEqual(pass('\u{1F600}'));
    });

    it('counts a ZWJ family emoji as 7 code points and accepts it', () => {
      const family = '\u{1F468}‍\u{1F469}‍\u{1F467}‍\u{1F466}';
      expect(Array.from(family)).toHaveLength(7);
      expect(validateTitle(family)).toEqual(pass(family));
      expect(validateTitle(family.repeat(28) + 'a'.repeat(4))).toEqual(pass(family.repeat(28) + 'a'.repeat(4)));
      expect(validateTitle(family.repeat(28) + 'a'.repeat(5))).toEqual(fail('too_long'));
    });

    it('accepts well-formed surrogate pairs', () => {
      expect(validateTitle('a\u{1F4A9}b')).toEqual(pass('a\u{1F4A9}b'));
    });
  });

  describe('trimming', () => {
    it('returns the trimmed value for a 200-character title with surrounding spaces', () => {
      const core = 'b'.repeat(200);
      expect(validateTitle(`   ${core}  \t`)).toEqual(pass(core));
    });

    it('does not count surrounding whitespace toward the limit', () => {
      expect(validateTitle(` ${'a'.repeat(200)} `)).toEqual(pass('a'.repeat(200)));
    });

    it('keeps inner whitespace', () => {
      expect(validateTitle('  a  b  ')).toEqual(pass('a  b'));
    });
  });

  describe('invalid_type', () => {
    it.each([
      ['null', null],
      ['undefined', undefined],
      ['number', 5],
      ['boolean', true],
      ['array', ['a']],
      ['object', { title: 'a' }],
    ])('rejects %s', (_name, input) => {
      expect(validateTitle(input)).toEqual(fail('invalid_type'));
    });
  });

  describe('invalid_character', () => {
    it.each([
      ['U+0000 alone', '\u0000'],
      ['U+0000 inside', 'a\u0000b'],
      ['lone high surrogate', '\ud800'],
      ['lone low surrogate', '\udc00'],
      ['lone surrogate inside', 'a\ud800b'],
      ['U+0000 padded with spaces', '  \u0000  '],
      ['lone surrogate padded with spaces', '  \ud800  '],
    ])('rejects %s', (_name, input) => {
      expect(validateTitle(input)).toEqual(fail('invalid_character'));
    });

    it('reports invalid_character, not too_long, for a 300-character title containing U+0000', () => {
      expect(validateTitle('a'.repeat(150) + '\u0000' + 'a'.repeat(149))).toEqual(fail('invalid_character'));
    });

    it('reports invalid_character, not too_long, for a 300-character title with a lone surrogate', () => {
      expect(validateTitle('a'.repeat(150) + '\ud800' + 'a'.repeat(149))).toEqual(fail('invalid_character'));
    });
  });

  it('never echoes the input in the result', () => {
    const marker = 'sensitive-marker';
    expect(JSON.stringify(validateTitle(marker + '\u0000'))).not.toContain(marker);
    expect(JSON.stringify(validateTitle(marker.repeat(30)))).not.toContain(marker);
  });
});
