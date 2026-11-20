// The TypeScript interpreter of the condition and expression language (ADR-0003, expression-language.md), framework-free
// (ADR-0010 D5). The C# interpreter is authoritative; both pass the shared vectors in specs/testing/expression-vectors.

export { ExpressionError, type ExpressionErrorCode } from './errors';
export { evaluateCondition, evaluateValue, type EvaluationContext } from './evaluator';
export { parseCondition, parseValue, type ConditionNode, type ParseResult, type ValueNode } from './parser';
export { instantFromEpochMilliseconds, parseDateTime, type Instant } from './temporal';
export { canonical, fromJson, toJson, type ExprValue } from './values';

/** The evaluation zone, fixed to UTC−03:00 for everyone in the first release (Q-15), in minutes east of UTC. */
export const EVALUATION_ZONE_MINUTES = -180;
