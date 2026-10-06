import { DomainValidationError } from '../../../../shared/domain/errors.js';

export const QUESTION_MAX_LENGTH = 4000;

// C0 control characters except TAB, LF and CR, plus DEL.
// eslint-disable-next-line no-control-regex
const FORBIDDEN_CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;

/** A user's question. Always non-empty, bounded and free of control characters. */
export class Question {
  private constructor(readonly value: string) {}

  static create(raw: string): Question {
    const text = raw.normalize('NFC').trim();
    if (text.length === 0) {
      throw new DomainValidationError('question', 'Question must not be empty.');
    }
    if (text.length > QUESTION_MAX_LENGTH) {
      throw new DomainValidationError(
        'question',
        `Question must be at most ${QUESTION_MAX_LENGTH} characters.`,
      );
    }
    if (FORBIDDEN_CONTROL_CHARS.test(text)) {
      throw new DomainValidationError('question', 'Question contains control characters.');
    }
    return new Question(text);
  }
}
