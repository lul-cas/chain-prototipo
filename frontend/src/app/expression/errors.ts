/** The evaluation failures of the language (expression-language.md §5.3). */
export type ExpressionErrorCode = 'type_mismatch' | 'division_by_zero' | 'empty_list' | 'invalid_number' | 'invalid_date' | 'overflow';

/** Evaluation fails with a code instead of guessing; each caller decides what the error means (a form field error here). */
export class ExpressionError extends Error {
  constructor(
    readonly code: ExpressionErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'ExpressionError';
  }
}

export const overflow = (): ExpressionError => new ExpressionError('overflow', 'The value is out of range.');
