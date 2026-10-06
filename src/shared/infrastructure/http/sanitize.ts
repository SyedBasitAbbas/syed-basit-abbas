import { FilterXSS } from 'xss';

/**
 * Strips every HTML tag (dropping the content of script/style blocks) and
 * HTML-escapes stray angle brackets. Applied to free text from users and to
 * text from the AI provider before it is stored or returned, so no consumer
 * can be tricked into rendering active markup.
 */
const plainText = new FilterXSS({
  whiteList: {},
  stripIgnoreTag: true,
  stripIgnoreTagBody: ['script', 'style'],
  allowCommentTag: false,
});

// Per the HTML tokenizer, "<" only opens a tag when followed by a letter, "!", "/"
// or "?". Escaping every other "<" first keeps text like "a < b" intact.
const LITERAL_LESS_THAN = /<(?![A-Za-z!/?])/g;

export function sanitizeText(input: string): string {
  return plainText.process(input.normalize('NFC').replace(LITERAL_LESS_THAN, '&lt;')).trim();
}
