import angular from 'angular-eslint';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    files: ['src/**/*.ts'],
    extends: [...tseslint.configs.recommended, ...angular.configs.tsRecommended],
    processor: angular.processInlineTemplates,
    rules: {
      '@angular-eslint/component-selector': 'off',
      '@angular-eslint/directive-selector': [
        'error',
        { type: 'attribute', prefix: 'chain', style: 'camelCase' },
      ],
    },
  },
  {
    // The expression interpreter is framework-free (ADR-0010 D5, D9): no Angular, no RxJS.
    files: ['src/app/expression/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        { patterns: [{ group: ['@angular/*', 'rxjs', 'rxjs/*'], message: 'expression/ is framework-free (ADR-0010 D5).' }] },
      ],
    },
  },
  {
    files: ['src/**/*.html'],
    extends: [...angular.configs.templateRecommended, ...angular.configs.templateAccessibility],
  },
);
