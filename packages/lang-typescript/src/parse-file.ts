import { parse } from '@babel/parser';

/**
 * Parses a file with Babel (TypeScript unless it is plain JavaScript).
 * TypeScript gets the legacy decorators of `experimentalDecorators`
 * (NestJS, Angular, TypeORM: only they decorate parameters, `@Param('id')
 * id`), which read standard class and member decorators too; JavaScript
 * gets the standard ones.
 */
export function parseFile(
  text: string,
  fileName = 'file.ts'
): ReturnType<typeof parse> {
  const isJsLike = /\.[cm]?jsx?$/i.test(fileName);
  const isJsx = /\.[jt]sx$/i.test(fileName);
  return parse(text, {
    sourceType: 'unambiguous',
    errorRecovery: true,
    plugins: [
      ...(isJsLike ? [] : [['typescript', {}] as ['typescript', object]]),
      ...(isJsx || isJsLike ? ['jsx' as const] : []),
      isJsLike ? ('decorators' as const) : ('decorators-legacy' as const),
    ],
  });
}
