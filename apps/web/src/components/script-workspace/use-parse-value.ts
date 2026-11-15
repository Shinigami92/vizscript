import type { ImportedDeclaration, TypeSystemInfo } from '@vizscript/core';
import { valueHost } from '@vizscript/core';
import type { Ref, ShallowRef } from 'vue';
import { provide } from 'vue';
import type { GraphClient } from '../../graph/graph-client';
import { PARSE_VALUE } from '../symbol-details/parse-value';

/**
 * Lets Details edit values that are no nodes (a function input's
 * default): parsed in their host file by the worker (`valueHost`).
 */
export function provideParseValue(deps: {
  client: GraphClient;
  text: Ref<string>;
  typeSystem: ShallowRef<TypeSystemInfo | null>;
  path: () => string;
  imports: () => ImportedDeclaration[] | undefined;
}): void {
  provide(PARSE_VALUE, async (range, typeText) => {
    const host = valueHost(
      deps.text.value,
      range,
      typeText,
      deps.typeSystem.value
    );
    if (!host) {
      return null;
    }

    try {
      const doc = await deps.client.parse(
        host.text,
        deps.path(),
        deps.imports()
      );
      return { doc, text: host.text, start: host.start };
    } catch {
      return null;
    }
  });
}
